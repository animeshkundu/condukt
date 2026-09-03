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
import {
  classifySdkEvent,
  isSdkForwardProgress,
  KNOWN_SDK_EVENT_TYPES,
} from '../../runtimes/copilot/lifecycle-events';
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

interface MockSdkSession {
  sessionId: string;
  send: ReturnType<typeof vi.fn>;
  sendAndWait: ReturnType<typeof vi.fn>;
  getEvents: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  rpc: {
    sendMessages: ReturnType<typeof vi.fn>;
    mode: {
      set: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
    };
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
    sessionId: 'session-1',
    send: vi.fn().mockResolvedValue('message-1'),
    sendAndWait: vi.fn().mockResolvedValue({
      type: 'assistant.message',
      data: { content: 'advisor response' },
    }),
    getEvents: vi.fn().mockResolvedValue([]),
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    rpc: {
      sendMessages: vi.fn().mockResolvedValue({ messageIds: [] }),
      mode: {
        set: vi.fn().mockImplementation(async ({ mode }: { mode: string }) => {
          session.rpc.mode.get.mockResolvedValue(mode);
          return undefined;
        }),
        get: vi.fn().mockResolvedValue('autopilot'),
      },
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
let mockCreateSession: ReturnType<typeof vi.fn<(config: Record<string, unknown>) => Promise<MockSdkSession>>>;
let mockResumeSession: ReturnType<typeof vi.fn<(sessionId: string, config: Record<string, unknown>) => Promise<MockSdkSession>>>;
let mockStart: ReturnType<typeof vi.fn<() => Promise<void>>>;
let mockStop: ReturnType<typeof vi.fn<() => Promise<void>>>;
let mockForceStop: ReturnType<typeof vi.fn<() => Promise<void>>>;
let mockEarlyEvents: Array<{
  readonly type: string;
  readonly data?: Record<string, unknown>;
  readonly agentId?: string;
}>;
let originalFunction: typeof globalThis.Function;

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
  mockCreateSession = vi.fn<(config: Record<string, unknown>) => Promise<MockSdkSession>>()
    .mockImplementation(async (config) => {
      const session = mockSdkSessions.shift() ?? mockSdkSession;
      session.sessionId = typeof config.sessionId === 'string' ? config.sessionId : 'session-1';
      return session;
    });
  mockResumeSession = vi.fn<(sessionId: string, config: Record<string, unknown>) => Promise<MockSdkSession>>()
    .mockImplementation(async (sessionId) => {
      const session = mockSdkSessions.shift() ?? createMockSdkSession();
      session.sessionId = sessionId;
      return session;
    });
  mockStart = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  mockStop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  mockForceStop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  mockEarlyEvents = [{ type: 'session.start', data: { early: true } }];
  originalFunction = globalThis.Function;

  // Replace Function constructor so that when SdkBackend creates its dynamic import
  // function, we intercept and return our mock SDK module.
  const mockFunction = function (...args: string[]): Function {
    if (args.length === 2 && args[0] === 'specifier' && args[1] === 'return import(specifier)') {
      return () => Promise.resolve({
        RuntimeConnection: {
          forStdio: vi.fn(() => ({ kind: 'stdio' as const })),
        },
        CopilotClient: class MockCopilotClient {
          constructor(config: Record<string, unknown>) {
            mockClientConfig = config;
          }
          start() { return mockStart(); }
          async createSession(config: Record<string, unknown>) {
            const onEvent = config.onEvent as SdkEventHandler | undefined;
            for (const event of mockEarlyEvents) onEvent?.(event);
            return mockCreateSession(config);
          }
          resumeSession(sessionId: string, config: Record<string, unknown>) {
            return mockResumeSession(sessionId, config);
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
  it('uses native provider transport and runtime-selected infinite sessions', async () => {
    const { session } = await createTestSession();
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    expect(mockClientConfig).not.toHaveProperty('requestHandler');
    expect(mockCreateSession.mock.calls[0]?.[0]).not.toHaveProperty('infiniteSessions');
  });

  it('classifies every event in the authoritative installed SDK schema', () => {
    const eventTypes = authoritativeSdkEventTypes();
    const unclassified = eventTypes.filter(type => classifySdkEvent(type) === undefined);

    expect(unclassified).toEqual([]);
    expect(KNOWN_SDK_EVENT_TYPES).toEqual(new Set(eventTypes));
    for (const phantom of ['assistant.tool_call', 'blob', 'agent_completed', 'agent_idle', 'shell_completed', 'shell_detached_completed']) {
      expect(classifySdkEvent(phantom), phantom).toBeUndefined();
    }
  });
  it('registers the advisor tool only when configured', async () => {
    const withoutAdvisor = await createTestSession();
    withoutAdvisor.session.send('plain prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    expect(mockCreateSession.mock.calls[0]?.[0]).not.toHaveProperty('tools');

    mockCreateSession.mockClear();
    mockSdkSession = createMockSdkSession();
    mockSdkSessions = [mockSdkSession];
    const withAdvisor = await createTestSession({}, {
      advisor: { model: 'advisor-model' },
    });
    withAdvisor.session.send('advised prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    const config = mockCreateSession.mock.calls[0]?.[0];
    const tools = config?.tools as Array<{
      readonly name: string;
      readonly skipPermission?: boolean;
      readonly defer?: string;
    }> | undefined;
    expect(tools).toHaveLength(1);
    expect(tools?.[0]).toEqual(expect.objectContaining({
      name: 'advisor',
      skipPermission: true,
      defer: 'never',
    }));
  });

  it('creates a toolless non-recursive advisor session', async () => {
    const caller = createMockSdkSession();
    const advised = createMockSdkSession();
    caller.getEvents.mockResolvedValue([
      { type: 'user.message', data: { content: 'Review this approach' } },
      { type: 'assistant.message', data: { content: 'Proposed approach' } },
    ]);
    advised.sendAndWait.mockResolvedValue({
      type: 'assistant.message',
      data: { content: 'Change the approach' },
    });
    mockSdkSessions = [caller, advised];

    const { session } = await createTestSession({}, {
      advisor: {
        model: 'advisor-model',
        thinkingBudget: 'xhigh',
        contextTier: 'long_context',
      },
    });
    session.send('prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    const rootConfig = mockCreateSession.mock.calls[0]?.[0];
    const tool = (rootConfig?.tools as Array<{
      readonly handler: (args: { readonly context?: string }) => Promise<unknown>;
    }>)[0];

    await expect(tool.handler({ context: 'Focus on correctness.' }))
      .resolves.toBe('Change the approach');
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(mockCreateSession.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      model: 'advisor-model',
      reasoningEffort: 'xhigh',
      contextTier: 'long_context',
      tools: [],
      availableTools: [],
      excludedTools: ['task'],
      customAgents: [],
      mcpServers: {},
      enableConfigDiscovery: false,
    }));
    const advisorConfig = mockCreateSession.mock.calls[1]?.[0];
    expect(advisorConfig).not.toHaveProperty('advisor');
    expect(advisorConfig).not.toHaveProperty('subagentRoster');
    expect(advised.abort).toHaveBeenCalledOnce();
    expect(advised.disconnect).toHaveBeenCalledOnce();
    expect(caller.abort).not.toHaveBeenCalled();
  });

  it('drops the oldest transcript entries within the configured character budget', async () => {
    const caller = createMockSdkSession();
    const advised = createMockSdkSession();
    caller.getEvents.mockResolvedValue([
      { type: 'user.message', data: { content: `old-${'x'.repeat(40)}` } },
      { type: 'assistant.message', data: { content: `middle-${'y'.repeat(40)}` } },
      { type: 'user.message', data: { content: `new-${'z'.repeat(40)}` } },
    ]);
    mockSdkSessions = [caller, advised];

    const { session } = await createTestSession({}, {
      advisor: { model: 'advisor-model', maxTranscriptChars: 100 },
    });
    session.send('prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    const tool = (mockCreateSession.mock.calls[0]?.[0].tools as Array<{
      readonly handler: (args: {}) => Promise<unknown>;
    }>)[0];
    await tool.handler({});

    const advisorPrompt = advised.sendAndWait.mock.calls[0]?.[0].prompt as string;
    const transcript = advisorPrompt.split('CALLING SESSION TRANSCRIPT\n')[1] ?? '';
    expect(transcript.length).toBeLessThanOrEqual(100);
    expect(transcript).toContain('new-');
    expect(transcript).not.toContain('old-');
    expect(transcript).toMatch(/oldest transcript turns omitted/);
  });

  it('clips one oversized newest turn without claiming that it was omitted', async () => {
    const caller = createMockSdkSession();
    const advised = createMockSdkSession();
    caller.getEvents.mockResolvedValue([
      { type: 'user.message', data: { content: 'x'.repeat(200) } },
    ]);
    mockSdkSessions = [caller, advised];

    const { session } = await createTestSession({}, {
      advisor: { model: 'advisor-model', maxTranscriptChars: 80 },
    });
    session.send('prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    const tool = (mockCreateSession.mock.calls[0]?.[0].tools as Array<{
      readonly handler: (args: {}) => Promise<unknown>;
    }>)[0];
    await tool.handler({});

    const advisorPrompt = advised.sendAndWait.mock.calls[0]?.[0].prompt as string;
    const transcript = advisorPrompt.split('CALLING SESSION TRANSCRIPT\n')[1] ?? '';
    expect(transcript.length).toBeLessThanOrEqual(80);
    expect(transcript).toContain('Newest transcript turn clipped');
    expect(transcript).not.toContain('oldest transcript turns omitted');
  });

  it('returns a short string when the advisor handler fails', async () => {
    const caller = createMockSdkSession();
    caller.getEvents.mockRejectedValue(new Error('history lookup failed'));
    mockSdkSessions = [caller];

    const { session } = await createTestSession({}, {
      advisor: { model: 'advisor-model' },
    });
    session.send('prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    const tool = (mockCreateSession.mock.calls[0]?.[0].tools as Array<{
      readonly handler: (args: {}) => Promise<unknown>;
    }>)[0];

    await expect(tool.handler({})).resolves.toBe(
      'Advisor unavailable: history lookup failed',
    );
    expect(mockCreateSession).toHaveBeenCalledOnce();
  });

  it.each([
    { mode: undefined, expected: 'autopilot' },
    { mode: 'plan' as const, expected: 'plan' },
  ])('sets SDK mode to $expected', async ({ mode, expected }) => {
    const { session, mock } = await createTestSession({}, {
      ...(mode === undefined ? {} : { mode }),
    });
    session.send('root prompt');

    await vi.waitFor(() => {
      expect(mock.rpc.mode.set).toHaveBeenCalledWith({ mode: expected });
    });
  });

  it('confirms the effective mode after setting a required mode', async () => {
    const { session, mock } = await createTestSession({}, {
      mode: 'plan',
      requireMode: true,
    });
    session.send('root prompt');

    await vi.waitFor(() => {
      expect(mock.rpc.mode.set).toHaveBeenCalledWith({ mode: 'plan' });
      expect(mock.rpc.mode.get).toHaveBeenCalledOnce();
      expect(mock.send).toHaveBeenCalledOnce();
    });
  });

  it('fails required mode startup when the effective mode readback mismatches', async () => {
    const { session, mock: sdkSession } = await createTestSession({}, {
      mode: 'plan',
      requireMode: true,
    });
    sdkSession.rpc.mode.get.mockResolvedValueOnce('autopilot');
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('root prompt');

    await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce());
    expect(errorHandler.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      message: expect.stringContaining("Effective SDK session mode 'autopilot' does not match required mode 'plan'"),
    }));
    expect(sdkSession.send).not.toHaveBeenCalled();
    expect(sdkSession.abort).toHaveBeenCalledOnce();
    expect(sdkSession.disconnect).toHaveBeenCalledOnce();
  });

  it('fails required mode startup when effective mode readback throws', async () => {
    const { session, mock: sdkSession } = await createTestSession({}, {
      mode: 'plan',
      requireMode: true,
    });
    sdkSession.rpc.mode.get.mockRejectedValueOnce(new Error('mode readback unavailable'));
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('root prompt');

    await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce());
    expect(errorHandler.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      message: expect.stringContaining('mode readback unavailable'),
    }));
    expect(sdkSession.send).not.toHaveBeenCalled();
  });

