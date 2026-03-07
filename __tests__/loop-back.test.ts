/**
 * Loop-back tests — 15 cases covering loop detection, resetLoopBody contract,
 * iteration tracking, fallback routing, and lifecycle interactions.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  NodeFn,
  NodeEntry,
  RunOptions,
  FlowGraph,
  AgentRuntime,
  NodeInput,
  ExecutionContext,
} from '../src/types';
import type { ExecutionEvent } from '../src/events';
import { run } from '../src/scheduler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-test-'));
  return {
    executionId: 'exec-loop',
    dir: tmpDir,
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
// Loop-back tests
// ---------------------------------------------------------------------------

describe('loop-back', () => {
  // Test 9: Simple loop: A → B → A (converges on iteration 2)
  it('simple loop: A → B → A converges after iterations', async () => {
    let iteration = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => {
          iteration++;
          return { action: 'default' };
        }),
        B: mkEntry(async () => {
          // First time: diverge (loop back to A). Second time: converge.
          return { action: iteration >= 2 ? 'converged' : 'diverged' };
        }),
        C: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': {
          source: 'B',
          action: 'diverged',
          fallbackTarget: 'C',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    const events = collectEvents(opts);
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    // A ran twice, B ran twice, C ran once
    expect(iteration).toBe(2);

    // Check that node:reset events were emitted
    const resetEvents = events.filter(e => e.type === 'node:reset');
    expect(resetEvents.length).toBeGreaterThan(0);
  });

  // Test 10: Loop with fan-out back to multiple targets: C → [A, B] (loop-back fan-out)
  it('loop fans out back to multiple targets', async () => {
    let cRunCount = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => ({ action: 'default' })),
        C: mkEntry(async () => {
          cRunCount++;
          return { action: cRunCount >= 2 ? 'converged' : 'diverged' };
        }),
        D: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'C' },
        B: { default: 'C' },
        C: { diverged: ['A', 'B'], converged: 'D' },
      },
      start: ['A', 'B'],
      loopFallback: {
        'C:diverged': {
          source: 'C',
          action: 'diverged',
          fallbackTarget: 'D',
          maxIterations: 5,
        },
        'A:default': {
          source: 'A',
          action: 'default',
          fallbackTarget: 'D',
          maxIterations: 5,
        },
        'B:default': {
          source: 'B',
          action: 'default',
          fallbackTarget: 'D',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    const events = collectEvents(opts);
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(cRunCount).toBe(2);

    // Both A and B should have been reset
    const resetNodeIds = events
      .filter(e => e.type === 'node:reset')
      .map(e => (e as { nodeId: string }).nodeId)
      .sort();
    expect(resetNodeIds).toContain('A');
    expect(resetNodeIds).toContain('B');
  });

  // Test 11: Max iterations exhausted → routes to loopFallback
  it('max iterations exhausted routes to fallback', async () => {
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { executed.push('A'); return { action: 'default' }; }),
        B: mkEntry(async () => { executed.push('B'); return { action: 'diverged' }; }),
        C: mkEntry(async () => { executed.push('C'); return { action: 'default' }; }),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'end' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': {
          source: 'B',
          action: 'diverged',
          fallbackTarget: 'C',
          maxIterations: 2,
        },
      },
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    // A runs: iter0, iter1, iter2 = 3 times. B runs 3 times. Then fallback to C.
    expect(executed).toContain('C');
    expect(executed.filter(e => e === 'A').length).toBe(3);
    expect(executed.filter(e => e === 'B').length).toBe(3);
  });

  // Test 12: Custom per-edge maxIterations
  it('custom per-edge maxIterations', async () => {
    let bCount = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => { bCount++; return { action: 'diverged' }; }),
        C: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'end' },
      },
      start: ['A'],
      maxIterations: 10, // graph-level default
      loopFallback: {
        'B:diverged': {
          source: 'B',
          action: 'diverged',
          fallbackTarget: 'C',
          maxIterations: 1, // per-edge override — more restrictive
        },
      },
    };

    const opts = mkOpts();
    await run(graph, opts);

    // maxIterations=1: first run (iter 0), loop once (iter 1), then exceeded → fallback
    expect(bCount).toBe(2);
  });

  // Test 13: RetryContext on loop
  it('provides RetryContext with iteration feedback on loop', async () => {
    let receivedContext: { priorOutput: string | null; feedback: string } | undefined;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async (input) => {
          if (input.retryContext) {
            receivedContext = {
              priorOutput: input.retryContext.priorOutput,
              feedback: input.retryContext.feedback,
            };
          }
          return { action: 'default', artifact: 'result from A' };
        }, { output: 'a.txt' }),
        B: mkEntry(async () => {
          if (!receivedContext) return { action: 'diverged' };
          return { action: 'converged' };
        }),
        C: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': {
          source: 'B',
          action: 'diverged',
          fallbackTarget: 'C',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    await run(graph, opts);

    expect(receivedContext).toBeDefined();
    expect(receivedContext!.feedback).toContain('iteration');
    expect(receivedContext!.priorOutput).toBe('result from A');
  });

  // Test 14: Loop resets source node
  it('loop resets source node status', async () => {
    let bRunCount = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => {
          bRunCount++;
          return { action: bRunCount >= 2 ? 'converged' : 'diverged' };
        }),
        C: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': {
          source: 'B',
          action: 'diverged',
          fallbackTarget: 'C',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    const events = collectEvents(opts);
    await run(graph, opts);

    // B (the source node) should have been reset
    const bResets = events.filter(
      e => e.type === 'node:reset' && (e as { nodeId: string }).nodeId === 'B'
    );
    expect(bResets.length).toBeGreaterThan(0);
  });

  // Test 15: Loop does NOT cascade downstream
  it('loop reset does not cascade to downstream nodes', async () => {
    const executed: string[] = [];
    let bRunCount = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { executed.push('A'); return { action: 'default' }; }),
        B: mkEntry(async () => {
          bRunCount++;
          executed.push('B');
          return { action: bRunCount >= 2 ? 'converged' : 'diverged' };
        }),
        C: mkEntry(async () => { executed.push('C'); return { action: 'default' }; }),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': {
          source: 'B',
          action: 'diverged',
          fallbackTarget: 'C',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    const events = collectEvents(opts);
    await run(graph, opts);

    // C should only run once (not reset by the loop)
    expect(executed.filter(e => e === 'C').length).toBe(1);

    // No node:reset for C
    const cResets = events.filter(
      e => e.type === 'node:reset' && (e as { nodeId: string }).nodeId === 'C'
    );
    expect(cResets).toHaveLength(0);
  });

  // Test 16: Fan-in preserved: unrelated sources not cleared
  it('loop preserves unrelated fan-in sources', async () => {
    // The loop A → B → A should not clear firedEdges for nodes outside the loop.
    // After the loop, B:converged fires to C. C should be dispatched.
    let bRunCount = 0;
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { executed.push('A'); return { action: 'default' }; }),
        B: mkEntry(async () => {
          bRunCount++;
          executed.push('B');
          return { action: bRunCount >= 2 ? 'converged' : 'diverged' };
        }),
        C: mkEntry(async () => { executed.push('C'); return { action: 'default' }; }),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': {
          source: 'B',
          action: 'diverged',
          fallbackTarget: 'C',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    const events = collectEvents(opts);
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    // C should run exactly once (after loop converges)
    expect(executed.filter(e => e === 'C').length).toBe(1);
    // No reset events for C
    const cResets = events.filter(
      e => e.type === 'node:reset' && (e as { nodeId: string }).nodeId === 'C'
    );
    expect(cResets).toHaveLength(0);
  });

  // Test 17: node:reset event emitted for each reset node
  it('emits node:reset for each reset node', async () => {
    let aRunCount = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { aRunCount++; return { action: 'default' }; }),
        B: mkEntry(async () => ({ action: aRunCount >= 2 ? 'converged' : 'diverged' })),
        C: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': {
          source: 'B',
          action: 'diverged',
          fallbackTarget: 'C',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    const events = collectEvents(opts);
    await run(graph, opts);

    const resetEvents = events.filter(e => e.type === 'node:reset');
    // A (target) and B (source) both get reset
    expect(resetEvents.length).toBe(2);
    const resetNodeIds = resetEvents.map(e => (e as { nodeId: string }).nodeId).sort();
    expect(resetNodeIds).toEqual(['A', 'B']);
  });

  // Test 18: iteration field set in node:reset event
  it('node:reset event contains correct iteration number', async () => {
    let aRunCount = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { aRunCount++; return { action: 'default' }; }),
        B: mkEntry(async () => ({ action: aRunCount >= 2 ? 'converged' : 'diverged' })),
        C: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': {
          source: 'B',
          action: 'diverged',
          fallbackTarget: 'C',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    const events = collectEvents(opts);
    await run(graph, opts);

    const resetEvents = events.filter(e => e.type === 'node:reset');
    for (const event of resetEvents) {
      const re = event as { iteration: number; reason: string; sourceNodeId: string };
      expect(re.iteration).toBe(1);
      expect(re.reason).toBe('loop-back');
      expect(re.sourceNodeId).toBe('B');
    }
  });

  // Test 19: Loop + abort
  it('loop respects abort signal', async () => {
    const ac = new AbortController();
    let aRunCount = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => {
          aRunCount++;
          if (aRunCount >= 2) ac.abort(); // abort on second run
          return { action: 'default' };
        }),
        B: mkEntry(async () => ({ action: 'diverged' })),
        C: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': {
          source: 'B',
          action: 'diverged',
          fallbackTarget: 'C',
          maxIterations: 10,
        },
      },
    };

    const opts = mkOpts({ signal: ac.signal });
    await expect(run(graph, opts)).rejects.toThrow('Flow aborted');
  });

  // Test 20: Loop + gate node as convergence check
  it('gate node can serve as loop convergence check', async () => {
    // A → B (gate that always returns 'converged' on second attempt)
    let bRunCount = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => {
          bRunCount++;
          return { action: bRunCount >= 2 ? 'converged' : 'diverged' };
        }, { nodeType: 'gate' }),
        C: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': {
          source: 'B',
          action: 'diverged',
          fallbackTarget: 'C',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(bRunCount).toBe(2);
  });

  // Test 21: Self-loop: A → A (with loopFallback)
  it('self-loop: node loops back to itself', async () => {
    let aRunCount = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => {
          aRunCount++;
          return { action: aRunCount >= 3 ? 'done' : 'retry' };
        }),
        B: mkEntry(async () => ({ action: 'default' })),
        C: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { retry: 'A', done: 'B' },
      },
      start: ['A'],
      loopFallback: {
        'A:retry': {
          source: 'A',
          action: 'retry',
          fallbackTarget: 'C',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(aRunCount).toBe(3);
  });

  // Test 22: Nested loops — inner self-loop + outer loop
  it('nested loops: inner self-loop resolves before outer loop iterates', async () => {
    let bRunCount = 0;
    let aRunCount = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => { aRunCount++; return { action: 'default' }; }),
        B: mkEntry(async () => {
          bRunCount++;
          // Self-loop once then converge
          return { action: bRunCount % 2 === 0 ? 'converged' : 'diverged' };
        }),
        C: mkEntry(async () => {
          // Outer loop: converge when A has run at least twice
          return { action: aRunCount >= 2 ? 'converged' : 'diverged' };
        }),
        D: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'B', converged: 'C' },
        C: { diverged: 'A', converged: 'D' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': {
          source: 'B',
          action: 'diverged',
          fallbackTarget: 'D',
          maxIterations: 10,
        },
        'C:diverged': {
          source: 'C',
          action: 'diverged',
          fallbackTarget: 'D',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    // A must have run at least twice for the outer loop to converge
    expect(aRunCount).toBeGreaterThanOrEqual(2);
    // B self-loops once per A iteration, so B runs at least 4 times (2 per A * 2 A runs)
    expect(bRunCount).toBeGreaterThanOrEqual(4);
  });

  // Test 23: Artifact lifecycle across iterations
  it('artifact is rewritten on each loop iteration', async () => {
    let aRunCount = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => {
          aRunCount++;
          return { action: 'default', artifact: `content-v${aRunCount}` };
        }, { output: 'a.txt' }),
        B: mkEntry(async (input) => {
          // Read the artifact
          const artifactPath = input.artifactPaths['a.txt'];
          if (artifactPath) {
            const content = fs.readFileSync(artifactPath, 'utf-8');
            if (content === 'content-v2') return { action: 'converged' };
          }
          return { action: 'diverged' };
        }, { reads: ['a.txt'] }),
        C: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': {
          source: 'B',
          action: 'diverged',
          fallbackTarget: 'C',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(aRunCount).toBe(2);
    // The artifact should contain the latest version
    const artifactPath = path.join(opts.dir, 'a.txt');
    const content = fs.readFileSync(artifactPath, 'utf-8');
    expect(content).toBe('content-v2');
  });

  // Test 24: feedbackExtractor provides rich feedback for loop-back retry context
  it('uses feedbackExtractor for loop-back retry context', async () => {
    const capturedFeedback: Record<string, string> = {};
    let cRunCount = 0;

    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async (input) => {
          if (input.retryContext) {
            capturedFeedback['A'] = input.retryContext.feedback;
          }
          return { action: 'default' };
        }),
        B: mkEntry(async (input) => {
          if (input.retryContext) {
            capturedFeedback['B'] = input.retryContext.feedback;
          }
          return { action: 'default' };
        }),
        C: mkEntry(async () => {
          cRunCount++;
          if (cRunCount < 2) {
            return { action: 'diverged', artifact: 'Models disagree on metric X' };
          }
          return { action: 'converged' };
        }, { output: 'c.txt' }),
        D: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'C' },
        B: { default: 'C' },
        C: { diverged: ['A', 'B'], converged: 'D' },
      },
      start: ['A', 'B'],
      loopFallback: {
        'C:diverged': {
          source: 'C',
          action: 'diverged',
          fallbackTarget: 'D',
          maxIterations: 5,
          feedbackExtractor: (sourceOutput) => `Disagreement: ${sourceOutput}`,
        },
        'A:default': {
          source: 'A',
          action: 'default',
          fallbackTarget: 'D',
          maxIterations: 5,
        },
        'B:default': {
          source: 'B',
          action: 'default',
          fallbackTarget: 'D',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(cRunCount).toBe(2);
    expect(capturedFeedback['A']).toBe('Disagreement: Models disagree on metric X');
    expect(capturedFeedback['B']).toBe('Disagreement: Models disagree on metric X');
  });

  // Test 25: Without feedbackExtractor, falls back to "iteration N"
  it('falls back to iteration N without feedbackExtractor', async () => {
    const capturedFeedback: Record<string, string> = {};
    let cRunCount = 0;

    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async (input) => {
          if (input.retryContext) {
            capturedFeedback['A'] = input.retryContext.feedback;
          }
          return { action: 'default' };
        }),
        B: mkEntry(async (input) => {
          if (input.retryContext) {
            capturedFeedback['B'] = input.retryContext.feedback;
          }
          return { action: 'default' };
        }),
        C: mkEntry(async () => {
          cRunCount++;
          if (cRunCount < 2) {
            return { action: 'diverged', artifact: 'Models disagree on metric X' };
          }
          return { action: 'converged' };
        }, { output: 'c.txt' }),
        D: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        A: { default: 'C' },
        B: { default: 'C' },
        C: { diverged: ['A', 'B'], converged: 'D' },
      },
      start: ['A', 'B'],
      loopFallback: {
        'C:diverged': {
          source: 'C',
          action: 'diverged',
          fallbackTarget: 'D',
          maxIterations: 5,
          // No feedbackExtractor — should fall back to "iteration N"
        },
        'A:default': {
          source: 'A',
          action: 'default',
          fallbackTarget: 'D',
          maxIterations: 5,
        },
        'B:default': {
          source: 'B',
          action: 'default',
          fallbackTarget: 'D',
          maxIterations: 5,
        },
      },
    };

    const opts = mkOpts();
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(cRunCount).toBe(2);
    expect(capturedFeedback['A']).toBe('iteration 1');
    expect(capturedFeedback['B']).toBe('iteration 1');
  });
});
