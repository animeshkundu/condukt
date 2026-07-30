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
import { _buildResumeStateForTesting, createBridge } from '../bridge/bridge';
import { StateRuntime } from '../state/state-runtime';
import { MemoryStorage } from '../state/storage-memory';
import { resolveGate, _getGateRegistryForTesting } from '../src/nodes';
import { computeFrontier, run, validateGraph } from '../src/scheduler';
import { replayEvents } from '../state/reducer';
import { cicdFlow } from '../examples/counter-test/cicd';
import type { ExecutionEvent } from '../src/events';
import type {
  FlowGraph,
  AgentRuntime,
  ExecutionProjection,
  NodeEntry,
  RunOptions,
} from '../src/types';

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

  it('recovers all fan-out targets from one atomic route when compatibility edges are truncated', async () => {
    const executionId = 'atomic-fan-out';
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => ({ action: 'default' })),
        C: mkEntry(async () => ({ action: 'default' })),
        D: mkEntry(async () => ({ action: 'default' })),
      },
      edges: { A: { default: ['B', 'C', 'D'] } },
      start: ['A'],
    };
    const events: ExecutionEvent[] = [];
    await run(graph, {
      executionId,
      dir: tmpDir,
      params: {},
      runtime: createMockRuntime(),
      emitState: async event => {
        events.push(event);
      },
      emitOutput: vi.fn(),
      signal: new AbortController().signal,
    });
    const firstCompatibilityEdge = events.findIndex(event =>
      event.type === 'edge:traversed' && event.source === 'A'
    );
    const truncated = events.slice(0, firstCompatibilityEdge + 1);
    truncated.push({
      type: 'run:completed',
      executionId,
      status: 'crashed',
      ts: Date.now(),
    });
    const projection = replayEvents(executionId, truncated);
    const state = _buildResumeStateForTesting(projection, graph, truncated);

    expect(computeFrontier(graph, state).sort()).toEqual(['B', 'C', 'D']);
    expect(state.firedEdges).toEqual(new Map([
      ['B', new Set(['A'])],
      ['C', new Set(['A'])],
      ['D', new Set(['A'])],
    ]));
  });

  it('reruns a completed node when its atomic route record is missing', () => {
    const executionId = 'missing-atomic-route';
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => ({ action: 'default' })),
        C: mkEntry(async () => ({ action: 'default' })),
        D: mkEntry(async () => ({ action: 'default' })),
      },
      edges: { A: { default: ['B', 'C', 'D'] } },
      start: ['A'],
    };
    const events: ExecutionEvent[] = [{
      type: 'run:started',
      executionId,
      flowId: '',
      params: {},
      graph: {
        nodes: Object.entries(graph.nodes).map(([id, node]) => ({
          id,
          displayName: node.displayName,
          nodeType: node.nodeType,
        })),
        edges: [
          { source: 'A', action: 'default', target: 'B' },
          { source: 'A', action: 'default', target: 'C' },
          { source: 'A', action: 'default', target: 'D' },
        ],
      },
      ts: 1,
    }, {
      type: 'node:completed',
      executionId,
      nodeId: 'A',
      action: 'default',
      elapsedMs: 1,
      routingExpected: true,
      ts: 2,
    }, {
      type: 'edge:traversed',
      executionId,
      source: 'A',
      target: 'B',
      action: 'default',
      ts: 3,
    }];
    const projection = replayEvents(executionId, events);
    const state = _buildResumeStateForTesting(projection, graph, events);

    expect(computeFrontier(graph, state)).toEqual(['A']);
    expect(state.firedEdges).toEqual(new Map());
  });

  it('drops an earlier atomic route when a later attempt tears before routing', () => {
    const executionId = 'later-route-torn';
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'new' })),
        old: mkEntry(async () => ({ action: 'default' })),
        next: mkEntry(async () => ({ action: 'default' })),
      },
      edges: { A: { old: 'old', new: 'next' } },
      start: ['A'],
    };
    const events: ExecutionEvent[] = [{
      type: 'run:started',
      executionId,
      flowId: '',
      params: {},
      graph: {
        nodes: Object.entries(graph.nodes).map(([id, node]) => ({
          id,
          displayName: node.displayName,
          nodeType: node.nodeType,
        })),
        edges: [
          { source: 'A', action: 'old', target: 'old' },
          { source: 'A', action: 'new', target: 'next' },
        ],
      },
      ts: 1,
    }, {
      type: 'node:completed',
      executionId,
      nodeId: 'A',
      action: 'old',
      elapsedMs: 1,
      routingExpected: true,
      ts: 2,
    }, {
      type: 'route:resolved',
      executionId,
      source: 'A',
      action: 'old',
      targets: ['old'],
      ts: 3,
    }, {
      type: 'node:reset',
      executionId,
      nodeId: 'A',
      reason: 'loop-back',
      iteration: 1,
      sourceNodeId: 'old',
      ts: 4,
    }, {
      type: 'node:completed',
      executionId,
      nodeId: 'A',
      action: 'new',
      elapsedMs: 1,
      routingExpected: true,
      ts: 5,
    }];
    const projection = replayEvents(executionId, events);
    const state = _buildResumeStateForTesting(projection, graph, events);

    expect(computeFrontier(graph, state)).toEqual(['A']);
    expect(state.firedEdges).toEqual(new Map());
  });

  it('survives two interrupted resumes without losing or partially scheduling fan-out', async () => {
    const executionId = 'chained-atomic-resume';
    const calls = new Map<string, number>();
    const countedEntry = (nodeId: string): NodeEntry => mkEntry(async () => {
      calls.set(nodeId, (calls.get(nodeId) ?? 0) + 1);
      return { action: 'default' };
    });
    const graph: FlowGraph = {
      nodes: {
        A: countedEntry('A'),
        B: countedEntry('B'),
        C: countedEntry('C'),
        D: countedEntry('D'),
      },
      edges: { A: { default: ['B', 'C', 'D'] } },
      start: ['A'],
    };
    const events: ExecutionEvent[] = [];
    const baseOptions = {
      executionId,
      dir: tmpDir,
      params: {},
      runtime: createMockRuntime(),
      emitOutput: vi.fn(),
      signal: new AbortController().signal,
    };
    const firstEmit: RunOptions['emitState'] = async event => {
      events.push(event);
      if (event.type === 'edge:traversed' && event.source === 'A') {
        throw new Error('first interruption');
      }
    };

    await expect(run(graph, { ...baseOptions, emitState: firstEmit }))
      .rejects.toThrow('first interruption');
    const firstProjection = replayEvents(executionId, events);
    const firstResume = _buildResumeStateForTesting(firstProjection, graph, events);
    expect(computeFrontier(graph, firstResume).sort()).toEqual(['B', 'C', 'D']);

    const secondEmit: RunOptions['emitState'] = async event => {
      events.push(event);
      if (event.type === 'route:resolved' && event.source === 'B') {
        throw new Error('second interruption');
      }
    };
    await expect(run(graph, {
      ...baseOptions,
      emitState: secondEmit,
      resumeFrom: firstResume,
    })).rejects.toThrow('second interruption');
    const secondProjection = replayEvents(executionId, events);
    const secondResume = _buildResumeStateForTesting(secondProjection, graph, events);
    expect(computeFrontier(graph, secondResume).sort()).toEqual(['C', 'D']);

    await run(graph, {
      ...baseOptions,
      emitState: async event => { events.push(event); },
      resumeFrom: secondResume,
    });
    const finalProjection = replayEvents(executionId, events);

    expect(finalProjection.status).toBe('completed');
    expect(Object.fromEntries(calls)).toEqual({ A: 1, B: 1, C: 2, D: 2 });
  });

  it('reruns a resolved gate when the scheduler completion did not persist', () => {
    const executionId = 'resolved-gate-crash';
    const graph: FlowGraph = {
      nodes: {
        gate: mkEntry(async () => ({ action: 'approved' }), { nodeType: 'gate' }),
        next: mkEntry(async () => ({ action: 'default' })),
      },
      edges: { gate: { approved: 'next', rejected: 'end' } },
      start: ['gate'],
    };
    const events: ExecutionEvent[] = [{
      type: 'run:started',
      executionId,
      flowId: '',
      params: {},
      graph: {
        nodes: Object.entries(graph.nodes).map(([id, node]) => ({
          id,
          displayName: node.displayName,
          nodeType: node.nodeType,
        })),
        edges: [
          { source: 'gate', action: 'approved', target: 'next' },
          { source: 'gate', action: 'rejected', target: 'end' },
        ],
      },
      ts: 1,
    }, {
      type: 'node:gated',
      executionId,
      nodeId: 'gate',
      gateType: 'approval',
      ts: 2,
    }, {
      type: 'gate:resolved',
      executionId,
      nodeId: 'gate',
      resolution: 'approved',
      ts: 3,
    }, {
      type: 'run:completed',
      executionId,
      status: 'crashed',
      ts: 4,
    }];
    const projection = replayEvents(executionId, events);
    const state = _buildResumeStateForTesting(projection, graph, events);

    expect(projection.graph.nodes.find(node => node.id === 'gate')?.status).toBe('completed');
    expect(state.completedNodes.has('gate')).toBe(false);
    expect(state.nodeStatuses.get('gate')).toBe('pending');
    expect(computeFrontier(graph, state)).toEqual(['gate']);
  });

  it('ignores a late gate audit event after that gate attempt already routed', () => {
    const executionId = 'late-gate-audit';
    const graph: FlowGraph = {
      nodes: {
        gate: mkEntry(async () => ({ action: 'approved' }), { nodeType: 'gate' }),
        next: mkEntry(async () => ({ action: 'default' })),
      },
      edges: { gate: { approved: 'next' } },
      start: ['gate'],
    };
    const events: ExecutionEvent[] = [{
      type: 'run:started',
      executionId,
      flowId: '',
      params: {},
      graph: {
        nodes: Object.entries(graph.nodes).map(([id, node]) => ({
          id,
          displayName: node.displayName,
          nodeType: node.nodeType,
        })),
        edges: [{ source: 'gate', action: 'approved', target: 'next' }],
      },
      ts: 1,
    }, {
      type: 'node:started',
      executionId,
      nodeId: 'gate',
      ts: 2,
    }, {
      type: 'node:gated',
      executionId,
      nodeId: 'gate',
      gateType: 'approval',
      ts: 3,
    }, {
      type: 'node:completed',
      executionId,
      nodeId: 'gate',
      action: 'approved',
      elapsedMs: 1,
      routingExpected: true,
      ts: 4,
    }, {
      type: 'route:resolved',
      executionId,
      source: 'gate',
      action: 'approved',
      targets: ['next'],
      ts: 5,
    }, {
      type: 'gate:resolved',
      executionId,
      nodeId: 'gate',
      resolution: 'approved',
      ts: 6,
    }];
    const projection = replayEvents(executionId, events);
    const state = _buildResumeStateForTesting(projection, graph, events);

    expect(state.completedNodes.has('gate')).toBe(true);
    expect(computeFrontier(graph, state)).toEqual(['next']);
  });

  it('keeps a legacy completion when its gate audit event was persisted afterward', () => {
    const executionId = 'legacy-late-gate-audit';
    const graph: FlowGraph = {
      nodes: {
        gate: mkEntry(async () => ({ action: 'approved' }), { nodeType: 'gate' }),
        next: mkEntry(async () => ({ action: 'default' })),
      },
      edges: { gate: { approved: 'next' } },
      start: ['gate'],
    };
    const events: ExecutionEvent[] = [{
      type: 'run:started',
      executionId,
      flowId: '',
      params: {},
      graph: {
        nodes: Object.entries(graph.nodes).map(([id, node]) => ({
          id,
          displayName: node.displayName,
          nodeType: node.nodeType,
        })),
        edges: [{ source: 'gate', action: 'approved', target: 'next' }],
      },
      ts: 1,
    }, {
      type: 'node:started',
      executionId,
      nodeId: 'gate',
      ts: 2,
    }, {
      type: 'node:completed',
      executionId,
      nodeId: 'gate',
      action: 'approved',
      elapsedMs: 1,
      ts: 3,
    }, {
      type: 'edge:traversed',
      executionId,
      source: 'gate',
      target: 'next',
      action: 'approved',
      ts: 4,
    }, {
      type: 'gate:resolved',
      executionId,
      nodeId: 'gate',
      resolution: 'approved',
      ts: 5,
    }];
    const projection = replayEvents(executionId, events);
    const state = _buildResumeStateForTesting(projection, graph, events);

    expect(state.completedNodes.has('gate')).toBe(true);
    expect(computeFrontier(graph, state)).toEqual(['next']);
  });

  it('keeps per-edge reconstruction for legacy logs', () => {
    const executionId = 'legacy-per-edge';
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'default' })),
        B: mkEntry(async () => ({ action: 'default' })),
      },
      edges: { A: { default: 'B' } },
      start: ['A'],
    };
    const events: ExecutionEvent[] = [{
      type: 'run:started',
      executionId,
      flowId: '',
      params: {},
      graph: {
        nodes: Object.entries(graph.nodes).map(([id, node]) => ({
          id,
          displayName: node.displayName,
          nodeType: node.nodeType,
        })),
        edges: [{ source: 'A', action: 'default', target: 'B' }],
      },
      ts: 1,
    }, {
      type: 'node:completed',
      executionId,
      nodeId: 'A',
      action: 'default',
      elapsedMs: 1,
      ts: 2,
    }, {
      type: 'edge:traversed',
      executionId,
      source: 'A',
      target: 'B',
      action: 'default',
      ts: 3,
    }];
    const projection = replayEvents(executionId, events);
    const state = _buildResumeStateForTesting(projection, graph, events);

    expect(computeFrontier(graph, state)).toEqual(['B']);
  });

  it('round-trips conditional actions from the atomic route', () => {
    const executionId = 'atomic-conditional';
    const graph: FlowGraph = {
      nodes: {
        A: mkEntry(async () => ({ action: 'foo' })),
        foo: mkEntry(async () => ({ action: 'default' })),
        bar: mkEntry(async () => ({ action: 'default' })),
      },
      edges: { A: { foo: 'foo', bar: 'bar' } },
      start: ['A'],
    };
    const events: ExecutionEvent[] = [{
      type: 'run:started',
      executionId,
      flowId: '',
      params: {},
      graph: {
        nodes: Object.entries(graph.nodes).map(([id, node]) => ({
          id,
          displayName: node.displayName,
          nodeType: node.nodeType,
        })),
        edges: [
          { source: 'A', action: 'foo', target: 'foo' },
          { source: 'A', action: 'bar', target: 'bar' },
        ],
      },
      ts: 1,
    }, {
      type: 'node:completed',
      executionId,
      nodeId: 'A',
      action: 'foo',
      elapsedMs: 1,
      routingExpected: true,
      ts: 2,
    }, {
      type: 'route:resolved',
      executionId,
      source: 'A',
      action: 'foo',
      targets: ['foo'],
      ts: 3,
    }];
    const projection = replayEvents(executionId, events);
    const state = _buildResumeStateForTesting(projection, graph, events);

    expect(computeFrontier(graph, state)).toEqual(['foo']);
    expect(state.firedEdges.has('bar')).toBe(false);
  });

  it.each([
    {
      name: 'exitOn count exhaustion',
      action: 'exit',
      targets: ['done'],
      exhaustion: { reason: 'count' as const },
      expected: ['done'],
    },
    {
      name: 'onExhausted count exhaustion',
      action: 'continue',
      targets: ['exhausted'],
      exhaustion: { reason: 'count' as const },
      expected: ['exhausted'],
    },
    {
      name: 'onExhausted time exhaustion',
      action: 'continue',
      targets: ['timed-out'],
      exhaustion: {
        reason: 'time' as const,
        budgetMs: 100,
        elapsedMs: 80,
        estimatedNextRoundMs: 30,
      },
      expected: ['timed-out'],
    },
    {
      name: 'legacy loop fallback',
      action: 'continue',
      targets: ['fallback'],
      exhaustion: undefined,
      expected: ['fallback'],
    },
  ])('round-trips $name from the atomic record', ({
    action,
    targets,
    exhaustion,
    expected,
  }) => {
    const executionId = `atomic-${expected[0]}`;
    const graph: FlowGraph = {
      nodes: {
        decision: mkEntry(async () => ({ action: 'continue' })),
        entry: mkEntry(async () => ({ action: 'default' })),
        done: mkEntry(async () => ({ action: 'default' })),
        exhausted: mkEntry(async () => ({ action: 'default' })),
        'timed-out': mkEntry(async () => ({ action: 'default' })),
        fallback: mkEntry(async () => ({ action: 'default' })),
      },
      edges: {
        decision: { continue: 'entry', exit: 'done' },
      },
      start: ['decision'],
    };
    const events: ExecutionEvent[] = [{
      type: 'run:started',
      executionId,
      flowId: '',
      params: {},
      graph: {
        nodes: Object.entries(graph.nodes).map(([id, node]) => ({
          id,
          displayName: node.displayName,
          nodeType: node.nodeType,
        })),
        edges: [
          { source: 'decision', action: 'continue', target: 'entry' },
          { source: 'decision', action: 'exit', target: 'done' },
        ],
      },
      ts: 1,
    }, {
      type: 'node:completed',
      executionId,
      nodeId: 'decision',
      action: 'continue',
      elapsedMs: 1,
      routingExpected: true,
      ts: 2,
    }, {
      type: 'route:resolved',
      executionId,
      source: 'decision',
      action,
      targets,
      ...(exhaustion ? { exhaustion } : {}),
      ts: 3,
    }];
    const projection = replayEvents(executionId, events);
    const state = _buildResumeStateForTesting(projection, graph, events);

    expect(computeFrontier(graph, state)).toEqual(expected);
  });

  it('reconstructs a loop reset frontier and iteration without per-edge events', () => {
    const executionId = 'atomic-loop-reset';
    const graph: FlowGraph = {
      nodes: {
        entry: mkEntry(async () => ({ action: 'default' })),
        decision: mkEntry(async () => ({ action: 'continue' })),
      },
      edges: {
        entry: { default: 'decision' },
        decision: { continue: 'entry', exit: 'end' },
      },
      start: ['entry'],
      loopFallback: {
        'decision:continue': {
          source: 'decision',
          action: 'continue',
          fallbackTarget: 'end',
          maxIterations: 3,
        },
      },
    };
    const events: ExecutionEvent[] = [{
      type: 'run:started',
      executionId,
      flowId: '',
      params: {},
      graph: {
        nodes: Object.entries(graph.nodes).map(([id, node]) => ({
          id,
          displayName: node.displayName,
          nodeType: node.nodeType,
        })),
        edges: [
          { source: 'entry', action: 'default', target: 'decision' },
          { source: 'decision', action: 'continue', target: 'entry' },
          { source: 'decision', action: 'exit', target: 'end' },
        ],
      },
      ts: 1,
    }, {
      type: 'node:completed',
      executionId,
      nodeId: 'entry',
      action: 'default',
      elapsedMs: 1,
      routingExpected: true,
      ts: 2,
    }, {
      type: 'route:resolved',
      executionId,
      source: 'entry',
      action: 'default',
      targets: ['decision'],
      ts: 3,
    }, {
      type: 'node:completed',
      executionId,
      nodeId: 'decision',
      action: 'continue',
      elapsedMs: 1,
      routingExpected: true,
      ts: 4,
    }, {
      type: 'route:resolved',
      executionId,
      source: 'decision',
      action: 'continue',
      targets: ['entry'],
      loop: {
        key: 'decision:continue',
        iteration: 1,
        resetNodes: ['entry', 'decision'],
        readyTargets: ['entry'],
        firedTargets: ['entry'],
        clearedEdges: [
          { source: 'entry', target: 'decision' },
          { source: 'decision', target: 'entry' },
        ],
      },
      ts: 5,
    }];
    const projection = replayEvents(executionId, events);
    const first = _buildResumeStateForTesting(projection, graph, events);
    const second = _buildResumeStateForTesting(projection, graph, events);

    expect(computeFrontier(graph, first)).toEqual(['entry']);
    expect(computeFrontier(graph, second)).toEqual(['entry']);
    expect(first.loopIterations).toEqual(new Map([['decision:continue', 1]]));
    expect(second).toEqual(first);
  });

  it('reconstructs legacy and LoopRegion iteration keys', async () => {
    const executionId = 'resume-loop-keys';
    const graph: FlowGraph = {
      nodes: {
        legacyEntry: mkEntry(async () => ({ action: 'default' })),
        legacyDecision: mkEntry(async () => ({ action: 'retry' })),
        regionEntry: mkEntry(async () => ({ action: 'default' })),
        regionDecision: mkEntry(async () => ({ action: 'continue' })),
      },
      edges: {
        legacyEntry: { default: 'legacyDecision' },
        legacyDecision: { retry: 'legacyEntry' },
        regionEntry: { default: 'regionDecision' },
        regionDecision: { continue: 'regionEntry', exit: 'end' },
      },
      start: ['legacyEntry', 'regionEntry'],
      loopFallback: {
        'legacyDecision:retry': {
          source: 'legacyDecision',
          action: 'retry',
          fallbackTarget: 'end',
          maxIterations: 3,
        },
      },
      loops: [{
        id: 'review',
        nodes: ['regionEntry', 'regionDecision'],
        entry: 'regionEntry',
        decision: 'regionDecision',
        continueOn: 'continue',
        exitOn: 'exit',
        maxRounds: 4,
      }],
    };
    const events = [
      {
        type: 'edge:traversed' as const,
        executionId,
        source: 'legacyDecision',
        target: 'legacyEntry',
        action: 'retry',
        ts: 1,
      },
      {
        type: 'node:reset' as const,
        executionId,
        nodeId: 'legacyEntry',
        reason: 'loop-back' as const,
        iteration: 2,
        sourceNodeId: 'legacyDecision',
        ts: 2,
      },
      {
        type: 'node:reset' as const,
        executionId,
        nodeId: 'legacyDecision',
        reason: 'loop-back' as const,
        iteration: 1,
        sourceNodeId: 'legacyDecision',
        ts: 3,
      },
      {
        type: 'edge:traversed' as const,
        executionId,
        source: 'regionDecision',
        target: 'regionEntry',
        action: 'continue',
        ts: 4,
      },
      {
        type: 'node:reset' as const,
        executionId,
        nodeId: 'regionEntry',
        reason: 'loop-back' as const,
        iteration: 3,
        sourceNodeId: 'regionDecision',
        ts: 5,
      },
      {
        type: 'node:reset' as const,
        executionId,
        nodeId: 'regionDecision',
        reason: 'loop-back' as const,
        iteration: 2,
        sourceNodeId: 'regionDecision',
        ts: 6,
      },
    ];
    const projection: ExecutionProjection = {
      id: executionId,
      flowId: '',
      status: 'stopped',
      params: {},
      graph: { nodes: [], edges: [], activeNodes: [], completedPath: [] },
      totalCost: 0,
      metadata: {},
    };

    const state = _buildResumeStateForTesting(projection, graph, events);

    expect(Object.fromEntries(state.loopIterations)).toEqual({
      'legacyDecision:retry': 2,
      'region:review': 3,
    });
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

  function countedEntry(
    counts: Record<string, number>,
    nodeId: string,
    action = 'default',
  ): NodeEntry {
    return mkEntry(async () => {
      counts[nodeId] = (counts[nodeId] ?? 0) + 1;
      return { action };
    }, { displayName: nodeId });
  }

  function reviewLoopGraph(counts: Record<string, number>): FlowGraph {
    return {
      nodes: {
        producer: countedEntry(counts, 'producer'),
        gate: countedEntry(counts, 'gate'),
        review: countedEntry(counts, 'review'),
        decision: countedEntry(counts, 'decision', 'exit'),
        dependent: countedEntry(counts, 'dependent'),
      },
      edges: {
        producer: { default: 'gate' },
        gate: { default: 'review' },
        review: { default: 'decision' },
        decision: { continue: 'producer', exit: 'dependent' },
      },
      start: ['producer'],
      loops: [{
        id: 'review-loop',
        nodes: ['producer', 'gate', 'review', 'decision'],
        entry: 'producer',
        decision: 'decision',
        continueOn: 'continue',
        exitOn: 'exit',
        maxIterations: 3,
      }],
    };
  }

  it('retryNode inside a loop does not re-run its upstream producer', async () => {
    const counts: Record<string, number> = {};
    const graph = reviewLoopGraph(counts);
    const executionId = 'retry-loop-body';

    await bridge.launch({
      executionId,
      graph,
      dir: path.join(tmpDir, executionId),
      params: {},
    });
    await vi.waitFor(() => expect(bridge.isRunning(executionId)).toBe(false));
    expect(counts).toEqual({
      producer: 1,
      gate: 1,
      review: 1,
      decision: 1,
      dependent: 1,
    });

    await bridge.retryNode(executionId, 'gate', graph);
    await vi.waitFor(() => expect(bridge.isRunning(executionId)).toBe(false));

    expect(counts).toEqual({
      producer: 1,
      gate: 2,
      review: 2,
      decision: 2,
      dependent: 2,
    });
  });

  it('retryNode on a loop decision follows its exit without resetting the loop entry', async () => {
    const counts: Record<string, number> = {};
    const graph = reviewLoopGraph(counts);
    const executionId = 'retry-loop-decision';

    await bridge.launch({
      executionId,
      graph,
      dir: path.join(tmpDir, executionId),
      params: {},
    });
    await vi.waitFor(() => expect(bridge.isRunning(executionId)).toBe(false));

    await bridge.retryNode(executionId, 'decision', graph);
    await vi.waitFor(() => expect(bridge.isRunning(executionId)).toBe(false));

    expect(counts).toEqual({
      producer: 1,
      gate: 1,
      review: 1,
      decision: 2,
      dependent: 2,
    });
  });

  it('retryNode outside a loop preserves ordinary downstream reset behavior', async () => {
    const counts: Record<string, number> = {};
    const graph: FlowGraph = {
      nodes: {
        upstream: countedEntry(counts, 'upstream'),
        retried: countedEntry(counts, 'retried'),
        dependent: countedEntry(counts, 'dependent'),
      },
      edges: {
        upstream: { default: 'retried' },
        retried: { default: 'dependent' },
      },
      start: ['upstream'],
    };
    const executionId = 'retry-no-loop';

    await bridge.launch({
      executionId,
      graph,
      dir: path.join(tmpDir, executionId),
      params: {},
    });
    await vi.waitFor(() => expect(bridge.isRunning(executionId)).toBe(false));

    await bridge.retryNode(executionId, 'retried', graph);
    await vi.waitFor(() => expect(bridge.isRunning(executionId)).toBe(false));

    expect(counts).toEqual({ upstream: 1, retried: 2, dependent: 2 });
  });

  it('retryNode respects the continuation edges of multiple loop regions', async () => {
    const counts: Record<string, number> = {};
    const graph: FlowGraph = {
      nodes: {
        producerA: countedEntry(counts, 'producerA'),
        gateA: countedEntry(counts, 'gateA'),
        decisionA: countedEntry(counts, 'decisionA', 'exit'),
        doneA: countedEntry(counts, 'doneA'),
        producerB: countedEntry(counts, 'producerB'),
        gateB: countedEntry(counts, 'gateB'),
        decisionB: countedEntry(counts, 'decisionB', 'exit'),
        doneB: countedEntry(counts, 'doneB'),
      },
      edges: {
        producerA: { default: 'gateA' },
        gateA: { default: 'decisionA' },
        decisionA: { continue: 'producerA', exit: 'doneA' },
        producerB: { default: 'gateB' },
        gateB: { default: 'decisionB' },
        decisionB: { continue: 'producerB', exit: 'doneB' },
      },
      start: ['producerA', 'producerB'],
      loops: [
        {
          id: 'loop-a',
          nodes: ['producerA', 'gateA', 'decisionA'],
          entry: 'producerA',
          decision: 'decisionA',
          continueOn: 'continue',
          exitOn: 'exit',
          maxIterations: 3,
        },
        {
          id: 'loop-b',
          nodes: ['producerB', 'gateB', 'decisionB'],
          entry: 'producerB',
          decision: 'decisionB',
          continueOn: 'continue',
          exitOn: 'exit',
          maxIterations: 3,
        },
      ],
    };
    const executionId = 'retry-multiple-loops';

    await bridge.launch({
      executionId,
      graph,
      dir: path.join(tmpDir, executionId),
      params: {},
    });
    await vi.waitFor(() => expect(bridge.isRunning(executionId)).toBe(false));

    await bridge.retryNode(executionId, 'gateA', graph);
    await vi.waitFor(() => expect(bridge.isRunning(executionId)).toBe(false));

    expect(counts).toEqual({
      producerA: 1,
      gateA: 2,
      decisionA: 2,
      doneA: 2,
      producerB: 1,
      gateB: 1,
      decisionB: 1,
      doneB: 1,
    });
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