  it('allows ordinary reads and read-only MCP while denying every write-capable operation', async () => {
    const { session } = await createTestSession({}, { permissionPolicy: 'read-only' });
    session.send('root prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    const config = mockCreateSession.mock.calls[0]?.[0] as {
      readonly onPermissionRequest: (request: Record<string, unknown>, invocation: { readonly sessionId: string }) => unknown;
    };
    const approved = [
      { kind: 'read', path: '/repo/file.ts' },
      { kind: 'mcp', toolName: 'list', readOnly: true },
    ] as const;
    for (const request of approved) {
      expect(config.onPermissionRequest(request, { sessionId: 'session-1' })).toEqual({
        kind: 'approve-once',
      });
    }

    const denied = [
      { kind: 'read', path: '/outside/file.ts', requestSandboxBypass: true },
      { kind: 'read', path: '/repo/file.ts', managedApprovalRequired: true },
      { kind: 'mcp', toolName: 'mutate', readOnly: false },
      { kind: 'mcp', toolName: 'unknown' },
      { kind: 'shell', fullCommandText: 'git status' },
      { kind: 'write', fileName: '/repo/file.ts' },
      { kind: 'custom-tool', toolName: 'helper' },
      { kind: 'hook', toolName: 'helper' },
      { kind: 'url', url: 'https://example.test' },
      { kind: 'memory', action: 'store' },
    ] as const;
    for (const request of denied) {
      expect(config.onPermissionRequest(request, { sessionId: 'session-1' })).toEqual({
        kind: 'reject',
        feedback: 'Permission denied by the read-only session policy.',
      });
    }
  });

  it('denies read-only MCP when the request omits the explicit readOnly marker', async () => {
    const { session } = await createTestSession({}, { permissionPolicy: 'read-only' });
    session.send('root prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    const config = mockCreateSession.mock.calls[0]?.[0] as {
      readonly onPermissionRequest: (request: Record<string, unknown>, invocation: { readonly sessionId: string }) => unknown;
    };
    expect(config.onPermissionRequest(
      { kind: 'mcp', toolName: 'search_code' },
      { sessionId: 'session-1' },
    )).toEqual({
      kind: 'reject',
      feedback: 'Permission denied by the read-only session policy.',
    });
  });

  it('denies a managed read request instead of bypassing the human approval boundary', async () => {
    const { session } = await createTestSession({}, { permissionPolicy: 'read-only' });
    session.send('root prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    const config = mockCreateSession.mock.calls[0]?.[0] as {
      readonly onPermissionRequest: (request: Record<string, unknown>, invocation: { readonly sessionId: string }) => unknown;
    };
    expect(config.onPermissionRequest(
      { kind: 'read', path: '/repo/file.ts', managedApprovalRequired: true },
      { sessionId: 'session-1' },
    )).toEqual({
      kind: 'reject',
      feedback: 'Permission denied by the read-only session policy.',
    });
  });

  it('does not approve read requests that request a sandbox bypass', async () => {
    const { session } = await createTestSession({}, { permissionPolicy: 'read-only' });
    session.send('root prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    const config = mockCreateSession.mock.calls[0]?.[0] as {
      readonly onPermissionRequest: (request: Record<string, unknown>, invocation: { readonly sessionId: string }) => unknown;
    };
    expect(config.onPermissionRequest(
      { kind: 'read', path: '/outside/file.ts', requestSandboxBypass: true },
      { sessionId: 'session-1' },
    )).toEqual({
      kind: 'reject',
      feedback: 'Permission denied by the read-only session policy.',
    });
  });

