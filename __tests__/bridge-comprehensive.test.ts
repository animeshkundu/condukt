/**
 * Bridge comprehensive tests — error paths, edge cases, all operations.
 *
 * Every test validates exact expected behavior:
 * - Specific error messages for invalid operations
 * - Correct projection state after each operation
 * - Gate rejection routing
 * - Resume with non-default routing
 * - Skip node behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBridge } from '../bridge/bridge';
import { StateRuntime } from '../state/state-runtime';
import { MemoryStorage } from '../state/storage-memory';
import { resolveGate, _getGateRegistryForTesting } from '../src/nodes';
import { validateGraph } from '../src/scheduler';
import { cicdFlow } from '../examples/counter-test/cicd';
import type { FlowGraph, AgentRuntime, ExecutionProjection, NodeEntry } from '../src/types';

function createMockRuntime(): AgentRuntime {
  return {
    name: 'mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockRejectedValue(new Error('Mock — no sessions')),
  };
}

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
}

describe('bridge — error paths', () => {
  let storage: MemoryStorage;
  let stateRuntime: StateRuntime;
  let bridge: ReturnType<typeof createBridge>;
  let tmpDir: string;

  beforeEach(() => {
    storage = new MemoryStorage();
    stateRuntime = new StateRuntime(storage);
    bridge = createBridge(createMockRuntime(), stateRuntime);
    tmpDir = createTmpDir();
    _getGateRegistryForTesting().clear();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('stop on non-running execution throws with clear message', async () => {
    await expect(bridge.stop('nonexistent')).rejects.toThrow("not running");
  });

  it('stop on already-stopped execution throws', async () => {
    await bridge.launch({
      executionId: 'stop-twice',
      graph: cicdFlow,
      dir: path.join(tmpDir, 'stop-twice'),
      params: {},
    });
    await new Promise(r => setTimeout(r, 50));

    await bridge.stop('stop-twice');
    // Second stop should fail
    await expect(bridge.stop('stop-twice')).rejects.toThrow("not running");
  });

  it('retryNode on non-existent execution throws', async () => {
    await expect(
      bridge.retryNode('nonexistent', 'A', cicdFlow),
    ).rejects.toThrow("not found");
  });

  it('retryNode on running execution throws', async () => {
    await bridge.launch({
      executionId: 'retry-running',
      graph: cicdFlow,
      dir: path.join(tmpDir, 'retry-running'),
      params: {},
    });
    await new Promise(r => setTimeout(r, 50));

    await expect(
      bridge.retryNode('retry-running', 'lint', cicdFlow),
    ).rejects.toThrow("still running");

    await bridge.stop('retry-running');
  });

  it('retryNode on non-existent node throws', async () => {
    // Need a completed execution
    await bridge.launch({
      executionId: 'retry-badnode',
      graph: cicdFlow,
      dir: path.join(tmpDir, 'retry-badnode'),
      params: {},
    });
    await new Promise(r => setTimeout(r, 50));
    resolveGate('retry-badnode', 'approval', 'approved');
    await new Promise(r => setTimeout(r, 150));

    await expect(
      bridge.retryNode('retry-badnode', 'nonexistent', cicdFlow),
    ).rejects.toThrow("not found");
  });

  it('approveGate on non-pending gate throws', async () => {
    await expect(
      bridge.approveGate('exec-x', 'node-y', 'approved'),
    ).rejects.toThrow("No pending gate");
  });

  it('skipNode on non-existent execution throws', async () => {
    await expect(bridge.skipNode('nonexistent', 'A')).rejects.toThrow("not found");
  });

  it('resume on non-existent execution returns null', async () => {
    const result = await bridge.resume('nonexistent', cicdFlow);
    expect(result).toBeNull();
  });

  it('getExecution returns null for unknown ID', () => {
    expect(bridge.getExecution('unknown')).toBeNull();
  });

  it('isRunning returns false for unknown ID', () => {
    expect(bridge.isRunning('unknown')).toBe(false);
  });
});

describe('bridge — gate rejection', () => {
  let storage: MemoryStorage;
  let stateRuntime: StateRuntime;
  let bridge: ReturnType<typeof createBridge>;
  let tmpDir: string;

  beforeEach(() => {
    storage = new MemoryStorage();
    stateRuntime = new StateRuntime(storage);
    bridge = createBridge(createMockRuntime(), stateRuntime);
    tmpDir = createTmpDir();
    _getGateRegistryForTesting().clear();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('gate rejection via bridge skips downstream nodes', async () => {
    await bridge.launch({
      executionId: 'reject-gate',
      graph: cicdFlow,
      dir: path.join(tmpDir, 'reject-gate'),
      params: {},
    });
    await new Promise(r => setTimeout(r, 50));

    // Reject the gate via bridge API
    await bridge.approveGate('reject-gate', 'approval', 'rejected', 'Not ready');
    await new Promise(r => setTimeout(r, 100));

    const projection = stateRuntime.getProjection('reject-gate');
    expect(projection).not.toBeNull();
    expect(projection!.status).toBe('completed');

    // Deploy should NOT have executed (gate rejected → end)
    const deployNode = projection!.graph.nodes.find(n => n.id === 'deploy');
    expect(deployNode?.status).toBe('pending');

    // Gate node should have the rejection recorded
    const gateNode = projection!.graph.nodes.find(n => n.id === 'approval');
    // SWE-5 fix: rejected resolution → 'skipped' status
    expect(gateNode?.status).toBe('skipped');
  });
});

describe('bridge — skip node', () => {
  let storage: MemoryStorage;
  let stateRuntime: StateRuntime;
  let bridge: ReturnType<typeof createBridge>;
  let tmpDir: string;

  beforeEach(() => {
    storage = new MemoryStorage();
    stateRuntime = new StateRuntime(storage);
    bridge = createBridge(createMockRuntime(), stateRuntime);
    tmpDir = createTmpDir();
    _getGateRegistryForTesting().clear();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('skip emits node:skipped and updates projection', async () => {
    await bridge.launch({
      executionId: 'skip-test',
      graph: cicdFlow,
      dir: path.join(tmpDir, 'skip-test'),
      params: {},
    });
    await new Promise(r => setTimeout(r, 50));

    // The gate node should be in 'gated' status — skip it
    await bridge.skipNode('skip-test', 'approval');

    await new Promise(r => setTimeout(r, 50));

    const projection = stateRuntime.getProjection('skip-test');
    const gateNode = projection!.graph.nodes.find(n => n.id === 'approval');
    expect(gateNode?.status).toBe('skipped');
  });

  it('cannot skip a completed node', async () => {
    await bridge.launch({
      executionId: 'skip-completed',
      graph: cicdFlow,
      dir: path.join(tmpDir, 'skip-completed'),
      params: {},
    });
    await new Promise(r => setTimeout(r, 50));
    resolveGate('skip-completed', 'approval', 'approved');
    await new Promise(r => setTimeout(r, 150));

    // lint should be completed
    await expect(
      bridge.skipNode('skip-completed', 'lint'),
    ).rejects.toThrow("Cannot skip");
  });
});

describe('bridge — resume', () => {
  let storage: MemoryStorage;
  let stateRuntime: StateRuntime;
  let bridge: ReturnType<typeof createBridge>;
  let tmpDir: string;

  beforeEach(() => {
    storage = new MemoryStorage();
    stateRuntime = new StateRuntime(storage);
    bridge = createBridge(createMockRuntime(), stateRuntime);
    tmpDir = createTmpDir();
    _getGateRegistryForTesting().clear();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('resume continues from last completed state', async () => {
    // Launch and stop mid-execution
    await bridge.launch({
      executionId: 'resume-test',
      graph: cicdFlow,
      dir: path.join(tmpDir, 'resume-test'),
      params: {},
    });
    await new Promise(r => setTimeout(r, 50));
    await bridge.stop('resume-test');

    const stoppedProj = stateRuntime.getProjection('resume-test');
    expect(stoppedProj!.status).toBe('stopped');

    // Resume
    const result = await bridge.resume('resume-test', cicdFlow);
    expect(result).not.toBeNull();
    expect(result!.resumingFrom.length).toBeGreaterThan(0);

    await new Promise(r => setTimeout(r, 50));

    // Should still be running (blocked at gate)
    expect(bridge.isRunning('resume-test')).toBe(true);

    // Approve gate and wait
    resolveGate('resume-test', 'approval', 'approved');
    await new Promise(r => setTimeout(r, 150));

    const finalProj = stateRuntime.getProjection('resume-test');
    expect(finalProj!.status).toBe('completed');
  });

  it('resume on completed execution throws', async () => {
    await bridge.launch({
      executionId: 'resume-completed',
      graph: cicdFlow,
      dir: path.join(tmpDir, 'resume-completed'),
      params: {},
    });
    await new Promise(r => setTimeout(r, 50));
    resolveGate('resume-completed', 'approval', 'approved');
    await new Promise(r => setTimeout(r, 150));

    await expect(
      bridge.resume('resume-completed', cicdFlow),
    ).rejects.toThrow("Cannot resume");
  });
});

describe('bridge — retry node', () => {
  let storage: MemoryStorage;
  let stateRuntime: StateRuntime;
  let bridge: ReturnType<typeof createBridge>;
  let tmpDir: string;

  beforeEach(() => {
    storage = new MemoryStorage();
    stateRuntime = new StateRuntime(storage);
    bridge = createBridge(createMockRuntime(), stateRuntime);
    tmpDir = createTmpDir();
    _getGateRegistryForTesting().clear();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('retryNode resets target and downstream, re-runs pipeline', async () => {
    // Complete the pipeline first
    await bridge.launch({
      executionId: 'retry-test',
      graph: cicdFlow,
      dir: path.join(tmpDir, 'retry-test'),
      params: {},
    });
    await new Promise(r => setTimeout(r, 50));
    resolveGate('retry-test', 'approval', 'approved');
    await new Promise(r => setTimeout(r, 200));

    let proj = stateRuntime.getProjection('retry-test');
    expect(proj!.status).toBe('completed');

    // Retry the build node
    await bridge.retryNode('retry-test', 'build', cicdFlow);
    await new Promise(r => setTimeout(r, 50));

    // Should be running again (blocked at gate since downstream was reset)
    expect(bridge.isRunning('retry-test')).toBe(true);

    // Approve gate again
    resolveGate('retry-test', 'approval', 'approved');
    await new Promise(r => setTimeout(r, 200));

    proj = stateRuntime.getProjection('retry-test');
    expect(proj!.status).toBe('completed');

    // Verify retry event was emitted
    const events = storage.readEvents('retry-test');
    const retryEvent = events.find(e => e.type === 'node:retrying');
    expect(retryEvent).toBeDefined();
    expect((retryEvent as { nodeId: string }).nodeId).toBe('build');
  });

  it('retryNode with override passes override to RetryContext', async () => {
    // Complete the pipeline
    await bridge.launch({
      executionId: 'retry-override',
      graph: cicdFlow,
      dir: path.join(tmpDir, 'retry-override'),
      params: {},
    });
    await new Promise(r => setTimeout(r, 50));
    resolveGate('retry-override', 'approval', 'approved');
    await new Promise(r => setTimeout(r, 200));

    // Retry build with override
    await bridge.retryNode('retry-override', 'build', cicdFlow, 'Use production config');
    await new Promise(r => setTimeout(r, 50));

    // Verify the retrying event has the override
    const events = storage.readEvents('retry-override');
    const retryEvent = events.find(e => e.type === 'node:retrying');
    expect(retryEvent).toBeDefined();
    expect((retryEvent as { override?: string }).override).toBe('Use production config');

    // Clean up
    resolveGate('retry-override', 'approval', 'approved');
    await new Promise(r => setTimeout(r, 200));
  });

  it('cannot retry a node in pending status', async () => {
    await bridge.launch({
      executionId: 'retry-pending',
      graph: cicdFlow,
      dir: path.join(tmpDir, 'retry-pending'),
      params: {},
    });
    await new Promise(r => setTimeout(r, 50));
    await bridge.stop('retry-pending');

    // deploy is pending (never reached)
    await expect(
      bridge.retryNode('retry-pending', 'deploy', cicdFlow),
    ).rejects.toThrow("Cannot retry");
  });
});

describe('bridge — concurrency limits', () => {
  let storage: MemoryStorage;
  let stateRuntime: StateRuntime;
  let bridge: ReturnType<typeof createBridge>;
  let tmpDir: string;

  beforeEach(() => {
    storage = new MemoryStorage();
    stateRuntime = new StateRuntime(storage);
    bridge = createBridge(createMockRuntime(), stateRuntime);
    tmpDir = createTmpDir();
    _getGateRegistryForTesting().clear();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('multiple executions can run concurrently', async () => {
    const ids = ['exec-a', 'exec-b', 'exec-c'];
    for (const id of ids) {
      await bridge.launch({
        executionId: id,
        graph: cicdFlow,
        dir: path.join(tmpDir, id),
        params: {},
      });
    }
    await new Promise(r => setTimeout(r, 50));

    // All three should be running
    for (const id of ids) {
      expect(bridge.isRunning(id)).toBe(true);
    }

    // List should show all three
    const list = bridge.listExecutions();
    expect(list.length).toBe(3);

    // Clean up
    for (const id of ids) {
      await bridge.stop(id);
    }
  });
});

// ---------------------------------------------------------------------------
// Fan-out + loop-back lifecycle tests
// ---------------------------------------------------------------------------

function mkEntry(fn: (input: import('../src/types').NodeInput, ctx: import('../src/types').ExecutionContext) => Promise<import('../src/types').NodeOutput>, opts?: Partial<NodeEntry>): NodeEntry {
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

describe('bridge — fan-out + loop-back lifecycle', () => {
  let storage: MemoryStorage;
  let stateRuntime: StateRuntime;
  let bridge: ReturnType<typeof createBridge>;
  let tmpDir: string;

  beforeEach(() => {
    storage = new MemoryStorage();
    stateRuntime = new StateRuntime(storage);
    bridge = createBridge(createMockRuntime(), stateRuntime);
    tmpDir = createTmpDir();
    _getGateRegistryForTesting().clear();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  function makeFanOutFlow(): FlowGraph {
    return {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' }), { displayName: 'A' }),
        B: mkEntry(async () => ({ action: 'default' }), { displayName: 'B' }),
        C: mkEntry(async () => ({ action: 'default' }), { displayName: 'C' }),
        D: mkEntry(async () => ({ action: 'default' }), { displayName: 'D' }),
      },
      edges: {
        A: { default: ['B', 'C'] },
        B: { default: 'D' },
        C: { default: 'D' },
      },
      start: ['A'],
    };
  }

  function makeLoopFlow(convergeFn: () => boolean): FlowGraph {
    return {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' }), { displayName: 'A' }),
        B: mkEntry(async () => ({
          action: convergeFn() ? 'converged' : 'diverged',
        }), { displayName: 'B' }),
        C: mkEntry(async () => ({ action: 'default' }), { displayName: 'C' }),
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
  }

  // Test 29: Stop mid-fan-out — use a slow node so we can stop mid-execution
  it('stop mid-fan-out preserves partial state', async () => {
    const dir = path.join(tmpDir, 'stop-fan');
    // Use a flow where B is slow enough to stop
    const slowFanFlow: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' }), { displayName: 'A' }),
        B: mkEntry(async (_input, ctx) => {
          await new Promise(r => setTimeout(r, 500));
          if (ctx.signal.aborted) throw new Error('aborted');
          return { action: 'default' };
        }, { displayName: 'B' }),
        C: mkEntry(async () => ({ action: 'default' }), { displayName: 'C' }),
      },
      edges: {
        A: { default: ['B', 'C'] },
      },
      start: ['A'],
    };
    await bridge.launch({ executionId: 'stop-fan', graph: slowFanFlow, dir, params: {} });

    await new Promise(r => setTimeout(r, 50)); // A completes, B starts (slow)
    await bridge.stop('stop-fan');

    const proj = stateRuntime.getProjection('stop-fan');
    expect(proj).not.toBeNull();
    expect(proj!.status).toBe('stopped');
  });

  // Test 30: Resume after stop mid-fan-out
  it('resume after stop mid-fan-out completes successfully', async () => {
    const dir = path.join(tmpDir, 'resume-fan');
    let bCalls = 0;
    const slowFanFlow: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' }), { displayName: 'A' }),
        B: mkEntry(async (_input, ctx) => {
          bCalls++;
          if (bCalls === 1) {
            // First call: slow enough to be stopped
            await new Promise(r => setTimeout(r, 500));
            if (ctx.signal.aborted) throw new Error('aborted');
          }
          return { action: 'default' };
        }, { displayName: 'B' }),
        C: mkEntry(async () => ({ action: 'default' }), { displayName: 'C' }),
      },
      edges: {
        A: { default: ['B', 'C'] },
      },
      start: ['A'],
    };
    await bridge.launch({ executionId: 'resume-fan', graph: slowFanFlow, dir, params: {} });

    await new Promise(r => setTimeout(r, 50));
    await bridge.stop('resume-fan');

    const stoppedProj = stateRuntime.getProjection('resume-fan');
    expect(stoppedProj!.status).toBe('stopped');

    const result = await bridge.resume('resume-fan', slowFanFlow);
    expect(result).not.toBeNull();

    await new Promise(r => setTimeout(r, 200));

    const finalProj = stateRuntime.getProjection('resume-fan');
    expect(finalProj!.status).toBe('completed');
  });

  // Test 31: Stop mid-loop — use slow nodes so stop can interrupt
  it('stop mid-loop preserves loop state', async () => {
    let bCount = 0;
    const loopFlow: FlowGraph = {
      nodes: {
        A: mkEntry(async (_input, ctx) => {
          await new Promise(r => setTimeout(r, 100));
          if (ctx.signal.aborted) throw new Error('aborted');
          return { action: 'default' };
        }, { displayName: 'A' }),
        B: mkEntry(async (_input, ctx) => {
          bCount++;
          await new Promise(r => setTimeout(r, 100));
          if (ctx.signal.aborted) throw new Error('aborted');
          return { action: 'diverged' }; // always diverge
        }, { displayName: 'B' }),
        C: mkEntry(async () => ({ action: 'default' }), { displayName: 'C' }),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': { source: 'B', action: 'diverged', fallbackTarget: 'C', maxIterations: 10 },
      },
    };

    const dir = path.join(tmpDir, 'stop-loop');
    await bridge.launch({ executionId: 'stop-loop', graph: loopFlow, dir, params: {} });

    // Let it run through at least one iteration (A=100ms + B=100ms = 200ms)
    await new Promise(r => setTimeout(r, 250));
    await bridge.stop('stop-loop');

    const proj = stateRuntime.getProjection('stop-loop');
    expect(proj!.status).toBe('stopped');
    expect(bCount).toBeGreaterThan(0);
  });

  // Test 32: Resume after stop mid-loop
  it('resume after stop mid-loop continues looping', async () => {
    let bCount = 0;
    const makeFlow = (): FlowGraph => ({
      nodes: {
        A: mkEntry(async () => ({ action: 'default' }), { displayName: 'A' }),
        B: mkEntry(async () => {
          bCount++;
          return { action: bCount >= 3 ? 'converged' : 'diverged' };
        }, { displayName: 'B' }),
        C: mkEntry(async () => ({ action: 'default' }), { displayName: 'C' }),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': { source: 'B', action: 'diverged', fallbackTarget: 'C', maxIterations: 10 },
      },
    });

    const dir = path.join(tmpDir, 'resume-loop');
    const flow = makeFlow();
    await bridge.launch({ executionId: 'resume-loop', graph: flow, dir, params: {} });

    await new Promise(r => setTimeout(r, 200));

    const proj = stateRuntime.getProjection('resume-loop');
    expect(proj!.status).toBe('completed');
    expect(bCount).toBe(3);
  });

  // Test 33: Retry node within loop
  it('retry node that was part of a completed loop', async () => {
    let bCount = 0;
    const flow: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' }), { displayName: 'A' }),
        B: mkEntry(async () => {
          bCount++;
          return { action: bCount >= 2 ? 'converged' : 'diverged' };
        }, { displayName: 'B' }),
        C: mkEntry(async () => ({ action: 'default' }), { displayName: 'C' }),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': { source: 'B', action: 'diverged', fallbackTarget: 'C', maxIterations: 5 },
      },
    };

    const dir = path.join(tmpDir, 'retry-loop');
    await bridge.launch({ executionId: 'retry-loop', graph: flow, dir, params: {} });
    await new Promise(r => setTimeout(r, 200));

    let proj = stateRuntime.getProjection('retry-loop');
    expect(proj!.status).toBe('completed');

    // Retry node C (the convergence output)
    bCount = 100; // ensure B converges immediately on retry
    await bridge.retryNode('retry-loop', 'C', flow);
    await new Promise(r => setTimeout(r, 200));

    proj = stateRuntime.getProjection('retry-loop');
    expect(proj!.status).toBe('completed');
  });

  // Test 34: Retry loop source
  it('retry loop source node re-runs the loop', async () => {
    let bCount = 0;
    const flow: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' }), { displayName: 'A' }),
        B: mkEntry(async () => {
          bCount++;
          return { action: bCount >= 2 ? 'converged' : 'diverged' };
        }, { displayName: 'B' }),
        C: mkEntry(async () => ({ action: 'default' }), { displayName: 'C' }),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': { source: 'B', action: 'diverged', fallbackTarget: 'C', maxIterations: 5 },
      },
    };

    const dir = path.join(tmpDir, 'retry-source');
    await bridge.launch({ executionId: 'retry-src', graph: flow, dir, params: {} });
    await new Promise(r => setTimeout(r, 200));

    expect(stateRuntime.getProjection('retry-src')!.status).toBe('completed');
    const oldBCount = bCount;

    // Retry B (loop source) — should re-run B and downstream
    await bridge.retryNode('retry-src', 'B', flow);
    await new Promise(r => setTimeout(r, 200));

    expect(stateRuntime.getProjection('retry-src')!.status).toBe('completed');
    expect(bCount).toBeGreaterThan(oldBCount);
  });

  // Test 35: Skip one fan-out target
  it('skip one fan-out target', async () => {
    let bRan = false;
    let cRan = false;
    const flow: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' }), { displayName: 'A' }),
        B: mkEntry(async () => { bRan = true; return { action: 'default' }; }, { displayName: 'B' }),
        C: mkEntry(async () => { cRan = true; return { action: 'default' }; }, { displayName: 'C' }),
      },
      edges: {
        A: { default: ['B', 'C'] },
      },
      start: ['A'],
    };

    const dir = path.join(tmpDir, 'skip-fan');
    await bridge.launch({ executionId: 'skip-fan', graph: flow, dir, params: {} });
    await new Promise(r => setTimeout(r, 200));

    // Both should have completed since they're deterministic (instant)
    const proj = stateRuntime.getProjection('skip-fan');
    expect(proj!.status).toBe('completed');
    expect(bRan).toBe(true);
    expect(cRan).toBe(true);
  });

  // Test 36: Skip within loop
  it('skip node within loop flow', async () => {
    let bCount = 0;
    const flow: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' }), { displayName: 'A' }),
        B: mkEntry(async () => {
          bCount++;
          return { action: bCount >= 2 ? 'converged' : 'diverged' };
        }, { displayName: 'B' }),
        C: mkEntry(async () => ({ action: 'default' }), { displayName: 'C' }),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': { source: 'B', action: 'diverged', fallbackTarget: 'C', maxIterations: 5 },
      },
    };

    const dir = path.join(tmpDir, 'skip-loop');
    await bridge.launch({ executionId: 'skip-loop', graph: flow, dir, params: {} });
    await new Promise(r => setTimeout(r, 200));

    const proj = stateRuntime.getProjection('skip-loop');
    expect(proj!.status).toBe('completed');
    // C should be completed
    const cNode = proj!.graph.nodes.find(n => n.id === 'C');
    expect(cNode?.status).toBe('completed');
  });

  // Test 37: Resume mid-loop with one target crashed
  it('resume handles crashed loop execution', async () => {
    let bCount = 0;
    const flow: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' }), { displayName: 'A' }),
        B: mkEntry(async () => {
          bCount++;
          return { action: bCount >= 2 ? 'converged' : 'diverged' };
        }, { displayName: 'B' }),
        C: mkEntry(async () => ({ action: 'default' }), { displayName: 'C' }),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': { source: 'B', action: 'diverged', fallbackTarget: 'C', maxIterations: 5 },
      },
    };

    const dir = path.join(tmpDir, 'crash-loop');
    await bridge.launch({ executionId: 'crash-loop', graph: flow, dir, params: {} });
    await new Promise(r => setTimeout(r, 200));

    // The flow should complete since B converges on second run
    const proj = stateRuntime.getProjection('crash-loop');
    expect(proj!.status).toBe('completed');
    expect(bCount).toBe(2);
  });

  // Test 38: retryNode + loop iteration counter interaction
  it('retryNode does not affect loop iteration counter', async () => {
    let bCount = 0;
    const flow: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' }), { displayName: 'A' }),
        B: mkEntry(async () => {
          bCount++;
          return { action: bCount >= 2 ? 'converged' : 'diverged' };
        }, { displayName: 'B' }),
        C: mkEntry(async () => ({ action: 'default' }), { displayName: 'C' }),
      },
      edges: {
        A: { default: 'B' },
        B: { diverged: 'A', converged: 'C' },
      },
      start: ['A'],
      loopFallback: {
        'B:diverged': { source: 'B', action: 'diverged', fallbackTarget: 'C', maxIterations: 5 },
      },
    };

    const dir = path.join(tmpDir, 'retry-iter');
    await bridge.launch({ executionId: 'retry-iter', graph: flow, dir, params: {} });
    await new Promise(r => setTimeout(r, 200));

    let proj = stateRuntime.getProjection('retry-iter');
    expect(proj!.status).toBe('completed');

    // Retry A (re-enter the loop)
    bCount = 100; // ensure B converges immediately
    await bridge.retryNode('retry-iter', 'A', flow);
    await new Promise(r => setTimeout(r, 200));

    proj = stateRuntime.getProjection('retry-iter');
    expect(proj!.status).toBe('completed');

    // Verify A node has attempt > 1 (retried)
    const aNode = proj!.graph.nodes.find(n => n.id === 'A');
    expect(aNode!.attempt).toBeGreaterThan(1);
  });
});
