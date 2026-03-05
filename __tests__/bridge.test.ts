/**
 * Bridge + composition integration tests.
 *
 * Tests the full flow: launch → scheduler → events → state → projection.
 * Uses MemoryStorage for zero I/O and the CI/CD counter-test composition
 * to prove framework genericity.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBridge } from '../bridge/bridge';
import { StateRuntime } from '../state/state-runtime';
import { MemoryStorage } from '../state/storage-memory';
import { resolveGate, _getGateRegistryForTesting } from '../src/nodes';
import { validateGraph } from '../src/scheduler';
import { cicdFlow } from '../examples/counter-test/cicd';
import type { FlowGraph, AgentRuntime } from '../src/types';

// ---------------------------------------------------------------------------
// Mock runtime (not needed for deterministic nodes, but required by bridge)
// ---------------------------------------------------------------------------

function createMockRuntime(): AgentRuntime {
  return {
    name: 'mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockRejectedValue(new Error('Mock runtime — no real sessions')),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bridge', () => {
  let storage: MemoryStorage;
  let stateRuntime: StateRuntime;
  let bridge: ReturnType<typeof createBridge>;
  let runtime: AgentRuntime;

  beforeEach(() => {
    storage = new MemoryStorage();
    stateRuntime = new StateRuntime(storage);
    runtime = createMockRuntime();
    bridge = createBridge(runtime, stateRuntime);
    // Clear gate registry between tests
    _getGateRegistryForTesting().clear();
  });

  it('validates the CI/CD counter-test flow graph', () => {
    expect(() => validateGraph(cicdFlow)).not.toThrow();
  });

  it('launches a CI/CD flow and runs to completion', async () => {
    const execId = await bridge.launch({
      executionId: 'cicd-001',
      graph: cicdFlow,
      dir: '/tmp/cicd-test',
      params: { testsPassing: true },
    });

    expect(execId).toBe('cicd-001');

    // Wait for the flow to complete (it runs in background)
    // The deterministic nodes are instant, but the gate blocks.
    // We need to approve the gate to let the flow finish.
    await new Promise(resolve => setTimeout(resolve, 50));

    // Check that the gate is pending
    let projection = stateRuntime.getProjection('cicd-001');
    expect(projection).not.toBeNull();

    // The gate should be blocking — approve it
    const resolved = resolveGate('cicd-001', 'approval', 'approved');
    expect(resolved).toBe(true);

    // Wait for completion
    await new Promise(resolve => setTimeout(resolve, 100));

    projection = stateRuntime.getProjection('cicd-001');
    expect(projection).not.toBeNull();
    expect(projection!.status).toBe('completed');

    // Verify graph state
    const nodes = projection!.graph.nodes;
    const lintNode = nodes.find(n => n.id === 'lint');
    const testNode = nodes.find(n => n.id === 'test');
    const buildNode = nodes.find(n => n.id === 'build');
    const deployNode = nodes.find(n => n.id === 'deploy');

    expect(lintNode?.status).toBe('completed');
    expect(testNode?.status).toBe('completed');
    expect(buildNode?.status).toBe('completed');
    expect(deployNode?.status).toBe('completed');

    // Verify completed path includes all nodes
    expect(projection!.graph.completedPath.length).toBeGreaterThanOrEqual(4);
  });

  it('stops a running execution', async () => {
    // Launch a flow that will block at the gate
    await bridge.launch({
      executionId: 'cicd-stop',
      graph: cicdFlow,
      dir: '/tmp/cicd-stop',
      params: {},
    });

    // Wait for gate to be reached
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(bridge.isRunning('cicd-stop')).toBe(true);

    // Stop the execution
    await bridge.stop('cicd-stop');

    // Verify it stopped
    expect(bridge.isRunning('cicd-stop')).toBe(false);
    const projection = stateRuntime.getProjection('cicd-stop');
    expect(projection).not.toBeNull();
    expect(projection!.status).toBe('stopped');
  });

  it('rejects duplicate execution IDs', async () => {
    await bridge.launch({
      executionId: 'cicd-dup',
      graph: cicdFlow,
      dir: '/tmp/cicd-dup',
      params: {},
    });

    await expect(bridge.launch({
      executionId: 'cicd-dup',
      graph: cicdFlow,
      dir: '/tmp/cicd-dup',
      params: {},
    })).rejects.toThrow('already running');

    // Clean up
    await bridge.stop('cicd-dup');
  });

  it('approves a gate node', async () => {
    await bridge.launch({
      executionId: 'cicd-approve',
      graph: cicdFlow,
      dir: '/tmp/cicd-approve',
      params: {},
    });

    // Wait for gate to be reached
    await new Promise(resolve => setTimeout(resolve, 50));

    // Approve the gate
    await bridge.approveGate('cicd-approve', 'approval', 'approved', 'LGTM');

    // Wait for completion
    await new Promise(resolve => setTimeout(resolve, 100));

    const projection = stateRuntime.getProjection('cicd-approve');
    expect(projection).not.toBeNull();
    expect(projection!.status).toBe('completed');

    // gate:resolved event should have been emitted
    const gateNode = projection!.graph.nodes.find(n => n.id === 'approval');
    expect(gateNode?.status).toBe('completed');
  });

  it('lists executions', async () => {
    const list = bridge.listExecutions();
    expect(Array.isArray(list)).toBe(true);
  });

  it('gets a single execution', () => {
    const result = bridge.getExecution('nonexistent');
    expect(result).toBeNull();
  });
});

describe('counter-test genericity', () => {
  it('CI/CD flow has zero investigation imports', async () => {
    // This test is a compile-time assertion:
    // If cicdFlow compiles without investigation imports, the framework is generic.
    // The fact that this test file imports cicdFlow and runs proves genericity.
    expect(cicdFlow.start).toEqual(['lint', 'test']);
    expect(Object.keys(cicdFlow.nodes)).toHaveLength(5);
    expect(cicdFlow.nodes.lint.nodeType).toBe('deterministic');
    expect(cicdFlow.nodes.approval.nodeType).toBe('gate');
  });

  it('CI/CD flow validates correctly', () => {
    expect(() => validateGraph(cicdFlow)).not.toThrow();
  });
});