  it('fails required mode startup before sending the prompt when mode.set throws', async () => {
    const { session, mock: sdkSession } = await createTestSession({}, {
      mode: 'plan',
      requireMode: true,
    });
    sdkSession.rpc.mode.set.mockRejectedValueOnce(new Error('mode unsupported'));
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('root prompt');

    await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce());
    expect(errorHandler.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      message: expect.stringContaining("Required SDK session mode 'plan' could not be applied"),
    }));
    expect(sdkSession.send).not.toHaveBeenCalled();
    expect(sdkSession.abort).toHaveBeenCalledOnce();
    expect(sdkSession.disconnect).toHaveBeenCalledOnce();
  });

  it('fails required mode startup before sending the prompt on an explicit false result', async () => {
    const { session, mock: sdkSession } = await createTestSession({}, {
      mode: 'plan',
      requireMode: true,
    });
    sdkSession.rpc.mode.set.mockResolvedValueOnce({ success: false });
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('root prompt');

    await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce());
    expect(errorHandler.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      message: expect.stringContaining("Required SDK session mode 'plan' could not be applied"),
    }));
    expect(sdkSession.send).not.toHaveBeenCalled();
  });

  it('keeps mode startup best-effort by default when mode.set throws', async () => {
    const { session, mock: sdkSession } = await createTestSession({}, { mode: 'plan' });
    sdkSession.rpc.mode.set.mockRejectedValueOnce(new Error('mode unsupported'));
    session.send('root prompt');

    await vi.waitFor(() => expect(sdkSession.send).toHaveBeenCalledOnce());
  });

  it('registers the stand-in tool only when configured', async () => {
    const withoutStandIn = await createTestSession();
    withoutStandIn.session.send('plain prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    expect(mockCreateSession.mock.calls[0]?.[0]).not.toHaveProperty('tools');

    mockCreateSession.mockClear();
    mockSdkSession = createMockSdkSession();
    mockSdkSessions = [mockSdkSession];
    const withStandIn = await createTestSession({}, {
      standIn: { memberCount: 3 },
    });
    withStandIn.session.send('stand-in prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    const tools = mockCreateSession.mock.calls[0]?.[0].tools as Array<{
      readonly name: string;
      readonly skipPermission?: boolean;
      readonly defer?: string;
    }> | undefined;
    expect(tools).toHaveLength(1);
    expect(tools?.[0]).toEqual(expect.objectContaining({
      name: 'stand_in',
      skipPermission: true,
      defer: 'never',
    }));
  });

  it('creates toolless non-recursive stand-in voter sessions', async () => {
    const caller = createMockSdkSession();
    const children = Array.from({ length: 4 }, () => createMockSdkSession());
    const responses = [
      { ranking: ['A', 'B'], reasoning: 'blind A', needMoreInfo: false },
      { ranking: ['B', 'A'], reasoning: 'blind B', needMoreInfo: false },
      { ranking: ['A', 'B'], reasoning: 'informed A', needMoreInfo: false },
      { ranking: ['A', 'B'], reasoning: 'informed B', needMoreInfo: false },
    ];
    for (const [index, child] of children.entries()) {
      child.sendAndWait.mockResolvedValue({
        type: 'assistant.message',
        data: { content: JSON.stringify(responses[index]) },
      });
    }
    mockSdkSessions = [caller, ...children];

    const { session } = await createTestSession({}, {
      standIn: { members: ['gpt-5.6-sol', 'claude-opus-5'] },
    });
    session.send('root prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    const tool = (mockCreateSession.mock.calls[0]?.[0].tools as Array<{
      readonly name: string;
      readonly handler: (args: {
        readonly decision: string;
        readonly options: readonly { readonly id: string; readonly summary: string }[];
        readonly context: string;
      }) => Promise<unknown>;
    }>).find((candidate) => candidate.name === 'stand_in');
    if (tool === undefined) throw new Error('Stand-in tool was not registered');

    await tool.handler({
      decision: 'Choose a path',
      options: [{ id: 'A', summary: 'Alpha' }, { id: 'B', summary: 'Beta' }],
      context: 'Only supplied context',
    });

    expect(mockCreateSession).toHaveBeenCalledTimes(5);
    for (const [childConfig] of mockCreateSession.mock.calls.slice(1)) {
      expect(childConfig).toEqual(expect.objectContaining({
        tools: [],
        availableTools: [],
        excludedTools: ['task'],
        customAgents: [],
        mcpServers: {},
        enableConfigDiscovery: false,
      }));
      expect(childConfig).not.toHaveProperty('advisor');
      expect(childConfig).not.toHaveProperty('standIn');
      expect(childConfig).not.toHaveProperty('subagentRoster');
    }
  });

  it('passes only caller-supplied decision context into cold-start stand-in prompts', async () => {
    const caller = createMockSdkSession();
    caller.getEvents.mockResolvedValue([
      { type: 'user.message', data: { content: 'PRIVATE CALLER HISTORY SENTINEL' } },
    ]);
    const children = Array.from({ length: 4 }, () => createMockSdkSession());
    for (const [index, child] of children.entries()) {
      child.sendAndWait.mockResolvedValue({
        type: 'assistant.message',
        data: {
          content: JSON.stringify({
            ranking: ['keep', 'change'],
            reasoning: `member ${index}`,
            needMoreInfo: false,
          }),
        },
      });
    }
    mockSdkSessions = [caller, ...children];

    const { session } = await createTestSession({}, {
      standIn: { members: ['gpt-5.6-sol', 'claude-opus-5'] },
    });
    session.send('PRIVATE ROOT PROMPT SENTINEL');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    const tool = (mockCreateSession.mock.calls[0]?.[0].tools as Array<{
      readonly name: string;
      readonly handler: (args: {
        readonly decision: string;
        readonly options: readonly { readonly id: string; readonly summary: string }[];
        readonly context: string;
      }) => Promise<unknown>;
    }>).find((candidate) => candidate.name === 'stand_in');
    if (tool === undefined) throw new Error('Stand-in tool was not registered');

    await tool.handler({
      decision: 'Keep or change?',
      options: [
        { id: 'keep', summary: 'Keep the current design' },
        { id: 'change', summary: 'Change it' },
      ],
      context: 'PUBLIC STAND_IN CONTEXT SENTINEL',
    });

    expect(caller.getEvents).not.toHaveBeenCalled();
    for (const child of children) {
      const prompt = child.sendAndWait.mock.calls[0]?.[0].prompt as string;
      expect(prompt).toContain('Keep or change?');
      expect(prompt).toContain('Keep the current design');
      expect(prompt).toContain('PUBLIC STAND_IN CONTEXT SENTINEL');
      expect(prompt).not.toContain('PRIVATE CALLER HISTORY SENTINEL');
      expect(prompt).not.toContain('PRIVATE ROOT PROMPT SENTINEL');
    }
  });

  it.each([1, 7])('rejects an option count of %i with a message', async (optionCount) => {
    const caller = createMockSdkSession();
    mockSdkSessions = [caller];
    const { session } = await createTestSession({}, {
      standIn: { members: ['gpt-5.6-sol', 'claude-opus-5'] },
    });
    session.send('root prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    const tool = (mockCreateSession.mock.calls[0]?.[0].tools as Array<{
      readonly name: string;
      readonly handler: (args: {
        readonly decision: string;
        readonly options: readonly { readonly id: string; readonly summary: string }[];
        readonly context: string;
      }) => Promise<unknown>;
    }>).find((candidate) => candidate.name === 'stand_in');
    if (tool === undefined) throw new Error('Stand-in tool was not registered');
    const options = Array.from({ length: optionCount }, (_, index) => ({
      id: `option-${index}`,
      summary: `Option ${index}`,
    }));

    await expect(tool.handler({ decision: 'Choose', options, context: 'Context' }))
      .resolves.toMatch(/^Stand-in unavailable: options must contain between 2 and 6 items/);
    expect(mockCreateSession).toHaveBeenCalledOnce();
  });

  it('runs blind and informed stand-in rounds with anonymized first-round answers', async () => {
    const caller = createMockSdkSession();
    const children = Array.from({ length: 4 }, () => createMockSdkSession());
    const responses = [
      { ranking: ['A', 'B'], reasoning: 'blind-alpha', needMoreInfo: false },
      { ranking: ['B', 'A'], reasoning: 'blind-beta', needMoreInfo: false },
      { ranking: ['A', 'B'], reasoning: 'informed-alpha', needMoreInfo: false },
      { ranking: ['A', 'B'], reasoning: 'informed-beta', needMoreInfo: false },
    ];
    for (const [index, child] of children.entries()) {
      child.sendAndWait.mockResolvedValue({
        type: 'assistant.message',
        data: { content: JSON.stringify(responses[index]) },
      });
    }
    mockSdkSessions = [caller, ...children];

    const { session } = await createTestSession({}, {
      standIn: { members: ['gpt-5.6-sol', 'claude-opus-5'] },
    });
    session.send('root prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    const tool = (mockCreateSession.mock.calls[0]?.[0].tools as Array<{
      readonly name: string;
      readonly handler: (args: {
        readonly decision: string;
        readonly options: readonly { readonly id: string; readonly summary: string }[];
        readonly context: string;
      }) => Promise<unknown>;
    }>).find((candidate) => candidate.name === 'stand_in');
    if (tool === undefined) throw new Error('Stand-in tool was not registered');

    const output = await tool.handler({
      decision: 'Choose',
      options: [{ id: 'A', summary: 'Alpha' }, { id: 'B', summary: 'Beta' }],
      context: 'Context',
    });

    expect(children[0]?.sendAndWait).toHaveBeenCalledOnce();
    expect(children[1]?.sendAndWait).toHaveBeenCalledOnce();
    const informedPromptA = children[2]?.sendAndWait.mock.calls[0]?.[0].prompt as string;
    const informedPromptB = children[3]?.sendAndWait.mock.calls[0]?.[0].prompt as string;
    for (const prompt of [informedPromptA, informedPromptB]) {
      expect(prompt).toContain('blind-alpha');
      expect(prompt).toContain('blind-beta');
      expect(prompt).toContain('member-1');
      expect(prompt).toContain('member-2');
      expect(prompt).not.toContain('gpt-5.6-sol');
      expect(prompt).not.toContain('claude-opus-5');
    }
    expect(JSON.parse(String(output))).toEqual(expect.objectContaining({
      status: 'consensus',
      winningOptionId: 'A',
      members: expect.arrayContaining([
        expect.objectContaining({ reasoning: 'informed-alpha' }),
        expect.objectContaining({ reasoning: 'informed-beta' }),
      ]),
    }));
  });

  it('requires two successful members in each stand-in round', async () => {
    const caller = createMockSdkSession();
    const blindSuccess = createMockSdkSession();
    const blindFailure = createMockSdkSession();
    blindSuccess.sendAndWait.mockResolvedValue({
      type: 'assistant.message',
      data: {
        content: JSON.stringify({
          ranking: ['A', 'B'],
          reasoning: 'only survivor',
          needMoreInfo: false,
        }),
      },
    });
    blindFailure.sendAndWait.mockRejectedValue(new Error('blind failure'));
    mockSdkSessions = [caller, blindSuccess, blindFailure];

    const { session } = await createTestSession({}, {
      standIn: { members: ['gpt-5.6-sol', 'claude-opus-5'] },
    });
    session.send('root prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    const tool = (mockCreateSession.mock.calls[0]?.[0].tools as Array<{
      readonly name: string;
      readonly handler: (args: {
        readonly decision: string;
        readonly options: readonly { readonly id: string; readonly summary: string }[];
        readonly context: string;
      }) => Promise<unknown>;
    }>).find((candidate) => candidate.name === 'stand_in');
    if (tool === undefined) throw new Error('Stand-in tool was not registered');

    await expect(tool.handler({
      decision: 'Choose',
      options: [{ id: 'A', summary: 'Alpha' }, { id: 'B', summary: 'Beta' }],
      context: 'Context',
    })).resolves.toBe(
      'Stand-in unavailable: fewer than two blind-round members succeeded',
    );
    expect(mockCreateSession).toHaveBeenCalledTimes(3);
  });

  it('returns a bounded string when the stand-in handler fails', async () => {
    const caller = createMockSdkSession();
    const failedA = createMockSdkSession();
    const failedB = createMockSdkSession();
    failedA.sendAndWait.mockRejectedValue(new Error(`first failure ${'x'.repeat(500)}`));
    failedB.sendAndWait.mockRejectedValue(new Error('second failure'));
    mockSdkSessions = [caller, failedA, failedB];

    const { session } = await createTestSession({}, {
      standIn: { members: ['gpt-5.6-sol', 'claude-opus-5'] },
    });
    session.send('root prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    const tool = (mockCreateSession.mock.calls[0]?.[0].tools as Array<{
      readonly name: string;
      readonly handler: (args: {
        readonly decision: string;
        readonly options: readonly { readonly id: string; readonly summary: string }[];
        readonly context: string;
      }) => Promise<unknown>;
    }>).find((candidate) => candidate.name === 'stand_in');
    if (tool === undefined) throw new Error('Stand-in tool was not registered');

    const result = await tool.handler({
      decision: 'Choose',
      options: [{ id: 'A', summary: 'Alpha' }, { id: 'B', summary: 'Beta' }],
      context: 'Context',
    });

    expect(result).toMatch(/^Stand-in unavailable:/);
    expect(String(result).length).toBeLessThanOrEqual(260);
  });

  ;

  ;

  ;

  ;

  ;

  ;

  ;

  ;

  it('records child usage without driving parent compaction', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger });
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
    const { session, mock } = await createTestSession({ logger });
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

  ;

  ;

  ;

  ;

  ;

  ;

  ;

  ;

  ;

  ;

  ;

  ;

  ;

  ;

  ;

  ;

  ;

  ;

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

  it('forwards the SDK-only max thinking effort through SdkBackend', async () => {
    const backend = new SdkBackend({ subagentRoster: false });
    const thinkingBudget = 'max' as unknown as SessionConfig['thinkingBudget'];
    const session = await backend.createSession({
      model: 'test-model',
      thinkingBudget,
      cwd: '.',
      addDirs: [],
      timeout: 3600,
      heartbeatTimeout: 120,
    });
    session.send('test prompt');

    await vi.waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        reasoningEffort: 'max',
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

  it('uses the explicit MCP working directory for file servers when the session cwd is detached', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'condukt-mcp-'));
    const mcpConfigPath = join(directory, 'mcp.json');
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        fileOnly: { command: 'file-server' },
      },
    }));

    try {
      const { session } = await createTestSession(
        {
          mcpConfigPath,
          mcpServerWorkingDirectory: '/workspace/repository',
        },
        { cwd: '/detached/session' },
      );
      session.send('test prompt');

      await vi.waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
          mcpServers: {
            fileOnly: {
              type: 'local',
              command: 'file-server',
              tools: ['*'],
              workingDirectory: '/workspace/repository',
            },
          },
        }));
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves generic file MCP config when no working directory option is provided', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'condukt-mcp-'));
    const mcpConfigPath = join(directory, 'mcp.json');
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        generic: {
          command: 'file-server',
          args: ['--cwd', '/server/argument'],
        },
      },
    }));

    try {
      const { session } = await createTestSession(
        { mcpConfigPath },
        { cwd: '/detached/session' },
      );
      session.send('test prompt');

      await vi.waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
          mcpServers: {
            generic: {
              type: 'local',
              command: 'file-server',
              args: ['--cwd', '/server/argument'],
              tools: ['*'],
            },
          },
        }));
      });
      expect(mockCreateSession.mock.calls[0]?.[0]).not.toHaveProperty(
        'mcpServers.generic.workingDirectory',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves an explicit file MCP server working directory over the backend option', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'condukt-mcp-'));
    const mcpConfigPath = join(directory, 'mcp.json');
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        explicit: {
          type: 'stdio',
          command: 'file-server',
          workingDirectory: '/server/specific',
        },
      },
    }));

    try {
      const { session } = await createTestSession({
        mcpConfigPath,
        mcpServerWorkingDirectory: '/workspace/repository',
      });
      session.send('test prompt');

      await vi.waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
          mcpServers: {
            explicit: {
              type: 'stdio',
              command: 'file-server',
              workingDirectory: '/server/specific',
              tools: ['*'],
            },
          },
        }));
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it('enforces tiered custom agents while preserving caller overrides', async () => {
    const backend = new SdkBackend();
    const session = await backend.createSession({
      model: 'gpt-5.6-sol',
      cwd: '.',
      addDirs: [],
      timeout: 3600,
      heartbeatTimeout: 120,
      customAgents: [{
        name: 'explore',
        prompt: 'Use the caller policy.',
        tools: [],
        model: 'caller-model',
        mcpServers: {
          filtered: {
            command: 'filtered-server',
            tools: ['read'],
            timeout: 15_000,
          },
        },
      }, {
        name: 'extra',
        prompt: 'This role is outside the enforced roster.',
        model: 'caller-model',
      }],
      defaultAgent: { excludedTools: ['task'] },
      excludedBuiltinAgents: ['explore'],
    });
    session.send('test prompt');

    await vi.waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        customAgents: [
          expect.objectContaining({ name: 'explore', model: 'caller-model' }),
          expect.objectContaining({ name: 'research', model: 'gemini-3.1-pro-preview' }),
          expect.objectContaining({ name: 'implement', model: 'gpt-5.6-terra' }),
          expect.objectContaining({ name: 'verify', model: 'claude-sonnet-5' }),
          expect.objectContaining({ name: 'review', model: 'claude-opus-5' }),
        ],
        defaultAgent: { excludedTools: ['task'] },
        excludedBuiltinAgents: ['explore', 'research'],
      }));
    });
    const config = mockCreateSession.mock.calls[0]?.[0] as {
      readonly customAgents: readonly Record<string, unknown>[];
    };
    expect(config.customAgents).toHaveLength(5);
    expect(config.customAgents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'extra' }),
    ]));
    expect(config.customAgents[0]).toEqual(expect.objectContaining({
      name: 'explore',
      prompt: 'Use the caller policy.',
      tools: [],
      model: 'caller-model',
      mcpServers: {
        filtered: {
          type: 'local',
          command: 'filtered-server',
          tools: ['read'],
          timeout: 15_000,
        },
      },
    }));
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

  ;

  ;

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
      .mockImplementationOnce(async (config) => {
        mockSdkSession.sessionId = String(config.sessionId);
        return mockSdkSession;
      })
      .mockImplementationOnce(async (config) => {
        const resolved = await secondCreation;
        resolved.sessionId = String(config.sessionId);
        return resolved;
      });

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

  it('does not treat informational or unknown transport chatter as forward progress', () => {
    expect(isSdkForwardProgress('session.usage_checkpoint', {})).toBe(false);
    expect(isSdkForwardProgress('hook.progress', { message: 'still here' })).toBe(false);
    expect(isSdkForwardProgress('future.progress', { message: 'still here' })).toBe(false);
  });

  it('requires non-empty streaming payloads for forward progress', () => {
    expect(isSdkForwardProgress('assistant.message_delta', { deltaContent: '' })).toBe(false);
    expect(isSdkForwardProgress('assistant.reasoning_delta', { deltaContent: '' })).toBe(false);
    expect(isSdkForwardProgress('tool.execution_partial_result', { partialOutput: '' })).toBe(false);
    expect(isSdkForwardProgress('assistant.message_delta', { deltaContent: 'x' })).toBe(true);
    expect(isSdkForwardProgress('assistant.reasoning_delta', { deltaContent: 'thinking' })).toBe(true);
    expect(isSdkForwardProgress('tool.execution_partial_result', { partialOutput: 'line' })).toBe(true);
  });

  it('does not extend the heartbeat for duplicate model or streaming progress', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession({}, {
        heartbeatTimeout: 2,
        sessionRecovery: false,
      });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('model.call_start', { apiCallId: 'same-call' });
      await vi.advanceTimersByTimeAsync(1_500);
      mock._emit('model.call_start', { apiCallId: 'same-call' });
      mock._emit('assistant.streaming_delta', { totalResponseSizeBytes: 10 });
      await vi.advanceTimersByTimeAsync(1_500);
      mock._emit('assistant.streaming_delta', { totalResponseSizeBytes: 10 });
      await vi.advanceTimersByTimeAsync(500);

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('session progress timeout'),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets novel model-call starts refresh the heartbeat', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession({}, {
        heartbeatTimeout: 180,
        sessionRecovery: false,
      });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      for (let elapsedSeconds = 0; elapsedSeconds < 12 * 60; elapsedSeconds += 150) {
        await vi.advanceTimersByTimeAsync(150 * 1000);
        mock._emit('model.call_start', { apiCallId: `call-${elapsedSeconds}` });
      }

      expect(errorHandler).not.toHaveBeenCalled();
      mock._emit('session.idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when a tool stays silent for the progress deadline', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession({}, {
        heartbeatTimeout: 2,
      });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('tool.execution_start', {
        toolName: 'Read',
        toolCallId: 'tool-1',
        arguments: {},
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(errorHandler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('session progress timeout'),
      }));
      expect(mockResumeSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets novel tool progress keep a tool alive until it completes', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession({}, {
        heartbeatTimeout: 2,
        sessionRecovery: false,
      });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      mock._emit('tool.execution_start', {
        toolName: 'Read',
        toolCallId: 'tool-1',
        arguments: {},
      });

      for (let i = 0; i < 3; i += 1) {
        await vi.advanceTimersByTimeAsync(1_500);
        mock._emit('tool.execution_progress', {
          toolCallId: 'tool-1',
          progressMessage: `page ${i}`,
        });
      }
      expect(errorHandler).not.toHaveBeenCalled();
      mock._emit('tool.execution_complete', {
        toolCallId: 'tool-1',
        result: { content: 'done' },
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(errorHandler).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when a pending external request loses its completion event', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession({}, {
        heartbeatTimeout: 2,
      });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('user_input.requested', { requestId: 'input-1' });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('session progress timeout'),
      }));
      expect(mockResumeSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a silent opted-out session despite unknown event chatter', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { session, mock } = await createTestSession({}, {
        heartbeatTimeout: 2,
        sessionRecovery: false,
      });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(1_500);
      mock._emit('future.progress');
      await vi.advanceTimersByTimeAsync(500);

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('session progress timeout'),
      }));
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Unknown event: future.progress'));
    } finally {
      stderr.mockRestore();
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
      const { session, mock } = await createTestSession({ logger });
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
      const { session, mock } = await createTestSession({}, {
        heartbeatTimeout: 2,
        sessionRecovery: false,
      });
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
      const { session, mock } = await createTestSession({ logger }, {
        heartbeatTimeout: 2,
        sessionRecovery: false,
      });
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
        message: expect.stringContaining('session progress timeout'),
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
      const { session, mock } = await createTestSession({}, {
        heartbeatTimeout: 2,
        sessionRecovery: false,
      });
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
        message: expect.stringContaining('session progress timeout'),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets eligible auto-switch errors reach the pending switch policy', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger });
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
      const { session, mock } = await createTestSession({ logger });
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

  it('resumes a silent unmatched root turn after its progress heartbeat expires', async () => {
    vi.useFakeTimers();
    try {
      const resumed = createMockSdkSession();
      const stalledHistory = [
        { type: 'user.message', data: { content: 'test prompt' } },
        { type: 'assistant.turn_start', data: { turnId: '12' } },
      ];
      mockSdkSessions.push(resumed);
      mockSdkSession.getEvents.mockResolvedValue(stalledHistory);
      resumed.getEvents.mockResolvedValue(stalledHistory);
      resumed.rpc.metadata.contextInfo.mockResolvedValue({
        contextInfo: {
          totalTokens: 1_000,
          promptTokenLimit: 100_000,
          systemTokens: 100,
          conversationTokens: 900,
          toolDefinitionsTokens: 0,
        },
      });
      const { session, mock } = await createTestSession({}, {
        heartbeatTimeout: 2,
        sessionRecovery: {
          maxContinuations: 1,
          backoffBaseMs: 100,
          jitter: false,
        },
      });
      const errorHandler = vi.fn();
      const recoveryHandler = vi.fn();
      session.on('error', errorHandler);
      session.on('recovery', recoveryHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('assistant.turn_start', { turnId: '12' });
      mock._emit('assistant.message_delta', { deltaContent: 'partial' });
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(mockResumeSession).toHaveBeenCalledOnce());

      expect(errorHandler).not.toHaveBeenCalled();
      expect(mock.abort).not.toHaveBeenCalled();
      expect(mock.disconnect).toHaveBeenCalledOnce();
      expect(mockResumeSession).toHaveBeenCalledWith(
        mock.sessionId,
        expect.objectContaining({ continuePendingWork: false }),
      );
      expect(resumed.rpc.sendMessages).toHaveBeenCalledWith({ messages: [], wait: false });
      expect(recoveryHandler).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'continuation-sent',
        continuation: 1,
        failureKind: 'session-progress-timeout',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays the production event shape without timing out healthy tool turns', async () => {
    vi.useFakeTimers();
    try {
      const resumed = createMockSdkSession();
      const stalledHistory = [
        { type: 'user.message', data: { content: 'test prompt' } },
        { type: 'assistant.turn_start', data: { turnId: '0' } },
        { type: 'assistant.message', data: { turnId: '0', toolRequests: [{ toolCallId: 'tool-0' }] } },
        { type: 'tool.execution_start', data: { turnId: '0', toolCallId: 'tool-0' } },
        { type: 'tool.execution_complete', data: { turnId: '0', toolCallId: 'tool-0' } },
        { type: 'assistant.turn_end', data: { turnId: '0' } },
        { type: 'assistant.turn_start', data: { turnId: '1' } },
      ];
      mockSdkSessions.push(resumed);
      mockSdkSession.getEvents.mockResolvedValue(stalledHistory);
      resumed.getEvents.mockResolvedValue(stalledHistory);
      resumed.rpc.metadata.contextInfo.mockResolvedValue({
        contextInfo: {
          totalTokens: 1_000,
          promptTokenLimit: 100_000,
          systemTokens: 100,
          conversationTokens: 900,
          toolDefinitionsTokens: 0,
        },
      });
      const { session, mock } = await createTestSession({}, {
        heartbeatTimeout: 180,
        sessionRecovery: {
          maxContinuations: 1,
          backoffBaseMs: 100,
          jitter: false,
        },
      });
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('assistant.turn_start', { turnId: '0' });
      await vi.advanceTimersByTimeAsync(39_000);
      mock._emit('assistant.message', { turnId: '0', toolRequests: [{ toolCallId: 'tool-0' }] });
      mock._emit('tool.execution_start', { turnId: '0', toolCallId: 'tool-0', toolName: 'Read' });
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(mockResumeSession).not.toHaveBeenCalled();
      mock._emit('tool.execution_complete', { turnId: '0', toolCallId: 'tool-0', result: { content: 'done' } });
      mock._emit('assistant.turn_end', { turnId: '0' });
      mock._emit('assistant.turn_start', { turnId: '1' });

      await vi.advanceTimersByTimeAsync(179_999);
      expect(mockResumeSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(mockResumeSession).toHaveBeenCalledOnce());
      expect(resumed.rpc.sendMessages).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a balanced turn with a terminal response when its session idle event was lost', async () => {
    vi.useFakeTimers();
    try {
      mockSdkSession.getEvents.mockResolvedValue([
        { type: 'user.message', data: { content: 'test prompt' } },
        { type: 'assistant.turn_start', data: { turnId: '0' } },
        { type: 'assistant.message', data: { turnId: '0', content: 'done' } },
        { type: 'assistant.turn_end', data: { turnId: '0' } },
      ]);
      const { session } = await createTestSession({}, {
        heartbeatTimeout: 2,
        sessionRecovery: {
          maxContinuations: 1,
          backoffBaseMs: 100,
          jitter: false,
        },
      });
      const idleHandler = vi.fn();
      session.on('idle', idleHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(100);

      await vi.waitFor(() => expect(idleHandler).toHaveBeenCalledOnce());
      expect(mockResumeSession).not.toHaveBeenCalled();
      expect(mockSdkSession.rpc.sendMessages).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues when disconnect only balances the abandoned turn without a terminal response', async () => {
    vi.useFakeTimers();
    try {
      const resumed = createMockSdkSession();
      mockSdkSessions.push(resumed);
      mockSdkSession.getEvents.mockResolvedValue([
        { type: 'user.message', data: { content: 'test prompt' } },
        { type: 'assistant.turn_start', data: { turnId: '12' } },
      ]);
      resumed.getEvents.mockResolvedValue([
        { type: 'user.message', data: { content: 'test prompt' } },
        { type: 'assistant.turn_start', data: { turnId: '12' } },
        { type: 'assistant.turn_end', data: { turnId: '12' } },
      ]);
      resumed.rpc.metadata.contextInfo.mockResolvedValue({
        contextInfo: {
          totalTokens: 1_000,
          promptTokenLimit: 100_000,
          systemTokens: 100,
          conversationTokens: 900,
          toolDefinitionsTokens: 0,
        },
      });
      const { session } = await createTestSession({}, {
        heartbeatTimeout: 2,
        sessionRecovery: {
          maxContinuations: 1,
          backoffBaseMs: 100,
          jitter: false,
        },
      });
      const idleHandler = vi.fn();
      session.on('idle', idleHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(mockResumeSession).toHaveBeenCalledOnce());

      expect(idleHandler).not.toHaveBeenCalled();
      expect(resumed.rpc.sendMessages).toHaveBeenCalledWith({ messages: [], wait: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed instead of recovering a heartbeat with an unmatched tool execution', async () => {
    vi.useFakeTimers();
    try {
      mockSdkSession.getEvents.mockResolvedValue([
        { type: 'user.message', data: { content: 'test prompt' } },
        { type: 'assistant.turn_start', data: { turnId: '1' } },
        { type: 'tool.execution_start', data: { turnId: '1', toolCallId: 'tool-1' } },
      ]);
      const { session } = await createTestSession({}, {
        heartbeatTimeout: 2,
        sessionRecovery: {
          maxContinuations: 1,
          backoffBaseMs: 100,
          jitter: false,
        },
      });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(100);

      await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce());
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        name: 'SessionRecoveryExhaustedError',
      }));
      expect(mockResumeSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes a transient model.call_failure in the same persisted session', async () => {
    vi.useFakeTimers();
    try {
      const resumed = createMockSdkSession();
      mockSdkSessions.push(resumed);
      mockSdkSession.getEvents.mockResolvedValue([{ type: 'user.message', data: { content: 'test prompt' } }]);
      resumed.getEvents.mockResolvedValue([{ type: 'user.message', data: { content: 'test prompt' } }]);
      resumed.rpc.metadata.contextInfo.mockResolvedValue({
        contextInfo: {
          totalTokens: 1_000,
          promptTokenLimit: 100_000,
          systemTokens: 100,
          conversationTokens: 900,
          toolDefinitionsTokens: 0,
        },
      });
      const { session, mock } = await createTestSession({}, {
        sessionRecovery: {
          maxContinuations: 1,
          nativeRetryGraceMs: 0,
          backoffBaseMs: 100,
          jitter: false,
        },
      });
      const errorHandler = vi.fn();
      const recoveryHandler = vi.fn();
      session.on('error', errorHandler);
      session.on('recovery', recoveryHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('model.call_failure', {
        errorMessage: 'transient upstream failure',
        statusCode: 503,
        failureKind: 'api',
        transport: 'http',
        model: 'test-model',
        source: 'top_level',
      });
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(mockResumeSession).toHaveBeenCalledOnce());

      expect(errorHandler).not.toHaveBeenCalled();
      expect(mock.abort).not.toHaveBeenCalled();
      expect(mock.disconnect).toHaveBeenCalledOnce();
      expect(mockResumeSession).toHaveBeenCalledWith(
        mock.sessionId,
        expect.objectContaining({ continuePendingWork: false }),
      );
      expect(resumed.rpc.sendMessages).toHaveBeenCalledWith({ messages: [], wait: false });
      expect(recoveryHandler).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'continuation-sent',
        continuation: 1,
        sessionId: mock.sessionId,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resume after the shared recovery budget expires', async () => {
    vi.useFakeTimers();
    try {
      mockSdkSession.getEvents.mockResolvedValue([
        { type: 'user.message', data: { content: 'test prompt' } },
        { type: 'assistant.turn_start', data: { turnId: '1' } },
      ]);
      const { session, mock } = await createTestSession({}, {
        sessionRecovery: {
          maxContinuations: 23,
          budgetMs: 50,
          nativeRetryGraceMs: 0,
          backoffBaseMs: 100,
          jitter: false,
        },
      });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('model.call_failure', {
        errorMessage: 'connection lost',
        failureKind: 'transport',
        transport: 'http',
        source: 'top_level',
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(mockResumeSession).not.toHaveBeenCalled();
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        name: 'SessionRecoveryExhaustedError',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps explicit recovery policies at 23 continuations', async () => {
    vi.useFakeTimers();
    try {
      const resumedSessions = Array.from({ length: 23 }, () => createMockSdkSession());
      const safeHistory = [{ type: 'user.message', data: { content: 'test prompt' } }];
      for (const handle of [mockSdkSession, ...resumedSessions]) {
        handle.getEvents.mockResolvedValue(safeHistory);
        handle.rpc.metadata.contextInfo.mockResolvedValue({
          contextInfo: {
            totalTokens: 1_000,
            promptTokenLimit: 100_000,
            systemTokens: 100,
            conversationTokens: 900,
            toolDefinitionsTokens: 0,
          },
        });
      }
      mockSdkSessions.push(...resumedSessions);
      const { session, mock } = await createTestSession({}, {
        sessionRecovery: {
          maxContinuations: 99,
          nativeRetryGraceMs: 0,
          backoffBaseMs: 100,
          backoffMaxMs: 100,
          jitter: false,
        },
      });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      let active = mock;
      for (let continuation = 1; continuation <= 23; continuation += 1) {
        active._emit('model.call_failure', {
          errorMessage: `connection lost ${continuation}`,
          apiCallId: `capped-call-${continuation}`,
          failureKind: 'transport',
          transport: 'http',
          source: 'top_level',
        });
        await vi.advanceTimersByTimeAsync(100);
        await vi.waitFor(() => expect(mockResumeSession).toHaveBeenCalledTimes(continuation));
        active = resumedSessions[continuation - 1];
      }

      active._emit('model.call_failure', {
        errorMessage: 'connection lost 24',
        apiCallId: 'capped-call-24',
        failureKind: 'transport',
        transport: 'http',
        source: 'top_level',
      });
      expect(mockResumeSession).toHaveBeenCalledTimes(23);
      expect(errorHandler).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors a 23-continuation ceiling without a 24th resume', async () => {
    vi.useFakeTimers();
    try {
      const resumedSessions = Array.from({ length: 23 }, () => createMockSdkSession());
      const safeHistory = [{ type: 'user.message', data: { content: 'test prompt' } }];
      for (const handle of [mockSdkSession, ...resumedSessions]) {
        handle.getEvents.mockResolvedValue(safeHistory);
        handle.rpc.metadata.contextInfo.mockResolvedValue({
          contextInfo: {
            totalTokens: 1_000,
            promptTokenLimit: 100_000,
            systemTokens: 100,
            conversationTokens: 900,
            toolDefinitionsTokens: 0,
          },
        });
      }
      mockSdkSessions.push(...resumedSessions);
      const { session, mock } = await createTestSession({}, {
        sessionRecovery: {
          maxContinuations: 23,
          nativeRetryGraceMs: 0,
          backoffBaseMs: 100,
          backoffMaxMs: 100,
          jitter: false,
        },
      });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      let active = mock;
      for (let continuation = 1; continuation <= 23; continuation += 1) {
        active._emit('model.call_failure', {
          errorMessage: `connection lost ${continuation}`,
          apiCallId: `call-${continuation}`,
          failureKind: 'transport',
          transport: 'http',
          source: 'top_level',
        });
        await vi.advanceTimersByTimeAsync(100);
        await vi.waitFor(() => expect(mockResumeSession).toHaveBeenCalledTimes(continuation));
        active = resumedSessions[continuation - 1];
      }

      active._emit('model.call_failure', {
        errorMessage: 'connection lost 24',
        apiCallId: 'call-24',
        failureKind: 'transport',
        transport: 'http',
        source: 'top_level',
      });
      expect(mockResumeSession).toHaveBeenCalledTimes(23);
      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        name: 'SessionRecoveryExhaustedError',
        suppressFreshSessionRetry: true,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when recovered history has unresolved permission work', async () => {
    vi.useFakeTimers();
    try {
      mockSdkSession.getEvents.mockResolvedValue([
        { type: 'user.message', data: { content: 'test prompt' } },
        { type: 'permission.requested', data: { requestId: 'pending-1' } },
      ]);
      const { session, mock } = await createTestSession({}, {
        sessionRecovery: {
          maxContinuations: 1,
          nativeRetryGraceMs: 0,
          backoffBaseMs: 100,
          jitter: false,
        },
      });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      mock._emit('model.call_failure', {
        errorMessage: 'connection lost',
        failureKind: 'transport',
        transport: 'http',
        source: 'top_level',
      });
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce());
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        name: 'SessionRecoveryExhaustedError',
        suppressFreshSessionRetry: true,
      }));
      expect(mockResumeSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an SDK-native retry suppress manual recovery during grace', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession({}, {
        sessionRecovery: {
          maxContinuations: 1,
          nativeRetryGraceMs: 1_000,
          backoffBaseMs: 100,
          jitter: false,
        },
      });
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      mock._emit('model.call_failure', {
        errorMessage: 'connection lost',
        failureKind: 'transport',
        transport: 'http',
        source: 'top_level',
      });
      mock._emit('assistant.turn_retry');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockResumeSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opts out of same-session recovery explicitly', async () => {
    const { session, mock } = await createTestSession({}, { sessionRecovery: false });
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');
    await new Promise(resolve => setTimeout(resolve, 50));
    mock._emit('model.call_failure', {
      errorMessage: 'connection lost',
      failureKind: 'transport',
      transport: 'http',
      source: 'top_level',
    });
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(mockResumeSession).not.toHaveBeenCalled();
  });

  it('classifies compaction model rejection as a first-class terminal failure', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger });
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

  ;

  it('trusts native compaction success and emits native token summaries without verification RPCs', async () => {
    const { session, mock } = await createTestSession();
    const compactionHandler = vi.fn();
    const errorHandler = vi.fn();
    session.on('compaction', compactionHandler);
    session.on('error', errorHandler);
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    mock._emit('session.compaction_start');
    mock._emit('session.compaction_complete', {
      success: true,
      preCompactionTokens: 280_000,
      postCompactionTokens: 150_000,
      tokensRemoved: 130_000,
    });

    expect(compactionHandler.mock.calls).toEqual([
      ['start'],
      ['complete', '280000 → 150000 tokens'],
    ]);
    expect(errorHandler).not.toHaveBeenCalled();
    expect(mock.rpc.metadata.contextInfo).not.toHaveBeenCalled();
    expect(mock.rpc.metadata.getContextAttribution).not.toHaveBeenCalled();
    expect(mock.rpc.metadata.recomputeContextTokens).not.toHaveBeenCalled();
    expect(mock.rpc.history.compact).not.toHaveBeenCalled();
  });

  it.each([
    ['tokens removed', { success: true, tokensRemoved: 100_000 }, '100000 tokens removed'],
    ['no counters', { success: true }, undefined],
  ])('emits native compaction completion with %s', async (_label, data, summary) => {
    const { session, mock } = await createTestSession();
    const compactionHandler = vi.fn();
    session.on('compaction', compactionHandler);
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    mock._emit('session.compaction_start');
    mock._emit('session.compaction_complete', data);

    expect(compactionHandler).toHaveBeenNthCalledWith(1, 'start');
    expect(compactionHandler).toHaveBeenNthCalledWith(2, 'complete', summary);
  });

  it('logs a second compaction start and ignores unmatched or duplicate completion', async () => {
    const logger = createMockLogger();
    const { session, mock } = await createTestSession({ logger });
    const compactionHandler = vi.fn();
    session.on('compaction', compactionHandler);
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    mock._emit('session.compaction_complete', { success: true });
    expect(compactionHandler).not.toHaveBeenCalled();

    mock._emit('session.compaction_start');
    mock._emit('session.compaction_start');
    expect(compactionHandler.mock.calls).toEqual([['start']]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Copilot emitted a second compaction start while one is active',
      expect.objectContaining({ activeEventId: 'unknown' }),
    );

    mock._emit('session.compaction_complete', { success: true });
    mock._emit('session.compaction_complete', { success: true });
    expect(compactionHandler.mock.calls).toEqual([
      ['start'],
      ['complete', undefined],
    ]);
  });

  it('defers parent idle during native compaction and settles after success', async () => {
    const { session, mock } = await createTestSession();
    const idleHandler = vi.fn();
    session.on('idle', idleHandler);
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    mock._emit('session.compaction_start');
    mock._emit('session.idle');
    expect(idleHandler).not.toHaveBeenCalled();

    mock._emit('session.compaction_complete', { success: true });
    expect(idleHandler).toHaveBeenCalledOnce();
  });

  it('leaves missing compaction completion to the node hard timeout', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession({}, {
        timeout: 2,
        heartbeatTimeout: 1,
        sessionRecovery: false,
      });
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('session.compaction_start');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(errorHandler).not.toHaveBeenCalled();
      expect(mock.rpc.history.compact).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Session timed out after 2s',
      }));
      expect(mock.abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps compaction failure terminal when a late native retry arrives', async () => {
    const { session, mock } = await createTestSession();
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

    mock._emit('session.compaction_start');
    mock._emit('session.compaction_complete', {
      success: false,
      error: 'quota exceeded',
      statusCode: 429,
    });
    mock._emit('assistant.turn_retry');

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(mockResumeSession).not.toHaveBeenCalled();
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
    const { session, mock } = await createTestSession({ logger });
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

  it('normalizes string status codes from model.call_failure', async () => {
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
      statusCode: 401,
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
    const { session, mock } = await createTestSession({ logger });
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

  ;

  ;

  describe('SdkBackend terminalLogLevel', () => {
    it('preserves exact legacy behavior when terminalLogLevel is omitted (passes warning to SDK, emits all direct stderr writes, retains logger)', async () => {
      const logger = createMockLogger();
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { session, mock } = await createTestSession({ logger });
        session.send('test prompt');
        await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
        expect(mockClientConfig?.logLevel).toBe('warning');

        // Trigger info-level write (Unknown event)
        mock._emit('future.unknown_event', { key: 'value' });
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[SdkBackend] Unknown event: future.unknown_event'));

        // Trigger warning-level write (task completion failure)
        mock._emit('session.task_complete', { success: false, summary: 'task issue' });
        expect(stderr).toHaveBeenCalledWith('[SdkBackend] TASK COMPLETION FAILED; session remains active\n');
        expect(logger.warn).toHaveBeenCalledWith(
          'Copilot task completion failed; session remains active',
          expect.objectContaining({ summary: 'task issue' }),
        );

        // Trigger error-level write (agent failure)
        mock._emit('session.error', { message: 'fatal agent crash' }, 'sub-1');
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[SdkBackend] AGENT-SCOPED FAILURE agentId=sub-1'));
        expect(logger.error).toHaveBeenCalledWith(
          'Copilot sub-agent failed; parent session remains active',
          expect.objectContaining({ agentId: 'sub-1', reason: 'fatal agent crash' }),
        );
      } finally {
        stderr.mockRestore();
      }
    });

    it('suppresses all direct stderr writes when terminalLogLevel is none, while passing none to SDK and preserving logger and events', async () => {
      const logger = createMockLogger();
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { session, mock } = await createTestSession({ logger, terminalLogLevel: 'none' });
        const errorHandler = vi.fn();
        session.on('error', errorHandler);
        session.send('test prompt');
        await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
        expect(mockClientConfig?.logLevel).toBe('none');

        // Trigger info-level write
        mock._emit('future.unknown_event', { key: 'value' });

        // Trigger warning-level write
        mock._emit('session.task_complete', { success: false, summary: 'task issue' });
        expect(logger.warn).toHaveBeenCalledWith(
          'Copilot task completion failed; session remains active',
          expect.objectContaining({ summary: 'task issue' }),
        );

        // Trigger error-level write
        mock._emit('session.error', { message: 'fatal agent crash' }, 'sub-1');
        expect(logger.error).toHaveBeenCalledWith(
          'Copilot sub-agent failed; parent session remains active',
          expect.objectContaining({ agentId: 'sub-1', reason: 'fatal agent crash' }),
        );

        // Stderr should have received 0 writes
        expect(stderr).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
    });

    it('emits error-level writes but suppresses warning- and info-level writes when terminalLogLevel is error', async () => {
      const logger = createMockLogger();
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { session, mock } = await createTestSession({ logger, terminalLogLevel: 'error' });
        session.send('test prompt');
        await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
        expect(mockClientConfig?.logLevel).toBe('error');

        // Info-level write should be suppressed
        mock._emit('future.unknown_event', { key: 'value' });
        expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('[SdkBackend] Unknown event:'));

        // Warning-level write should be suppressed
        mock._emit('session.task_complete', { success: false, summary: 'task issue' });
        expect(stderr).not.toHaveBeenCalledWith('[SdkBackend] TASK COMPLETION FAILED; session remains active\n');
        expect(logger.warn).toHaveBeenCalled();

        // Error-level write should emit
        mock._emit('session.error', { message: 'child error' }, 'sub-1');
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[SdkBackend] AGENT-SCOPED FAILURE agentId=sub-1'));
        expect(logger.error).toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
    });

    it('emits error- and warning-level writes but suppresses info-level writes when terminalLogLevel is warning', async () => {
      const logger = createMockLogger();
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { session, mock } = await createTestSession({ logger, terminalLogLevel: 'warning' });
        session.send('test prompt');
        await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
        expect(mockClientConfig?.logLevel).toBe('warning');

        // Info-level write should be suppressed
        mock._emit('future.unknown_event', { key: 'value' });
        expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('[SdkBackend] Unknown event:'));

        // Warning-level write should emit
        mock._emit('session.task_complete', { success: false, summary: 'task issue' });
        expect(stderr).toHaveBeenCalledWith('[SdkBackend] TASK COMPLETION FAILED; session remains active\n');

        // Error-level write should emit
        mock._emit('session.error', { message: 'child error' }, 'sub-1');
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[SdkBackend] AGENT-SCOPED FAILURE agentId=sub-1'));
      } finally {
        stderr.mockRestore();
      }
    });

    it.each([
      ['info' as const],
      ['debug' as const],
      ['all' as const],
    ])('emits error, warning, and info writes when terminalLogLevel is %s', async (level) => {
      const logger = createMockLogger();
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { session, mock } = await createTestSession({ logger, terminalLogLevel: level });
        session.send('test prompt');
        await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
        expect(mockClientConfig?.logLevel).toBe(level);

        // Info-level write should emit
        mock._emit('future.unknown_event', { key: 'value' });
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[SdkBackend] Unknown event: future.unknown_event'));

        // Warning-level write should emit
        mock._emit('session.task_complete', { success: false, summary: 'task issue' });
        expect(stderr).toHaveBeenCalledWith('[SdkBackend] TASK COMPLETION FAILED; session remains active\n');

        // Error-level write should emit
        mock._emit('session.error', { message: 'child error' }, 'sub-1');
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[SdkBackend] AGENT-SCOPED FAILURE agentId=sub-1'));
      } finally {
        stderr.mockRestore();
      }
    });
  });
});
