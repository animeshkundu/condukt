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
  NodeInput,
  ExecutionContext,
} from '../src/types';
import { FlowValidationError, FlowAbortedError } from '../src/types';
import type { ExecutionEvent, OutputEvent } from '../src/events';
import { run, computeFrontier, validateGraph } from '../src/scheduler';

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
  return (opts.emitState as ReturnType<typeof vi.fn>).mock.calls.map(
    (c: [ExecutionEvent]) => c[0].type,
  );
}

function emittedEvents(opts: RunOptions): ExecutionEvent[] {
  return (opts.emitState as ReturnType<typeof vi.fn>).mock.calls.map(
    (c: [ExecutionEvent]) => c[0],
  );
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
        return (originalEmitState as ReturnType<typeof vi.fn>)(event);
      };

      const result = await run(graph, opts);

      expect(result.completed).toBe(true);

      // C should have executed (all 3 nodes ran)
      const events = (originalEmitState as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: [ExecutionEvent]) => c[0],
      );
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
        await (originalEmit as ReturnType<typeof vi.fn>)(event);
        // Abort after we see A's edge traversed — B will be pending next batch
        if (event.type === 'edge:traversed') {
          ac.abort();
        }
      };

      await expect(run(graph, opts)).rejects.toThrow(FlowAbortedError);

      const types = (originalEmit as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: [ExecutionEvent]) => c[0].type,
      );
      expect(types).toContain('node:killed');
      expect(types).toContain('run:completed');

      // Verify the run:completed has status 'stopped'
      const runCompleted = (originalEmit as ReturnType<typeof vi.fn>).mock.calls
        .map((c: [ExecutionEvent]) => c[0])
        .find((e: ExecutionEvent) => e.type === 'run:completed');
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

    it('node timeout', async () => {
      const slowNode: NodeFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
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

      const events = emittedEvents(opts);
      const failEvent = events.find((e) => e.type === 'node:failed');
      expect(failEvent).toBeDefined();
      expect((failEvent as { error: string }).error).toContain('timed out');
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
