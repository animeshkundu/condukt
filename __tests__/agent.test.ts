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
import { FlowAbortedError } from '../src/types';
import { agent, wasCompletedBeforeCrash } from '../src/agent';

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

  it('creates session with correct config', async () => {
    const config: AgentConfig = {
      objective: 'test objective',
      tools: [{ id: 'tool-1', displayName: 'Tool 1' }],
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

    expect(mockRuntime.createSession).toHaveBeenCalledWith({
      model: 'gpt-5.3',
      cwd: '/tmp/test-agent',
      addDirs: ['/tmp/test-agent'],
      timeout: 1800,
      heartbeatTimeout: 60,
    });
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

    // Should have: 1 text output + 1 tool start + 1 tool complete = 3 events
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: 'node:output',
      content: 'Hello world',
      nodeId: 'node-1',
    });
    expect(events[1]).toMatchObject({
      type: 'node:tool',
      tool: 'read_file',
      phase: 'start',
    });
    expect(events[2]).toMatchObject({
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

    // Should have: 2 reasoning + 1 text = 3 events
    expect(events).toHaveLength(3);

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

    // existsSync is called first to check for stale artifact, then unlinkSync to delete
    expect(fs.unlinkSync).toHaveBeenCalled();
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
