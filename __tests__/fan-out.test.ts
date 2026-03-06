/**
 * Fan-out tests — 8 cases covering parallel dispatch, diamond convergence,
 * conditional fan-out, 'end' targets, edge events, and multi-level fan-out.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  NodeFn,
  NodeEntry,
  RunOptions,
  FlowGraph,
  AgentRuntime,
  NodeInput,
  ExecutionContext,
} from '../src/types';
import { FlowValidationError } from '../src/types';
import type { ExecutionEvent } from '../src/events';
import { run, validateGraph } from '../src/scheduler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockNode(action: string): NodeFn {
  return async (_input: NodeInput, _ctx: ExecutionContext) => ({ action });
}

function mkEntry(fn: NodeFn, opts?: Partial<NodeEntry>): NodeEntry {
  return {
    fn,
    displayName: opts?.displayName ?? 'test',
    nodeType: opts?.nodeType ?? 'deterministic',
    output: opts?.output,
    reads: opts?.reads,
    model: opts?.model,
    timeout: opts?.timeout,
  };
}

function mkOpts(overrides?: Partial<RunOptions>): RunOptions {
  const ac = new AbortController();
  const mockRuntime: AgentRuntime = {
    name: 'test-runtime',
    createSession: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
  return {
    executionId: 'exec-fan',
    dir: '/tmp/fan-out-test',
    params: {},
    runtime: mockRuntime,
    emitState: vi.fn().mockResolvedValue(undefined),
    emitOutput: vi.fn(),
    signal: ac.signal,
    ...overrides,
  };
}

function collectEvents(opts: RunOptions): ExecutionEvent[] {
  const events: ExecutionEvent[] = [];
  const origEmit = opts.emitState;
  (opts as { emitState: typeof origEmit }).emitState = async (event: ExecutionEvent) => {
    events.push(event);
    await origEmit(event);
  };
  return events;
}

// ---------------------------------------------------------------------------
// Fan-out tests
// ---------------------------------------------------------------------------

describe('fan-out', () => {
  // Test 1: A → [B, C]: both dispatch in parallel
  it('dispatches fan-out targets in parallel', async () => {
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { executed.push('A'); return { action: 'default' }; }),
        B: mkEntry(async () => { executed.push('B'); return { action: 'default' }; }),
        C: mkEntry(async () => { executed.push('C'); return { action: 'default' }; }),
      },
      edges: { A: { default: ['B', 'C'] } },
      start: ['A'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(executed).toContain('A');
    expect(executed).toContain('B');
    expect(executed).toContain('C');
    // B and C run after A
    expect(executed.indexOf('A')).toBeLessThan(executed.indexOf('B'));
    expect(executed.indexOf('A')).toBeLessThan(executed.indexOf('C'));
  });

  // Test 2: A → [B, C] → D: D waits for both (diamond)
  it('diamond: D waits for both B and C to complete', async () => {
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { executed.push('A'); return { action: 'default' }; }),
        B: mkEntry(async () => { executed.push('B'); return { action: 'default' }; }),
        C: mkEntry(async () => { executed.push('C'); return { action: 'default' }; }),
        D: mkEntry(async () => { executed.push('D'); return { action: 'default' }; }),
      },
      edges: {
        A: { default: ['B', 'C'] },
        B: { default: 'D' },
        C: { default: 'D' },
      },
      start: ['A'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(executed).toEqual(['A', 'B', 'C', 'D']);
  });

  // Test 3: Conditional fan-out: pass → [B, C], fail → D
  it('conditional fan-out routes based on action', async () => {
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { executed.push('A'); return { action: 'pass' }; }),
        B: mkEntry(async () => { executed.push('B'); return { action: 'default' }; }),
        C: mkEntry(async () => { executed.push('C'); return { action: 'default' }; }),
        D: mkEntry(async () => { executed.push('D'); return { action: 'default' }; }),
      },
      edges: {
        A: { pass: ['B', 'C'], fail: 'D' },
      },
      start: ['A'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(executed).toContain('B');
    expect(executed).toContain('C');
    expect(executed).not.toContain('D');
  });

  // Test 4: Fan-out with 'end': [B, 'end'] → only B dispatches
  it('fan-out with end: only non-end targets dispatch', async () => {
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { executed.push('A'); return { action: 'default' }; }),
        B: mkEntry(async () => { executed.push('B'); return { action: 'default' }; }),
      },
      edges: { A: { default: ['B', 'end'] } },
      start: ['A'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(executed).toEqual(['A', 'B']);
  });

  // Test 5: Fan-out edge events: one edge:traversed per target
  it('emits one edge:traversed per fan-out target', async () => {
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(mockNode('default')),
        B: mkEntry(mockNode('default')),
        C: mkEntry(mockNode('default')),
      },
      edges: { A: { default: ['B', 'C'] } },
      start: ['A'],
    };

    const opts = mkOpts();
    const events = collectEvents(opts);
    await run(graph, opts);

    const edgeEvents = events.filter(e => e.type === 'edge:traversed');
    expect(edgeEvents).toHaveLength(2);
    const targets = edgeEvents.map(e => (e as { target: string }).target).sort();
    expect(targets).toEqual(['B', 'C']);
  });

  // Test 6: All fan-out targets fail → downstream skipped
  it('all fan-out targets fail: downstream never runs', async () => {
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(mockNode('default')),
        B: mkEntry(async () => { throw new Error('B failed'); }),
        C: mkEntry(async () => { throw new Error('C failed'); }),
        D: mkEntry(async () => { executed.push('D'); return { action: 'default' }; }),
      },
      edges: {
        A: { default: ['B', 'C'] },
        B: { default: 'D' },
        C: { default: 'D' },
      },
      start: ['A'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    // Flow completes with failures — D never executes because B and C both failed
    expect(result.completed).toBe(false);
    expect(executed).not.toContain('D');
  });

  // Test 7: Partial fan-out failure → downstream waits for all settled
  it('partial fan-out failure: downstream waits for all sources', async () => {
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(mockNode('default')),
        B: mkEntry(async () => { throw new Error('B failed'); }),
        C: mkEntry(async () => { executed.push('C'); return { action: 'default' }; }),
        D: mkEntry(async () => { executed.push('D'); return { action: 'default' }; }),
      },
      edges: {
        A: { default: ['B', 'C'] },
        B: { default: 'D' },
        C: { default: 'D' },
      },
      start: ['A'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    // B failed but C succeeded. D has two sources (B, C). B failed so B never fired to D.
    // C fired to D. But D's firedEdges only has C. Since C is completed, D runs.
    // Actually: D's firedEdges will have only C (since B failed and never fired).
    // So D should run because all of its fired sources are completed.
    expect(executed).toContain('C');
    expect(executed).toContain('D');
    // Overall flow reports failure because B failed
    expect(result.completed).toBe(false);
  });

  // Test 8: Multi-level fan-out: A → [B, C], B → [D, E]
  it('multi-level fan-out: A → [B, C], B → [D, E]', async () => {
    const executed: string[] = [];
    const mkFn = (id: string): NodeFn => async () => {
      executed.push(id);
      return { action: 'default' };
    };
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(mkFn('A')),
        B: mkEntry(mkFn('B')),
        C: mkEntry(mkFn('C')),
        D: mkEntry(mkFn('D')),
        E: mkEntry(mkFn('E')),
      },
      edges: {
        A: { default: ['B', 'C'] },
        B: { default: ['D', 'E'] },
      },
      start: ['A'],
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(executed).toContain('A');
    expect(executed).toContain('B');
    expect(executed).toContain('C');
    expect(executed).toContain('D');
    expect(executed).toContain('E');
    // A runs first, then B and C in parallel, then D and E after B
    expect(executed.indexOf('A')).toBe(0);
    expect(executed.indexOf('B')).toBeLessThan(executed.indexOf('D'));
    expect(executed.indexOf('B')).toBeLessThan(executed.indexOf('E'));
  });
});

describe('validateGraph with fan-out', () => {
  it('validates array target existence', () => {
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(mockNode('default')),
        B: mkEntry(mockNode('default')),
      },
      edges: { A: { default: ['B', 'MISSING'] } },
      start: ['A'],
    };

    expect(() => validateGraph(graph)).toThrow(FlowValidationError);
    try {
      validateGraph(graph);
    } catch (e) {
      expect((e as FlowValidationError).issues).toContainEqual(
        expect.stringContaining('MISSING'),
      );
    }
  });

  it('rejects cycles without loopFallback', () => {
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(mockNode('default')),
        B: mkEntry(mockNode('default')),
      },
      edges: {
        A: { default: 'B' },
        B: { default: 'A' },
      },
      start: ['A'],
    };

    expect(() => validateGraph(graph)).toThrow(FlowValidationError);
    try {
      validateGraph(graph);
    } catch (e) {
      expect((e as FlowValidationError).issues).toContainEqual(
        expect.stringContaining('Cycle detected'),
      );
    }
  });

  it('accepts cycles with valid loopFallback', () => {
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(mockNode('default')),
        B: mkEntry(mockNode('default')),
        C: mkEntry(mockNode('default')),
      },
      edges: {
        A: { default: 'B' },
        B: { default: 'A' },
      },
      start: ['A'],
      loopFallback: {
        'B:default': {
          source: 'B',
          action: 'default',
          fallbackTarget: 'C',
          maxIterations: 3,
        },
      },
    };

    expect(() => validateGraph(graph)).not.toThrow();
  });

  it('rejects loopFallback with invalid fallbackTarget', () => {
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(mockNode('default')),
        B: mkEntry(mockNode('default')),
      },
      edges: {
        A: { default: 'B' },
        B: { default: 'A' },
      },
      start: ['A'],
      loopFallback: {
        'B:default': {
          source: 'B',
          action: 'default',
          fallbackTarget: 'MISSING',
          maxIterations: 3,
        },
      },
    };

    expect(() => validateGraph(graph)).toThrow(FlowValidationError);
    try {
      validateGraph(graph);
    } catch (e) {
      expect((e as FlowValidationError).issues).toContainEqual(
        expect.stringContaining('MISSING'),
      );
    }
  });
});
