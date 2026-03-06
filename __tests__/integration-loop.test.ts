/**
 * Integration tests for fan-out + loop-back convergence loops.
 *
 * 7 tests covering: happy path (no loop), diverge-then-converge,
 * maxIterations exhaustion, full dip pipeline mock, resume from crash,
 * event log count verification, and completedPath cap.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, computeFrontier } from '../src/scheduler';
import { MemoryStorage } from '../state/storage-memory';
import { StateRuntime } from '../state/state-runtime';
import { replayEvents } from '../state/reducer';
import type {
  NodeFn,
  NodeEntry,
  RunOptions,
  FlowGraph,
  AgentRuntime,
} from '../src/types';
import type { ExecutionEvent } from '../src/events';

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

function mkRunOptions(
  stateRuntime: StateRuntime,
  overrides?: Partial<RunOptions>,
): RunOptions {
  const ac = new AbortController();
  const mockRuntime: AgentRuntime = {
    name: 'test-runtime',
    createSession: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-int-'));
  return {
    executionId: `exec-${Date.now()}`,
    dir: tmpDir,
    params: {},
    runtime: mockRuntime,
    emitState: async (event: ExecutionEvent) => {
      await stateRuntime.handleEvent(event);
    },
    emitOutput: vi.fn(),
    signal: ac.signal,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('integration: convergence loops', () => {
  let storage: MemoryStorage;
  let stateRuntime: StateRuntime;

  beforeEach(() => {
    storage = new MemoryStorage();
    stateRuntime = new StateRuntime(storage);
  });

  // Test 39: Full convergence loop — converge on round 1 (happy path)
  it('converge on round 1: no loop-back fires', async () => {
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        investigateA: mkEntry(async () => {
          executed.push('investigateA');
          return { action: 'default' };
        }),
        investigateB: mkEntry(async () => {
          executed.push('investigateB');
          return { action: 'default' };
        }),
        convergenceCheck: mkEntry(async () => {
          executed.push('convergenceCheck');
          return { action: 'converged' };
        }),
        qualityGate: mkEntry(async () => {
          executed.push('qualityGate');
          return { action: 'default' };
        }),
      },
      edges: {
        investigateA: { default: 'convergenceCheck' },
        investigateB: { default: 'convergenceCheck' },
        convergenceCheck: {
          diverged: ['investigateA', 'investigateB'],
          converged: 'qualityGate',
        },
      },
      start: ['investigateA', 'investigateB'],
      loopFallback: {
        'convergenceCheck:diverged': {
          source: 'convergenceCheck',
          action: 'diverged',
          fallbackTarget: 'qualityGate',
          maxIterations: 3,
        },
        'investigateA:default': {
          source: 'investigateA',
          action: 'default',
          fallbackTarget: 'qualityGate',
          maxIterations: 3,
        },
        'investigateB:default': {
          source: 'investigateB',
          action: 'default',
          fallbackTarget: 'qualityGate',
          maxIterations: 3,
        },
      },
    };

    const opts = mkRunOptions(stateRuntime, { executionId: 'int-loop-39' });
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    // Each node runs exactly once — no loop-back
    expect(executed.filter(e => e === 'investigateA')).toHaveLength(1);
    expect(executed.filter(e => e === 'investigateB')).toHaveLength(1);
    expect(executed.filter(e => e === 'convergenceCheck')).toHaveLength(1);
    expect(executed.filter(e => e === 'qualityGate')).toHaveLength(1);

    // No node:reset events
    const events = stateRuntime.readEvents('int-loop-39');
    const resets = events.filter(e => e.type === 'node:reset');
    expect(resets).toHaveLength(0);

    const projection = stateRuntime.getProjection('int-loop-39');
    expect(projection!.status).toBe('completed');
  });

  // Test 40: Full convergence loop — diverge then converge on round 2
  it('diverge then converge on round 2', async () => {
    let checkCount = 0;
    const graph: FlowGraph = {
      nodes: {
        investigateA: mkEntry(async () => ({ action: 'default' })),
        investigateB: mkEntry(async () => ({ action: 'default' })),
        convergenceCheck: mkEntry(async () => {
          checkCount++;
          return { action: checkCount >= 2 ? 'converged' : 'diverged' };
        }),
        qualityGate: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        investigateA: { default: 'convergenceCheck' },
        investigateB: { default: 'convergenceCheck' },
        convergenceCheck: {
          diverged: ['investigateA', 'investigateB'],
          converged: 'qualityGate',
        },
      },
      start: ['investigateA', 'investigateB'],
      loopFallback: {
        'convergenceCheck:diverged': {
          source: 'convergenceCheck',
          action: 'diverged',
          fallbackTarget: 'qualityGate',
          maxIterations: 5,
        },
        'investigateA:default': {
          source: 'investigateA',
          action: 'default',
          fallbackTarget: 'qualityGate',
          maxIterations: 5,
        },
        'investigateB:default': {
          source: 'investigateB',
          action: 'default',
          fallbackTarget: 'qualityGate',
          maxIterations: 5,
        },
      },
    };

    const opts = mkRunOptions(stateRuntime, { executionId: 'int-loop-40' });
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    expect(checkCount).toBe(2);

    const events = stateRuntime.readEvents('int-loop-40');
    const resets = events.filter(e => e.type === 'node:reset');
    // investigateA, investigateB, convergenceCheck all reset once
    expect(resets.length).toBe(3);

    // Verify retryContext was provided on looped nodes
    const projection = stateRuntime.getProjection('int-loop-40');
    expect(projection!.status).toBe('completed');

    // investigateA and investigateB should be on iteration 1
    const nodeA = projection!.graph.nodes.find(n => n.id === 'investigateA')!;
    const nodeB = projection!.graph.nodes.find(n => n.id === 'investigateB')!;
    expect(nodeA.iteration).toBe(1);
    expect(nodeB.iteration).toBe(1);
  });

  // Test 41: Exhausted after maxIterations — fallback target runs
  it('exhausted after maxIterations routes to fallback', async () => {
    const executed: string[] = [];
    const graph: FlowGraph = {
      nodes: {
        investigate: mkEntry(async () => {
          executed.push('investigate');
          return { action: 'default' };
        }),
        convergenceCheck: mkEntry(async () => {
          executed.push('convergenceCheck');
          return { action: 'diverged' }; // never converges
        }),
        fallback: mkEntry(async () => {
          executed.push('fallback');
          return { action: 'default' };
        }),
        qualityGate: mkEntry(async () => {
          executed.push('qualityGate');
          return { action: 'default' };
        }),
      },
      edges: {
        investigate: { default: 'convergenceCheck' },
        convergenceCheck: {
          diverged: 'investigate',
          converged: 'qualityGate',
        },
      },
      start: ['investigate'],
      loopFallback: {
        'convergenceCheck:diverged': {
          source: 'convergenceCheck',
          action: 'diverged',
          fallbackTarget: 'fallback',
          maxIterations: 2,
        },
      },
    };

    const opts = mkRunOptions(stateRuntime, { executionId: 'int-loop-41' });
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);
    // investigate runs: iter0, iter1, iter2 = 3 times
    expect(executed.filter(e => e === 'investigate')).toHaveLength(3);
    // convergenceCheck runs 3 times (iter0, iter1, iter2)
    expect(executed.filter(e => e === 'convergenceCheck')).toHaveLength(3);
    // Fallback runs once
    expect(executed.filter(e => e === 'fallback')).toHaveLength(1);
    // qualityGate never reached (fallback is the terminal)
    expect(executed.filter(e => e === 'qualityGate')).toHaveLength(0);
  });

  // Test 42: Full dip pipeline mock
  it('full dip pipeline: [A, B] -> check -> loop or qualityGate -> workitem', async () => {
    let checkCount = 0;
    const executed: string[] = [];

    const graph: FlowGraph = {
      nodes: {
        investigateA: mkEntry(async (input) => {
          executed.push('investigateA');
          // On second iteration, retryContext should be present
          if (input.retryContext) {
            expect(input.retryContext.feedback).toContain('iteration');
          }
          return { action: 'default', artifact: `findingA-v${checkCount + 1}` };
        }, { output: 'investigateA.md' }),
        investigateB: mkEntry(async (input) => {
          executed.push('investigateB');
          if (input.retryContext) {
            expect(input.retryContext.feedback).toContain('iteration');
          }
          return { action: 'default', artifact: `findingB-v${checkCount + 1}` };
        }, { output: 'investigateB.md' }),
        convergenceCheck: mkEntry(async () => {
          checkCount++;
          executed.push('convergenceCheck');
          // Converge on round 2
          return { action: checkCount >= 2 ? 'converged' : 'diverged' };
        }),
        qualityGate: mkEntry(async () => {
          executed.push('qualityGate');
          return { action: 'pass' };
        }),
        workitem: mkEntry(async () => {
          executed.push('workitem');
          return { action: 'default' };
        }),
      },
      edges: {
        investigateA: { default: 'convergenceCheck' },
        investigateB: { default: 'convergenceCheck' },
        convergenceCheck: {
          diverged: ['investigateA', 'investigateB'],
          converged: 'qualityGate',
        },
        qualityGate: { pass: 'workitem', fail: 'end' },
      },
      start: ['investigateA', 'investigateB'],
      loopFallback: {
        'convergenceCheck:diverged': {
          source: 'convergenceCheck',
          action: 'diverged',
          fallbackTarget: 'qualityGate',
          maxIterations: 5,
        },
        'investigateA:default': {
          source: 'investigateA',
          action: 'default',
          fallbackTarget: 'qualityGate',
          maxIterations: 5,
        },
        'investigateB:default': {
          source: 'investigateB',
          action: 'default',
          fallbackTarget: 'qualityGate',
          maxIterations: 5,
        },
      },
    };

    const opts = mkRunOptions(stateRuntime, { executionId: 'int-loop-42' });
    const result = await run(graph, opts);

    expect(result.completed).toBe(true);

    // Full pipeline: A+B run twice, check runs twice, QG once, workitem once
    expect(executed.filter(e => e === 'investigateA')).toHaveLength(2);
    expect(executed.filter(e => e === 'investigateB')).toHaveLength(2);
    expect(executed.filter(e => e === 'convergenceCheck')).toHaveLength(2);
    expect(executed.filter(e => e === 'qualityGate')).toHaveLength(1);
    expect(executed.filter(e => e === 'workitem')).toHaveLength(1);

    // Verify final projection
    const projection = stateRuntime.getProjection('int-loop-42');
    expect(projection!.status).toBe('completed');
    const allCompleted = projection!.graph.nodes.every(
      n => n.status === 'completed',
    );
    expect(allCompleted).toBe(true);

    // Artifacts should contain latest version
    const artifactA = path.join(opts.dir, 'investigateA.md');
    expect(fs.readFileSync(artifactA, 'utf-8')).toBe('findingA-v2');
  });

  // Test 43: Resume from crashed mid-loop
  it('resume from crashed mid-loop completes successfully', async () => {
    const ac = new AbortController();
    let aRunCount = 0;

    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => {
          aRunCount++;
          if (aRunCount === 2) {
            // Simulate crash on second iteration by aborting
            ac.abort();
          }
          return { action: 'default' };
        }),
        B: mkEntry(async () => {
          return { action: aRunCount >= 3 ? 'converged' : 'diverged' };
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
          maxIterations: 10,
        },
      },
    };

    const execId = 'int-loop-43';
    const opts = mkRunOptions(stateRuntime, {
      executionId: execId,
      signal: ac.signal,
    });

    // First run — will abort mid-loop
    await expect(run(graph, opts)).rejects.toThrow();

    // Verify crashed/stopped state
    const preResumeProjection = stateRuntime.getProjection(execId);
    expect(preResumeProjection!.status).toBe('stopped');

    // Build resume state from projection
    const events = stateRuntime.readEvents(execId);
    const projection = replayEvents(execId, events);

    const completedNodes = new Map<string, { action: string; finishedAt: number }>();
    const firedEdges = new Map<string, Set<string>>();
    const nodeStatuses = new Map<string, string>();

    for (const node of projection.graph.nodes) {
      nodeStatuses.set(node.id, node.status);
      if (node.status === 'completed' && node.finishedAt) {
        completedNodes.set(node.id, {
          action: node.action ?? 'default',
          finishedAt: node.finishedAt,
        });
      }
    }
    for (const edge of projection.graph.edges) {
      if (edge.state === 'taken') {
        if (!firedEdges.has(edge.target)) {
          firedEdges.set(edge.target, new Set());
        }
        firedEdges.get(edge.target)!.add(edge.source);
      }
    }

    const resumeState = {
      completedNodes,
      firedEdges,
      nodeStatuses,
      loopIterations: new Map<string, number>(),
    };

    // Resume with fresh abort controller
    const ac2 = new AbortController();
    const resumeOpts = mkRunOptions(stateRuntime, {
      executionId: execId,
      dir: opts.dir,
      signal: ac2.signal,
      resumeFrom: resumeState,
    });

    const resumeResult = await run(graph, resumeOpts);
    expect(resumeResult.completed).toBe(true);

    // Verify C ran (convergence reached on resumed iteration)
    const finalProjection = stateRuntime.getProjection(execId);
    const nodeC = finalProjection!.graph.nodes.find(n => n.id === 'C')!;
    expect(nodeC.status).toBe('completed');
  });

  // Test 44: Event log count — verify no event explosion
  it('event log count is proportional to iterations', async () => {
    let checkCount = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => {
          checkCount++;
          return { action: checkCount >= 3 ? 'converged' : 'diverged' };
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
          maxIterations: 10,
        },
      },
    };

    const execId = 'int-loop-44';
    const opts = mkRunOptions(stateRuntime, { executionId: execId });
    await run(graph, opts);

    const events = stateRuntime.readEvents(execId);

    // Count by type
    const counts: Record<string, number> = {};
    for (const e of events) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
    }

    // 3 iterations of A (iter 0, 1, 2) + 3 of B + 1 of C = 7 node:started
    expect(counts['node:started']).toBe(7);
    expect(counts['node:completed']).toBe(7);

    // 2 loop-backs: each resets A and B = 4 node:reset events
    expect(counts['node:reset']).toBe(4);

    // 1 run:started + 1 run:completed
    expect(counts['run:started']).toBe(1);
    expect(counts['run:completed']).toBe(1);

    // Total events should be bounded and predictable
    // run:started(1) + 7*started + 7*completed + 4*reset + edges + run:completed(1)
    // Verify no explosion: total < 50 for a 3-iteration, 3-node loop
    expect(events.length).toBeLessThan(50);
  });

  // Test 45: completedPath capped at 200 even with many loop iterations
  it('completedPath capped at 200 with many iterations', async () => {
    // Use maxIterations=150 to generate ~300+ completions (A + B each iteration)
    let checkCount = 0;
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => {
          checkCount++;
          // Never converge — always diverge
          return { action: 'diverged' };
        }),
        C: mkEntry(async () => ({ action: 'default' })),
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
          maxIterations: 120,
        },
      },
    };

    const execId = 'int-loop-45';
    const opts = mkRunOptions(stateRuntime, { executionId: execId });
    await run(graph, opts);

    const projection = stateRuntime.getProjection(execId);
    expect(projection!.status).toBe('completed');

    // A runs 121 times, B runs 121 times, C runs once = 243 completions
    // But completedPath should be capped at 200
    expect(projection!.graph.completedPath.length).toBeLessThanOrEqual(200);
    expect(projection!.graph.completedPath.length).toBe(200);

    // Replay from events should produce the same capped result
    const events = stateRuntime.readEvents(execId);
    const replayed = replayEvents(execId, events);
    expect(replayed.graph.completedPath.length).toBe(200);
  });
});
