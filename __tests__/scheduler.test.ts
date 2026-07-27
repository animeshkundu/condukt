/**
 * Scheduler tests — 12 cases covering all topologies and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  NodeFn,
  NodeEntry,
  RunOptions,
  FlowGraph,
  ResumeState,
  AgentRuntime,
  AgentSession,
  NodeInput,
  ExecutionContext,
} from '../src/types';
import {
  DEFAULT_AGENT_TIMEOUT_SECS,
  FlowValidationError,
  FlowAbortedError,
} from '../src/types';
import type { ExecutionEvent, OutputEvent } from '../src/events';
import { run, computeFrontier, validateGraph } from '../src/scheduler';
import { agent } from '../src/agent';
import { deterministic } from '../src/nodes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockNode(
  action: string,
  artifact?: string,
  metadata?: Record<string, unknown>,
): NodeFn {
  return async (_input: NodeInput, _ctx: ExecutionContext) => ({
    action,
    artifact,
    metadata,
  });
}

function mockNodeEntry(
  fn: NodeFn,
  opts?: Partial<NodeEntry>,
): NodeEntry {
  return {
    fn,
    displayName: opts?.displayName ?? 'test-node',
    nodeType: opts?.nodeType ?? 'deterministic',
    output: opts?.output,
    reads: opts?.reads,
    model: opts?.model,
    timeout: opts?.timeout,
  };
}

function mockRunOptions(
  overrides?: Partial<RunOptions>,
): RunOptions {
  const ac = new AbortController();
  const mockRuntime: AgentRuntime = {
    name: 'test-runtime',
    createSession: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
  };

  return {
    executionId: 'exec-1',
    dir: '/tmp/test-flow',
    params: {},
    runtime: mockRuntime,
    emitState: vi.fn().mockResolvedValue(undefined),
    emitOutput: vi.fn(),
    signal: ac.signal,
    ...overrides,
  };
}

function emittedTypes(opts: RunOptions): string[] {
  const calls = (opts.emitState as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[ExecutionEvent]>;
  return calls.map(([event]) => event.type);
}

function emittedEvents(opts: RunOptions): ExecutionEvent[] {
  const calls = (opts.emitState as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[ExecutionEvent]>;
  return calls.map(([event]) => event);
}

type SessionHandler = (...args: unknown[]) => void;

interface UsageSession {
  readonly session: AgentSession;
  readonly emit: (event: string, ...args: unknown[]) => void;
}

function usageSession(onSend: (emit: UsageSession['emit']) => void): UsageSession {
  const handlers = new Map<string, SessionHandler[]>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  };
  const session = {
    pid: null,
    send: () => onSend(emit),
    on: (event: string, handler: SessionHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    abort: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentSession;
  return { session, emit };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scheduler', () => {
  // Mock fs for artifact operations
  vi.mock('node:fs', () => ({
    existsSync: vi.fn().mockReturnValue(false),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
  }));

  describe('run', () => {
    it('linear flow: A → B → C', async () => {
      const order: string[] = [];
      const mkFn = (id: string): NodeFn => async () => {
        order.push(id);
        return { action: 'default' };
      };

      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(mkFn('A'), { displayName: 'Node A' }),
          B: mockNodeEntry(mkFn('B'), { displayName: 'Node B' }),
          C: mockNodeEntry(mkFn('C'), { displayName: 'Node C' }),
        },
        edges: {
          A: { default: 'B' },
          B: { default: 'C' },
        },
        start: ['A'],
      };

      const opts = mockRunOptions();
      const result = await run(graph, opts);

      expect(result.completed).toBe(true);
      expect(order).toEqual(['A', 'B', 'C']);

      const types = emittedTypes(opts);
      expect(types).toContain('run:started');
      expect(types).toContain('run:completed');
      expect(types.filter((t) => t === 'edge:traversed')).toHaveLength(2);
    });

    it('emits a cost event for usage metadata when a resolver is configured', async () => {
      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(
            deterministic('Usage node', async () => ({
              action: 'default',
              metadata: {
                usage: {
                  totalTokens: 100,
                  model: 'test-model',
                },
              },
            })),
          ),
        },
        edges: {},
        start: ['A'],
      };
      const opts = mockRunOptions({ costResolver: () => 0.5 });

      await run(graph, opts);

      const costEvent = emittedEvents(opts).find(
        (event) => event.type === 'cost:recorded',
      );
      expect(costEvent).toMatchObject({
        type: 'cost:recorded',
        executionId: 'exec-1',
        nodeId: 'A',
        cost: 0.5,
        tokens: 100,
        model: 'test-model',
      });
    });

    it('emits separate cost attribution for main-agent and subagent usage', async () => {
      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(mockNode('default', undefined, {
            usage: { totalTokens: 100, model: 'main-model' },
            subagentUsage: [
              { totalTokens: 40, model: 'cheap-worker' },
              { totalTokens: 60, model: 'review-worker' },
            ],
          }), { model: 'main-model' }),
        },
        edges: {},
        start: ['A'],
      };
      const opts = mockRunOptions({
        costResolver: (usage, model) => Number(usage.totalTokens) * (model === 'main-model' ? 2 : 1),
      });

      await run(graph, opts);

      const costs = emittedEvents(opts).filter((event) => event.type === 'cost:recorded');
      expect(costs).toHaveLength(3);
      expect(costs).toEqual(expect.arrayContaining([
        expect.objectContaining({ model: 'main-model', tokens: 100, cost: 200 }),
        expect.objectContaining({ model: 'cheap-worker', tokens: 40, cost: 40 }),
        expect.objectContaining({ model: 'review-worker', tokens: 60, cost: 60 }),
      ]));
    });

    it('uses unknown instead of the parent model for model-less subagent usage', async () => {
      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(mockNode('default', undefined, {
            subagentUsage: [{ totalTokens: 40 }],
          }), { model: 'parent-model' }),
        },
        edges: {},
        start: ['A'],
      };
      const resolver = vi.fn().mockReturnValue(4);
      const opts = mockRunOptions({ costResolver: resolver });

      await run(graph, opts);

      const costEvent = emittedEvents(opts).find(
        (event) => event.type === 'cost:recorded',
      );
      expect(costEvent).toMatchObject({
        type: 'cost:recorded',
        model: 'unknown',
        provenance: 'subagent',
        tokens: 40,
      });
      expect(resolver).toHaveBeenCalledWith(
        expect.objectContaining({ totalTokens: 40, provenance: 'subagent' }),
        'unknown',
      );
    });

    it('records main usage from failed and successful retry attempts', async () => {
      const first = usageSession((emit) => queueMicrotask(() => {
        emit('usage', { totalTokens: 10, model: 'attempt-one' });
        emit('error', Object.assign(new Error('temporary'), { statusCode: 503 }));
      }));
      const second = usageSession((emit) => queueMicrotask(() => {
        emit('usage', { totalTokens: 20, model: 'attempt-two' });
        emit('idle');
      }));
      const runtime: AgentRuntime = {
        name: 'retry-usage-runtime',
        createSession: vi.fn()
          .mockResolvedValueOnce(first.session)
          .mockResolvedValueOnce(second.session),
        isAvailable: vi.fn().mockResolvedValue(true),
      };
      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(agent({
            model: 'parent-model',
            promptBuilder: () => 'go',
            retry: { maxAttempts: 2, backoffBaseMs: 100, jitter: false },
          }), { model: 'parent-model' }),
        },
        edges: {},
        start: ['A'],
      };
      const opts = mockRunOptions({ runtime, costResolver: () => 1 });

      await run(graph, opts);

      const costs = emittedEvents(opts).filter((event) => event.type === 'cost:recorded');
      expect(costs).toEqual(expect.arrayContaining([
        expect.objectContaining({ model: 'attempt-one', tokens: 10, provenance: 'main' }),
        expect.objectContaining({ model: 'attempt-two', tokens: 20, provenance: 'main' }),
      ]));
      expect(costs).toHaveLength(2);
    });

    it('records usage from every failed attempt when retries are exhausted', async () => {
      const first = usageSession((emit) => queueMicrotask(() => {
        emit('usage', { totalTokens: 11, model: 'attempt-one' });
        emit('subagent_end', 'worker', { totalTokens: 3 });
        emit('error', Object.assign(new Error('first failure'), { statusCode: 500 }));
      }));
      const second = usageSession((emit) => queueMicrotask(() => {
        emit('usage', { totalTokens: 22, model: 'attempt-two' });
        emit('error', Object.assign(new Error('last failure'), { statusCode: 503 }));
      }));
      const runtime: AgentRuntime = {
        name: 'failed-usage-runtime',
        createSession: vi.fn()
          .mockResolvedValueOnce(first.session)
          .mockResolvedValueOnce(second.session),
        isAvailable: vi.fn().mockResolvedValue(true),
      };
      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(agent({
            model: 'parent-model',
            promptBuilder: () => 'go',
            retry: { maxAttempts: 2, backoffBaseMs: 100, jitter: false },
          }), { model: 'parent-model' }),
        },
        edges: {},
        start: ['A'],
      };
      const opts = mockRunOptions({ runtime, costResolver: () => 1 });

      const result = await run(graph, opts);

      expect(result.completed).toBe(false);
      const costs = emittedEvents(opts).filter((event) => event.type === 'cost:recorded');
      expect(costs).toEqual(expect.arrayContaining([
        expect.objectContaining({ model: 'attempt-one', tokens: 11, provenance: 'main' }),
        expect.objectContaining({ model: 'attempt-two', tokens: 22, provenance: 'main' }),
        expect.objectContaining({ model: 'unknown', tokens: 3, provenance: 'subagent' }),
      ]));
      expect(costs).toHaveLength(3);
    });

    it('parallel start: [A, B] → C (fan-in)', async () => {
      const batchTracker: string[][] = [];
      let currentBatch: string[] = [];
      let batchPromiseResolve: (() => void) | null = null;

      const mkFn = (id: string): NodeFn => async () => {
        currentBatch.push(id);
        return { action: 'default' };
      };

      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(mkFn('A'), { displayName: 'Node A' }),
          B: mockNodeEntry(mkFn('B'), { displayName: 'Node B' }),
          C: mockNodeEntry(mkFn('C'), { displayName: 'Node C' }),
        },
        edges: {
          A: { default: 'C' },
          B: { default: 'C' },
        },
        start: ['A', 'B'],
      };

      // Use emitState to track batch boundaries
      const opts = mockRunOptions();
      const originalEmitState = opts.emitState;
      let nodeStartCount = 0;
      (opts as { emitState: RunOptions['emitState'] }).emitState = async (
        event: ExecutionEvent,
      ) => {
        if (event.type === 'node:started') {
          nodeStartCount++;
        }
        if (event.type === 'run:completed' || event.type === 'edge:traversed') {
          // batch boundary detected implicitly
        }
        return originalEmitState(event);
      };

      const result = await run(graph, opts);

      expect(result.completed).toBe(true);

      // C should have executed (all 3 nodes ran)
      const calls = (originalEmitState as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[ExecutionEvent]>;
      const events = calls.map(([event]) => event);
      const completedNodes = events
        .filter((e: ExecutionEvent) => e.type === 'node:completed')
        .map((e: ExecutionEvent) => (e as { nodeId: string }).nodeId);
      expect(completedNodes).toContain('A');
      expect(completedNodes).toContain('B');
      expect(completedNodes).toContain('C');

      // A and B should complete before C
      const aIdx = completedNodes.indexOf('A');
      const bIdx = completedNodes.indexOf('B');
      const cIdx = completedNodes.indexOf('C');
      expect(cIdx).toBeGreaterThan(aIdx);
      expect(cIdx).toBeGreaterThan(bIdx);
    });

    it('conditional routing: A → pass → B, A → fail → C', async () => {
      const executed: string[] = [];

      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(
            async () => {
              executed.push('A');
              return { action: 'pass' };
            },
            { displayName: 'Node A' },
          ),
          B: mockNodeEntry(
            async () => {
              executed.push('B');
              return { action: 'default' };
            },
            { displayName: 'Node B' },
          ),
          C: mockNodeEntry(
            async () => {
              executed.push('C');
              return { action: 'default' };
            },
            { displayName: 'Node C' },
          ),
        },
        edges: {
          A: { pass: 'B', fail: 'C' },
        },
        start: ['A'],
      };

      const opts = mockRunOptions();
      const result = await run(graph, opts);

      expect(result.completed).toBe(true);
      expect(executed).toEqual(['A', 'B']);
      expect(executed).not.toContain('C');
    });

    it('abort stops execution', async () => {
      const ac = new AbortController();
      let firstBatchDone = false;

      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(
            async () => {
              firstBatchDone = true;
              return { action: 'default' };
            },
            { displayName: 'Node A' },
          ),
          B: mockNodeEntry(mockNode('default'), { displayName: 'Node B' }),
        },
        edges: {
          A: { default: 'B' },
        },
        start: ['A'],
      };

      const opts = mockRunOptions({ signal: ac.signal });

      // Intercept emitState to abort after A completes and edges fire
      const originalEmit = opts.emitState;
      (opts as { emitState: RunOptions['emitState'] }).emitState = async (
        event: ExecutionEvent,
      ) => {
        await originalEmit(event);
        // Abort after we see A's edge traversed — B will be pending next batch
        if (event.type === 'edge:traversed') {
          ac.abort();
        }
      };

      await expect(run(graph, opts)).rejects.toThrow(FlowAbortedError);

      const originalCalls = (originalEmit as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[ExecutionEvent]>;
      const types = originalCalls.map(([event]) => event.type);
      expect(types).toContain('node:killed');
      expect(types).toContain('run:completed');

      // Verify the run:completed has status 'stopped'
      const runCompleted = originalCalls
        .map(([event]) => event)
        .find((event) => event.type === 'run:completed');
      expect(runCompleted).toBeDefined();
      expect((runCompleted as { status: string }).status).toBe('stopped');
    });

    it('resume from checkpoint', async () => {
      const executed: string[] = [];

      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(
            async () => {
              executed.push('A');
              return { action: 'default' };
            },
            { displayName: 'Node A' },
          ),
          B: mockNodeEntry(
            async () => {
              executed.push('B');
              return { action: 'default' };
            },
            { displayName: 'Node B' },
          ),
        },
        edges: {
          A: { default: 'B' },
        },
        start: ['A'],
      };

      const resumeState: ResumeState = {
        completedNodes: new Map([
          ['A', { action: 'default', finishedAt: Date.now() }],
        ]),
        firedEdges: new Map([['B', new Set(['A'])]]),
        nodeStatuses: new Map([['A', 'completed']]),
        loopIterations: new Map(),
      };

      const opts = mockRunOptions({ resumeFrom: resumeState });
      const result = await run(graph, opts);

      expect(result.completed).toBe(true);
      // Only B should have executed
      expect(executed).toEqual(['B']);
      expect(executed).not.toContain('A');

      const types = emittedTypes(opts);
      expect(types).toContain('run:resumed');
    });

    it.each([
      {
        name: 'uses the agent default for a deterministic node',
        timeout: undefined,
        expected: DEFAULT_AGENT_TIMEOUT_SECS,
      },
      {
        name: 'preserves an explicit timeout',
        timeout: 37,
        expected: 37,
      },
    ])('$name', async ({ timeout, expected }) => {
      vi.useFakeTimers();
      try {
        const blockingNode: NodeFn = async (_input, ctx) => {
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { action: 'default' };
        };
        const graph: FlowGraph = {
          nodes: {
            A: mockNodeEntry(blockingNode, {
              ...(timeout === undefined ? {} : { timeout }),
            }),
          },
          edges: {},
          start: ['A'],
        };
        const opts = mockRunOptions();

        const runPromise = run(graph, opts);
        const resultExpectation = expect(runPromise).resolves.toMatchObject({ completed: false });
        await vi.advanceTimersByTimeAsync(expected * 1000);
        await resultExpectation;

        const failEvent = emittedEvents(opts).find((event) => event.type === 'node:failed');
        expect(failEvent).toMatchObject({ error: `Node timed out after ${expected}s` });
      } finally {
        vi.useRealTimers();
      }
    });

    it('node timeout aborts the execution context signal', async () => {
      let observedSignal: AbortSignal | undefined;
      let sawAbort = false;
      const slowNode: NodeFn = async (_input, ctx) => {
        observedSignal = ctx.signal;
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve();
          }, { once: true });
        });
        return { action: 'default' };
      };

      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(slowNode, {
            displayName: 'Slow Node',
            timeout: 0.01, // 10ms timeout
          }),
        },
        edges: {},
        start: ['A'],
      };

      const opts = mockRunOptions();
      const result = await run(graph, opts);

      expect(result.completed).toBe(false);
      expect(observedSignal).toBeDefined();
      expect(observedSignal).not.toBe(opts.signal);
      expect(sawAbort).toBe(true);
      expect(observedSignal!.aborted).toBe(true);

      const events = emittedEvents(opts);
      const failEvent = events.find((e) => e.type === 'node:failed');
      expect(failEvent).toBeDefined();
      expect((failEvent as { error: string }).error).toContain('timed out');
    });

    it('flow abort propagates to an active node execution context signal', async () => {
      const controller = new AbortController();
      let nodeStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        nodeStarted = resolve;
      });
      let observedSignal: AbortSignal | undefined;
      let sawAbort = false;

      const blockingNode: NodeFn = async (_input, ctx) => {
        observedSignal = ctx.signal;
        nodeStarted();
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve();
          }, { once: true });
        });
        return { action: 'default' };
      };

      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(blockingNode, { displayName: 'Blocking Node' }),
        },
        edges: {},
        start: ['A'],
      };
      const opts = mockRunOptions({ signal: controller.signal });
      const runPromise = run(graph, opts);

      await started;
      controller.abort();

      await expect(runPromise).rejects.toThrow(FlowAbortedError);
      expect(observedSignal).toBeDefined();
      expect(observedSignal).not.toBe(controller.signal);
      expect(sawAbort).toBe(true);
      expect(observedSignal!.aborted).toBe(true);
    });

    it('unmatched action falls back to default edge', async () => {
      const executed: string[] = [];

      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(
            async () => {
              executed.push('A');
              return { action: 'unexpected_action' };
            },
            { displayName: 'Node A' },
          ),
          B: mockNodeEntry(
            async () => {
              executed.push('B');
              return { action: 'default' };
            },
            { displayName: 'Node B' },
          ),
        },
        edges: {
          A: { pass: 'end', default: 'B' },
        },
        start: ['A'],
      };

      const opts = mockRunOptions();
      const result = await run(graph, opts);

      expect(result.completed).toBe(true);
      expect(executed).toEqual(['A', 'B']);
    });

    it('unmatched action with no default = terminal', async () => {
      const executed: string[] = [];

      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(
            async () => {
              executed.push('A');
              return { action: 'unknown' };
            },
            { displayName: 'Node A' },
          ),
          B: mockNodeEntry(
            async () => {
              executed.push('B');
              return { action: 'default' };
            },
            { displayName: 'Node B' },
          ),
        },
        edges: {
          A: { pass: 'B' },
        },
        start: ['A'],
      };

      const opts = mockRunOptions();
      const result = await run(graph, opts);

      expect(result.completed).toBe(true);
      // B should NOT execute because A returned 'unknown' and there's no default edge
      expect(executed).toEqual(['A']);
    });

    it('empty graph', async () => {
      const graph: FlowGraph = {
        nodes: {},
        edges: {},
        start: [],
      };

      const opts = mockRunOptions();
      const result = await run(graph, opts);

      expect(result.completed).toBe(true);

      const types = emittedTypes(opts);
      expect(types).toContain('run:started');
      expect(types).toContain('run:completed');
    });

    it('artifacts flow between nodes', async () => {
      const fs = await import('node:fs');

      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(mockNode('default', 'artifact content from A'), {
            displayName: 'Producer',
            output: 'report.md',
          }),
          B: mockNodeEntry(
            async (input: NodeInput) => {
              // Verify B receives artifact path for report.md
              expect(input.artifactPaths['report.md']).toBeDefined();
              expect(input.artifactPaths['report.md']).toContain('report.md');
              return { action: 'default' };
            },
            {
              displayName: 'Consumer',
              reads: ['report.md'],
            },
          ),
        },
        edges: {
          A: { default: 'B' },
        },
        start: ['A'],
      };

      const opts = mockRunOptions();
      const result = await run(graph, opts);

      expect(result.completed).toBe(true);

      // Verify artifact was written
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('report.md'),
        'artifact content from A',
        'utf-8',
      );

      // Verify artifact:written event was emitted
      const events = emittedEvents(opts);
      const artifactEvent = events.find((e) => e.type === 'artifact:written');
      expect(artifactEvent).toBeDefined();
      expect((artifactEvent as { size: number }).size).toBe(
        'artifact content from A'.length,
      );
    });
  });

  describe('computeFrontier', () => {
    it('retry frontier computation', () => {
      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(mockNode('default'), { displayName: 'A' }),
          B: mockNodeEntry(mockNode('default'), { displayName: 'B' }),
          C: mockNodeEntry(mockNode('default'), { displayName: 'C' }),
        },
        edges: {
          A: { default: 'B' },
          B: { default: 'C' },
        },
        start: ['A'],
      };

      // A completed, B not yet
      const state: ResumeState = {
        completedNodes: new Map([
          ['A', { action: 'default', finishedAt: Date.now() }],
        ]),
        firedEdges: new Map([['B', new Set(['A'])]]),
        nodeStatuses: new Map([['A', 'completed']]),
        loopIterations: new Map(),
      };

      const frontier = computeFrontier(graph, state);
      expect(frontier).toEqual(['B']);
    });
  });

  describe('validateGraph', () => {
    it('catches invalid edges', () => {
      const graph: FlowGraph = {
        nodes: {
          A: mockNodeEntry(mockNode('default'), { displayName: 'A' }),
        },
        edges: {
          A: { default: 'nonexistent' },
          ghost: { default: 'A' },
        },
        start: ['A', 'also_missing'],
      };

      expect(() => validateGraph(graph)).toThrow(FlowValidationError);

      try {
        validateGraph(graph);
      } catch (e) {
        const err = e as FlowValidationError;
        expect(err.issues.length).toBeGreaterThanOrEqual(3);
        // Should detect: missing start node, missing edge target, missing edge source
        expect(err.issues.some((i) => i.includes('also_missing'))).toBe(true);
        expect(err.issues.some((i) => i.includes('nonexistent'))).toBe(true);
        expect(err.issues.some((i) => i.includes('ghost'))).toBe(true);
      }
    });
  });
});
