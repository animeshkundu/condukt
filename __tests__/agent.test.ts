/**
 * Agent factory tests — 8 cases covering session lifecycle, crash recovery,
 * setup/teardown, actionParser, isolation, and abort.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AgentConfig,
  AgentRuntime,
  AgentSession,
  ExecutionContext,
  NodeInput,
  SessionConfig,
} from '../src/types';
import type { OutputEvent } from '../src/events';
import { DEFAULT_MCP_SERVERS } from '../src';
import { DEFAULT_RETRY_POLICY, FlowAbortedError } from '../src/types';
import {
  agent,
  isRetriableModelError,
  retryDelayMs,
  wasCompletedBeforeCrash,
} from '../src/agent';

const EXPECTED_DEFAULT_MCP_SERVERS = {
  playwright: {
    type: 'local',
    command: 'npx',
    args: ['@playwright/mcp@latest'],
    tools: ['*'],
    timeout: 30_000,
  },
  github: {
    type: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: {
      Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN|GITHUB_TOKEN|GH_TOKEN|COPILOT_GITHUB_TOKEN}',
      'X-MCP-Toolsets': 'all',
    },
    tools: ['*'],
    timeout: 30_000,
  },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EventHandler<T extends unknown[] = unknown[]> = (...args: T) => void;

interface MockSession {
  pid: number | null;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  _handlers: Map<string, EventHandler[]>;
  _emit: (event: string, ...args: unknown[]) => void;
}

function createMockSession(): MockSession {
  const handlers = new Map<string, EventHandler[]>();

  const session: MockSession = {
    pid: 1234,
    send: vi.fn(),
    on: vi.fn((event: string, handler: EventHandler) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    }),
    abort: vi.fn().mockResolvedValue(undefined),
    _handlers: handlers,
    _emit: (event: string, ...args: unknown[]) => {
      const eventHandlers = handlers.get(event) ?? [];
      for (const h of eventHandlers) {
        h(...args);
      }
    },
  };

  return session;
}

function createMockRuntime(session: MockSession): AgentRuntime {
  return {
    name: 'test-runtime',
    createSession: vi.fn().mockResolvedValue(session as unknown as AgentSession),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

function createMockInput(dir: string = '/tmp/test-agent'): NodeInput {
  return {
    dir,
    params: { repo: 'test-repo' },
    artifactPaths: {},
  };
}

function createMockContext(
  runtime: AgentRuntime,
  overrides?: Partial<ExecutionContext>,
): ExecutionContext {
  const ac = new AbortController();
  return {
    executionId: 'exec-1',
    nodeId: 'node-1',
    runtime,
    emitOutput: vi.fn(),
    signal: ac.signal,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent factory', () => {
  // Mock fs for artifact operations
  vi.mock('node:fs', () => ({
    existsSync: vi.fn().mockReturnValue(false),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue('artifact content here'),
    writeFileSync: vi.fn(),
  }));

  let mockSession: MockSession;
  let mockRuntime: AgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = createMockSession();
    mockRuntime = createMockRuntime(mockSession);
  });

  it('defaults the heartbeat timeout to 15 minutes', async () => {
    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => mockSession._emit('idle'));
    });

    await agent({ promptBuilder: () => 'test prompt' })(
      createMockInput(),
      createMockContext(mockRuntime),
    );

    expect(mockRuntime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ heartbeatTimeout: 900 }),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('creates today\'s session config when contextTier is omitted', async () => {
    const config: AgentConfig = {
      objective: 'test objective',
      model: 'gpt-5.3',
      timeout: 1800,
      heartbeatTimeout: 60,
      promptBuilder: () => 'test prompt',
    };

    const nodeFn = agent(config);
    const input = createMockInput();
    const ctx = createMockContext(mockRuntime);

    // Make session go idle immediately after send
    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => mockSession._emit('idle'));
    });

    await nodeFn(input, ctx);

    expect(mockRuntime.createSession).toHaveBeenCalledWith(
      {
        model: 'gpt-5.3',
        thinkingBudget: 'high',
        contextTier: 'long_context',
        compactionMode: undefined,
        cwd: '/tmp/test-agent',
        addDirs: ['/tmp/test-agent'],
        timeout: 1800,
        heartbeatTimeout: 60,
        systemMessage: undefined,
        availableTools: undefined,
        excludedTools: undefined,
        mcpServers: EXPECTED_DEFAULT_MCP_SERVERS,
        customAgents: undefined,
        subagentRoster: undefined,
        subagentsEnabled: undefined,
        maxDepth: undefined,
        maxConcurrency: undefined,
        defaultAgent: undefined,
        excludedBuiltinAgents: undefined,
        nodeId: 'node-1',
        memberId: undefined,
        artifactFilename: undefined,
      },
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('forwards the selected compaction mode', async () => {
    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => mockSession._emit('idle'));
    });

    await agent({
      promptBuilder: () => 'test prompt',
      compactionMode: 'aggressive',
    })(createMockInput(), createMockContext(mockRuntime));

    expect(mockRuntime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ compactionMode: 'aggressive' }),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('uses default MCP servers and lets consumers replace, extend, or disable them', async () => {
    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => mockSession._emit('idle'));
    });

    await agent({ promptBuilder: () => 'defaults' })(
      createMockInput(),
      createMockContext(mockRuntime),
    );
    await agent({
      mcpServers: {
        custom: { command: 'custom-server', args: ['--stdio'] },
      },
      promptBuilder: () => 'replacement',
    })(createMockInput(), createMockContext(mockRuntime));
    await agent({
      mcpServers: {
        ...DEFAULT_MCP_SERVERS,
        custom: { command: 'custom-server' },
      },
      promptBuilder: () => 'extension',
    })(createMockInput(), createMockContext(mockRuntime));
    await agent({
      mcpServers: false,
      promptBuilder: () => 'disabled',
    })(createMockInput(), createMockContext(mockRuntime));

    const calls = vi.mocked(mockRuntime.createSession).mock.calls;
    expect(DEFAULT_MCP_SERVERS).toEqual(EXPECTED_DEFAULT_MCP_SERVERS);
    expect(calls[0]?.[0].mcpServers).toBe(DEFAULT_MCP_SERVERS);
    expect(calls[1]?.[0].mcpServers).toEqual({
      custom: { command: 'custom-server', args: ['--stdio'] },
    });
    expect(calls[2]?.[0].mcpServers).toEqual({
      ...EXPECTED_DEFAULT_MCP_SERVERS,
      custom: { command: 'custom-server' },
    });
    expect(calls[3]?.[0].mcpServers).toBe(false);
  });

  it('lets an explicit default tier opt out of long context', async () => {
    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => mockSession._emit('idle'));
    });

    await agent({
      objective: 'test objective',
      contextTier: 'default',
      promptBuilder: () => 'test prompt',
    })(createMockInput(), createMockContext(mockRuntime));

    expect(vi.mocked(mockRuntime.createSession).mock.calls[0]?.[0])
      .toMatchObject({ contextTier: 'default' });
  });

  it('defaults the producer model cross-lab from the reviewer default', async () => {
    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => mockSession._emit('idle'));
    });

    await agent({
      objective: 'test objective',
      promptBuilder: () => 'test prompt',
    })(createMockInput(), createMockContext(mockRuntime));

    expect(vi.mocked(mockRuntime.createSession).mock.calls[0]?.[0])
      .toMatchObject({ model: 'gpt-5.6-sol', thinkingBudget: 'high' });
  });

  it('forwards contextTier and thinkingBudget to the session config', async () => {
    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => mockSession._emit('idle'));
    });

    await agent({
      model: 'gpt-5.6-sol',
      contextTier: 'long_context',
      thinkingBudget: 'xhigh',
      promptBuilder: () => 'test prompt',
    })(createMockInput(), createMockContext(mockRuntime));

    expect(mockRuntime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.6-sol',
        contextTier: 'long_context',
        thinkingBudget: 'xhigh',
      }),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it.each([
    {
      name: 'prefers explicit availableTools over tools',
      config: {
        availableTools: ['explicit-tool'],
        tools: [{ id: 'legacy-tool', displayName: 'Legacy Tool' }],
      },
      expected: ['explicit-tool'],
    },
    {
      name: 'derives availableTools from tools',
      config: {
        tools: [
          { id: 'tool-1', displayName: 'Tool 1' },
          { id: 'tool-2', displayName: 'Tool 2' },
        ],
      },
      expected: ['tool-1', 'tool-2'],
    },
    {
      name: 'leaves availableTools undefined when neither is set',
      config: {},
      expected: undefined,
    },
  ])('$name', async ({ config, expected }) => {
    const nodeFn = agent({
      ...config,
      promptBuilder: () => 'test prompt',
    });

    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => mockSession._emit('idle'));
    });

    await nodeFn(createMockInput(), createMockContext(mockRuntime));

    expect(mockRuntime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ availableTools: expected }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns the last usage event in metadata while preserving output emission', async () => {
    const nodeFn = agent({ promptBuilder: () => 'go' });
    const ctx = createMockContext(mockRuntime);
    const usage = {
      inputTokens: 30,
      outputTokens: 20,
      totalTokens: 50,
      model: 'test-model',
    };

    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => {
        mockSession._emit('usage', { totalTokens: 10, model: 'initial-model' });
        mockSession._emit('usage', usage);
        mockSession._emit('idle');
      });
    });

    const result = await nodeFn(createMockInput(), ctx);

    expect(result.metadata).toEqual({ usage });
    expect(ctx.emitOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'node:usage',
        inputTokens: 30,
        outputTokens: 20,
        totalTokens: 50,
        model: 'test-model',
      }),
    );
  });

  it('builds and sends prompt from promptBuilder', async () => {
    const config: AgentConfig = {
      objective: 'test',
      tools: [],
      promptBuilder: (input) => `Analyze ${input.params.repo}`,
    };

    const nodeFn = agent(config);
    const input = createMockInput();
    const ctx = createMockContext(mockRuntime);

    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => mockSession._emit('idle'));
    });

    await nodeFn(input, ctx);

    expect(mockSession.send).toHaveBeenCalledWith('Analyze test-repo');
  });

  it('handles structured prompt (system + user)', async () => {
    const config: AgentConfig = {
      objective: 'test',
      tools: [],
      promptBuilder: () => ({
        system: 'You are a helpful assistant.',
        user: 'Analyze this.',
      }),
    };

    const nodeFn = agent(config);
    const input = createMockInput();
    const ctx = createMockContext(mockRuntime);

    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => mockSession._emit('idle'));
    });

    await nodeFn(input, ctx);

    expect(mockSession.send).toHaveBeenCalledWith(
      'You are a helpful assistant.\n\nAnalyze this.',
    );
  });

  it('streams text and tool events via emitOutput', async () => {
    const config: AgentConfig = {
      objective: 'test',
      tools: [],
      promptBuilder: () => 'go',
    };

    const nodeFn = agent(config);
    const input = createMockInput();
    const ctx = createMockContext(mockRuntime);

    mockSession.send.mockImplementation(() => {
      // Simulate session activity
      queueMicrotask(() => {
        mockSession._emit('text', 'Hello world');
        mockSession._emit('tool_start', 'read_file', '/tmp/input.txt');
        mockSession._emit('tool_complete', 'read_file', 'file contents...');
        mockSession._emit('idle');
      });
    });

    await nodeFn(input, ctx);

    const emitCalls = (ctx.emitOutput as ReturnType<typeof vi.fn>).mock.calls;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = emitCalls.map((c: any[]) => c[0] as OutputEvent);

    // Prompt is emitted once immediately before the streamed response and tools.
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      type: 'node:prompt',
      content: 'go',
      role: 'agent',
      model: 'claude-opus-4.6',
      nodeId: 'node-1',
    });
    expect(events[1]).toMatchObject({
      type: 'node:output',
      content: 'Hello world',
      nodeId: 'node-1',
    });
    expect(events[2]).toMatchObject({
      type: 'node:tool',
      tool: 'read_file',
      phase: 'start',
    });
    expect(events[3]).toMatchObject({
      type: 'node:tool',
      tool: 'read_file',
      phase: 'complete',
    });
  });

  it('reads artifact and parses action on idle', async () => {
    const fs = await import('node:fs');
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      'VERDICT: PASS\nAll checks passed.',
    );

    const config: AgentConfig = {
      objective: 'test',
      tools: [],
      output: 'result.md',
      promptBuilder: () => 'go',
      actionParser: (content) => {
        if (content.includes('PASS')) return 'pass';
        if (content.includes('FAIL')) return 'fail';
        return 'default';
      },
    };

    const nodeFn = agent(config);
    const input = createMockInput();
    const ctx = createMockContext(mockRuntime);

    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => mockSession._emit('idle'));
    });

    const result = await nodeFn(input, ctx);

    expect(result.action).toBe('pass');
    expect(result.artifact).toBe('VERDICT: PASS\nAll checks passed.');
  });

  it('calls setup before and teardown after session', async () => {
    const callOrder: string[] = [];

    const config: AgentConfig = {
      objective: 'test',
      tools: [],
      promptBuilder: () => 'go',
      setup: async (_input) => {
        callOrder.push('setup');
      },
      teardown: async (_input) => {
        callOrder.push('teardown');
      },
    };

    const nodeFn = agent(config);
    const input = createMockInput();
    const ctx = createMockContext(mockRuntime);

    mockSession.send.mockImplementation(() => {
      callOrder.push('send');
      queueMicrotask(() => mockSession._emit('idle'));
    });

    await nodeFn(input, ctx);

    expect(callOrder).toEqual(['setup', 'send', 'teardown']);
  });

  it('teardown runs even on error', async () => {
    let teardownCalled = false;

    const config: AgentConfig = {
      objective: 'test',
      tools: [],
      promptBuilder: () => 'go',
      teardown: async () => {
        teardownCalled = true;
      },
    };

    const nodeFn = agent(config);
    const input = createMockInput();
    const ctx = createMockContext(mockRuntime);

    mockSession.send.mockImplementation(() => {
      queueMicrotask(() =>
        mockSession._emit('error', new Error('Session exploded')),
      );
    });

    await expect(nodeFn(input, ctx)).rejects.toThrow('Session exploded');
    expect(teardownCalled).toBe(true);
  });

  it('isolation mode sets addDirs to empty array', async () => {
    const config: AgentConfig = {
      objective: 'isolated test',
      tools: [],
      isolation: true,
      promptBuilder: () => 'go',
    };

    const nodeFn = agent(config);
    const input = createMockInput();
    const ctx = createMockContext(mockRuntime);

    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => mockSession._emit('idle'));
    });

    await nodeFn(input, ctx);

    expect(mockRuntime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ addDirs: [] }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('GT-3 crash recovery: error with completion indicator + artifact', async () => {
    const fs = await import('node:fs');
    // Simulate: artifact exists on disk
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      'Investigation completed. All sections written.',
    );

    const config: AgentConfig = {
      objective: 'test',
      tools: [],
      output: 'report.md',
      promptBuilder: () => 'go',
      completionIndicators: ['completed', 'Done.'],
      actionParser: (content) =>
        content.includes('completed') ? 'pass' : 'default',
    };

    const nodeFn = agent(config);
    const input = createMockInput();
    const ctx = createMockContext(mockRuntime);

    // Session emits text with completion indicator, then crashes
    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => {
        mockSession._emit('text', 'Working on investigation...');
        mockSession._emit('text', 'Investigation completed successfully.');
        mockSession._emit('error', new Error('Model error during summary'));
      });
    });

    const result = await nodeFn(input, ctx);

    // Should recover: artifact was written before crash
    expect(result.action).toBe('pass');
    expect(result.artifact).toContain('completed');
  });

  it('throws FlowAbortedError when signal is already aborted', async () => {
    const config: AgentConfig = {
      objective: 'test',
      tools: [],
      promptBuilder: () => 'go',
    };

    const nodeFn = agent(config);
    const input = createMockInput();
    const ac = new AbortController();
    ac.abort();
    const ctx = createMockContext(mockRuntime, { signal: ac.signal });

    await expect(nodeFn(input, ctx)).rejects.toThrow(FlowAbortedError);
  });

  it('streams reasoning events via emitOutput', async () => {
    const config: AgentConfig = {
      objective: 'test',
      tools: [],
      promptBuilder: () => 'go',
    };

    const nodeFn = agent(config);
    const input = createMockInput();
    const ctx = createMockContext(mockRuntime);

    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => {
        mockSession._emit('reasoning', 'thinking about it');
        mockSession._emit('reasoning', 'still thinking');
        mockSession._emit('text', 'final answer');
        mockSession._emit('idle');
      });
    });

    await nodeFn(input, ctx);

    const emitCalls = (ctx.emitOutput as ReturnType<typeof vi.fn>).mock.calls;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = emitCalls.map((c: any[]) => c[0] as OutputEvent);

    // Should have: 1 prompt + 2 reasoning + 1 text = 4 events
    expect(events).toHaveLength(4);

    const reasoningEvents = events.filter(e => e.type === 'node:reasoning');
    expect(reasoningEvents).toHaveLength(2);
    expect(reasoningEvents[0]).toMatchObject({
      type: 'node:reasoning',
      content: 'thinking about it',
      nodeId: 'node-1',
    });
    expect(reasoningEvents[1]).toMatchObject({
      type: 'node:reasoning',
      content: 'still thinking',
      nodeId: 'node-1',
    });

    // Verify ordering: reasoning events come before text events
    const allTypes = events.map(e => e.type);
    const firstReasoning = allTypes.indexOf('node:reasoning');
    const firstOutput = allTypes.indexOf('node:output');
    expect(firstReasoning).toBeLessThan(firstOutput);
  });

  it('deletes stale artifact before starting', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const config: AgentConfig = {
      objective: 'test',
      tools: [],
      output: 'report.md',
      promptBuilder: () => 'go',
    };

    const nodeFn = agent(config);
    const input = createMockInput();
    const ctx = createMockContext(mockRuntime);

    mockSession.send.mockImplementation(() => {
      queueMicrotask(() => mockSession._emit('idle'));
    });

    await nodeFn(input, ctx);

    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  it('removes a failed attempt artifact before retry and does not return it', async () => {
    const fs = await import('node:fs');
    const failed = createMockSession();
    const succeeded = createMockSession();
    const runtime: AgentRuntime = {
      name: 'artifact-retry-runtime',
      createSession: vi.fn()
        .mockResolvedValueOnce(failed as unknown as AgentSession)
        .mockResolvedValueOnce(succeeded as unknown as AgentSession),
      isAvailable: vi.fn().mockResolvedValue(true),
    };
    let artifact: string | undefined;
    let failedArtifactWasReadable = false;
    let artifactSeenBySecondAttempt: string | undefined;
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation(() => artifact !== undefined);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (artifact === undefined) {
        throw Object.assign(new Error('artifact not found'), { code: 'ENOENT' });
      }
      failedArtifactWasReadable = true;
      return artifact;
    });
    (fs.unlinkSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (artifact === undefined) {
        throw Object.assign(new Error('artifact not found'), { code: 'ENOENT' });
      }
      artifact = undefined;
    });
    failed.send.mockImplementation(() => queueMicrotask(() => {
      artifact = 'artifact from failed attempt';
      expect(fs.readFileSync('/tmp/test-agent/report.md', 'utf-8')).toBe(artifact);
      failed._emit('error', Object.assign(new Error('upstream unavailable'), { statusCode: 503 }));
    }));
    succeeded.send.mockImplementation(() => {
      artifactSeenBySecondAttempt = artifact;
      queueMicrotask(() => succeeded._emit('idle'));
    });

    const result = await agent({
      output: 'report.md',
      promptBuilder: () => 'go',
      retry: { maxAttempts: 2, backoffBaseMs: 100, jitter: false },
    })(createMockInput(), createMockContext(runtime));

    expect(failedArtifactWasReadable).toBe(true);
    expect(artifactSeenBySecondAttempt).toBeUndefined();
    expect(result.artifact).toBeUndefined();
    expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
  });

  it('fails before starting an attempt when its stale artifact cannot be removed', async () => {
    const fs = await import('node:fs');
    const removalError = Object.assign(new Error('artifact is locked'), { code: 'EACCES' });
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    (fs.unlinkSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw removalError;
    });

    await expect(agent({
      output: 'report.md',
      promptBuilder: () => 'go',
      retry: { maxAttempts: 1 },
    })(createMockInput(), createMockContext(mockRuntime))).rejects.toBe(removalError);

    expect(mockRuntime.createSession).not.toHaveBeenCalled();
  });

  it('retries a 499 error with a fresh session and emits node:retrying', async () => {
    const failed = createMockSession();
    const succeeded = createMockSession();
    const runtime: AgentRuntime = {
      name: 'retry-runtime',
      createSession: vi.fn()
        .mockResolvedValueOnce(failed as unknown as AgentSession)
        .mockResolvedValueOnce(succeeded as unknown as AgentSession),
      isAvailable: vi.fn().mockResolvedValue(true),
    };
    const emitState = vi.fn().mockResolvedValue(undefined);
    failed.send.mockImplementation(() => queueMicrotask(() => failed._emit(
      'error', Object.assign(new Error('499 status code 499'), { statusCode: 499 }),
    )));
    succeeded.send.mockImplementation(() => queueMicrotask(() => succeeded._emit('idle')));

    await agent({
      promptBuilder: () => 'go',
      retry: { maxAttempts: 2, backoffBaseMs: 100, jitter: false },
    })(createMockInput(), createMockContext(runtime, { emitState }));

    expect(runtime.createSession).toHaveBeenCalledTimes(2);
    expect(emitState).toHaveBeenCalledWith(expect.objectContaining({
      type: 'node:retrying',
      attempt: 2,
    }));
  });

  it('does not retry a permanent error', async () => {
    mockSession.send.mockImplementation(() => queueMicrotask(() => mockSession._emit(
      'error', Object.assign(new Error('permission denied'), { statusCode: 403 }),
    )));
    const ctx = createMockContext(mockRuntime, { emitState: vi.fn().mockResolvedValue(undefined) });

    await expect(agent({
      promptBuilder: () => 'go',
      retry: { maxAttempts: 3, backoffBaseMs: 100, jitter: false },
    })(createMockInput(), ctx)).rejects.toThrow('permission denied');

    expect(mockRuntime.createSession).toHaveBeenCalledOnce();
    expect(ctx.emitState).not.toHaveBeenCalled();
  });

  it('fails closed with the last error when attempts are exhausted', async () => {
    const first = createMockSession();
    const last = createMockSession();
    const runtime = createMockRuntime(first);
    (runtime.createSession as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(first as unknown as AgentSession)
      .mockResolvedValueOnce(last as unknown as AgentSession);
    first.send.mockImplementation(() => queueMicrotask(() => first._emit(
      'error', Object.assign(new Error('first failure'), { statusCode: 500 }),
    )));
    last.send.mockImplementation(() => queueMicrotask(() => last._emit(
      'error', Object.assign(new Error('last failure'), { statusCode: 503 }),
    )));

    await expect(agent({
      promptBuilder: () => 'go',
      retry: { maxAttempts: 2, backoffBaseMs: 100, jitter: false },
    })(createMockInput(), createMockContext(runtime))).rejects.toThrow('last failure');
    expect(runtime.createSession).toHaveBeenCalledTimes(2);
  });

  it('stops before retry when the wall-clock budget cannot cover backoff', async () => {
    mockSession.send.mockImplementation(() => queueMicrotask(() => mockSession._emit(
      'error', Object.assign(new Error('rate limited'), { statusCode: 429 }),
    )));

    await expect(agent({
      promptBuilder: () => 'go',
      retry: { maxAttempts: 3, backoffBaseMs: 50, jitter: false, budgetMs: 10 },
    })(createMockInput(), createMockContext(mockRuntime))).rejects.toThrow('rate limited');
    expect(mockRuntime.createSession).toHaveBeenCalledOnce();
  });

  it('aborts during retry backoff without starting another attempt', async () => {
    const controller = new AbortController();
    mockSession.send.mockImplementation(() => queueMicrotask(() => mockSession._emit(
      'error', Object.assign(new Error('temporary network failure'), { code: 'ECONNRESET' }),
    )));
    const emitState = vi.fn().mockImplementation(async () => {
      controller.abort();
    });

    await expect(agent({
      promptBuilder: () => 'go',
      retry: { maxAttempts: 3, backoffBaseMs: 100, jitter: false },
    })(createMockInput(), createMockContext(mockRuntime, {
      signal: controller.signal,
      emitState,
    }))).rejects.toThrow(FlowAbortedError);
    expect(mockRuntime.createSession).toHaveBeenCalledOnce();
  });

  it('preserves one-attempt behavior when no retry policy is configured', async () => {
    mockSession.send.mockImplementation(() => queueMicrotask(() => mockSession._emit(
      'error', Object.assign(new Error('transient'), { statusCode: 503 }),
    )));

    await expect(agent({ promptBuilder: () => 'go' })(
      createMockInput(), createMockContext(mockRuntime),
    )).rejects.toThrow('transient');
    expect(mockRuntime.createSession).toHaveBeenCalledOnce();
  });

  it('retries transient failures with the exported default policy', async () => {
    vi.useFakeTimers();
    try {
      const failed = createMockSession();
      const succeeded = createMockSession();
      const runtime: AgentRuntime = {
        name: 'default-retry-runtime',
        createSession: vi.fn()
          .mockResolvedValueOnce(failed as unknown as AgentSession)
          .mockResolvedValueOnce(succeeded as unknown as AgentSession),
        isAvailable: vi.fn().mockResolvedValue(true),
      };
      failed.send.mockImplementation(() => queueMicrotask(() => failed._emit(
        'error', Object.assign(new Error('transient'), { statusCode: 503 }),
      )));
      succeeded.send.mockImplementation(() => queueMicrotask(() => succeeded._emit('idle')));

      const run = agent({
        promptBuilder: () => 'go',
        retry: DEFAULT_RETRY_POLICY,
      })(createMockInput(), createMockContext(runtime));
      await vi.advanceTimersByTimeAsync(5_000);
      await run;

      expect(runtime.createSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses maxAttempts 1 to disable an explicit retry policy', async () => {
    mockSession.send.mockImplementation(() => queueMicrotask(() => mockSession._emit(
      'error', Object.assign(new Error('transient'), { statusCode: 503 }),
    )));

    await expect(agent({
      promptBuilder: () => 'go',
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
    })(createMockInput(), createMockContext(mockRuntime))).rejects.toThrow('transient');
    expect(mockRuntime.createSession).toHaveBeenCalledOnce();
  });

  it('bounds the default retry deadline to the node timeout', async () => {
    vi.useFakeTimers();
    try {
      mockSession.send.mockImplementation(() => queueMicrotask(() => mockSession._emit(
        'error', Object.assign(new Error('transient'), { statusCode: 503 }),
      )));

      const run = agent({
        promptBuilder: () => 'go',
        timeout: 1,
        retry: { backoffBaseMs: 5_000, jitter: false },
      })(createMockInput(), createMockContext(mockRuntime));
      const rejected = expect(run).rejects.toThrow('transient');
      await vi.advanceTimersByTimeAsync(1_000);

      await rejected;
      expect(mockRuntime.createSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records subagent model and token usage in node metadata', async () => {
    mockSession.send.mockImplementation(() => queueMicrotask(() => {
      mockSession._emit('subagent_end', 'Worker', {
        model: 'cheap-worker',
        totalTokens: 321,
        durationMs: 20,
        totalToolCalls: 2,
      });
      mockSession._emit('idle');
    }));

    const output = await agent({ promptBuilder: () => 'go' })(
      createMockInput(), createMockContext(mockRuntime),
    );
    expect(output.metadata?.subagentUsage).toEqual([
      { model: 'cheap-worker', totalTokens: 321 },
    ]);
  });

  it.each([
    'Auth token timeout while refreshing credentials',
    'authorization request timed out',
    'unauthorized after connection timeout',
    'forbidden because the session timed out',
    'permission denied after socket timeout',
    'invalid request because the connection timed out',
    'unprocessable response after heartbeat timeout',
  ])('does not retry a permanent text marker containing a timeout: %s', async (message) => {
    const error = new Error(message);
    mockSession.send.mockImplementation(() => queueMicrotask(() => {
      mockSession._emit('error', error);
    }));

    await expect(agent({
      promptBuilder: () => 'go',
      retry: { maxAttempts: 2, backoffBaseMs: 100, jitter: false },
    })(createMockInput(), createMockContext(mockRuntime))).rejects.toBe(error);
    expect(mockRuntime.createSession).toHaveBeenCalledOnce();
  });

  it.each([408, 425, 429, 499, 500, 503, 599])(
    'classifies status %i as retriable',
    (statusCode) => {
      expect(isRetriableModelError(new Error('model call failed'), {
        attempt: 1,
        statusCode,
      })).toBe(true);
    },
  );

  it.each([418, 460])('classifies unknown status %i as retriable', (statusCode) => {
    expect(isRetriableModelError(new Error('unrecognized failure'), {
      attempt: 1,
      statusCode,
    })).toBe(true);
  });

  it.each([400, 401, 403, 404, 405, 410, 413, 414, 415, 422])(
    'classifies permanent status %i as non-retriable',
    (statusCode) => {
      expect(isRetriableModelError(new Error('model call failed'), {
        attempt: 1,
        statusCode,
      })).toBe(false);
    },
  );

  it.each([200, 302, 399])('does not retry anomalous status %i', (statusCode) => {
    expect(isRetriableModelError(new Error('model call failed'), {
      attempt: 1,
      statusCode,
    })).toBe(false);
  });

  it('classifies an unrecognized model error without a status as retriable', () => {
    expect(isRetriableModelError(new Error('unrecognized failure'), { attempt: 1 })).toBe(true);
  });

  it('lets a retriable status override a permanent text marker', () => {
    expect(isRetriableModelError(new Error('invalid request from upstream'), {
      attempt: 1,
      statusCode: 503,
    })).toBe(true);
  });

  it('uses a permanent text marker when no structured signal exists', () => {
    expect(isRetriableModelError(new Error('invalid request from upstream'), {
      attempt: 1,
    })).toBe(false);
  });

  it('retries ECONNABORTED even when its message says aborted', () => {
    expect(isRetriableModelError(Object.assign(
      new Error('The socket operation was aborted'),
      { code: 'ECONNABORTED' },
    ), {
      attempt: 1,
      errorCode: 'ECONNABORTED',
    })).toBe(true);
  });

  it('lets a permanent message decide when the error code is unrecognized', () => {
    expect(isRetriableModelError(new Error('authentication failed for the configured key'), {
      attempt: 1,
      errorCode: 'PROVIDER_SPECIFIC_CODE',
    })).toBe(false);
  });

  it('retries an unrecognized error code when nothing marks it permanent', () => {
    expect(isRetriableModelError(new Error('upstream closed the connection'), {
      attempt: 1,
      errorCode: 'PROVIDER_SPECIFIC_CODE',
    })).toBe(true);
  });

  it.each([
    'socket hang up because the stream was aborted',
    'The operation was aborted',
    'upstream request cancelled',
  ])('does not treat transient abort text as permanent: %s', (message) => {
    expect(isRetriableModelError(new Error(message), { attempt: 1 })).toBe(true);
  });

  it('never classifies FlowAbortedError as retriable', () => {
    expect(isRetriableModelError(new FlowAbortedError(), {
      attempt: 1,
      statusCode: 503,
      errorCode: 'ECONNABORTED',
    })).toBe(false);
  });

  it('uses a caller-supplied retry classifier instead of the default', async () => {
    const error = Object.assign(new Error('invalid request'), { statusCode: 400 });
    const isRetriable = vi.fn().mockReturnValue(true);
    const failed = createMockSession();
    const succeeded = createMockSession();
    const runtime: AgentRuntime = {
      name: 'custom-classifier-runtime',
      createSession: vi.fn()
        .mockResolvedValueOnce(failed as unknown as AgentSession)
        .mockResolvedValueOnce(succeeded as unknown as AgentSession),
      isAvailable: vi.fn().mockResolvedValue(true),
    };
    failed.send.mockImplementation(() => queueMicrotask(() => failed._emit('error', error)));
    succeeded.send.mockImplementation(() => queueMicrotask(() => succeeded._emit('idle')));

    await agent({
      promptBuilder: () => 'go',
      retry: { maxAttempts: 2, backoffBaseMs: 100, jitter: false, isRetriable },
    })(createMockInput(), createMockContext(runtime));

    expect(isRetriable).toHaveBeenCalledWith(error, {
      attempt: 1,
      statusCode: 400,
    });
    expect(runtime.createSession).toHaveBeenCalledTimes(2);
  });

  it('does not retry a deeply nested string-status 401 from the runtime', async () => {
    const nestedError = new Error('outer', {
      cause: new Error('middle', {
        cause: Object.assign(new Error('credential rejected'), { status: '401' }),
      }),
    });
    mockSession.send.mockImplementation(() => queueMicrotask(() => {
      mockSession._emit('error', nestedError);
    }));

    await expect(agent({
      promptBuilder: () => 'go',
      retry: { maxAttempts: 2, backoffBaseMs: 100, jitter: false },
    })(createMockInput(), createMockContext(mockRuntime))).rejects.toBe(nestedError);
    expect(mockRuntime.createSession).toHaveBeenCalledOnce();
  });

  it('retries a deeply nested string-status 503 from the runtime', async () => {
    const failed = createMockSession();
    const succeeded = createMockSession();
    const runtime: AgentRuntime = {
      name: 'deep-status-runtime',
      createSession: vi.fn()
        .mockResolvedValueOnce(failed as unknown as AgentSession)
        .mockResolvedValueOnce(succeeded as unknown as AgentSession),
      isAvailable: vi.fn().mockResolvedValue(true),
    };
    const nestedError = new Error('outer', {
      cause: new Error('middle', {
        cause: Object.assign(new Error('upstream rejected'), { statusCode: '503' }),
      }),
    });
    failed.send.mockImplementation(() => queueMicrotask(() => failed._emit('error', nestedError)));
    succeeded.send.mockImplementation(() => queueMicrotask(() => succeeded._emit('idle')));

    await agent({
      promptBuilder: () => 'go',
      retry: { maxAttempts: 2, backoffBaseMs: 100, jitter: false },
    })(createMockInput(), createMockContext(runtime));

    expect(runtime.createSession).toHaveBeenCalledTimes(2);
  });

  it('keeps retry delays finite and at least 100ms for invalid configuration and jitter', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(retryDelayMs({ backoffBaseMs: 1, jitter: true }, 1)).toBe(100);
      expect(retryDelayMs({ backoffBaseMs: 0, jitter: false }, 1)).toBe(5_000);
      expect(retryDelayMs({ backoffBaseMs: Number.NaN, jitter: false }, 1)).toBe(5_000);
      expect(retryDelayMs({
        backoffBaseMs: Number.POSITIVE_INFINITY,
        backoffMaxMs: Number.POSITIVE_INFINITY,
        jitter: false,
      }, Number.MAX_SAFE_INTEGER)).toBe(120_000);
    } finally {
      random.mockRestore();
    }
  });

  it('surfaces FlowAbortedError when abort races an in-flight 500', async () => {
    const controller = new AbortController();
    mockSession.send.mockImplementation(() => queueMicrotask(() => {
      controller.abort();
      mockSession._emit('error', Object.assign(new Error('upstream failed'), { statusCode: 500 }));
    }));

    await expect(agent({
      promptBuilder: () => 'go',
      retry: { maxAttempts: 2, backoffBaseMs: 100, jitter: false },
    })(createMockInput(), createMockContext(mockRuntime, {
      signal: controller.signal,
    }))).rejects.toThrow(FlowAbortedError);
  });

  it('aborts a late session when cancellation wins pending session creation', async () => {
    const controller = new AbortController();
    const lateSession = createMockSession();
    let resolveCreation: ((session: AgentSession) => void) | undefined;
    const creation = new Promise<AgentSession>((resolve) => {
      resolveCreation = resolve;
    });
    const runtime: AgentRuntime = {
      name: 'slow-creation-runtime',
      createSession: vi.fn().mockReturnValue(creation),
      isAvailable: vi.fn().mockResolvedValue(true),
    };

    const runPromise = agent({ promptBuilder: () => 'go' })(
      createMockInput(),
      createMockContext(runtime, { signal: controller.signal }),
    );
    await Promise.resolve();
    controller.abort();

    await expect(runPromise).rejects.toThrow(FlowAbortedError);
    resolveCreation?.(lateSession as unknown as AgentSession);
    await Promise.resolve();
    await Promise.resolve();

    expect(lateSession.abort).toHaveBeenCalledOnce();
    expect(lateSession.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// wasCompletedBeforeCrash unit tests
// ---------------------------------------------------------------------------

describe('wasCompletedBeforeCrash', () => {
  vi.mock('node:fs', () => ({
    existsSync: vi.fn().mockReturnValue(false),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
  }));

  it('returns false when no indicator in output', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      'This is a real artifact with enough content to pass.',
    );

    const result = wasCompletedBeforeCrash(
      '/tmp/test',
      'output.md',
      ['Working...', 'Still working...'],
    );

    expect(result).toBe(false);
  });

  it('returns false when indicator present but no artifact', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = wasCompletedBeforeCrash(
      '/tmp/test',
      'output.md',
      ['Task completed successfully'],
    );

    expect(result).toBe(false);
  });

  it('returns false when indicator present but artifact too small', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('tiny');

    const result = wasCompletedBeforeCrash(
      '/tmp/test',
      'output.md',
      ['Task completed successfully'],
    );

    expect(result).toBe(false);
  });

  it('returns true when both conditions met', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      'Full investigation report with all sections. This artifact has substantial content.',
    );

    const result = wasCompletedBeforeCrash(
      '/tmp/test',
      'output.md',
      ['Working...', 'Task completed successfully'],
    );

    expect(result).toBe(true);
  });

  it('uses custom indicators when provided', async () => {
    const fs = await import('node:fs');
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      'Full artifact with enough content to pass the threshold check.',
    );

    // Default indicators should not match
    const withDefault = wasCompletedBeforeCrash(
      '/tmp/test',
      'output.md',
      ['CUSTOM_DONE_MARKER appeared'],
    );
    expect(withDefault).toBe(false);

    // Custom indicator should match
    const withCustom = wasCompletedBeforeCrash(
      '/tmp/test',
      'output.md',
      ['CUSTOM_DONE_MARKER appeared'],
      ['CUSTOM_DONE_MARKER'],
    );
    expect(withCustom).toBe(true);
  });
});
