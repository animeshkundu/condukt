/**
 * SdkBackend event mapping tests.
 *
 * The SdkBackend wraps @github/copilot-sdk with a CopilotSession interface.
 * Since the SDK is loaded via dynamic import and the SdkSession class is
 * not exported, these tests verify the event mapping contracts by mocking
 * the SDK module and testing through SdkBackend.createSession().
 *
 * The mock replaces the dynamic `import()` call with a fake CopilotClient
 * that captures event handlers and lets us simulate SDK events.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { agent } from '../../src/agent';
import { adaptCopilotBackend } from '../../runtimes/copilot/copilot-adapter';
import { SdkBackend } from '../../runtimes/copilot/sdk-backend';
import { classifySdkEvent, KNOWN_SDK_EVENT_TYPES } from '../../runtimes/copilot/lifecycle-events';
import type { CopilotSession } from '../../runtimes/copilot/copilot-backend';
import type { SessionConfig } from '../../src/types';

// ---------------------------------------------------------------------------
// Mock SDK types that mirror the real SDK's shape
// ---------------------------------------------------------------------------

type SdkEventHandler = (e: {
  type?: string;
  agentId?: string;
  data?: Record<string, unknown>;
}) => void;

interface MockModelInfo {
  readonly id: string;
  readonly name: string;
  readonly capabilities: {
    readonly supports: {
      readonly vision: boolean;
      readonly reasoningEffort: boolean;
    };
    readonly limits: {
      readonly max_prompt_tokens?: number;
      readonly max_context_window_tokens: number;
    };
  };
}

interface MockSdkSession {
  send: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  rpc: {
    mode: { set: ReturnType<typeof vi.fn> };
    tools: { updateSubagentSettings: ReturnType<typeof vi.fn> };
    history: {
      compact: ReturnType<typeof vi.fn>;
      truncate: ReturnType<typeof vi.fn>;
      summarizeForHandoff: ReturnType<typeof vi.fn>;
    };
    metadata: {
      contextInfo: ReturnType<typeof vi.fn>;
      getContextAttribution: ReturnType<typeof vi.fn>;
      getContextHeaviestMessages: ReturnType<typeof vi.fn>;
      recomputeContextTokens: ReturnType<typeof vi.fn>;
    };
    usage: { getMetrics: ReturnType<typeof vi.fn> };
    mcp: { cancelSamplingExecution: ReturnType<typeof vi.fn> };
    ui: {
      handlePendingAutoModeSwitch: ReturnType<typeof vi.fn>;
      handlePendingSessionLimitsExhausted: ReturnType<typeof vi.fn>;
    };
  };
  on: (event: string | SdkEventHandler, handler?: SdkEventHandler) => void;
  /** Simulate an SDK event by type. */
  _emit: (type: string, data?: Record<string, unknown>, agentId?: string) => void;
}

function createMockSdkSession(): MockSdkSession {
  const handlers = new Map<string, SdkEventHandler[]>();
  const catchAll: SdkEventHandler[] = [];

  const session: MockSdkSession = {
    send: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    rpc: {
      mode: { set: vi.fn().mockResolvedValue(undefined) },
      tools: { updateSubagentSettings: vi.fn().mockResolvedValue({}) },
      history: {
        compact: vi.fn().mockResolvedValue({ success: true, tokensRemoved: 0, messagesRemoved: 0 }),
        truncate: vi.fn().mockResolvedValue({ eventsRemoved: 0 }),
        summarizeForHandoff: vi.fn().mockResolvedValue({ summary: '' }),
      },
      metadata: {
        contextInfo: vi.fn().mockResolvedValue({ contextInfo: null }),
        getContextAttribution: vi.fn().mockImplementation(async () => {
          const pending = session.rpc.metadata.contextInfo.mock.results.at(-1)?.value;
          const info = pending ? await pending : { contextInfo: null };
          const contextInfo = info.contextInfo;
          return { contextAttribution: contextInfo ? {
            totalTokens: contextInfo.totalTokens,
            entries: [
              {
                kind: 'system',
                id: 'system:prompt',
                label: 'system prompt',
                tokens: contextInfo.systemTokens,
              },
              {
                kind: 'toolDefinition',
                id: 'toolDefinition:all',
                label: 'tool definitions',
                tokens: contextInfo.toolDefinitionsTokens,
              },
            ],
            compactions: { count: session.rpc.history.compact.mock.calls.length },
          } : null };
        }),
        getContextHeaviestMessages: vi.fn().mockImplementation(async () => {
          const pending = session.rpc.metadata.contextInfo.mock.results.at(-1)?.value;
          const info = pending ? await pending : { contextInfo: null };
          return { totalTokens: info.contextInfo?.totalTokens ?? 0, messages: [] };
        }),
        recomputeContextTokens: vi.fn().mockImplementation(async () => {
          const pending = session.rpc.metadata.contextInfo.mock.results.at(-1)?.value;
          const info = pending ? await pending : { contextInfo: null };
          const contextInfo = info.contextInfo;
          return {
            totalTokens: contextInfo
              ? contextInfo.systemTokens + contextInfo.conversationTokens
              : 0,
            messagesTokenCount: contextInfo?.conversationTokens ?? 0,
            systemTokenCount: contextInfo?.systemTokens ?? 0,
          };
        }),
      },
      usage: {
        getMetrics: vi.fn().mockResolvedValue({
          totalPremiumRequestCost: 0,
          totalUserRequests: 0,
          totalApiDurationMs: 0,
          sessionStartTime: '2026-01-01T00:00:00.000Z',
          codeChanges: {
            linesAdded: 0,
            linesRemoved: 0,
            filesModifiedCount: 0,
            filesModified: [],
          },
          modelMetrics: {},
          lastCallInputTokens: 0,
          lastCallOutputTokens: 0,
        }),
      },
      mcp: { cancelSamplingExecution: vi.fn().mockResolvedValue({ cancelled: true }) },
      ui: {
        handlePendingAutoModeSwitch: vi.fn().mockResolvedValue({ success: true }),
        handlePendingSessionLimitsExhausted: vi.fn().mockResolvedValue({ success: true }),
      },
    },
    on: (eventOrHandler: string | SdkEventHandler, handler?: SdkEventHandler) => {
      if (typeof eventOrHandler === 'function') {
        catchAll.push(eventOrHandler);
      } else if (handler) {
        const list = handlers.get(eventOrHandler) ?? [];
        list.push(handler);
        handlers.set(eventOrHandler, list);
      }
    },
    _emit: (type: string, data?: Record<string, unknown>, agentId?: string) => {
      const event = { type, data, agentId };
      const list = handlers.get(type) ?? [];
      for (const h of list) h(event);
      for (const h of catchAll) h(event);
    },
  };
  return session;
}

// ---------------------------------------------------------------------------
// Test helpers: create session and capture events
// ---------------------------------------------------------------------------

let mockSdkSession: MockSdkSession;
let mockSdkSessions: MockSdkSession[];
let mockClientConfig: Record<string, unknown> | undefined;
let mockForwardedRequests: Request[];
let mockWebSocketContexts: Array<Record<string, unknown>>;
let MockCopilotRequestHandlerClass: {
  new (): {
    sendRequest(request: Request, context: Record<string, unknown>): Promise<Response>;
    openWebSocket(context: Record<string, unknown>): Promise<unknown>;
  };
};
let MockCopilotWebSocketForwarderClass: new (context: Record<string, unknown>) => unknown;
let mockCreateSession: ReturnType<typeof vi.fn<(config: Record<string, unknown>) => Promise<MockSdkSession>>>;
let mockStart: ReturnType<typeof vi.fn<() => Promise<void>>>;
let mockListModels: ReturnType<typeof vi.fn<() => Promise<MockModelInfo[]>>>;
let mockStop: ReturnType<typeof vi.fn<() => Promise<void>>>;
let mockForceStop: ReturnType<typeof vi.fn<() => Promise<void>>>;
let mockEarlyEvents: Array<{
  readonly type: string;
  readonly data?: Record<string, unknown>;
  readonly agentId?: string;
}>;
let originalFunction: typeof globalThis.Function;
let NativeRequest: typeof Request;

/**
 * Creates a SdkBackend session with a mock SDK module.
 * Returns the CopilotSession and the mock so tests can simulate SDK events.
 */
