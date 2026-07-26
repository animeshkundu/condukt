import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/types';
import { SdkBackend } from '../../runtimes/copilot/sdk-backend';
import {
  DEFAULT_SUBAGENT_ROSTER,
  mergeSubagentRosters,
} from '../../runtimes/copilot/subagents';

interface MockSdkSession {
  readonly send: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly rpc: {
    readonly tools: { readonly updateSubagentSettings: ReturnType<typeof vi.fn> };
    readonly mode: { readonly set: ReturnType<typeof vi.fn> };
  };
  readonly on: (...args: readonly unknown[]) => void;
}

let mockSdkSession: MockSdkSession;
let mockCreateSession: (config: Record<string, unknown>) => Promise<MockSdkSession>;
let originalFunction: typeof globalThis.Function;
let callOrder: string[];

function createMockSdkSession(): MockSdkSession {
  return {
    send: vi.fn().mockImplementation(async () => { callOrder.push('send'); }),
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    rpc: {
      tools: {
        updateSubagentSettings: vi.fn().mockImplementation(async () => {
          callOrder.push('updateSubagentSettings');
          return {};
        }),
      },
      mode: { set: vi.fn().mockResolvedValue(undefined) },
    },
    on: () => undefined,
  };
}

async function sendWithRoster(
  backendRoster?: NonNullable<ConstructorParameters<typeof SdkBackend>[0]>['subagentRoster'],
  sessionRoster?: Parameters<SdkBackend['createSession']>[0]['subagentRoster'],
  logger?: Logger,
): Promise<MockSdkSession> {
  const backend = new SdkBackend({
    ...(backendRoster !== undefined ? { subagentRoster: backendRoster } : {}),
    ...(logger !== undefined ? { logger } : {}),
  });
  const session = await backend.createSession({
    model: 'test-model',
    cwd: '.',
    addDirs: [],
    timeout: 3600,
    heartbeatTimeout: 120,
    ...(sessionRoster !== undefined ? { subagentRoster: sessionRoster } : {}),
  });
  session.send('test prompt');
  await vi.waitFor(() => expect(mockSdkSession.send).toHaveBeenCalled());
  return mockSdkSession;
}

beforeEach(() => {
  callOrder = [];
  mockSdkSession = createMockSdkSession();
  mockCreateSession = vi.fn().mockImplementation(async () => {
    callOrder.push('createSession');
    return mockSdkSession;
  });
  originalFunction = globalThis.Function;

  const mockFunction = function (...args: string[]): Function {
    if (args.length === 2 && args[0] === 'specifier' && args[1] === 'return import(specifier)') {
      return () => Promise.resolve({
        RuntimeConnection: {
          forStdio: vi.fn(() => ({ kind: 'stdio' as const })),
        },
        CopilotClient: class MockCopilotClient {
          createSession(config: Record<string, unknown>) {
            return mockCreateSession(config);
          }
          stop() { return Promise.resolve(); }
          forceStop() { return Promise.resolve(); }
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

describe('Copilot subagent roster', () => {
  it('applies the complete stable default roster before the first prompt', async () => {
    const mock = await sendWithRoster(DEFAULT_SUBAGENT_ROSTER);

    expect(mock.rpc.tools.updateSubagentSettings).toHaveBeenCalledOnce();
    expect(mock.rpc.tools.updateSubagentSettings).toHaveBeenCalledWith({
      subagents: { agents: DEFAULT_SUBAGENT_ROSTER },
    });
    expect(callOrder).toEqual(['createSession', 'updateSubagentSettings', 'send']);
  });

  it('merges consumer overrides per agent and per field', async () => {
    const mock = await sendWithRoster(
      {
        explore: { model: 'backend-model' },
        verifier: { model: 'gpt-5.6-sol', effortLevel: 'xhigh' },
      },
      {
        explore: { effortLevel: 'medium' },
      },
    );

    expect(mock.rpc.tools.updateSubagentSettings).toHaveBeenCalledWith({
      subagents: {
        agents: mergeSubagentRosters(DEFAULT_SUBAGENT_ROSTER, {
          explore: {
            model: 'backend-model',
            effortLevel: 'medium',
          },
          verifier: { model: 'gpt-5.6-sol', effortLevel: 'xhigh' },
        }),
      },
    });
    const params = mock.rpc.tools.updateSubagentSettings.mock.calls[0]?.[0] as {
      readonly subagents: { readonly agents: Record<string, Record<string, unknown>> };
    };
    expect(params.subagents.agents.explore).toEqual({
      model: 'backend-model',
      effortLevel: 'medium',
      contextTier: 'long_context',
    });
    expect(params.subagents.agents['code-review']).toEqual(DEFAULT_SUBAGENT_ROSTER['code-review']);
    expect(params.subagents.agents.verifier).toEqual({
      model: 'gpt-5.6-sol',
      effortLevel: 'xhigh',
    });
  });

  it('sends nothing when the roster is unset', async () => {
    const mock = await sendWithRoster();
    expect(mock.rpc.tools.updateSubagentSettings).not.toHaveBeenCalled();
  });

  it('sends nothing when the roster is false', async () => {
    const disabledBackend = await sendWithRoster(false);
    expect(disabledBackend.rpc.tools.updateSubagentSettings).not.toHaveBeenCalled();

    mockSdkSession = createMockSdkSession();
    await sendWithRoster({ explore: { model: 'backend-model' } }, false);
    expect(mockSdkSession.rpc.tools.updateSubagentSettings).not.toHaveBeenCalled();
  });

  it('logs and swallows an RPC rejection so the prompt is still sent', async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    mockSdkSession.rpc.tools.updateSubagentSettings.mockRejectedValueOnce(
      new Error('experimental RPC unavailable'),
    );

    const mock = await sendWithRoster(DEFAULT_SUBAGENT_ROSTER, undefined, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to apply Copilot subagent roster; using default settings',
      { error: 'experimental RPC unavailable' },
    );
    expect(mock.send).toHaveBeenCalledWith({ prompt: 'test prompt' });
    expect(callOrder).toEqual(['createSession', 'send']);
  });

  it('keeps every default entry within the shape the Copilot CLI accepts', () => {
    for (const [name, entry] of Object.entries(DEFAULT_SUBAGENT_ROSTER)) {
      expect(Object.keys(entry).sort(), `${name} may only set CLI-known fields`)
        .toEqual(['contextTier', 'effortLevel', 'model']);
      expect(['inherit', 'default', 'long_context'], `${name} contextTier`)
        .toContain(entry.contextTier);
    }
  });

  it('keeps review agents complementary and planning inherited', () => {
    expect(DEFAULT_SUBAGENT_ROSTER['code-review']?.model).toBe('complementary');
    expect(DEFAULT_SUBAGENT_ROSTER['security-review']?.model).toBe('complementary');
    expect(DEFAULT_SUBAGENT_ROSTER.plan?.model).toBe('inherit');
  });
});
