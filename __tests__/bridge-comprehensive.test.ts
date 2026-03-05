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
import type { FlowGraph, AgentRuntime, ExecutionProjection } from '../src/types';

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