async function createTestSession(
  options: ConstructorParameters<typeof SdkBackend>[0] = {},
  config: Partial<SessionConfig> = {},
): Promise<{ session: CopilotSession; mock: MockSdkSession }> {
  const backend = new SdkBackend(options);
  const session = await backend.createSession({
    model: 'test-model',
    cwd: '.',
    addDirs: [],
    timeout: 3600,
    heartbeatTimeout: 120,
    ...config,
  });

  return { session, mock: mockSdkSession };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

interface MockContextDiagnostics {
  readonly attributionTotalTokens: number | null;
  readonly recomputedTotalTokens: number;
  readonly messagesTokenCount: number;
  readonly systemTokenCount: number;
  readonly successfulCompactions: number;
}

function queueContextDiagnostics(
  mock: MockSdkSession,
  diagnostics: MockContextDiagnostics,
): void {
  mock.rpc.metadata.getContextAttribution.mockResolvedValueOnce({
    contextAttribution: diagnostics.attributionTotalTokens === null
      ? null
      : {
          totalTokens: diagnostics.attributionTotalTokens,
          entries: [],
          compactions: { count: diagnostics.successfulCompactions },
        },
  });
  mock.rpc.metadata.getContextHeaviestMessages.mockResolvedValueOnce({
    totalTokens: diagnostics.recomputedTotalTokens,
    messages: [],
  });
  mock.rpc.metadata.recomputeContextTokens.mockResolvedValueOnce({
    totalTokens: diagnostics.recomputedTotalTokens,
    messagesTokenCount: diagnostics.messagesTokenCount,
    systemTokenCount: diagnostics.systemTokenCount,
  });
}

function queueParentMeasurement(
  mock: MockSdkSession,
  measurement: MockContextDiagnostics & {
    readonly promptTokenLimit: number;
    readonly toolDefinitionsTokens: number;
  },
): void {
  mock.rpc.metadata.contextInfo.mockResolvedValueOnce({
    contextInfo: {
      totalTokens: measurement.attributionTotalTokens
        ?? measurement.recomputedTotalTokens,
      promptTokenLimit: measurement.promptTokenLimit,
      systemTokens: measurement.systemTokenCount,
      conversationTokens: measurement.messagesTokenCount,
      toolDefinitionsTokens: measurement.toolDefinitionsTokens,
    },
  });
  queueContextDiagnostics(mock, measurement);
}

function observedRequestHandler(): {
  sendRequest(request: Request, context: Record<string, unknown>): Promise<Response>;
} {
  return mockClientConfig?.requestHandler as {
    sendRequest(request: Request, context: Record<string, unknown>): Promise<Response>;
  };
}

async function sendObservedParentRequest(requestId: string): Promise<Response> {
  return observedRequestHandler().sendRequest(
    new NativeRequest('https://example.test/inference', {
      method: 'POST',
      body: '{}',
    }),
    {
      requestId,
      sessionId: 'session-1',
      agentId: 'session-1',
      interactionType: 'conversation-agent',
    },
  );
}

interface JsonSchemaDefinition {
  readonly anyOf?: ReadonlyArray<{ readonly $ref?: string }>;
  readonly properties?: { readonly type?: { readonly const?: string } };
}

interface SessionEventsSchema {
  readonly definitions?: Readonly<Record<string, JsonSchemaDefinition>>;
}

function findSessionEventsSchema(): string {
  const nodeModules = fileURLToPath(new URL('../../node_modules/', import.meta.url));
  const githubPackages = join(nodeModules, '@github');
  const schemaPath = readdirSync(githubPackages)
    .filter(name => name.startsWith('copilot-'))
    .map(name => join(githubPackages, name, 'schemas', 'session-events.schema.json'))
    .find(existsSync);
  if (!schemaPath) throw new Error('Installed Copilot CLI session-events.schema.json not found');
  return schemaPath;
}

function authoritativeSdkEventTypes(): string[] {
  const schema = JSON.parse(readFileSync(findSessionEventsSchema(), 'utf8')) as SessionEventsSchema;
  const definitions = schema.definitions;
  const variants = definitions?.SessionEvent?.anyOf;
  if (!definitions || !variants) throw new Error('Invalid Copilot CLI session event schema');

  return variants.map((variant) => {
    const definitionName = variant.$ref?.split('/').at(-1);
    const eventType = definitionName
      ? definitions[definitionName]?.properties?.type?.const
      : undefined;
    if (!eventType) throw new Error(`Session event variant has no type discriminator: ${variant.$ref ?? '(missing ref)'}`);
    return eventType;
  });
}

// We need to mock the `new Function('specifier', 'return import(specifier)')` pattern.
// The SdkBackend uses this to dynamically import @github/copilot-sdk.
beforeEach(() => {
  mockSdkSession = createMockSdkSession();
  mockSdkSessions = [mockSdkSession];
  mockClientConfig = undefined;
  mockForwardedRequests = [];
  mockWebSocketContexts = [];
  MockCopilotRequestHandlerClass = class MockCopilotRequestHandler {
    async sendRequest(request: Request): Promise<Response> {
      mockForwardedRequests.push(request);
      return new Response(null, { status: 204 });
    }
    openWebSocket(context: Record<string, unknown>): Promise<Record<string, never>> {
      mockWebSocketContexts.push(context);
      return Promise.resolve({});
    }
  };
  MockCopilotWebSocketForwarderClass = class MockCopilotWebSocketForwarder {
    constructor(context: Record<string, unknown>) {
      mockWebSocketContexts.push(context);
    }
  };
  mockCreateSession = vi.fn<(config: Record<string, unknown>) => Promise<MockSdkSession>>()
    .mockImplementation(async () => mockSdkSessions.shift() ?? mockSdkSession);
  mockStart = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  mockStop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  mockForceStop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  mockEarlyEvents = [{ type: 'session.start', data: { early: true } }];
  mockListModels = vi.fn<() => Promise<MockModelInfo[]>>().mockResolvedValue([{
    id: 'test-model',
    name: 'Test Model',
    capabilities: {
      supports: { vision: false, reasoningEffort: true },
      limits: {
        max_prompt_tokens: 922_000,
        max_context_window_tokens: 1_050_000,
      },
    },
  }]);
  originalFunction = globalThis.Function;
  NativeRequest = globalThis.Request;

  // Replace Function constructor so that when SdkBackend creates its dynamic import
  // function, we intercept and return our mock SDK module.
  const mockFunction = function (...args: string[]): Function {
    if (args.length === 2 && args[0] === 'specifier' && args[1] === 'return import(specifier)') {
      return () => Promise.resolve({
        RuntimeConnection: {
          forStdio: vi.fn(() => ({ kind: 'stdio' as const })),
        },
        CopilotRequestHandler: MockCopilotRequestHandlerClass,
        CopilotWebSocketForwarder: MockCopilotWebSocketForwarderClass,
        CopilotClient: class MockCopilotClient {
          constructor(config: Record<string, unknown>) {
            mockClientConfig = config;
          }
          start() { return mockStart(); }
          listModels() { return mockListModels(); }
          async createSession(config: Record<string, unknown>) {
            const onEvent = config.onEvent as SdkEventHandler | undefined;
            for (const event of mockEarlyEvents) onEvent?.(event);
            return mockCreateSession(config);
          }
          stop() { return mockStop(); }
          forceStop() { return mockForceStop(); }
        },
        approveAll: () => ({}),
      });
    }
    return originalFunction(...args);
  };
  (globalThis as Record<string, unknown>).Function = mockFunction as unknown as typeof Function;
});

afterEach(() => {
  globalThis.Function = originalFunction;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SdkBackend event mapping', () => {
  it('classifies every event in the authoritative installed SDK schema', () => {
    const eventTypes = authoritativeSdkEventTypes();
    const unclassified = eventTypes.filter(type => classifySdkEvent(type) === undefined);

    expect(unclassified).toEqual([]);
    expect(KNOWN_SDK_EVENT_TYPES).toEqual(new Set(eventTypes));
    for (const phantom of ['assistant.tool_call', 'blob', 'agent_completed', 'agent_idle', 'shell_completed', 'shell_detached_completed']) {
      expect(classifySdkEvent(phantom), phantom).toBeUndefined();
    }
  });
  it('defaults to stock compaction and bootstraps adaptive headroom from exact fixed overhead when opted in', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, {
      compactionMode: 'adaptive',
    });
    session.send('test prompt');

    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: 0.80,
        bufferExhaustionThreshold: 0.95,
      },
    }));
    expect(mockCreateSession.mock.calls[0]?.[0]).not.toHaveProperty('modelCapabilities');
    expect(mockStart.mock.invocationCallOrder[0]).toBeLessThan(mockListModels.mock.invocationCallOrder[0]!);
    expect(logger.info).toHaveBeenCalledWith('Resolved Copilot model prompt-token limit', {
      model: 'test-model',
      reportedPromptTokenLimit: 922_000,
      limitSource: 'max_prompt_tokens',
    });

    queueParentMeasurement(mock, {
      attributionTotalTokens: 100_000,
      recomputedTotalTokens: 80_000,
      messagesTokenCount: 50_000,
      systemTokenCount: 30_000,
      successfulCompactions: 0,
      promptTokenLimit: 922_000,
      toolDefinitionsTokens: 20_000,
    });
    await sendObservedParentRequest('req-bootstrap-attribution');

    expect(logger.info).toHaveBeenCalledWith(
      'Refreshed Copilot parent context before model request',
      expect.objectContaining({
        adaptiveCompactionHeadroom: 50_000,
        adaptiveCompactionThreshold: 872_000,
        adaptiveBootstrapSource: 'context-attribution',
        largestObservedInterRequestGrowth: 0,
      }),
    );
  });

  it('uses the first exact recomputation as bootstrap when attribution has no fixed overhead', async () => {
    mockListModels.mockResolvedValueOnce([{
      id: 'test-model',
      name: 'Test Model',
      capabilities: {
        supports: { vision: false, reasoningEffort: true },
        limits: { max_context_window_tokens: 400_000 },
      },
    }]);
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, {
      compactionMode: 'adaptive',
    });
    session.send('test prompt');

    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    queueParentMeasurement(mock, {
      attributionTotalTokens: null,
      recomputedTotalTokens: 75_000,
      messagesTokenCount: 75_000,
      systemTokenCount: 0,
      successfulCompactions: 0,
      promptTokenLimit: 400_000,
      toolDefinitionsTokens: 0,
    });
    await sendObservedParentRequest('req-bootstrap-recomputation');

    expect(logger.info).toHaveBeenCalledWith(
      'Refreshed Copilot parent context before model request',
      expect.objectContaining({
        adaptiveCompactionHeadroom: 75_000,
        adaptiveCompactionThreshold: 325_000,
        adaptiveBootstrapSource: 'first-recomputed-request',
      }),
    );
  });

  it('uses the reduced infinite-session thresholds only in aggressive mode', async () => {
    const { session } = await createTestSession({}, { compactionMode: 'aggressive' });
    session.send('test prompt');

    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: 0.60,
        bufferExhaustionThreshold: 0.75,
      },
    }));
    expect(mockCreateSession.mock.calls[0]?.[0]).not.toHaveProperty('modelCapabilities');
  });

  it('widens headroom by the largest observed inter-request growth', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    const handler = mockClientConfig?.requestHandler as {
      sendRequest(request: Request, context: Record<string, unknown>): Promise<Response>;
    };
    mock.rpc.metadata.contextInfo
      .mockResolvedValueOnce({
        contextInfo: {
          totalTokens: 100_000,
          promptTokenLimit: 922_000,
          systemTokens: 30_000,
          conversationTokens: 50_000,
          toolDefinitionsTokens: 20_000,
        },
      })
      .mockResolvedValueOnce({
        contextInfo: {
          totalTokens: 220_000,
          promptTokenLimit: 922_000,
          systemTokens: 30_000,
          conversationTokens: 170_000,
          toolDefinitionsTokens: 20_000,
        },
      });

    await handler.sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      { requestId: 'req-1', sessionId: 'session-1', interactionType: 'conversation-agent' },
    );
    await handler.sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      { requestId: 'req-2', sessionId: 'session-1', interactionType: 'conversation-agent' },
    );

    expect(logger.info).toHaveBeenCalledWith(
      'Refreshed Copilot parent context before model request',
      expect.objectContaining({
        previousRequestTokens: 100_000,
        observedInterRequestGrowth: 120_000,
        adaptiveBootstrapHeadroom: 50_000,
        largestObservedInterRequestGrowth: 120_000,
        adaptiveCompactionHeadroom: 170_000,
        adaptiveCompactionThreshold: 752_000,
      }),
    );
  });

  it('does not invent an adaptive ceiling from early usage before exact diagnostics exist', async () => {
    mockEarlyEvents.push({
      type: 'session.usage_info',
      data: {
        currentTokens: 280_000,
        tokenLimit: 300_000,
        messagesLength: 6,
        systemTokens: 20_000,
        conversationTokens: 255_000,
        toolDefinitionsTokens: 5_000,
      },
    });

    const { session, mock } = await createTestSession({}, {
      compactionMode: 'adaptive',
    });
    session.send('test prompt');

    await vi.waitFor(() => expect(mock.send).toHaveBeenCalledOnce());
    expect(mock.rpc.history.compact).not.toHaveBeenCalled();
  });

  it('proactively compacts parent usage that crosses the adaptive ceiling', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    mock.rpc.history.compact.mockResolvedValueOnce({
      success: true,
      tokensRemoved: 130_000,
      messagesRemoved: 3,
    });
    session.send('test prompt');
    await vi.waitFor(() => expect(mock.send).toHaveBeenCalledOnce());

    mock._emit('session.usage_info', {
      currentTokens: 100_000,
      tokenLimit: 300_000,
      messagesLength: 6,
      systemTokens: 20_000,
      conversationTokens: 75_000,
      toolDefinitionsTokens: 5_000,
    });
    queueParentMeasurement(mock, {
      attributionTotalTokens: 100_000,
      recomputedTotalTokens: 95_000,
      messagesTokenCount: 75_000,
      systemTokenCount: 20_000,
      successfulCompactions: 0,
      promptTokenLimit: 300_000,
      toolDefinitionsTokens: 5_000,
    });
    await sendObservedParentRequest('req-establish-policy');

    queueContextDiagnostics(mock, {
      attributionTotalTokens: 280_000,
      recomputedTotalTokens: 275_000,
      messagesTokenCount: 255_000,
      systemTokenCount: 20_000,
      successfulCompactions: 0,
    });
    queueParentMeasurement(mock, {
      attributionTotalTokens: 150_000,
      recomputedTotalTokens: 145_000,
      messagesTokenCount: 125_000,
      systemTokenCount: 20_000,
      successfulCompactions: 1,
      promptTokenLimit: 300_000,
      toolDefinitionsTokens: 5_000,
    });
    mock._emit('session.usage_info', {
      currentTokens: 280_000,
      tokenLimit: 300_000,
      messagesLength: 6,
      systemTokens: 20_000,
      conversationTokens: 255_000,
      toolDefinitionsTokens: 5_000,
    });

    await vi.waitFor(() => expect(mock.rpc.history.compact).toHaveBeenCalledOnce());
    expect(logger.info).toHaveBeenCalledWith(
      'Verified Copilot parent context compaction',
      expect.objectContaining({
        source: 'usage-threshold',
        beforeTokens: 275_000,
        afterTokens: 145_000,
        beforeSuccessfulCompactions: 0,
        afterSuccessfulCompactions: 1,
        tokensRemoved: 130_000,
        messagesRemoved: 3,
        messagesLength: 6,
        adaptiveCompactionThreshold: 275_000,
        adaptiveCompactionHeadroom: 25_000,
      }),
    );
  });

  it('surfaces a terminal error when exact diagnostics show no compaction reduction', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    mock.rpc.history.compact.mockResolvedValueOnce({
      success: true,
      tokensRemoved: 0,
      messagesRemoved: 0,
    });
    session.send('test prompt');
    await vi.waitFor(() => expect(mock.send).toHaveBeenCalledOnce());

    mock._emit('session.usage_info', {
      currentTokens: 100_000,
      tokenLimit: 300_000,
      messagesLength: 6,
      systemTokens: 20_000,
      conversationTokens: 75_000,
      toolDefinitionsTokens: 5_000,
    });
    queueParentMeasurement(mock, {
      attributionTotalTokens: 100_000,
      recomputedTotalTokens: 95_000,
      messagesTokenCount: 75_000,
      systemTokenCount: 20_000,
      successfulCompactions: 0,
      promptTokenLimit: 300_000,
      toolDefinitionsTokens: 5_000,
    });
    await sendObservedParentRequest('req-establish-noop-policy');

    queueContextDiagnostics(mock, {
      attributionTotalTokens: 280_000,
      recomputedTotalTokens: 275_000,
      messagesTokenCount: 255_000,
      systemTokenCount: 20_000,
      successfulCompactions: 0,
    });
    queueParentMeasurement(mock, {
      attributionTotalTokens: 280_000,
      recomputedTotalTokens: 275_000,
      messagesTokenCount: 255_000,
      systemTokenCount: 20_000,
      successfulCompactions: 1,
      promptTokenLimit: 300_000,
      toolDefinitionsTokens: 5_000,
    });
    mock._emit('session.usage_info', {
      currentTokens: 280_000,
      tokenLimit: 300_000,
      messagesLength: 6,
      systemTokens: 20_000,
      conversationTokens: 255_000,
      toolDefinitionsTokens: 5_000,
    });

    await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce());
    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('currentTokens=280000, tokenLimit=300000, ceiling=275000, headroom=25000, tokensRemoved=0, messagesLength=6'),
    }));
    expect(logger.error).toHaveBeenCalledWith(
      'Copilot parent context could not be compacted safely',
      expect.objectContaining({
        reason: expect.stringContaining('exact token recomputation did not decrease'),
      }),
    );
  });

  it('diagnoses an oversized incoming message before futile compaction', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');
    await vi.waitFor(() => expect(mock.send).toHaveBeenCalledOnce());

    mock._emit('session.usage_info', {
      currentTokens: 100_000,
      tokenLimit: 922_000,
      messagesLength: 3,
      systemTokens: 10_000,
      conversationTokens: 85_000,
      toolDefinitionsTokens: 5_000,
    });
    queueParentMeasurement(mock, {
      attributionTotalTokens: 100_000,
      recomputedTotalTokens: 95_000,
      messagesTokenCount: 85_000,
      systemTokenCount: 10_000,
      successfulCompactions: 0,
      promptTokenLimit: 922_000,
      toolDefinitionsTokens: 5_000,
    });
    await sendObservedParentRequest('req-establish-oversized-policy');

    mock._emit('session.usage_info', {
      currentTokens: 910_000,
      tokenLimit: 922_000,
      messagesLength: 3,
    });

    await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce());
    expect(mock.rpc.history.compact).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Copilot parent context could not be compacted safely',
      expect.objectContaining({
        currentTokens: 910_000,
        messagesLength: 3,
        reason: expect.stringContaining('latest oversized context addition'),
      }),
    );
  });

  it('records child usage without driving parent compaction', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    session.send('test prompt');
    await vi.waitFor(() => expect(mock.send).toHaveBeenCalledOnce());

    mock._emit('session.usage_info', {
      currentTokens: 1_911_664,
      tokenLimit: 2_000_000,
      messagesLength: 20,
      systemTokens: 10_000,
      toolDefinitionsTokens: 5_000,
    }, 'child-1');

    expect(mock.rpc.history.compact).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Copilot sub-agent context usage',
      expect.objectContaining({ agentId: 'child-1', currentTokens: 1_911_664 }),
    );
  });

  it('records sub-agent totalTokens as cumulative consumption', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    session.send('test prompt');
    await vi.waitFor(() => expect(mock.send).toHaveBeenCalledOnce());

    mock._emit('subagent.completed', {
      agentName: 'research',
      agentDisplayName: 'Research',
      model: 'claude-sonnet-4.6',
      totalTokens: 1_911_664,
      totalToolCalls: 20,
      durationMs: 60_000,
    }, 'child-1');

    expect(logger.info).toHaveBeenCalledWith(
      'Copilot sub-agent cumulative token consumption',
      {
        agentName: 'research',
        model: 'claude-sonnet-4.6',
        cumulativeTokensConsumed: 1_911_664,
        totalToolCalls: 20,
        durationMs: 60_000,
      },
    );
  });

  it('leaves model-issued sub-agent dispatch enabled by default', async () => {
    const { session } = await createTestSession();
    session.send('test prompt');

    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    expect(mockCreateSession.mock.calls[0]?.[0]).not.toHaveProperty('excludedTools');
  });

  it('disables task dispatch when sub-agents are explicitly disabled', async () => {
    const { session } = await createTestSession({ subagentsEnabled: false });
    session.send('test prompt');

    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      excludedTools: ['task'],
    }));
  });

  it('preserves caller exclusions while applying the explicit sub-agent off switch', async () => {
    const { session } = await createTestSession(
      { subagentsEnabled: false },
      { excludedTools: ['edit', 'task'] },
    );
    session.send('test prompt');

    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      excludedTools: ['edit', 'task'],
    }));
  });

  it('rejects task permission requests while preserving approval for other tools', async () => {
    const { session } = await createTestSession({ subagentsEnabled: false });
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    const config = mockCreateSession.mock.calls[0]?.[0] as {
      readonly onPermissionRequest: (
        request: Record<string, unknown>,
        invocation: { readonly sessionId: string },
      ) => unknown;
    };
    expect(config.onPermissionRequest(
      { kind: 'custom-tool', toolName: 'task' },
      { sessionId: 'session-1' },
    )).toEqual({
      kind: 'reject',
      feedback: 'Model-issued sub-agent dispatch is disabled for this session.',
    });
    expect(config.onPermissionRequest(
      { kind: 'custom-tool', toolName: 'view' },
      { sessionId: 'session-1' },
    )).toEqual({});
  });

  it('permits capability discovery but blocks parent-scoped traffic before a session handle exists', async () => {
    let releaseSession!: () => void;
    mockCreateSession.mockImplementationOnce(() => new Promise((resolve) => {
      releaseSession = () => resolve(mockSdkSession);
    }));
    const { session } = await createTestSession();
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    const handler = mockClientConfig?.requestHandler as {
      sendRequest(request: Request, context: Record<string, unknown>): Promise<Response>;
    };

    await expect(handler.sendRequest(
      new NativeRequest('https://example.test/models', { method: 'GET' }),
      { requestId: 'req-control', interactionType: undefined },
    )).resolves.toMatchObject({ status: 204 });
    await expect(handler.sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      {
        requestId: 'req-parent-before-handle',
        sessionId: 'session-1',
        interactionType: 'conversation-agent',
      },
    )).rejects.toThrow('parent context headroom has not been restored');
    expect(mockForwardedRequests).toHaveLength(1);
    releaseSession();
    await vi.waitFor(() => expect(mockSdkSession.send).toHaveBeenCalledOnce());
  });

  it('tags and fingerprints normal, compaction, child, and retry requests', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    mock._emit('session.usage_info', {
      currentTokens: 100_000,
      tokenLimit: 922_000,
      messagesLength: 8,
      systemTokens: 10_000,
      conversationTokens: 85_000,
      toolDefinitionsTokens: 5_000,
    });
    mock.rpc.metadata.contextInfo.mockResolvedValue({
      contextInfo: {
        totalTokens: 101_000,
        promptTokenLimit: 922_000,
        systemTokens: 10_000,
        conversationTokens: 86_000,
        toolDefinitionsTokens: 5_000,
      },
    });
    const handler = mockClientConfig?.requestHandler as {
      sendRequest(request: Request, context: Record<string, unknown>): Promise<Response>;
      openWebSocket(context: Record<string, unknown>): Promise<unknown>;
    };
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'safe prompt' }] });
    await handler.sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body }),
      {
        requestId: 'req-normal',
        sessionId: 'session-1',
        agentId: 'session-1',
        interactionType: 'conversation-agent',
      },
    );
    await handler.sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      {
        requestId: 'req-compaction',
        sessionId: 'session-1',
        interactionType: 'conversation-compaction',
      },
    );
    await handler.openWebSocket({
      requestId: 'req-child',
      sessionId: 'session-1',
      agentId: 'child-1',
      parentAgentId: 'parent-1',
      interactionType: 'conversation-subagent',
    });
    mock._emit('assistant.turn_retry');
    await handler.sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      {
        requestId: 'req-retry',
        sessionId: 'session-1',
        agentId: 'session-1',
        interactionType: 'conversation-agent',
      },
    );

    expect(mockForwardedRequests).toHaveLength(3);
    expect(mockWebSocketContexts).toEqual([
      expect.objectContaining({ requestId: 'req-child', agentId: 'child-1' }),
    ]);
    const requestLogs = logger.info.mock.calls
      .filter(([message]) => message === 'Copilot model request dispatch')
      .map(([, fields]) => fields);
    expect(requestLogs).toEqual([
      expect.objectContaining({
        requestId: 'req-normal',
        sessionId: 'session-1',
        purpose: 'normal-turn',
        interactionType: 'conversation-agent',
        currentTokens: 101_000,
        observedRequestBodyBytes: new TextEncoder().encode(body).byteLength,
        observedRequestBodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        requestId: 'req-compaction',
        purpose: 'compaction',
        interactionType: 'conversation-compaction',
      }),
      expect.objectContaining({
        requestId: 'req-child',
        agentId: 'child-1',
        parentAgentId: 'parent-1',
        purpose: 'child',
        interactionType: 'conversation-subagent',
      }),
      expect.objectContaining({
        requestId: 'req-retry',
        purpose: 'retry',
        interactionType: 'conversation-agent',
      }),
    ]);
    expect(requestLogs[0]).not.toHaveProperty('observedRequestBodyTokens');
  });

  it('keeps child retries isolated from parent refresh and adaptive dispatch guards', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    mock.rpc.metadata.contextInfo.mockClear();
    mock._emit('assistant.turn_retry', {}, 'child-1');

    await observedRequestHandler().sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      {
        requestId: 'req-child-retry',
        sessionId: 'session-1',
        agentId: 'child-1',
        parentAgentId: 'session-1',
        interactionType: 'conversation-subagent',
      },
    );

    expect(mockForwardedRequests).toHaveLength(1);
    expect(mock.rpc.metadata.contextInfo).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Copilot model request dispatch',
      expect.objectContaining({
        requestId: 'req-child-retry',
        purpose: 'retry',
        agentId: 'child-1',
      }),
    );
  });

  it('does not consume a pending parent retry while classifying compaction traffic', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger });
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    mock._emit('session.usage_info', {
      currentTokens: 100_000,
      tokenLimit: 922_000,
      messagesLength: 8,
      systemTokens: 10_000,
      conversationTokens: 85_000,
      toolDefinitionsTokens: 5_000,
    });
    mock.rpc.metadata.contextInfo.mockResolvedValue({
      contextInfo: {
        totalTokens: 100_000,
        promptTokenLimit: 922_000,
        systemTokens: 10_000,
        conversationTokens: 85_000,
        toolDefinitionsTokens: 5_000,
      },
    });
    mock._emit('assistant.turn_retry');

    await observedRequestHandler().sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      {
        requestId: 'req-compaction-before-retry',
        sessionId: 'session-1',
        interactionType: 'conversation-compaction',
      },
    );
    await observedRequestHandler().sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      {
        requestId: 'req-retry-after-compaction',
        sessionId: 'session-1',
        agentId: 'session-1',
        interactionType: 'conversation-agent',
      },
    );

    const requestLogs = logger.info.mock.calls
      .filter(([message]) => message === 'Copilot model request dispatch')
      .map(([, fields]) => fields);
    expect(requestLogs).toEqual([
      expect.objectContaining({
        requestId: 'req-compaction-before-retry',
        purpose: 'compaction',
      }),
      expect.objectContaining({
        requestId: 'req-retry-after-compaction',
        purpose: 'retry',
      }),
    ]);
  });

  it('treats ambiguous distinct identifiers as guarded parent traffic', async () => {
    const { session, mock } = await createTestSession({}, { compactionMode: 'adaptive' });
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    mock.rpc.metadata.contextInfo.mockRejectedValueOnce(new Error('measurement failed'));

    await expect(observedRequestHandler().sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      {
        requestId: 'req-ambiguous-identifiers',
        sessionId: 'session-1',
        agentId: 'unscoped-agent',
        interactionType: 'conversation-agent',
      },
    )).rejects.toThrow('parent context headroom has not been restored');
    expect(mock.rpc.metadata.contextInfo).toHaveBeenCalledOnce();
    expect(mockForwardedRequests).toHaveLength(0);
  });

  it('treats incomplete parent provenance on compaction as guarded parent traffic', async () => {
    const { session, mock } = await createTestSession();
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    mock.rpc.metadata.contextInfo.mockResolvedValueOnce({
      contextInfo: {
        totalTokens: 944_213,
        promptTokenLimit: 922_000,
        systemTokens: 10_000,
        conversationTokens: 929_213,
        toolDefinitionsTokens: 5_000,
      },
    });

    await expect(observedRequestHandler().sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      {
        requestId: 'req-malformed-compaction-provenance',
        sessionId: 'session-1',
        parentAgentId: 'unexpected-parent',
        interactionType: 'conversation-compaction',
      },
    )).rejects.toThrow('parent context headroom has not been restored');
    expect(mock.rpc.metadata.contextInfo).toHaveBeenCalledOnce();
    expect(mockForwardedRequests).toHaveLength(0);
  });

  it('retains parent retry provenance when an attempted dispatch is blocked', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger });
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    mock._emit('session.usage_info', {
      currentTokens: 200_000,
      tokenLimit: 300_000,
      messagesLength: 8,
      systemTokens: 10_000,
      conversationTokens: 185_000,
      toolDefinitionsTokens: 5_000,
    });
    queueContextDiagnostics(mock, {
      attributionTotalTokens: 200_000,
      recomputedTotalTokens: 195_000,
      messagesTokenCount: 185_000,
      systemTokenCount: 10_000,
      successfulCompactions: 0,
    });
    mock._emit('session.compaction_start');
    queueContextDiagnostics(mock, {
      attributionTotalTokens: 100_000,
      recomputedTotalTokens: 95_000,
      messagesTokenCount: 85_000,
      systemTokenCount: 10_000,
      successfulCompactions: 1,
    });
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    mock.rpc.metadata.contextInfo.mockImplementationOnce(async () => {
      await verificationGate;
      return {
        contextInfo: {
          totalTokens: 100_000,
          promptTokenLimit: 300_000,
          systemTokens: 10_000,
          conversationTokens: 85_000,
          toolDefinitionsTokens: 5_000,
        },
      };
    });
    mock._emit('session.compaction_complete', { success: true });
    await vi.waitFor(() => expect(mock.rpc.metadata.contextInfo).toHaveBeenCalledOnce());
    mock._emit('assistant.turn_retry');

    await expect(sendObservedParentRequest('req-blocked-retry')).rejects.toThrow(
      'parent context headroom has not been restored',
    );
    releaseVerification();
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith(
      'Verified completed Copilot parent compaction',
      expect.any(Object),
    ));
    await sendObservedParentRequest('req-forwarded-retry');

    expect(logger.info).toHaveBeenCalledWith(
      'Copilot model request dispatch',
      expect.objectContaining({
        requestId: 'req-forwarded-retry',
        purpose: 'retry',
      }),
    );
  });

  it('blocks a known-oversize parent compaction request before provider dispatch', async () => {
    const { session, mock } = await createTestSession();
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    mock._emit('session.usage_info', {
      currentTokens: 944_213,
      tokenLimit: 922_000,
      messagesLength: 8,
      systemTokens: 10_000,
      conversationTokens: 929_213,
      toolDefinitionsTokens: 5_000,
    });
    mock.rpc.metadata.contextInfo.mockResolvedValueOnce({
      contextInfo: {
        totalTokens: 944_213,
        promptTokenLimit: 922_000,
        systemTokens: 10_000,
        conversationTokens: 929_213,
        toolDefinitionsTokens: 5_000,
      },
    });

    await expect(observedRequestHandler().sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      {
        requestId: 'req-oversize-compaction',
        sessionId: 'session-1',
        interactionType: 'conversation-compaction',
      },
    )).rejects.toThrow('parent context headroom has not been restored');
    expect(mock.rpc.metadata.contextInfo).toHaveBeenCalledOnce();
    expect(mockForwardedRequests).toHaveLength(0);
  });

  it('serializes concurrent adaptive parent measurements without sharing failed accounting', async () => {
    const { session, mock } = await createTestSession({}, { compactionMode: 'adaptive' });
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    let releaseFirstMeasurement!: () => void;
    const firstMeasurementGate = new Promise<void>((resolve) => {
      releaseFirstMeasurement = resolve;
    });
    mock.rpc.metadata.contextInfo
      .mockImplementationOnce(async () => {
        await firstMeasurementGate;
        throw new Error('first measurement failed');
      })
      .mockResolvedValueOnce({
        contextInfo: {
          totalTokens: 100_000,
          promptTokenLimit: 922_000,
          systemTokens: 10_000,
          conversationTokens: 85_000,
          toolDefinitionsTokens: 5_000,
        },
      });

    const firstRequest = sendObservedParentRequest('req-concurrent-failed');
    const secondRequest = sendObservedParentRequest('req-concurrent-safe');
    await vi.waitFor(() => {
      expect(mock.rpc.metadata.contextInfo).toHaveBeenCalledTimes(1);
    });
    releaseFirstMeasurement();

    await expect(firstRequest).rejects.toThrow('parent context headroom has not been restored');
    await expect(secondRequest).resolves.toMatchObject({ status: 204 });
    expect(mock.rpc.metadata.contextInfo).toHaveBeenCalledTimes(2);
    expect(mockForwardedRequests).toHaveLength(1);
  });

  it('blocks a stock parent request when measured growth would exceed the live token limit', async () => {
    const { session, mock } = await createTestSession();
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    mock.rpc.metadata.contextInfo
      .mockResolvedValueOnce({
        contextInfo: {
          totalTokens: 600_000,
          promptTokenLimit: 922_000,
          systemTokens: 10_000,
          conversationTokens: 585_000,
          toolDefinitionsTokens: 5_000,
        },
      })
      .mockResolvedValueOnce({
        contextInfo: {
          totalTokens: 800_000,
          promptTokenLimit: 922_000,
          systemTokens: 10_000,
          conversationTokens: 785_000,
          toolDefinitionsTokens: 5_000,
        },
      });

    await sendObservedParentRequest('req-stock-growth-baseline');
    mock._emit('session.usage_info', {
      currentTokens: 800_000,
      tokenLimit: 922_000,
      messagesLength: 8,
      systemTokens: 10_000,
      conversationTokens: 785_000,
      toolDefinitionsTokens: 5_000,
    });
    await expect(sendObservedParentRequest('req-stock-growth-overflow')).rejects.toThrow(
      'parent context headroom has not been restored',
    );
    expect(mockForwardedRequests).toHaveLength(1);
  });

  it('blocks an ordinary parent request when observed usage remains above the adaptive ceiling', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    mock._emit('session.usage_info', {
      currentTokens: 270_000,
      tokenLimit: 300_000,
      messagesLength: 3,
      systemTokens: 10_000,
      conversationTokens: 255_000,
      toolDefinitionsTokens: 5_000,
    });
    mock.rpc.metadata.contextInfo.mockResolvedValueOnce({
      contextInfo: {
        totalTokens: 290_000,
        promptTokenLimit: 300_000,
        systemTokens: 10_000,
        conversationTokens: 275_000,
        toolDefinitionsTokens: 5_000,
      },
    });
    const handler = mockClientConfig?.requestHandler as {
      sendRequest(request: Request, context: Record<string, unknown>): Promise<Response>;
    };
    await expect(handler.sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      {
        requestId: 'req-blocked',
        sessionId: 'session-1',
        interactionType: 'conversation-agent',
      },
    )).rejects.toThrow('parent context headroom has not been restored');
    expect(mockForwardedRequests).toHaveLength(0);
  });

  it('blocks an ordinary parent request when fresh context measurement fails', async () => {
    const { session, mock } = await createTestSession({}, {
      compactionMode: 'adaptive',
    });
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    mock._emit('session.usage_info', {
      currentTokens: 100_000,
      tokenLimit: 922_000,
      messagesLength: 8,
      systemTokens: 10_000,
      toolDefinitionsTokens: 5_000,
    });
    mock.rpc.metadata.contextInfo.mockRejectedValueOnce(new Error('context RPC unavailable'));
    const handler = mockClientConfig?.requestHandler as {
      sendRequest(request: Request, context: Record<string, unknown>): Promise<Response>;
    };

    await expect(handler.sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      {
        requestId: 'req-no-accounting',
        sessionId: 'session-1',
        interactionType: 'conversation-agent',
      },
    )).rejects.toThrow('parent context headroom has not been restored');
    expect(mockForwardedRequests).toHaveLength(0);
  });

  it('degrades safely when the selected model has malformed capabilities', async () => {
    mockListModels.mockResolvedValueOnce([{
      id: 'test-model',
      name: 'Test Model',
    } as MockModelInfo]);
    const logger = createMockLogger();
    const { session } = await createTestSession({ logger });
    session.send('test prompt');

    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalled());
    expect(mockCreateSession.mock.calls[0]?.[0]).not.toHaveProperty('modelCapabilities');
    expect(logger.warn).toHaveBeenCalledWith(
      'Copilot model capability lookup returned no usable token limit; awaiting runtime context accounting',
      {
        model: 'test-model',
        reason: 'invalid_limit',
        maxPromptTokens: undefined,
        maxContextWindowTokens: undefined,
      },
    );
  });

  it('does not substitute the context window for an invalid reported prompt limit', async () => {
    mockListModels.mockResolvedValueOnce([{
      id: 'test-model',
      name: 'Test Model',
      capabilities: {
        supports: { vision: false, reasoningEffort: true },
        limits: {
          max_prompt_tokens: 0,
          max_context_window_tokens: 400_000,
        },
      },
    }]);
    const logger = createMockLogger();
    const { session } = await createTestSession({ logger });
    session.send('test prompt');

    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalled());
    expect(mockCreateSession.mock.calls[0]?.[0]).not.toHaveProperty('modelCapabilities');
    expect(logger.warn).toHaveBeenCalledWith(
      'Copilot model capability lookup returned no usable token limit; awaiting runtime context accounting',
      {
        model: 'test-model',
        reason: 'invalid_limit',
        maxPromptTokens: 0,
        maxContextWindowTokens: 400_000,
      },
    );
  });

  it('creates sessions with SDK fallback compaction when model listing fails', async () => {
    mockListModels.mockRejectedValueOnce(new Error('models unavailable'));
    const logger = createMockLogger();
    const { session } = await createTestSession({ logger });
    session.send('test prompt');

    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalled());
    expect(mockCreateSession.mock.calls[0]?.[0]).not.toHaveProperty('modelCapabilities');
    expect(mockCreateSession.mock.calls[0]?.[0]).toMatchObject({
      infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: 0.80,
        bufferExhaustionThreshold: 0.95,
      },
    });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      'Copilot model capability discovery failed; awaiting runtime context accounting',
      { reason: 'list_models_failed', error: 'models unavailable' },
    );
  });

  it('creates sessions without an absolute ceiling when the model is absent', async () => {
    mockListModels.mockResolvedValueOnce([]);
    const logger = createMockLogger();
    const { session } = await createTestSession({ logger });
    session.send('test prompt');

    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalled());
    expect(mockCreateSession.mock.calls[0]?.[0]).not.toHaveProperty('modelCapabilities');
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      'Copilot model capability lookup failed; awaiting runtime context accounting',
      { model: 'test-model', reason: 'model_not_found' },
    );
  });

  it('lists models and logs resolution once across concurrent sessions on the same backend', async () => {
    let resolveModels!: (models: MockModelInfo[]) => void;
    mockListModels.mockReturnValueOnce(new Promise(resolve => { resolveModels = resolve; }));
    const logger = createMockLogger();
    const backend = new SdkBackend({ logger });
    const createConfig = (): SessionConfig => ({
      model: 'test-model',
      cwd: '.',
      addDirs: [],
      timeout: 3600,
      heartbeatTimeout: 120,
    });
    const first = await backend.createSession(createConfig());
    const second = await backend.createSession(createConfig());
    first.send('first prompt');
    second.send('second prompt');

    await vi.waitFor(() => expect(mockListModels).toHaveBeenCalledOnce());
    resolveModels([{
      id: 'test-model',
      name: 'Test Model',
      capabilities: {
        supports: { vision: false, reasoningEffort: true },
        limits: {
          max_prompt_tokens: 922_000,
          max_context_window_tokens: 1_050_000,
        },
      },
    }]);

    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledTimes(2));
    expect(mockStart).toHaveBeenCalledOnce();
    expect(mockListModels).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('logs a shared listing failure once across multiple sessions', async () => {
    mockListModels.mockRejectedValueOnce(new Error('models unavailable'));
    const logger = createMockLogger();
    const backend = new SdkBackend({ logger });
    const createConfig = (): SessionConfig => ({
      model: 'test-model',
      cwd: '.',
      addDirs: [],
      timeout: 3600,
      heartbeatTimeout: 120,
    });
    const first = await backend.createSession(createConfig());
    const second = await backend.createSession(createConfig());
    first.send('first prompt');
    second.send('second prompt');

    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledTimes(2));
    expect(mockStart).toHaveBeenCalledOnce();
    expect(mockListModels).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('forwards contextTier, thinkingBudget, and configDirectory to the SDK session config', async () => {
    const backend = new SdkBackend({ configDir: '/project', subagentRoster: false });
    await backend.createSession({
      model: 'test-model',
      contextTier: 'long_context',
      thinkingBudget: 'xhigh',
      cwd: '.',
      addDirs: [],
      timeout: 3600,
      heartbeatTimeout: 120,
    }).then(session => session.send('test prompt'));

    await vi.waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        contextTier: 'long_context',
        reasoningEffort: 'xhigh',
        configDirectory: '/project',
      }));
    });
  });

  it('resolves a fallback-chain env reference embedded in an MCP header', async () => {
    // The default GitHub header is `Bearer ${A|B|C}`. A matcher without the alternatives finds
    // no reference, leaves the value untouched, and ships the placeholder as a literal bearer
    // token: the server answers 401 and simply returns no tools, with nothing logged.
    vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GH_TOKEN', 'gh-token-value');

    const { session } = await createTestSession({}, {
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://example.test/mcp/',
          headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN|GITHUB_TOKEN|GH_TOKEN}' },
          tools: ['*'],
        },
      },
    });
    session.send('test prompt');

    await vi.waitFor(() => {
      const config = mockCreateSession.mock.calls.at(-1)?.[0] as {
        mcpServers?: Record<string, { headers?: Record<string, string> }>;
      };
      const authorization = config?.mcpServers?.remote?.headers?.Authorization;
      expect(authorization).toBe('Bearer gh-token-value');
      expect(authorization).not.toContain('${');
    });
  });

  it('merges backend MCP file servers with session servers, favoring the session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'condukt-mcp-'));
    const mcpConfigPath = join(directory, 'mcp.json');
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        fileOnly: { command: 'file-server' },
        shared: { command: 'file-version' },
      },
    }));

    try {
      const { session } = await createTestSession(
        { mcpConfigPath },
        {
          mcpServers: {
            shared: { command: 'session-version', tools: ['read'] },
            sessionOnly: { command: 'session-server' },
          },
        },
      );
      session.send('test prompt');

      await vi.waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
          mcpServers: {
            fileOnly: {
              type: 'local',
              command: 'file-server',
              tools: ['*'],
            },
            shared: {
              type: 'local',
              command: 'session-version',
              tools: ['read'],
            },
            sessionOnly: {
              type: 'local',
              command: 'session-server',
            },
          },
        }));
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not load backend MCP file servers when the session disables MCP', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'condukt-mcp-'));
    const mcpConfigPath = join(directory, 'mcp.json');
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: { configured: { command: 'file-server' } },
    }));

    try {
      const { session } = await createTestSession({ mcpConfigPath }, { mcpServers: false });
      session.send('test prompt');

      await vi.waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalled();
      });
      expect(mockCreateSession.mock.calls[0]?.[0]).not.toHaveProperty('mcpServers');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs an agent node when an MCP server reports a startup failure', async () => {
    const backend = new SdkBackend();
    const node = agent({
      model: 'test-model',
      mcpServers: {
        broken: {
          command: '__missing_mcp_executable__',
          tools: ['*'],
          timeout: 1_000,
        },
      },
      promptBuilder: () => 'test prompt',
    });
    const run = node(
      { dir: '.', params: {}, artifactPaths: {} },
      {
        executionId: 'mcp-failure',
        nodeId: 'agent',
        runtime: adaptCopilotBackend(backend),
        emitOutput: vi.fn(),
        signal: new AbortController().signal,
      },
    );

    await vi.waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        mcpServers: {
          broken: {
            type: 'local',
            command: '__missing_mcp_executable__',
            tools: ['*'],
            timeout: 1_000,
          },
        },
      }));
    });

    mockSdkSession._emit('session.mcp_server_status_changed', {
      serverName: 'broken',
      status: 'failed',
      error: 'spawn ENOENT',
    });
    mockSdkSession._emit('assistant.message', { content: 'done' });
    mockSdkSession._emit('session.idle');

    await expect(run).resolves.toMatchObject({ action: 'default' });
  });

  it('resolves MCP secrets from the environment without retaining placeholders', async () => {
    vi.stubEnv('CONDUKT_TEST_MCP_TOKEN', 'test-token');
    try {
      const backend = new SdkBackend();
      const session = await backend.createSession({
        model: 'test-model',
        cwd: '.',
        addDirs: [],
        timeout: 3600,
        heartbeatTimeout: 120,
        mcpServers: {
          remote: {
            type: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer ${CONDUKT_TEST_MCP_TOKEN}' },
          },
          local: {
            command: 'local-mcp',
            env: {
              TOKEN: '${CONDUKT_TEST_MCP_TOKEN}',
              MISSING: '${CONDUKT_MISSING_MCP_TOKEN}',
            },
          },
        },
      });
      session.send('test prompt');

      await vi.waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
          mcpServers: {
            remote: {
              type: 'http',
              url: 'https://example.test/mcp',
              headers: { Authorization: 'Bearer test-token' },
            },
            local: {
              type: 'local',
              command: 'local-mcp',
              env: { TOKEN: 'test-token' },
            },
          },
        }));
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('omits a GitHub authorization header when its environment token is absent', async () => {
    const previous = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    try {
      const backend = new SdkBackend();
      const session = await backend.createSession({
        model: 'test-model',
        cwd: '.',
        addDirs: [],
        timeout: 3600,
        heartbeatTimeout: 120,
        mcpServers: {
          github: {
            type: 'http',
            url: 'https://api.githubcopilot.com/mcp/',
            headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' },
          },
        },
      });
      session.send('test prompt');

      await vi.waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
          mcpServers: {
            github: {
              type: 'http',
              url: 'https://api.githubcopilot.com/mcp/',
              headers: undefined,
            },
          },
        }));
      });
    } finally {
      if (previous === undefined) delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
      else process.env.GITHUB_PERSONAL_ACCESS_TOKEN = previous;
    }
  });

  it('forwards subagent configuration to the SDK session', async () => {
    const backend = new SdkBackend();
    const session = await backend.createSession({
      model: 'test-model',
      cwd: '.',
      addDirs: [],
      timeout: 3600,
      heartbeatTimeout: 120,
      customAgents: [{
        name: 'worker',
        prompt: 'Do bounded work.',
        tools: [],
        model: 'cheap-model',
        mcpServers: {
          filtered: {
            command: 'filtered-server',
            tools: ['read'],
            timeout: 15_000,
          },
        },
      }],
      defaultAgent: { excludedTools: ['task'] },
      excludedBuiltinAgents: ['explore'],
    });
    session.send('test prompt');

    await vi.waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        customAgents: [{
          name: 'worker',
          prompt: 'Do bounded work.',
          tools: [],
          model: 'cheap-model',
          mcpServers: {
            filtered: {
              type: 'local',
              command: 'filtered-server',
              tools: ['read'],
              timeout: 15_000,
            },
          },
        }],
        defaultAgent: { excludedTools: ['task'] },
        excludedBuiltinAgents: ['explore'],
      }));
    });
  });

  it('treats SDK 0.2 lifecycle events as informational without changing turn state', async () => {
    const { session, mock } = await createTestSession();
    const idleHandler = vi.fn();
    const errorHandler = vi.fn();
    session.on('idle', idleHandler);
    session.on('error', errorHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const type of [
      'session.skills_loaded', 'session.extensions_loaded', 'agent_completed', 'agent_idle',
      'mcp.oauth_required', 'mcp.oauth_completed', 'command.execute', 'commands.changed',
      'shell_completed', 'shell_detached_completed', 'system.notification', 'blob',
    ]) mock._emit(type);

    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('Unhandled event'));
    expect(idleHandler).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();
    mock._emit('session.idle');
    expect(idleHandler).toHaveBeenCalledOnce();
    stderr.mockRestore();
  });

  it('deduplicates streamed text from assistant.message', async () => {
    const { session, mock } = await createTestSession();

    const textHandler = vi.fn();
    session.on('text', textHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    mock._emit('assistant.message_delta', { deltaContent: 'Hello ' });
    mock._emit('assistant.message_delta', { deltaContent: 'world' });
    mock._emit('assistant.message', { content: 'Hello world!' });

    expect(textHandler.mock.calls.map(([text]) => text)).toEqual(['Hello ', 'world', '!']);
  });

  it('deduplicates interleaved root and sub-agent streams independently', async () => {
    const { session, mock } = await createTestSession();
    const textHandler = vi.fn();
    session.on('text', textHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('assistant.message_delta', { deltaContent: 'root ', parentToolCallId: undefined });
    mock._emit('assistant.message_delta', { deltaContent: 'sub ', parentToolCallId: 'tc-parent-1' });
    mock._emit('assistant.message_delta', { deltaContent: 'text', parentToolCallId: undefined });
    mock._emit('assistant.message', { content: 'sub text!', parentToolCallId: 'tc-parent-1' });
    mock._emit('assistant.message', { content: 'root text!', parentToolCallId: undefined });

    expect(textHandler.mock.calls).toEqual([
      ['root ', undefined],
      ['sub ', 'tc-parent-1'],
      ['text', undefined],
      ['text!', 'tc-parent-1'],
      ['!', undefined],
    ]);
  });

  it('resets dedup state at send and terminal turn boundaries', async () => {
    const { session, mock } = await createTestSession();
    const textHandler = vi.fn();
    session.on('text', textHandler);
    session.send('first prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('assistant.message_delta', { deltaContent: 'same' });
    mock._emit('session.task_complete');

    const secondMock = createMockSdkSession();
    mockSdkSessions.push(secondMock);
    session.send('second prompt');
    await new Promise(r => setTimeout(r, 50));
    secondMock._emit('assistant.message', { content: 'same again' });
    secondMock._emit('assistant.message_delta', { deltaContent: 'stale' });
    secondMock._emit('session.task_complete');

    expect(textHandler.mock.calls.map(([text]) => text)).toEqual(['same', 'same again', 'stale']);
  });

  it('emits a final message without prior deltas and forgets its stream state', async () => {
    const { session, mock } = await createTestSession();
    const textHandler = vi.fn();
    session.on('text', textHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('assistant.message', { content: 'complete' });
    mock._emit('assistant.message', { content: 'complete again' });

    expect(textHandler.mock.calls.map(([text]) => text)).toEqual(['complete', 'complete again']);
  });

  it('keeps unfinished sub-agent delta state while another stream finalizes', async () => {
    const { session, mock } = await createTestSession();
    const textHandler = vi.fn();
    session.on('text', textHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('assistant.message_delta', { deltaContent: 'sub ', parentToolCallId: 'tc-parent-1' });
    mock._emit('assistant.message_delta', { deltaContent: 'root ' });
    mock._emit('assistant.message', { content: 'root done' });
    mock._emit('assistant.message', { content: 'sub done', parentToolCallId: 'tc-parent-1' });

    expect(textHandler.mock.calls).toEqual([
      ['sub ', 'tc-parent-1'],
      ['root ', undefined],
      ['done', undefined],
      ['done', 'tc-parent-1'],
    ]);
  });

  it('ignores stale abort and text events from a cleaned-up prior turn', async () => {
    vi.useFakeTimers();
    try {
      const secondMock = createMockSdkSession();
      mockSdkSessions.push(secondMock);
      const { session, mock: firstMock } = await createTestSession();
      const textHandler = vi.fn();
      const errorHandler = vi.fn();
      session.on('text', textHandler);
      session.on('error', errorHandler);

      session.send('first prompt');
      await vi.advanceTimersByTimeAsync(0);
      firstMock._emit('session.idle');
      session.send('second prompt');
      await vi.advanceTimersByTimeAsync(0);

      firstMock._emit('assistant.message_delta', { deltaContent: 'stale delta' });
      firstMock._emit('assistant.message', { content: 'stale final' });
      firstMock._emit('abort', { reason: 'remote_command' });
      secondMock._emit('assistant.message', { content: 'fresh' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(textHandler.mock.calls.map(([text]) => text)).toEqual(['fresh']);
      expect(errorHandler).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forces a stuck compaction through the SDK history API', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      mock._emit('session.compaction_start');
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

      expect(mock.rpc.history.compact).toHaveBeenCalledOnce();
      expect(mock.abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails immediately when the stuck-compaction recovery call is rejected', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      mock.rpc.history.compact.mockRejectedValueOnce(new Error('compact failed'));

      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      mock._emit('session.compaction_start');
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Compaction recovery request failed: compact failed',
      }));
      expect(mock.abort).toHaveBeenCalledOnce();
      expect(mock.send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('send after abort emits an error instead of silently hanging', async () => {
    const { session } = await createTestSession();
    const errorHandler = vi.fn();
    session.on('error', errorHandler);

    await session.abort();
    errorHandler.mockClear();
    session.send('must not run');

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ message: 'Session is aborted' }));
  });

  it('ignores a late old-session idle during the next send setup gap', async () => {
    const secondMock = createMockSdkSession();
    let resolveSecond!: (session: MockSdkSession) => void;
    const secondCreation = new Promise<MockSdkSession>(resolve => { resolveSecond = resolve; });
    mockCreateSession
      .mockResolvedValueOnce(mockSdkSession)
      .mockReturnValueOnce(secondCreation);

    const { session, mock: firstMock } = await createTestSession();
    const idleHandler = vi.fn();
    session.on('idle', idleHandler);
    session.send('first prompt');
    await new Promise(r => setTimeout(r, 50));
    firstMock._emit('session.idle');
    expect(idleHandler).toHaveBeenCalledOnce();

    session.send('second prompt');
    firstMock._emit('session.idle');
    resolveSecond(secondMock);
    await new Promise(r => setTimeout(r, 50));
    secondMock._emit('session.idle');

    expect(idleHandler).toHaveBeenCalledTimes(2);
  });

  it('cleans up the SDK client when SDK session creation fails', async () => {
    mockCreateSession.mockRejectedValueOnce(new Error('creation failed'));
    const { session } = await createTestSession();
    const errorHandler = vi.fn();
    session.on('error', errorHandler);

    session.send('test prompt');

    await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mockStop).toHaveBeenCalledOnce());
    expect(mockForceStop).toHaveBeenCalledOnce();
  });

  it('clears timers and emits one error when SDK send rejects asynchronously', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      mock.send.mockRejectedValueOnce(new Error('send failed'));

      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ message: 'send failed' }));

      await vi.advanceTimersByTimeAsync(3600 * 1000);
      expect(errorHandler).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears unfinished tool state before the next turn', async () => {
    const secondMock = createMockSdkSession();
    mockSdkSessions.push(secondMock);
    const { session, mock: firstMock } = await createTestSession();
    const toolOutputHandler = vi.fn();
    session.on('tool_output', toolOutputHandler);
    session.send('first prompt');
    await new Promise(r => setTimeout(r, 50));

    firstMock._emit('tool.execution_start', {
      toolName: 'Bash', toolCallId: 'reused-id', arguments: {}, parentToolCallId: 'old-parent',
    });
    firstMock._emit('session.idle');
    session.send('second prompt');
    await new Promise(r => setTimeout(r, 50));
    secondMock._emit('tool.execution_partial_result', { toolCallId: 'reused-id', partialOutput: 'new output' });

    expect(toolOutputHandler).not.toHaveBeenCalled();
    secondMock._emit('tool.execution_start', {
      toolName: 'Read', toolCallId: 'reused-id', arguments: {}, parentToolCallId: 'new-parent',
    });
    expect(toolOutputHandler).toHaveBeenCalledWith('Read', 'new output', 'new-parent');
  });

  it('keeps an active session alive when only unknown events arrive', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { session, mock } = await createTestSession({}, { heartbeatTimeout: 2 });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      for (let eventCount = 0; eventCount < 6; eventCount += 1) {
        await vi.advanceTimersByTimeAsync(1500);
        mock._emit('future.progress');
      }

      expect(errorHandler).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Unknown event: future.progress'));
      mock._emit('session.idle');
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps a long model call alive from model.call_start events', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession({}, { heartbeatTimeout: 180 });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      for (let elapsedSeconds = 0; elapsedSeconds < 12 * 60; elapsedSeconds += 150) {
        await vi.advanceTimersByTimeAsync(150 * 1000);
        mock._emit('model.call_start');
      }

      expect(errorHandler).not.toHaveBeenCalled();
      mock._emit('session.idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails unknown failure-shaped events instead of hanging', async () => {
    const { session, mock } = await createTestSession();
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('future.transport_fatal', { failed: true, error: 'future failure' });

    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('future.transport_fatal'),
    }));
  });

  it('logs unknown agent-scoped failures without failing the parent', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const logger = createMockLogger();
      const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await new Promise(r => setTimeout(r, 50));

      mock._emit('future.transport_fatal', {
        failed: true, error: 'future child failure',
      }, 'bg-child-1');

      expect(errorHandler).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Copilot sub-agent failed; parent session remains active',
        expect.objectContaining({
          agentId: 'bg-child-1',
          eventType: 'future.transport_fatal',
          reason: 'future child failure',
        }),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('still fails terminal events immediately after liveness resets', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession({}, { heartbeatTimeout: 2 });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1500);

      mock._emit('model.call_failure', { errorMessage: 'upstream failed' });

      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('upstream failed'),
      }));
      await vi.advanceTimersByTimeAsync(2 * 1000);
      expect(errorHandler).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats error shutdown as terminal failure and routine shutdown as benign', async () => {
    const { session, mock } = await createTestSession();
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('session.shutdown', { shutdownType: 'routine' });
    expect(errorHandler).not.toHaveBeenCalled();
    mock._emit('session.shutdown', { shutdownType: 'error', errorReason: 'CLI crashed' });
    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ message: 'CLI crashed' }));
  });

  it('applies headless policies to pending requests', async () => {
    const { session, mock } = await createTestSession();
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('sampling.requested', { requestId: 'sampling-1' });
    mock._emit('auto_mode_switch.requested', { requestId: 'switch-1' });
    mock._emit('session_limits_exhausted.requested', { requestId: 'limit-1' });
    mock._emit('mcp.headers_refresh_required', { requestId: 'headers-1' });
    await vi.waitFor(() => {
      expect(mock.rpc.mcp.cancelSamplingExecution).toHaveBeenCalledWith({ requestId: 'sampling-1' });
      expect(mock.rpc.ui.handlePendingAutoModeSwitch).toHaveBeenCalledWith({
        requestId: 'switch-1', response: 'yes',
      });
      expect(mock.rpc.ui.handlePendingSessionLimitsExhausted).toHaveBeenCalledWith({
        requestId: 'limit-1', response: { action: 'cancel' },
      });
    });
  });

  it('logs an agent-scoped session error and keeps the parent session alive', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const logger = createMockLogger();
      const { session, mock } = await createTestSession({ logger }, { heartbeatTimeout: 2 });
      const errorHandler = vi.fn();
      const textHandler = vi.fn();
      session.on('error', errorHandler);
      session.on('text', textHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('session.error', {
        message: 'child context is full', errorType: 'context_limit', statusCode: 400,
      }, 'bg-child-1');

      expect(errorHandler).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Copilot sub-agent failed; parent session remains active',
        {
          agentId: 'bg-child-1',
          eventType: 'session.error',
          reason: 'child context is full',
          errorType: 'context_limit',
        },
      );
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
        'AGENT-SCOPED FAILURE agentId=bg-child-1 event=session.error reason=child context is full',
      ));

      mock._emit('assistant.message', { content: 'parent continued' });
      expect(textHandler).toHaveBeenCalledWith('parent continued', undefined);

      await vi.advanceTimersByTimeAsync(2 * 1000);
      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('heartbeat timeout'),
      }));
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fails a session-scoped session error immediately', async () => {
    const { session, mock } = await createTestSession();
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('session.error', {
      message: 'authentication failed', errorType: 'authentication', statusCode: 401,
    });

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
      message: 'authentication failed',
    }));
  });

  it('does not settle the parent from agent-scoped terminal-success events', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession({}, { heartbeatTimeout: 2 });
      const idleHandler = vi.fn();
      const errorHandler = vi.fn();
      session.on('idle', idleHandler);
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('session.idle', {}, 'bg-child-1');
      mock._emit('session.task_complete', {}, 'bg-child-1');

      expect(idleHandler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2 * 1000);
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('heartbeat timeout'),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets eligible auto-switch errors reach the pending switch policy', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('session.error', {
      message: 'rate limited', errorType: 'rate_limit', eligibleForAutoSwitch: true,
    });
    mock._emit('auto_mode_switch.requested', { requestId: 'switch-rate-limit' });

    expect(errorHandler).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mock.rpc.ui.handlePendingAutoModeSwitch).toHaveBeenCalledWith({
        requestId: 'switch-rate-limit', response: 'yes',
      });
    });
  });

  it('keeps the auto-switch exemption agent-scoped and loud', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const logger = createMockLogger();
      const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await new Promise(r => setTimeout(r, 50));

      mock._emit('session.error', {
        message: 'child rate limited', errorType: 'rate_limit', eligibleForAutoSwitch: true,
      }, 'bg-child-1');

      expect(errorHandler).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Copilot sub-agent failed; parent session remains active',
        expect.objectContaining({ agentId: 'bg-child-1', reason: 'child rate limited' }),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('treats custom_agents_updated as benign and omits binary payload logging', async () => {
    const { session, mock } = await createTestSession();
    const errorHandler = vi.fn();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    session.on('error', errorHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('session.custom_agents_updated', { agents: [] });
    mock._emit('session.binary_asset', { data: 'x'.repeat(10_000) });

    expect(errorHandler).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('x'.repeat(100)));
    stderr.mockRestore();
  });

  it('uses real top-level event names rather than phantom nested discriminators', async () => {
    const { session, mock } = await createTestSession();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('system.notification', { kind: { type: 'agent_idle' } });
    mock._emit('assistant.tool_call_delta', { inputDelta: '{}' });

    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('Unknown event'));
    stderr.mockRestore();
  });

  it('parentToolCallId forwarded from assistant.message', async () => {
    const { session, mock } = await createTestSession();

    const textHandler = vi.fn();
    session.on('text', textHandler);
    session.send('test prompt');

    // Wait for async _run to set up handlers
    await new Promise(r => setTimeout(r, 50));

    mock._emit('assistant.message', {
      content: 'Hello from sub-agent',
      parentToolCallId: 'tc-parent-1',
    });

    expect(textHandler).toHaveBeenCalledWith('Hello from sub-agent', 'tc-parent-1');
  });

  it('parentToolCallId forwarded from tool.execution_start', async () => {
    const { session, mock } = await createTestSession();

    const toolStartHandler = vi.fn();
    session.on('tool_start', toolStartHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    mock._emit('tool.execution_start', {
      toolName: 'Read',
      toolCallId: 'tc-1',
      arguments: { file_path: 'src/app.ts' },
      parentToolCallId: 'tc-parent-1',
    });

    expect(toolStartHandler).toHaveBeenCalledWith(
      'Read',
      expect.any(String),
      expect.objectContaining({ file_path: 'src/app.ts' }),
      'tc-1',
      'tc-parent-1',
    );
  });

  it('_callIdToParent map populated from tool.execution_start for partial_result lookups', async () => {
    const { session, mock } = await createTestSession();

    const toolOutputHandler = vi.fn();
    session.on('tool_output', toolOutputHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    // Start a tool with parentToolCallId
    mock._emit('tool.execution_start', {
      toolName: 'Bash',
      toolCallId: 'tc-child-1',
      arguments: { command: 'npm test' },
      parentToolCallId: 'tc-parent-1',
    });

    // Partial result arrives — should look up parentToolCallId from the map
    mock._emit('tool.execution_partial_result', {
      toolCallId: 'tc-child-1',
      partialOutput: 'test output line',
    });

    expect(toolOutputHandler).toHaveBeenCalledWith('Bash', 'test output line', 'tc-parent-1');
  });

  it('subagent.started extracts toolCallId as named field', async () => {
    const { session, mock } = await createTestSession();

    const subagentStartHandler = vi.fn();
    session.on('subagent_start', subagentStartHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    mock._emit('subagent.started', {
      agentName: 'reviewer',
      agentDisplayName: 'Code Reviewer',
      toolCallId: 'tc-sa-1',
    });

    expect(subagentStartHandler).toHaveBeenCalledWith(
      'Code Reviewer',
      expect.objectContaining({ toolCallId: 'tc-sa-1' }),
    );
  });

  it('subagent.started does NOT emit synthetic tool_start', async () => {
    const { session, mock } = await createTestSession();

    const toolStartHandler = vi.fn();
    session.on('tool_start', toolStartHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    mock._emit('subagent.started', {
      agentName: 'worker',
      toolCallId: 'tc-sa-1',
    });

    // No tool_start event should have been emitted for the sub-agent
    expect(toolStartHandler).not.toHaveBeenCalled();
  });

  it('model.call_failure emits error instead of hanging', async () => {
    const { session, mock } = await createTestSession();

    const errorHandler = vi.fn();
    const idleHandler = vi.fn();
    session.on('error', errorHandler);
    session.on('idle', idleHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    mock._emit('model.call_failure', {
      errorMessage: 'transient upstream failure',
      statusCode: 503,
      model: 'test-model',
      source: 'top_level',
    });

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('transient upstream failure'),
      statusCode: 503,
    }));
    expect(idleHandler).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mock.abort).toHaveBeenCalledOnce();
      expect(mock.disconnect).toHaveBeenCalledOnce();
    });
  });

  it('classifies compaction model rejection as a first-class terminal failure', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));
    mock._emit('session.usage_info', {
      currentTokens: 200_000,
      tokenLimit: 922_000,
      messagesLength: 8,
      systemTokens: 10_000,
      conversationTokens: 185_000,
      toolDefinitionsTokens: 5_000,
    });
    mock._emit('model.call_failure', {
      errorMessage: 'maximum prompt tokens exceeded',
      errorCode: 'model_max_prompt_tokens_exceeded',
      statusCode: 400,
      source: 'compaction',
      initiator: 'compaction',
    });

    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('HTTP 400'),
      errorCode: 'model_max_prompt_tokens_exceeded',
    }));
  });

  it('treats an explicit compaction completion failure as terminal', async () => {
    const { session, mock } = await createTestSession();
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));
    mock._emit('session.compaction_start');
    mock._emit('session.compaction_complete', {
      success: false,
      error: 'summary request rejected',
      statusCode: 400,
      requestId: 'provider-request-1',
    });

    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Compaction model call failed (HTTP 400): summary request rejected',
    }));
  });

  it('re-measures successful built-in compaction and continues after headroom is restored', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    const compactionHandler = vi.fn();
    const errorHandler = vi.fn();
    session.on('compaction', compactionHandler);
    session.on('error', errorHandler);
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    mock._emit('session.usage_info', {
      currentTokens: 270_000,
      tokenLimit: 300_000,
      messagesLength: 8,
      systemTokens: 10_000,
      conversationTokens: 255_000,
      toolDefinitionsTokens: 5_000,
    });
    expect(mock.rpc.history.compact).not.toHaveBeenCalled();
    queueContextDiagnostics(mock, {
      attributionTotalTokens: 280_000,
      recomputedTotalTokens: 275_000,
      messagesTokenCount: 265_000,
      systemTokenCount: 10_000,
      successfulCompactions: 0,
    });
    mock._emit('session.compaction_start');
    queueContextDiagnostics(mock, {
      attributionTotalTokens: 150_000,
      recomputedTotalTokens: 145_000,
      messagesTokenCount: 135_000,
      systemTokenCount: 10_000,
      successfulCompactions: 1,
    });

    let releasePostCompactionMeasurement!: () => void;
    const pendingPostCompactionMeasurement = new Promise<void>((resolve) => {
      releasePostCompactionMeasurement = resolve;
    });
    mock.rpc.metadata.contextInfo.mockImplementationOnce(async () => {
      await pendingPostCompactionMeasurement;
      return {
        contextInfo: {
          totalTokens: 150_000,
          promptTokenLimit: 300_000,
          systemTokens: 10_000,
          conversationTokens: 135_000,
          toolDefinitionsTokens: 5_000,
        },
      };
    });

    mock._emit('session.compaction_complete', {
      success: true,
      preCompactionTokens: 280_000,
      postCompactionTokens: 150_000,
      tokensRemoved: 130_000,
    });
    await vi.waitFor(() => expect(mock.rpc.metadata.contextInfo).toHaveBeenCalledTimes(1));
    await expect(observedRequestHandler().sendRequest(
      new NativeRequest('https://example.test/inference', { method: 'POST', body: '{}' }),
      {
        requestId: 'req-during-compaction-verification',
        sessionId: 'session-1',
        agentId: 'session-1',
        interactionType: 'conversation-agent',
      },
    )).rejects.toThrow('parent context headroom has not been restored');
    expect(mockForwardedRequests).toHaveLength(0);
    releasePostCompactionMeasurement();

    await vi.waitFor(() => expect(compactionHandler).toHaveBeenCalledWith(
      'complete',
      '275000 → 145000 exact tokens (compactions 0 → 1)',
    ));
    expect(errorHandler).not.toHaveBeenCalled();
    expect(mock.rpc.metadata.contextInfo).toHaveBeenCalledWith({
      promptTokenLimit: 300_000,
      outputTokenLimit: 0,
      selectedModel: 'test-model',
    });
    expect(logger.info).toHaveBeenCalledWith(
      'Verified completed Copilot parent compaction',
      expect.objectContaining({
        measuredPreCompactionTokens: 275_000,
        measuredPostCompactionTokens: 145_000,
        beforeSuccessfulCompactions: 0,
        afterSuccessfulCompactions: 1,
        adaptiveCompactionThreshold: 285_000,
        adaptiveCompactionHeadroom: 15_000,
      }),
    );
  });

  it('blocks ordinary parent dispatch while stock compaction is in progress', async () => {
    const { session, mock } = await createTestSession();
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    mock._emit('session.usage_info', {
      currentTokens: 200_000,
      tokenLimit: 300_000,
      messagesLength: 8,
      systemTokens: 10_000,
      conversationTokens: 185_000,
      toolDefinitionsTokens: 5_000,
    });
    queueContextDiagnostics(mock, {
      attributionTotalTokens: 200_000,
      recomputedTotalTokens: 195_000,
      messagesTokenCount: 185_000,
      systemTokenCount: 10_000,
      successfulCompactions: 0,
    });
    mock._emit('session.compaction_start');

    await expect(sendObservedParentRequest('req-during-stock-compaction')).rejects.toThrow(
      'parent context headroom has not been restored',
    );
    expect(mockForwardedRequests).toHaveLength(0);
  });

  it('does not let stale verification reopen dispatch for a newer compaction', async () => {
    const { session, mock } = await createTestSession();
    const compactionHandler = vi.fn();
    session.on('compaction', compactionHandler);
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    mock._emit('session.usage_info', {
      currentTokens: 220_000,
      tokenLimit: 300_000,
      messagesLength: 8,
      systemTokens: 10_000,
      conversationTokens: 205_000,
      toolDefinitionsTokens: 5_000,
    });

    queueContextDiagnostics(mock, {
      attributionTotalTokens: 220_000,
      recomputedTotalTokens: 215_000,
      messagesTokenCount: 205_000,
      systemTokenCount: 10_000,
      successfulCompactions: 0,
    });
    mock._emit('session.compaction_start');
    queueContextDiagnostics(mock, {
      attributionTotalTokens: 150_000,
      recomputedTotalTokens: 145_000,
      messagesTokenCount: 135_000,
      systemTokenCount: 10_000,
      successfulCompactions: 1,
    });
    let releaseFirstVerification!: () => void;
    const firstVerificationGate = new Promise<void>((resolve) => {
      releaseFirstVerification = resolve;
    });
    mock.rpc.metadata.contextInfo.mockImplementationOnce(async () => {
      await firstVerificationGate;
      return {
        contextInfo: {
          totalTokens: 150_000,
          promptTokenLimit: 300_000,
          systemTokens: 10_000,
          conversationTokens: 135_000,
          toolDefinitionsTokens: 5_000,
        },
      };
    });
    mock._emit('session.compaction_complete', { success: true });
    await vi.waitFor(() => expect(mock.rpc.metadata.contextInfo).toHaveBeenCalledTimes(1));

    queueContextDiagnostics(mock, {
      attributionTotalTokens: 150_000,
      recomputedTotalTokens: 145_000,
      messagesTokenCount: 135_000,
      systemTokenCount: 10_000,
      successfulCompactions: 1,
    });
    mock._emit('session.compaction_start');
    queueContextDiagnostics(mock, {
      attributionTotalTokens: 80_000,
      recomputedTotalTokens: 75_000,
      messagesTokenCount: 65_000,
      systemTokenCount: 10_000,
      successfulCompactions: 2,
    });
    let releaseSecondVerification!: () => void;
    const secondVerificationGate = new Promise<void>((resolve) => {
      releaseSecondVerification = resolve;
    });
    mock.rpc.metadata.contextInfo.mockImplementationOnce(async () => {
      await secondVerificationGate;
      return {
        contextInfo: {
          totalTokens: 80_000,
          promptTokenLimit: 300_000,
          systemTokens: 10_000,
          conversationTokens: 65_000,
          toolDefinitionsTokens: 5_000,
        },
      };
    });
    mock._emit('session.compaction_complete', { success: true });
    await vi.waitFor(() => expect(mock.rpc.metadata.contextInfo).toHaveBeenCalledTimes(2));

    releaseFirstVerification();
    await vi.waitFor(() => expect(compactionHandler).toHaveBeenCalledTimes(2));
    expect(compactionHandler).toHaveBeenNthCalledWith(1, 'start');
    expect(compactionHandler).toHaveBeenNthCalledWith(2, 'start');
    await expect(sendObservedParentRequest('req-before-newer-verification')).rejects.toThrow(
      'parent context headroom has not been restored',
    );
    expect(mockForwardedRequests).toHaveLength(0);

    releaseSecondVerification();
    await vi.waitFor(() => expect(compactionHandler).toHaveBeenCalledWith(
      'complete',
      '145000 → 75000 exact tokens (compactions 1 → 2)',
    ));
  });

  it('fails when built-in compaction does not restore adaptive headroom', async () => {
    const { session, mock } = await createTestSession({}, {
      compactionMode: 'adaptive',
    });
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    mock._emit('session.usage_info', {
      currentTokens: 270_000,
      tokenLimit: 300_000,
      messagesLength: 8,
      systemTokens: 10_000,
      conversationTokens: 255_000,
      toolDefinitionsTokens: 5_000,
    });
    expect(mock.rpc.history.compact).not.toHaveBeenCalled();
    queueContextDiagnostics(mock, {
      attributionTotalTokens: 280_000,
      recomputedTotalTokens: 275_000,
      messagesTokenCount: 265_000,
      systemTokenCount: 10_000,
      successfulCompactions: 0,
    });
    mock._emit('session.compaction_start');
    queueParentMeasurement(mock, {
      attributionTotalTokens: 290_000,
      recomputedTotalTokens: 285_000,
      messagesTokenCount: 275_000,
      systemTokenCount: 10_000,
      successfulCompactions: 1,
      promptTokenLimit: 300_000,
      toolDefinitionsTokens: 5_000,
    });

    mock._emit('session.compaction_complete', {
      success: true,
      preCompactionTokens: 280_000,
      postCompactionTokens: 290_000,
      tokensRemoved: 0,
    });

    await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('exact token recomputation did not decrease after compaction'),
    })));
  });

  it('fails when successful built-in compaction cannot be re-measured', async () => {
    const { session, mock } = await createTestSession();
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    mock._emit('session.usage_info', {
      currentTokens: 270_000,
      tokenLimit: 300_000,
      messagesLength: 8,
      systemTokens: 10_000,
      conversationTokens: 255_000,
      toolDefinitionsTokens: 5_000,
    });
    expect(mock.rpc.history.compact).not.toHaveBeenCalled();
    queueContextDiagnostics(mock, {
      attributionTotalTokens: 280_000,
      recomputedTotalTokens: 275_000,
      messagesTokenCount: 265_000,
      systemTokenCount: 10_000,
      successfulCompactions: 0,
    });
    mock._emit('session.compaction_start');
    mock.rpc.metadata.contextInfo.mockResolvedValueOnce({ contextInfo: null });

    mock._emit('session.compaction_complete', {
      success: true,
      preCompactionTokens: 280_000,
      postCompactionTokens: 150_000,
      tokensRemoved: 130_000,
    });

    await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('could not be verified with exact token recomputation and attribution counts'),
    })));
  });

  it('exposes typed metadata diagnostics and usage metrics', async () => {
    const { session, mock } = await createTestSession();
    const attribution = {
      totalTokens: 123_000,
      entries: [],
      compactions: { count: 2 },
    };
    const heaviestMessages = {
      totalTokens: 90_000,
      messages: [{ id: 'event-9', tokens: 40_000 }],
    };
    const recomputed = {
      totalTokens: 120_000,
      messagesTokenCount: 90_000,
      systemTokenCount: 30_000,
    };
    const metrics = { totalTokens: 456_000, compactions: 2 };
    mock.rpc.metadata.getContextAttribution.mockResolvedValueOnce({
      contextAttribution: attribution,
    });
    mock.rpc.metadata.getContextHeaviestMessages.mockResolvedValueOnce(heaviestMessages);
    mock.rpc.metadata.recomputeContextTokens.mockResolvedValueOnce(recomputed);
    mock.rpc.usage.getMetrics.mockResolvedValueOnce(metrics);
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    await expect(session.metadata?.getContextAttribution()).resolves.toEqual(attribution);
    await expect(session.metadata?.getContextHeaviestMessages(4)).resolves.toEqual(heaviestMessages);
    await expect(session.metadata?.recomputeContextTokens('alternate-model')).resolves.toEqual(recomputed);
    await expect(session.usage?.getMetrics()).resolves.toEqual(metrics);
    expect(mock.rpc.metadata.getContextHeaviestMessages).toHaveBeenCalledWith({ limit: 4 });
    expect(mock.rpc.metadata.recomputeContextTokens).toHaveBeenCalledWith({
      modelId: 'alternate-model',
    });
  });

  it('exposes native handoff summary and history truncation operations', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    mock.rpc.history.summarizeForHandoff.mockResolvedValueOnce({ summary: '# Handoff\nContext' });
    mock.rpc.history.truncate.mockResolvedValueOnce({ eventsRemoved: 7 });
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    await expect(session.history?.summarizeForHandoff()).resolves.toBe('# Handoff\nContext');
    await expect(session.history?.truncate('event-42')).resolves.toBe(7);
    expect(mock.rpc.history.truncate).toHaveBeenCalledWith({ eventId: 'event-42' });
    expect(logger.info).toHaveBeenCalledWith(
      'Copilot history handoff summary completed',
      { summaryLength: 17 },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Copilot history truncation completed',
      { eventId: 'event-42', eventsRemoved: 7 },
    );
  });

  it('preserves string status codes from model.call_failure', async () => {
    const { session, mock } = await createTestSession();
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));
    mock._emit('model.call_failure', {
      errorMessage: 'unauthorized',
      statusCode: '401',
    });

    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('HTTP 401'),
      statusCode: '401',
    }));
  });

  it('fails an abort-only turn after a short grace window', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('abort', { reason: 'remote_command' });
      await vi.advanceTimersByTimeAsync(999);
      expect(errorHandler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('remote_command'),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels abort failure when session.idle arrives during grace', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      const errorHandler = vi.fn();
      const idleHandler = vi.fn();
      session.on('error', errorHandler);
      session.on('idle', idleHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('abort', { reason: 'user_initiated' });
      mock._emit('session.idle');
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleHandler).toHaveBeenCalledOnce();
      expect(errorHandler).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['success true', { success: true }],
    ['success absent', {}],
  ])('session.task_complete with %s emits idle and cleans up', async (_label, data) => {
    const { session, mock } = await createTestSession();

    const idleHandler = vi.fn();
    session.on('idle', idleHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    mock._emit('session.task_complete', data);

    expect(idleHandler).toHaveBeenCalledOnce();
  });

  it('session.task_complete with success false leaves the session active and logs visibly', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger }, { compactionMode: 'adaptive' });
    const idleHandler = vi.fn();
    session.on('idle', idleHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    mock._emit('session.task_complete', { success: false, summary: 'invalid arguments' });

    expect(idleHandler).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Copilot task completion failed; session remains active',
      { eventType: 'session.task_complete', summary: 'invalid arguments' },
    );
    expect(stderr).toHaveBeenCalledWith(
      '[SdkBackend] TASK COMPLETION FAILED; session remains active\n',
    );

    mock._emit('session.task_complete', { success: true });
    expect(idleHandler).toHaveBeenCalledOnce();
    stderr.mockRestore();
  });

  it('session.task_complete is safe when session.idle also fires', async () => {
    const { session, mock } = await createTestSession();

    const idleHandler = vi.fn();
    session.on('idle', idleHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    // Both events fire — _cleanup() no-ops on second call
    mock._emit('session.task_complete');
    mock._emit('session.idle');

    expect(idleHandler).toHaveBeenCalledOnce();
  });

  it('content ?? detailedContent ordering matches spec', async () => {
    const { session, mock } = await createTestSession();

    const toolCompleteHandler = vi.fn();
    session.on('tool_complete', toolCompleteHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    // Pre-seed tool name mapping
    mock._emit('tool.execution_start', {
      toolName: 'Read',
      toolCallId: 'tc-1',
      arguments: {},
    });

    // Complete with both content and detailedContent — content should take precedence
    mock._emit('tool.execution_complete', {
      toolCallId: 'tc-1',
      result: {
        content: 'short result',
        detailedContent: 'verbose detailed result',
      },
    });

    expect(toolCompleteHandler).toHaveBeenCalledWith('Read', 'short result', 'tc-1', undefined);

    // Now test fallback to detailedContent when content is missing
    toolCompleteHandler.mockClear();

    mock._emit('tool.execution_start', {
      toolName: 'Grep',
      toolCallId: 'tc-2',
      arguments: {},
    });

    mock._emit('tool.execution_complete', {
      toolCallId: 'tc-2',
      result: {
        detailedContent: 'verbose fallback result',
      },
    });

    expect(toolCompleteHandler).toHaveBeenCalledWith('Grep', 'verbose fallback result', 'tc-2', undefined);
  });
});
