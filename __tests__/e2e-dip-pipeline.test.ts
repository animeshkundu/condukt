/**
 * End-to-end test: availability dip pipeline pattern through the bridge API.
 *
 * Mirrors the exact topology from docs/DESIGN-FAN-OUT-LOOP-BACK.md:
 *   start: [investigateA, investigateB]
 *   investigateA + investigateB → convergenceCheck (fan-in)
 *   convergenceCheck: { converged: qualityGate, diverged: [investigateA, investigateB] }
 *   loopFallback: convergenceCheck:diverged → deepDive (maxIterations: 3)
 *   deepDive → qualityGate
 *   qualityGate: { pass: composeWorkItem, fail: end }
 *   composeWorkItem → createAndVerify
 *
 * Tests the full bridge lifecycle: launch, projection reads, convergence loop,
 * event log, and final state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBridge } from '../bridge/bridge';
import { StateRuntime } from '../state/state-runtime';
import { MemoryStorage } from '../state/storage-memory';
import type { FlowGraph, AgentRuntime, NodeEntry, NodeFn } from '../src/types';

function mockRuntime(): AgentRuntime {
  return {
    name: 'mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockRejectedValue(new Error('Mock — no sessions')),
  };
}

function mkEntry(fn: NodeFn, opts?: Partial<NodeEntry>): NodeEntry {
  return {
    fn,
    displayName: opts?.displayName ?? 'test',
    nodeType: opts?.nodeType ?? 'deterministic',
    output: opts?.output,
    reads: opts?.reads,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('e2e: availability dip pipeline through bridge', () => {
  let storage: MemoryStorage;
  let stateRuntime: StateRuntime;
  let bridge: ReturnType<typeof createBridge>;
  let tmpDir: string;

  beforeEach(() => {
    storage = new MemoryStorage();
    stateRuntime = new StateRuntime(storage);
    bridge = createBridge(mockRuntime(), stateRuntime);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dip-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('full dip pipeline: diverge once, converge on round 2, complete through QG + workitem', async () => {
    let convergenceCallCount = 0;
    const nodeExecutions: string[] = [];

    const graph: FlowGraph = {
      nodes: {
        investigateA: mkEntry(async (input) => {
          nodeExecutions.push(`investigateA:iter${input.retryContext ? '1+' : '0'}`);
          const content = input.retryContext
            ? `Revised findings from A (iteration ${input.retryContext.feedback})`
            : 'Initial findings from investigator A: root cause is config-change-x';
          return { action: 'default', artifact: content };
        }, { displayName: 'Investigate A (opus)', output: 'investigation_a.md' }),

        investigateB: mkEntry(async (input) => {
          nodeExecutions.push(`investigateB:iter${input.retryContext ? '1+' : '0'}`);
          const content = input.retryContext
            ? `Revised findings from B (iteration ${input.retryContext.feedback})`
            : 'Initial findings from investigator B: root cause is deployment-regression-y';
          return { action: 'default', artifact: content };
        }, { displayName: 'Investigate B (codex)', output: 'investigation_b.md' }),

        convergenceCheck: mkEntry(async () => {
          convergenceCallCount++;
          nodeExecutions.push(`convergenceCheck:call${convergenceCallCount}`);
          // First call: diverged (different root causes). Second call: converged.
          if (convergenceCallCount >= 2) {
            return { action: 'converged', artifact: 'VERDICT: CONVERGED\nRoot cause: config-change-x confirmed by both' };
          }
          return { action: 'diverged', artifact: 'VERDICT: DIVERGED\nA says config-change, B says deployment' };
        }, { displayName: 'Convergence Check (sonnet)', output: 'convergence.md', reads: ['investigation_a.md', 'investigation_b.md'] }),

        deepDive: mkEntry(async () => {
          nodeExecutions.push('deepDive');
          return { action: 'default', artifact: 'Deep dive resolution — should NOT run in this test' };
        }, { displayName: 'Deep Dive (opus)', output: 'final.md' }),

        qualityGate: mkEntry(async () => {
          nodeExecutions.push('qualityGate');
          return { action: 'pass' };
        }, { displayName: 'Quality Gate', nodeType: 'deterministic' }),

        composeWorkItem: mkEntry(async () => {
          nodeExecutions.push('composeWorkItem');
          return { action: 'default', artifact: 'TITLE: Fix config-change-x\nDESCRIPTION: ...' };
        }, { displayName: 'Compose Work Item (opus)', output: 'workitem.md' }),

        createAndVerify: mkEntry(async () => {
          nodeExecutions.push('createAndVerify');
          return { action: 'default', artifact: '5211465' };
        }, { displayName: 'Create & Verify (sonnet)', output: 'workitem_id.txt' }),
      },

      edges: {
        investigateA:    { default: 'convergenceCheck' },
        investigateB:    { default: 'convergenceCheck' },
        convergenceCheck: { converged: 'qualityGate', diverged: ['investigateA', 'investigateB'] },
        deepDive:        { default: 'qualityGate' },
        qualityGate:     { pass: 'composeWorkItem', fail: 'end' },
        composeWorkItem: { default: 'createAndVerify' },
      },

      start: ['investigateA', 'investigateB'],

      loopFallback: {
        'convergenceCheck:diverged': {
          source: 'convergenceCheck',
          action: 'diverged',
          fallbackTarget: 'deepDive',
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

    // Launch through the bridge (not run() directly)
    const execId = await bridge.launch({
      executionId: 'e2e-dip-001',
      graph,
      dir: path.join(tmpDir, 'e2e-dip-001'),
      params: { scenario: 'test-scenario', ask: 'Why did availability drop?' },
    });

    // Wait for execution to complete
    let projection = bridge.getExecution(execId);
    const maxWait = 10_000;
    const start = Date.now();
    while (projection?.status === 'running' && Date.now() - start < maxWait) {
      await sleep(50);
      projection = bridge.getExecution(execId);
    }

    // --- Assertions ---

    // 1. Execution completed successfully
    expect(projection!.status).toBe('completed');

    // 2. Node execution order: A+B (round 1) → check (diverged) → A+B (round 2) → check (converged) → QG → WI → verify
    expect(nodeExecutions).toEqual([
      'investigateA:iter0',
      'investigateB:iter0',
      'convergenceCheck:call1',
      'investigateA:iter1+',
      'investigateB:iter1+',
      'convergenceCheck:call2',
      'qualityGate',
      'composeWorkItem',
      'createAndVerify',
    ]);

    // 3. deepDive was NOT executed (convergence succeeded before exhaustion)
    expect(nodeExecutions).not.toContain('deepDive');

    // 4. All nodes show completed in projection
    const nodes = projection!.graph.nodes;
    const completedNodes = nodes.filter(n => n.status === 'completed');
    // 6 of 7 nodes completed — deepDive was never reached (convergence succeeded)
    expect(completedNodes.length).toBe(6);

    // deepDive stays pending (never dispatched in the converged path)
    const deepDiveNode = nodes.find(n => n.id === 'deepDive')!;
    expect(deepDiveNode.status).toBe('pending');

    // 5. Loop nodes have correct iteration count
    const nodeA = nodes.find(n => n.id === 'investigateA')!;
    const nodeB = nodes.find(n => n.id === 'investigateB')!;
    const nodeCheck = nodes.find(n => n.id === 'convergenceCheck')!;
    expect(nodeA.iteration).toBe(1);
    expect(nodeB.iteration).toBe(1);
    expect(nodeCheck.iteration).toBe(1);

    // 6. Non-loop nodes have iteration 0
    const nodeQG = nodes.find(n => n.id === 'qualityGate')!;
    expect(nodeQG.iteration).toBe(0);

    // 7. Artifacts contain latest version
    const artifactA = path.join(tmpDir, 'e2e-dip-001', 'investigation_a.md');
    const contentA = fs.readFileSync(artifactA, 'utf-8');
    expect(contentA).toContain('Revised findings');

    // 8. Work item ID artifact exists
    const wiPath = path.join(tmpDir, 'e2e-dip-001', 'workitem_id.txt');
    expect(fs.readFileSync(wiPath, 'utf-8')).toBe('5211465');

    // 9. Edge states in projection: convergence check's diverged edge was taken
    const edges = projection!.graph.edges;
    const divergedEdges = edges.filter(e => e.source === 'convergenceCheck' && e.action === 'diverged');
    expect(divergedEdges.length).toBeGreaterThan(0);
    expect(divergedEdges.some(e => e.state === 'taken')).toBe(true);

    // 10. Event log has node:reset events
    const events = stateRuntime.readEvents(execId);
    const resets = events.filter(e => e.type === 'node:reset');
    expect(resets.length).toBe(3); // investigateA, investigateB, convergenceCheck

    // 11. Params are preserved in projection
    expect(projection!.params.scenario).toBe('test-scenario');
  });

  it('full dip pipeline: never converges, falls through to deepDive', async () => {
    const nodeExecutions: string[] = [];

    const graph: FlowGraph = {
      nodes: {
        investigateA: mkEntry(async () => {
          nodeExecutions.push('A');
          return { action: 'default', artifact: 'findings A' };
        }, { displayName: 'A', output: 'a.md' }),

        investigateB: mkEntry(async () => {
          nodeExecutions.push('B');
          return { action: 'default', artifact: 'findings B' };
        }, { displayName: 'B', output: 'b.md' }),

        convergenceCheck: mkEntry(async () => {
          nodeExecutions.push('check');
          return { action: 'diverged' }; // never converges
        }, { displayName: 'Check' }),

        deepDive: mkEntry(async () => {
          nodeExecutions.push('deepDive');
          return { action: 'default', artifact: 'Deep dive resolved the disagreement' };
        }, { displayName: 'Deep Dive', output: 'final.md' }),

        done: mkEntry(async () => {
          nodeExecutions.push('done');
          return { action: 'default' };
        }, { displayName: 'Done' }),
      },

      edges: {
        investigateA:    { default: 'convergenceCheck' },
        investigateB:    { default: 'convergenceCheck' },
        convergenceCheck: { converged: 'done', diverged: ['investigateA', 'investigateB'] },
        deepDive:        { default: 'done' },
      },

      start: ['investigateA', 'investigateB'],
      maxIterations: 2,

      loopFallback: {
        'convergenceCheck:diverged': {
          source: 'convergenceCheck',
          action: 'diverged',
          fallbackTarget: 'deepDive',
          maxIterations: 2,
        },
        'investigateA:default': {
          source: 'investigateA',
          action: 'default',
          fallbackTarget: 'done',
          maxIterations: 2,
        },
        'investigateB:default': {
          source: 'investigateB',
          action: 'default',
          fallbackTarget: 'done',
          maxIterations: 2,
        },
      },
    };

    const execId = await bridge.launch({
      executionId: 'e2e-dip-002',
      graph,
      dir: path.join(tmpDir, 'e2e-dip-002'),
      params: {},
    });

    let projection = bridge.getExecution(execId);
    const start = Date.now();
    while (projection?.status === 'running' && Date.now() - start < 10_000) {
      await sleep(50);
      projection = bridge.getExecution(execId);
    }

    expect(projection!.status).toBe('completed');

    // A and B run 3 times each (iter 0, 1, 2), check runs 3 times, then deepDive, then done
    expect(nodeExecutions.filter(e => e === 'A')).toHaveLength(3);
    expect(nodeExecutions.filter(e => e === 'B')).toHaveLength(3);
    expect(nodeExecutions.filter(e => e === 'check')).toHaveLength(3);
    expect(nodeExecutions.filter(e => e === 'deepDive')).toHaveLength(1);
    expect(nodeExecutions.filter(e => e === 'done')).toHaveLength(1);

    // deepDive DID execute (fallback after exhaustion)
    const deepDiveNode = projection!.graph.nodes.find(n => n.id === 'deepDive')!;
    expect(deepDiveNode.status).toBe('completed');
  });
});
