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
    history: { compact: ReturnType<typeof vi.fn> };
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
      history: { compact: vi.fn().mockResolvedValue({ success: true, tokensRemoved: 0, messagesRemoved: 0 }) },
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
let mockCreateSession: ReturnType<typeof vi.fn<(config: Record<string, unknown>) => Promise<MockSdkSession>>>;
let mockStart: ReturnType<typeof vi.fn<() => Promise<void>>>;
let mockListModels: ReturnType<typeof vi.fn<() => Promise<MockModelInfo[]>>>;
let mockStop: ReturnType<typeof vi.fn<() => Promise<void>>>;
let mockForceStop: ReturnType<typeof vi.fn<() => Promise<void>>>;
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
  mockCreateSession = vi.fn<(config: Record<string, unknown>) => Promise<MockSdkSession>>()
    .mockImplementation(async () => mockSdkSessions.shift() ?? mockSdkSession);
  mockStart = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  mockStop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  mockForceStop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
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

  // Replace Function constructor so that when SdkBackend creates its dynamic import
  // function, we intercept and return our mock SDK module.
  const mockFunction = function (...args: string[]): Function {
    if (args.length === 2 && args[0] === 'specifier' && args[1] === 'return import(specifier)') {
      return () => Promise.resolve({
        RuntimeConnection: {
          forStdio: vi.fn(() => ({ kind: 'stdio' as const })),
        },
        CopilotClient: class MockCopilotClient {
          start() { return mockStart(); }
          listModels() { return mockListModels(); }
          async createSession(config: Record<string, unknown>) {
            const onEvent = config.onEvent as SdkEventHandler | undefined;
            onEvent?.({ type: 'session.start', data: { early: true } });
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
  it('applies 80% of the discovered prompt limit as an absolute ceiling', async () => {
    const logger = createMockLogger();
    const { session } = await createTestSession({ logger });
    session.send('test prompt');

    await vi.waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        modelCapabilities: {
          limits: { max_prompt_tokens: 737_600 },
        },
        infiniteSessions: {
          enabled: true,
          backgroundCompactionThreshold: 0.60,
          bufferExhaustionThreshold: 0.75,
        },
      }));
    });
    expect(mockStart.mock.invocationCallOrder[0]).toBeLessThan(mockListModels.mock.invocationCallOrder[0]!);
    expect(logger.info).toHaveBeenCalledWith('Resolved Copilot model prompt-token ceiling', {
      model: 'test-model',
      discoveredLimit: 922_000,
      limitSource: 'max_prompt_tokens',
      promptTokenCeiling: 737_600,
    });
  });

  it('falls back to 80% of the context window when the prompt limit is absent', async () => {
    mockListModels.mockResolvedValueOnce([{
      id: 'test-model',
      name: 'Test Model',
      capabilities: {
        supports: { vision: false, reasoningEffort: true },
        limits: { max_context_window_tokens: 400_000 },
      },
    }]);
    const logger = createMockLogger();
    const { session } = await createTestSession({ logger });
    session.send('test prompt');

    await vi.waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        modelCapabilities: {
          limits: { max_prompt_tokens: 320_000 },
        },
      }));
    });
    expect(logger.info).toHaveBeenCalledWith('Resolved Copilot model prompt-token ceiling', {
      model: 'test-model',
      discoveredLimit: 400_000,
      limitSource: 'max_context_window_tokens',
      promptTokenCeiling: 320_000,
    });
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
      'Copilot model capability lookup returned no usable token limit; using proportional compaction thresholds only',
      {
        model: 'test-model',
        reason: 'invalid_limit',
        maxPromptTokens: undefined,
        maxContextWindowTokens: undefined,
      },
    );
  });

  it('omits a computed prompt-token ceiling that rounds down to zero', async () => {
    mockListModels.mockResolvedValueOnce([{
      id: 'test-model',
      name: 'Test Model',
      capabilities: {
        supports: { vision: false, reasoningEffort: true },
        limits: {
          max_prompt_tokens: 0.5,
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
      'Copilot model capability lookup produced no usable prompt-token ceiling; using proportional compaction thresholds only',
      {
        model: 'test-model',
        reason: 'invalid_computed_ceiling',
        discoveredLimit: 0.5,
        limitSource: 'max_prompt_tokens',
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
      'Copilot model capability lookup returned no usable token limit; using proportional compaction thresholds only',
      {
        model: 'test-model',
        reason: 'invalid_limit',
        maxPromptTokens: 0,
        maxContextWindowTokens: 400_000,
      },
    );
  });

  it('creates sessions without an absolute ceiling when model listing fails', async () => {
    mockListModels.mockRejectedValueOnce(new Error('models unavailable'));
    const logger = createMockLogger();
    const { session } = await createTestSession({ logger });
    session.send('test prompt');

    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalled());
    expect(mockCreateSession.mock.calls[0]?.[0]).not.toHaveProperty('modelCapabilities');
    expect(mockCreateSession.mock.calls[0]?.[0]).toMatchObject({
      infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: 0.60,
        bufferExhaustionThreshold: 0.75,
      },
    });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      'Copilot model capability discovery failed; using proportional compaction thresholds only',
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
      'Copilot model capability lookup failed; using proportional compaction thresholds only',
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

  it('recovers a stuck compaction after an intentional abort', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      mock.rpc.history.compact.mockRejectedValueOnce(new Error('compact failed'));
      mock.abort.mockImplementationOnce(async () => {
        mock._emit('abort', { reason: 'user_initiated' });
        mock._emit('session.idle');
      });

      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      mock._emit('session.compaction_start');
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(2000);

      expect(errorHandler).not.toHaveBeenCalled();
      expect(mock.send).toHaveBeenLastCalledWith({ prompt: 'Continue from where you left off.' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-arm heartbeat when the session fails during recovery send', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      mock.rpc.history.compact.mockRejectedValueOnce(new Error('compact failed'));
      let resolveRecovery!: () => void;
      const recoverySend = new Promise<void>(resolve => { resolveRecovery = resolve; });
      mock.send.mockResolvedValueOnce(undefined).mockReturnValueOnce(recoverySend);

      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      mock._emit('session.compaction_start');
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 2000);
      expect(mock.send).toHaveBeenLastCalledWith({ prompt: 'Continue from where you left off.' });

      mock._emit('session.error', { message: 'failed during recovery send' });
      resolveRecovery();
      await vi.advanceTimersByTimeAsync(120 * 1000);

      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ message: 'failed during recovery send' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a delayed abort throughout compaction recovery', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      mock.rpc.history.compact.mockRejectedValueOnce(new Error('compact failed'));
      let resolveRecovery!: () => void;
      const recoverySend = new Promise<void>(resolve => { resolveRecovery = resolve; });
      mock.send.mockResolvedValueOnce(undefined).mockReturnValueOnce(recoverySend);

      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      mock._emit('session.compaction_start');
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 7000);
      mock._emit('abort', { reason: 'user_initiated' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(errorHandler).not.toHaveBeenCalled();
      resolveRecovery();
      await vi.advanceTimersByTimeAsync(0);
      expect(mock.send).toHaveBeenLastCalledWith({ prompt: 'Continue from where you left off.' });
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

  it('session.task_complete emits idle and cleans up', async () => {
    const { session, mock } = await createTestSession();

    const idleHandler = vi.fn();
    session.on('idle', idleHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    mock._emit('session.task_complete');

    expect(idleHandler).toHaveBeenCalledOnce();
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
