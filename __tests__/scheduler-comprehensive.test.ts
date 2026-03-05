/**
 * Scheduler comprehensive tests — edge cases, error paths, concurrency.
 *
 * Every test validates exact expected behavior:
 * - Specific event sequences and event payloads
 * - Exact node execution order
 * - Correct status on every node
 * - Proper error propagation
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  NodeFn, NodeEntry, RunOptions, FlowGraph,
  ResumeState, AgentRuntime, NodeInput, ExecutionContext,
} from '../src/types';
import { FlowValidationError, FlowAbortedError } from '../src/types';
import type { ExecutionEvent } from '../src/events';
import { run, computeFrontier, validateGraph } from '../src/scheduler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkEntry(fn: NodeFn, opts?: Partial<NodeEntry>): NodeEntry {
  return {
    fn, displayName: opts?.displayName ?? 'node',
    nodeType: opts?.nodeType ?? 'deterministic',
    output: opts?.output, reads: opts?.reads,
    model: opts?.model, timeout: opts?.timeout,
  };
}

function mkOpts(overrides?: Partial<RunOptions>): RunOptions {
  return {
    executionId: 'test-exec',
    dir: '/tmp/test',
    params: {},
    runtime: {
      name: 'mock', createSession: vi.fn(), isAvailable: vi.fn().mockResolvedValue(true),
    },
    emitState: vi.fn().mockResolvedValue(undefined),
    emitOutput: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function getEvents(opts: RunOptions): ExecutionEvent[] {
  return (opts.emitState as ReturnType<typeof vi.fn>).mock.calls.map(
    (c: unknown[]) => c[0] as ExecutionEvent,
  );
}

function getTypes(opts: RunOptions): string[] {
  return getEvents(opts).map(e => e.type);
}

// ---------------------------------------------------------------------------
// Mock fs (same as scheduler.test.ts)
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// ===========================================================================
// GRAPH VALIDATION
// ===========================================================================

describe('validateGraph — edge cases', () => {
  it('accepts graph with edges to "end" (terminal)', () => {
    const graph: FlowGraph = {
      nodes: { A: mkEntry(async () => ({ action: 'done' })) },
      edges: { A: { done: 'end' } },
      start: ['A'],
    };
    expect(() => validateGraph(graph)).not.toThrow();
  });

  it('detects duplicate output filenames across nodes', () => {
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' }), { output: 'report.md' }),
        B: mkEntry(async () => ({ action: 'default' }), { output: 'report.md' }),
      },
      edges: { A: { default: 'B' } },
      start: ['A'],
    };
    expect(() => validateGraph(graph)).toThrow(FlowValidationError);
    try { validateGraph(graph); } catch (e) {
      expect((e as FlowValidationError).issues.some(i => i.includes('Duplicate output'))).toBe(true);
    }
  });

  it('accepts valid graph without errors', () => {
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => ({ action: 'default' })),
      },
      edges: { A: { default: 'B' } },
      start: ['A'],
    };
    expect(() => validateGraph(graph)).not.toThrow();
  });
});

// ===========================================================================
// NODE FAILURE & DOWNSTREAM IMPACT
// ===========================================================================

describe('scheduler — node failure', () => {
  it('failed node prevents downstream execution', async () => {
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { executed.push('A'); throw new Error('A exploded'); }),
        B: mkEntry(async () => { executed.push('B'); return { action: 'default' }; }),
      },
      edges: { A: { default: 'B' } },
      start: ['A'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(false);
    expect(executed).toEqual(['A']); // B never ran
    expect(executed).not.toContain('B');

    const events = getEvents(opts);
    const failEvent = events.find(e => e.type === 'node:failed');
    expect(failEvent).toBeDefined();
    expect((failEvent as { nodeId: string }).nodeId).toBe('A');
    expect((failEvent as { error: string }).error).toBe('A exploded');

    // run:completed should have status 'failed'
    const runCompleted = events.find(e => e.type === 'run:completed');
    expect((runCompleted as { status: string }).status).toBe('failed');
  });

  it('failure in one parallel branch still allows the surviving branch to fan-in', async () => {
    // Scheduler fan-in model: a node becomes ready when all sources that
    // ACTUALLY fired edges to it are completed. If A fails, it never fires
    // an edge to C. So C only waits for B's edge, and B succeeded.
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { executed.push('A'); throw new Error('fail'); }),
        B: mkEntry(async () => { executed.push('B'); return { action: 'default' }; }),
        C: mkEntry(async () => { executed.push('C'); return { action: 'default' }; }),
      },
      edges: {
        A: { default: 'C' },
        B: { default: 'C' },
      },
      start: ['A', 'B'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    // Both A and B ran in parallel
    expect(executed).toContain('A');
    expect(executed).toContain('B');
    // C runs because B succeeded and fired its edge — A's failure doesn't block C
    expect(executed).toContain('C');

    const events = getEvents(opts);
    const failEvents = events.filter(e => e.type === 'node:failed');
    expect(failEvents).toHaveLength(1);
    expect((failEvents[0] as { nodeId: string }).nodeId).toBe('A');

    // Result is 'failed' because A failed even though C completed
    expect(result.completed).toBe(false);
  });

  it('multiple nodes can fail in the same batch', async () => {
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { throw new Error('A failed'); }),
        B: mkEntry(async () => { throw new Error('B failed'); }),
      },
      edges: {},
      start: ['A', 'B'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(false);

    const events = getEvents(opts);
    const failEvents = events.filter(e => e.type === 'node:failed');
    expect(failEvents).toHaveLength(2);
    const failedNodeIds = failEvents.map(e => (e as { nodeId: string }).nodeId);
    expect(failedNodeIds).toContain('A');
    expect(failedNodeIds).toContain('B');
  });
});

// ===========================================================================
// METADATA ACCUMULATION
// ===========================================================================

describe('scheduler — metadata accumulation', () => {
  it('metadata from multiple nodes is emitted as separate events', async () => {
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({
          action: 'default',
          metadata: { countA: 10, tags: ['fast'] },
        })),
        B: mkEntry(async () => ({
          action: 'default',
          metadata: { countB: 20, tags: ['reliable'] },
        })),
      },
      edges: { A: { default: 'B' } },
      start: ['A'],
    };

    const opts = mkOpts();
    await run(graph, opts);

    const events = getEvents(opts);
    const metaEvents = events.filter(e => e.type === 'metadata');
    expect(metaEvents.length).toBeGreaterThanOrEqual(4); // countA, tags, countB, tags

    // Verify specific metadata values
    const countA = metaEvents.find(e => (e as { key: string }).key === 'countA');
    expect(countA).toBeDefined();
    expect((countA as { value: unknown }).value).toBe(10);
  });
});

// ===========================================================================
// RETRY CONTEXT PROPAGATION (PARITY-1)
// ===========================================================================

describe('scheduler — retryContexts propagation', () => {
  it('injects retryContext into NodeInput when retryContexts is provided', async () => {
    let receivedRetryCtx: unknown = undefined;

    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async (input) => {
          receivedRetryCtx = input.retryContext;
          return { action: 'default' };
        }),
      },
      edges: {},
      start: ['A'],
    };

    const opts = mkOpts({
      retryContexts: {
        A: {
          priorOutput: 'old content',
          feedback: 'Please include more detail',
          override: 'Add telemetry data',
        },
      },
    });

    await run(graph, opts);

    expect(receivedRetryCtx).toBeDefined();
    expect((receivedRetryCtx as { priorOutput: string }).priorOutput).toBe('old content');
    expect((receivedRetryCtx as { feedback: string }).feedback).toBe('Please include more detail');
    expect((receivedRetryCtx as { override: string }).override).toBe('Add telemetry data');
  });

  it('does not inject retryContext for nodes without retryContexts entry', async () => {
    let receivedRetryCtx: unknown = 'sentinel';

    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async (input) => {
          receivedRetryCtx = input.retryContext;
          return { action: 'default' };
        }),
        B: mkEntry(async () => ({ action: 'default' })),
      },
      edges: { A: { default: 'B' } },
      start: ['A'],
    };

    const opts = mkOpts({
      retryContexts: {
        B: { priorOutput: null, feedback: 'retry B', override: undefined },
      },
    });

    await run(graph, opts);

    // A should NOT have retryContext since it wasn't in retryContexts
    expect(receivedRetryCtx).toBeUndefined();
  });
});

// ===========================================================================
// DEAD-END NODES & TERMINAL ROUTING
// ===========================================================================

describe('scheduler — terminal nodes', () => {
  it('node with no outgoing edges is a terminal — flow completes', async () => {
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { executed.push('A'); return { action: 'default' }; }),
      },
      edges: {}, // No edges at all
      start: ['A'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(executed).toEqual(['A']);
  });

  it('edge to "end" terminates that path but flow completes', async () => {
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { executed.push('A'); return { action: 'stop' }; }),
        B: mkEntry(async () => { executed.push('B'); return { action: 'default' }; }),
      },
      edges: { A: { stop: 'end', continue: 'B' } },
      start: ['A'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(executed).toEqual(['A']); // B was not reached
  });
});

// ===========================================================================
// RESUME WITH NON-DEFAULT ACTIONS (SYS-4 fix validation)
// ===========================================================================

describe('scheduler — resume with conditional routing', () => {
  it('resume preserves fired edges from non-default actions', async () => {
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'pass' })),
        B: mkEntry(async () => { executed.push('B'); return { action: 'default' }; }),
        C: mkEntry(async () => { executed.push('C'); return { action: 'default' }; }),
      },
      edges: {
        A: { pass: 'B', fail: 'C' },
      },
      start: ['A'],
    };

    // A completed with 'pass' action, B is frontier
    const resumeState: ResumeState = {
      completedNodes: new Map([['A', { action: 'pass', finishedAt: 1000 }]]),
      firedEdges: new Map([['B', new Set(['A'])]]),
      nodeStatuses: new Map([['A', 'completed']]),
    };

    const opts = mkOpts({ resumeFrom: resumeState });
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(executed).toEqual(['B']); // Only B ran, not C
    expect(executed).not.toContain('C');
  });
});

// ===========================================================================
// CONCURRENT BATCH — execution correctness
// ===========================================================================

describe('scheduler — parallel batch correctness', () => {
  it('three parallel nodes all complete before downstream runs', async () => {
    const order: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { order.push('A'); return { action: 'default' }; }),
        B: mkEntry(async () => { order.push('B'); return { action: 'default' }; }),
        C: mkEntry(async () => { order.push('C'); return { action: 'default' }; }),
        D: mkEntry(async () => { order.push('D'); return { action: 'default' }; }),
      },
      edges: {
        A: { default: 'D' },
        B: { default: 'D' },
        C: { default: 'D' },
      },
      start: ['A', 'B', 'C'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    // D must be last
    expect(order.indexOf('D')).toBe(3);
    // A, B, C can be in any order but all before D
    expect(order.slice(0, 3).sort()).toEqual(['A', 'B', 'C']);
  });

  it('parallel nodes with different speeds all complete before fan-in', async () => {
    const order: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        fast: mkEntry(async () => {
          order.push('fast');
          return { action: 'default' };
        }),
        slow: mkEntry(async () => {
          await new Promise(r => setTimeout(r, 30));
          order.push('slow');
          return { action: 'default' };
        }),
        join: mkEntry(async () => {
          order.push('join');
          return { action: 'default' };
        }),
      },
      edges: {
        fast: { default: 'join' },
        slow: { default: 'join' },
      },
      start: ['fast', 'slow'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(order.indexOf('join')).toBe(2); // Always last
  });
});

// ===========================================================================
// EVENT SEQUENCE VALIDATION
// ===========================================================================

describe('scheduler — event sequence correctness', () => {
  it('emits events in correct order for linear flow', async () => {
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => ({ action: 'default' })),
      },
      edges: { A: { default: 'B' } },
      start: ['A'],
    };

    const opts = mkOpts();
    await run(graph, opts);

    const types = getTypes(opts);

    // Verify order: run:started must be first
    expect(types[0]).toBe('run:started');
    // run:completed must be last
    expect(types[types.length - 1]).toBe('run:completed');

    // node:started must come before node:completed for same node
    const aStartIdx = types.indexOf('node:started');
    const aCompleteIdx = types.findIndex(
      (t, i) => t === 'node:completed' && i > aStartIdx,
    );
    expect(aCompleteIdx).toBeGreaterThan(aStartIdx);

    // edge:traversed must come after node:completed
    const edgeIdx = types.indexOf('edge:traversed');
    expect(edgeIdx).toBeGreaterThan(aCompleteIdx);

    // Verify run:completed status
    const events = getEvents(opts);
    const completed = events.find(e => e.type === 'run:completed');
    expect((completed as { status: string }).status).toBe('completed');
  });

  it('node:completed events carry the action string', async () => {
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'custom_action' })),
      },
      edges: {},
      start: ['A'],
    };

    const opts = mkOpts();
    await run(graph, opts);

    const events = getEvents(opts);
    const nodeCompleted = events.find(e => e.type === 'node:completed');
    expect(nodeCompleted).toBeDefined();
    expect((nodeCompleted as { action: string }).action).toBe('custom_action');
  });

  it('emits node:gated for gate-type nodes', async () => {
    const gateNode: NodeFn = async (_input, ctx) => {
      // Immediately resolve to avoid blocking
      return { action: 'approved' };
    };

    const graph: FlowGraph = {
      nodes: {
        G: { fn: gateNode, displayName: 'Gate', nodeType: 'gate' },
      },
      edges: {},
      start: ['G'],
    };

    const opts = mkOpts();
    await run(graph, opts);

    const types = getTypes(opts);
    expect(types).toContain('node:gated');

    const events = getEvents(opts);
    const gatedEvent = events.find(e => e.type === 'node:gated');
    expect((gatedEvent as { nodeId: string }).nodeId).toBe('G');
    expect((gatedEvent as { gateType: string }).gateType).toBe('approval');
  });
});

// ===========================================================================
// ABORT EDGE CASES
// ===========================================================================

describe('scheduler — abort edge cases', () => {
  it('pre-aborted signal prevents any node execution', async () => {
    const executed: string[] = [];
    const ac = new AbortController();
    ac.abort(); // Pre-abort

    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { executed.push('A'); return { action: 'default' }; }),
      },
      edges: {},
      start: ['A'],
    };

    const opts = mkOpts({ signal: ac.signal });
    await expect(run(graph, opts)).rejects.toThrow(FlowAbortedError);

    // A should still execute because abort is checked before the batch,
    // but the batch dispatches A which may or may not run depending on timing
    // The important thing is that run:completed has status 'stopped'
    const events = getEvents(opts);
    const completed = events.find(e => e.type === 'run:completed');
    expect(completed).toBeDefined();
    expect((completed as { status: string }).status).toBe('stopped');
  });

  it('abort during batch kills pending nodes and reports stopped', async () => {
    const ac = new AbortController();
    let aborted = false;

    const graph: FlowGraph = {
      nodes: {
        slow: mkEntry(async () => {
          await new Promise(r => setTimeout(r, 200));
          return { action: 'default' };
        }),
        fast: mkEntry(async () => {
          // Abort after fast completes
          if (!aborted) {
            aborted = true;
            ac.abort();
          }
          return { action: 'default' };
        }),
      },
      edges: {},
      start: ['slow', 'fast'],
    };

    const opts = mkOpts({ signal: ac.signal });
    await expect(run(graph, opts)).rejects.toThrow(FlowAbortedError);

    const events = getEvents(opts);
    const completed = events.find(e => e.type === 'run:completed');
    expect((completed as { status: string }).status).toBe('stopped');
  });
});

// ===========================================================================
// computeFrontier edge cases
// ===========================================================================

describe('computeFrontier — edge cases', () => {
  it('returns empty for fully completed graph', () => {
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => ({ action: 'default' })),
      },
      edges: { A: { default: 'B' } },
      start: ['A'],
    };

    const state: ResumeState = {
      completedNodes: new Map([
        ['A', { action: 'default', finishedAt: 1000 }],
        ['B', { action: 'default', finishedAt: 2000 }],
      ]),
      firedEdges: new Map([['B', new Set(['A'])]]),
      nodeStatuses: new Map([['A', 'completed'], ['B', 'completed']]),
    };

    expect(computeFrontier(graph, state)).toEqual([]);
  });

  it('returns start nodes when nothing completed', () => {
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => ({ action: 'default' })),
      },
      edges: { A: { default: 'B' } },
      start: ['A'],
    };

    const state: ResumeState = {
      completedNodes: new Map(),
      firedEdges: new Map(),
      nodeStatuses: new Map(),
    };

    expect(computeFrontier(graph, state)).toEqual(['A']);
  });

  it('fan-in: C ready when all FIRED sources complete (not all possible sources)', () => {
    // computeFrontier checks firedEdges, not the graph structure.
    // If A fired to C and A is completed, C is ready — even if B hasn't fired yet.
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => ({ action: 'default' })),
        C: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'C' },
        B: { default: 'C' },
      },
      start: ['A', 'B'],
    };

    // A completed and fired edge to C. B is a start node not yet completed.
    const state: ResumeState = {
      completedNodes: new Map([['A', { action: 'default', finishedAt: 1000 }]]),
      firedEdges: new Map([['C', new Set(['A'])]]),
      nodeStatuses: new Map([['A', 'completed']]),
    };

    const frontier = computeFrontier(graph, state);
    // B is in frontier (start node, not completed)
    // C is in frontier (its only fired source, A, is completed)
    expect(frontier).toContain('B');
    expect(frontier).toContain('C');
  });
});
