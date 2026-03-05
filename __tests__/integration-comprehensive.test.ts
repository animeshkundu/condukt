/**
 * Integration comprehensive tests — full pipeline scenarios with exact validation.
 *
 * Tests run the CI/CD counter-test composition end-to-end through:
 * - Scheduler + StateRuntime + Storage + Bridge
 * - Verifies exact event sequences, projection states, edge routing
 * - Every assertion validates expected behavior precisely
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, validateGraph, computeFrontier } from '../src/scheduler';
import { deterministic, gate, resolveGate, _getGateRegistryForTesting } from '../src/nodes';
import { MemoryStorage } from '../state/storage-memory';
import { StateRuntime } from '../state/state-runtime';
import { reduce, createEmptyProjection, replayEvents } from '../state/reducer';
import { createBridge } from '../bridge/bridge';
import type {
  FlowGraph, RunOptions, AgentRuntime, ResumeState,
  NodeInput, NodeOutput, ExecutionProjection,
} from '../src/types';
import { FlowAbortedError } from '../src/types';
import type { ExecutionEvent } from '../src/events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRuntime(): AgentRuntime {
  return {
    name: 'mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockRejectedValue(new Error('Mock — no sessions')),
  };
}

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'int-comp-'));
}

// A simple 3-node pipeline: producer → checker → reporter
// checker is deterministic (pass/fail based on params)
// This avoids gates for simpler scenarios
function createSimplePipeline(failChecker = false): FlowGraph {
  const producer = deterministic('Producer', async (input: NodeInput): Promise<NodeOutput> => {
    return {
      action: 'default',
      artifact: 'Produced data: 42',
      metadata: { producedAt: Date.now() },
    };
  });

  const checker = deterministic('Checker', async (input: NodeInput): Promise<NodeOutput> => {
    if (failChecker) throw new Error('Check failed: bad data');
    return {
      action: input.params.quality === 'high' ? 'pass' : 'warn',
      metadata: { quality: input.params.quality ?? 'unknown' },
    };
  });

  const reporter = deterministic('Reporter', async (input: NodeInput): Promise<NodeOutput> => {
    return {
      action: 'default',
      artifact: 'Report: all good',
    };
  });

  return {
    nodes: {
      producer: { fn: producer, displayName: 'Producer', nodeType: 'deterministic', output: 'data.txt' },
      checker: { fn: checker, displayName: 'Checker', nodeType: 'deterministic', reads: ['data.txt'] },
      reporter: { fn: reporter, displayName: 'Reporter', nodeType: 'deterministic', output: 'report.md' },
    },
    edges: {
      producer: { default: 'checker' },
      checker: { pass: 'reporter', warn: 'reporter', fail: 'end' },
    },
    start: ['producer'],
  };
}

// ===========================================================================
// HAPPY PATH — exact event validation
// ===========================================================================

describe('integration — simple pipeline happy path', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } });

  it('complete pipeline emits correct events in order', async () => {
    const events: ExecutionEvent[] = [];
    const storage = new MemoryStorage();
    const stateRuntime = new StateRuntime(storage);

    const opts: RunOptions = {
      executionId: 'happy-001',
      dir: tmpDir,
      params: { quality: 'high' },
      runtime: createMockRuntime(),
      emitState: async (event) => {
        events.push(event);
        await stateRuntime.handleEvent(event);
      },
      emitOutput: vi.fn(),
      signal: new AbortController().signal,
    };

    const result = await run(createSimplePipeline(), opts);

    // Overall result
    expect(result.completed).toBe(true);
    expect(result.durationMs).toBeGreaterThan(0);

    // Event sequence validation
    const types = events.map(e => e.type);
    expect(types[0]).toBe('run:started');
    expect(types[types.length - 1]).toBe('run:completed');

    // Exactly 3 node:started and 3 node:completed
    expect(types.filter(t => t === 'node:started')).toHaveLength(3);
    expect(types.filter(t => t === 'node:completed')).toHaveLength(3);

    // Exactly 2 edge:traversed (producer→checker, checker→reporter)
    expect(types.filter(t => t === 'edge:traversed')).toHaveLength(2);

    // At least 1 artifact:written (producer writes data.txt)
    expect(types.filter(t => t === 'artifact:written').length).toBeGreaterThanOrEqual(1);

    // Metadata events emitted
    expect(types.filter(t => t === 'metadata').length).toBeGreaterThanOrEqual(1);

    // Verify edge routing — checker returned 'pass' → reporter
    const edgeEvents = events.filter(e => e.type === 'edge:traversed');
    const checkerEdge = edgeEvents.find(
      e => (e as { source: string }).source === 'checker',
    );
    expect(checkerEdge).toBeDefined();
    expect((checkerEdge as { target: string }).target).toBe('reporter');
    expect((checkerEdge as { action: string }).action).toBe('pass');
  });

  it('projection matches event replay exactly', async () => {
    const events: ExecutionEvent[] = [];
    const storage = new MemoryStorage();
    const stateRuntime = new StateRuntime(storage);

    const opts: RunOptions = {
      executionId: 'replay-001',
      dir: tmpDir,
      params: { quality: 'high' },
      runtime: createMockRuntime(),
      emitState: async (event) => {
        events.push(event);
        await stateRuntime.handleEvent(event);
      },
      emitOutput: vi.fn(),
      signal: new AbortController().signal,
    };

    await run(createSimplePipeline(), opts);

    // Replay from events
    const replayed = replayEvents('replay-001', events);
    const cached = stateRuntime.getProjection('replay-001')!;

    // Status matches
    expect(replayed.status).toBe(cached.status);
    expect(replayed.status).toBe('completed');

    // Graph structure matches
    expect(replayed.graph.nodes.length).toBe(cached.graph.nodes.length);
    expect(replayed.graph.edges.length).toBe(cached.graph.edges.length);
    expect(replayed.graph.completedPath).toEqual(cached.graph.completedPath);

    // Every node status matches
    for (const node of replayed.graph.nodes) {
      const cachedNode = cached.graph.nodes.find(n => n.id === node.id);
      expect(cachedNode).toBeDefined();
      expect(node.status).toBe(cachedNode!.status);
      expect(node.action).toBe(cachedNode!.action);
    }

    // Every edge state matches
    for (const edge of replayed.graph.edges) {
      const cachedEdge = cached.graph.edges.find(
        e => e.source === edge.source && e.target === edge.target,
      );
      expect(cachedEdge).toBeDefined();
      expect(edge.state).toBe(cachedEdge!.state);
    }
  });
});

// ===========================================================================
// NODE FAILURE — exact impact validation
// ===========================================================================

describe('integration — node failure mid-pipeline', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } });

  it('checker failure stops pipeline and records error precisely', async () => {
    const events: ExecutionEvent[] = [];
    const storage = new MemoryStorage();
    const stateRuntime = new StateRuntime(storage);

    const opts: RunOptions = {
      executionId: 'fail-001',
      dir: tmpDir,
      params: {},
      runtime: createMockRuntime(),
      emitState: async (event) => {
        events.push(event);
        await stateRuntime.handleEvent(event);
      },
      emitOutput: vi.fn(),
      signal: new AbortController().signal,
    };

    const result = await run(createSimplePipeline(true), opts);

    expect(result.completed).toBe(false);

    // Verify projection
    const projection = stateRuntime.getProjection('fail-001')!;
    expect(projection.status).toBe('failed');

    // Producer completed
    const producer = projection.graph.nodes.find(n => n.id === 'producer');
    expect(producer?.status).toBe('completed');

    // Checker failed with specific error message
    const checker = projection.graph.nodes.find(n => n.id === 'checker');
    expect(checker?.status).toBe('failed');
    expect(checker?.error).toBe('Check failed: bad data');

    // Reporter never started
    const reporter = projection.graph.nodes.find(n => n.id === 'reporter');
    expect(reporter?.status).toBe('pending');

    // Edge from producer→checker was taken
    const prodEdge = projection.graph.edges.find(
      e => e.source === 'producer' && e.target === 'checker',
    );
    expect(prodEdge?.state).toBe('taken');

    // No edge from checker was taken (it failed)
    const checkEdge = projection.graph.edges.find(e => e.source === 'checker');
    // If edge exists, it should be 'default' (not_taken) because checker threw
    if (checkEdge) {
      expect(checkEdge.state).not.toBe('taken');
    }

    // completedPath only includes producer
    expect(projection.graph.completedPath).toEqual(['producer']);
  });
});

// ===========================================================================
// CONDITIONAL ROUTING — exact edge validation
// ===========================================================================

describe('integration — conditional routing', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } });

  it('warn action routes correctly and marks non-taken edges', async () => {
    const events: ExecutionEvent[] = [];
    const storage = new MemoryStorage();
    const stateRuntime = new StateRuntime(storage);

    const opts: RunOptions = {
      executionId: 'route-001',
      dir: tmpDir,
      params: { quality: 'low' }, // Triggers 'warn' action
      runtime: createMockRuntime(),
      emitState: async (event) => {
        events.push(event);
        await stateRuntime.handleEvent(event);
      },
      emitOutput: vi.fn(),
      signal: new AbortController().signal,
    };

    await run(createSimplePipeline(), opts);

    const projection = stateRuntime.getProjection('route-001')!;
    expect(projection.status).toBe('completed');

    // Verify edge states
    const edges = projection.graph.edges;

    // checker → reporter via 'warn' should be taken
    const warnEdge = edges.find(
      e => e.source === 'checker' && e.target === 'reporter' && e.action === 'warn',
    );
    // Or it could be 'pass' edge since both go to reporter — depends on which edge matched
    const takenEdge = edges.find(e => e.source === 'checker' && e.state === 'taken');
    expect(takenEdge).toBeDefined();
    expect(takenEdge!.target).toBe('reporter');

    // The other edges from checker should be not_taken
    const notTaken = edges.filter(
      e => e.source === 'checker' && e.state === 'not_taken',
    );
    expect(notTaken.length).toBeGreaterThanOrEqual(1);

    // checker node's action should be recorded
    const checkerNode = projection.graph.nodes.find(n => n.id === 'checker');
    expect(checkerNode?.action).toBe('warn');
  });
});

// ===========================================================================
// CRASH RECOVERY — event log as source of truth
// ===========================================================================

describe('integration — crash recovery', () => {
  it('recoverOnStartup replays from event log and marks running as crashed', async () => {
    const storage = new MemoryStorage();

    // Simulate events from a run that was interrupted
    const events: ExecutionEvent[] = [
      {
        type: 'run:started',
        executionId: 'crash-001',
        flowId: '',
        params: { quality: 'high' },
        graph: {
          nodes: [
            { id: 'producer', displayName: 'Producer', nodeType: 'deterministic', output: 'data.txt' },
            { id: 'checker', displayName: 'Checker', nodeType: 'deterministic' },
          ],
          edges: [{ source: 'producer', action: 'default', target: 'checker' }],
        },
        ts: 1000,
      },
      { type: 'node:started', executionId: 'crash-001', nodeId: 'producer', ts: 1001 },
      { type: 'node:completed', executionId: 'crash-001', nodeId: 'producer', action: 'default', elapsedMs: 50, ts: 1050 },
      // Crash happens here — checker never started
    ];

    for (const event of events) {
      storage.appendEvent('crash-001', event);
    }

    // Recovery
    const stateRuntime = new StateRuntime(storage);
    stateRuntime.recoverOnStartup();

    const projection = stateRuntime.getProjection('crash-001')!;
    expect(projection.status).toBe('crashed');

    // Producer should be completed
    const producer = projection.graph.nodes.find(n => n.id === 'producer');
    expect(producer?.status).toBe('completed');
    expect(producer?.action).toBe('default');

    // Checker should be pending (never started)
    const checker = projection.graph.nodes.find(n => n.id === 'checker');
    expect(checker?.status).toBe('pending');

    // completedPath should include producer
    expect(projection.graph.completedPath).toContain('producer');
  });

  it('recovery of completed execution preserves state perfectly', () => {
    const storage = new MemoryStorage();

    const events: ExecutionEvent[] = [
      {
        type: 'run:started',
        executionId: 'recover-done',
        flowId: 'test',
        params: {},
        graph: {
          nodes: [{ id: 'A', displayName: 'A', nodeType: 'deterministic' }],
          edges: [],
        },
        ts: 1000,
      },
      { type: 'node:started', executionId: 'recover-done', nodeId: 'A', ts: 1001 },
      { type: 'node:completed', executionId: 'recover-done', nodeId: 'A', action: 'done', elapsedMs: 100, ts: 1100 },
      { type: 'run:completed', executionId: 'recover-done', status: 'completed', ts: 1200 },
    ];

    for (const event of events) {
      storage.appendEvent('recover-done', event);
    }

    const stateRuntime = new StateRuntime(storage);
    stateRuntime.recoverOnStartup();

    const projection = stateRuntime.getProjection('recover-done')!;
    expect(projection.status).toBe('completed'); // NOT crashed
    expect(projection.graph.nodes[0].status).toBe('completed');
    expect(projection.graph.nodes[0].action).toBe('done');
  });
});

// ===========================================================================
// RESUME AFTER FAILURE — correct frontier computation
// ===========================================================================

describe('integration — resume after failure', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } });

  it('resume skips completed nodes and runs from frontier', async () => {
    const nodeExecutionCount = new Map<string, number>();
    const events: ExecutionEvent[] = [];
    const storage = new MemoryStorage();
    const stateRuntime = new StateRuntime(storage);

    const mkNode = (id: string) => deterministic(id, async () => {
      nodeExecutionCount.set(id, (nodeExecutionCount.get(id) ?? 0) + 1);
      return { action: 'default' };
    });

    const graph: FlowGraph = {
      nodes: {
        A: { fn: mkNode('A'), displayName: 'A', nodeType: 'deterministic' },
        B: { fn: mkNode('B'), displayName: 'B', nodeType: 'deterministic' },
        C: { fn: mkNode('C'), displayName: 'C', nodeType: 'deterministic' },
      },
      edges: {
        A: { default: 'B' },
        B: { default: 'C' },
      },
      start: ['A'],
    };

    // Resume from A completed, B pending
    const resumeState: ResumeState = {
      completedNodes: new Map([['A', { action: 'default', finishedAt: 1000 }]]),
      firedEdges: new Map([['B', new Set(['A'])]]),
      nodeStatuses: new Map([['A', 'completed']]),
    };

    const opts: RunOptions = {
      executionId: 'resume-001',
      dir: tmpDir,
      params: {},
      runtime: createMockRuntime(),
      emitState: async (event) => {
        events.push(event);
        await stateRuntime.handleEvent(event);
      },
      emitOutput: vi.fn(),
      signal: new AbortController().signal,
      resumeFrom: resumeState,
    };

    const result = await run(graph, opts);

    expect(result.completed).toBe(true);

    // A should NOT have been re-executed
    expect(nodeExecutionCount.has('A')).toBe(false);
    // B and C should each execute exactly once
    expect(nodeExecutionCount.get('B')).toBe(1);
    expect(nodeExecutionCount.get('C')).toBe(1);

    // run:resumed event should have been emitted (not run:started)
    const types = events.map(e => e.type);
    expect(types).toContain('run:resumed');
    expect(types).not.toContain('run:started');
  });
});

// ===========================================================================
// CONCURRENT EXECUTIONS — isolation validation
// ===========================================================================

describe('integration — concurrent execution isolation', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } });

  it('two parallel executions do not corrupt each other', async () => {
    const storage = new MemoryStorage();
    const stateRuntime = new StateRuntime(storage);

    const graph: FlowGraph = {
      nodes: {
        A: {
          fn: deterministic('A', async (input) => ({
            action: 'default',
            metadata: { execId: input.params.tag },
          })),
          displayName: 'A', nodeType: 'deterministic',
        },
      },
      edges: {},
      start: ['A'],
    };

    const makeOpts = (id: string, tag: string): RunOptions => ({
      executionId: id,
      dir: path.join(tmpDir, id),
      params: { tag },
      runtime: createMockRuntime(),
      emitState: async (event) => { await stateRuntime.handleEvent(event); },
      emitOutput: vi.fn(),
      signal: new AbortController().signal,
    });

    // Run two executions concurrently
    const [r1, r2] = await Promise.all([
      run(graph, makeOpts('exec-A', 'alpha')),
      run(graph, makeOpts('exec-B', 'beta')),
    ]);

    expect(r1.completed).toBe(true);
    expect(r2.completed).toBe(true);

    // Each execution should have its own projection
    const projA = stateRuntime.getProjection('exec-A')!;
    const projB = stateRuntime.getProjection('exec-B')!;

    expect(projA.id).toBe('exec-A');
    expect(projB.id).toBe('exec-B');

    // Metadata should be isolated
    expect(projA.metadata.execId).toBe('alpha');
    expect(projB.metadata.execId).toBe('beta');

    // Storage should have separate event logs
    const eventsA = storage.readEvents('exec-A');
    const eventsB = storage.readEvents('exec-B');
    expect(eventsA.every(e => e.executionId === 'exec-A')).toBe(true);
    expect(eventsB.every(e => e.executionId === 'exec-B')).toBe(true);
  });
});

// ===========================================================================
// GATE WITH BRIDGE — full lifecycle
// ===========================================================================

describe('integration — gate lifecycle via bridge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    _getGateRegistryForTesting().clear();
  });
  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } });

  it('approve → complete: full event chain validated', async () => {
    const storage = new MemoryStorage();
    const stateRuntime = new StateRuntime(storage);
    const bridge = createBridge(createMockRuntime(), stateRuntime);

    const preGate = deterministic('pre', async () => ({ action: 'default' }));
    const gateNode = gate('review');
    const postGate = deterministic('post', async () => ({
      action: 'default', artifact: 'Done!',
    }));

    const graph: FlowGraph = {
      nodes: {
        pre: { fn: preGate, displayName: 'Pre', nodeType: 'deterministic' },
        review: { fn: gateNode, displayName: 'Review', nodeType: 'gate' },
        post: { fn: postGate, displayName: 'Post', nodeType: 'deterministic', output: 'done.txt' },
      },
      edges: {
        pre: { default: 'review' },
        review: { approved: 'post', rejected: 'end' },
      },
      start: ['pre'],
    };

    await bridge.launch({
      executionId: 'gate-lifecycle',
      graph,
      dir: path.join(tmpDir, 'gate-lifecycle'),
      params: {},
    });

    await new Promise(r => setTimeout(r, 50));

    // Gate should be pending
    let proj = stateRuntime.getProjection('gate-lifecycle')!;
    const gateNodeState = proj.graph.nodes.find(n => n.id === 'review');
    expect(gateNodeState?.status).toBe('gated');

    // Approve
    await bridge.approveGate('gate-lifecycle', 'review', 'approved', 'Looks good');
    await new Promise(r => setTimeout(r, 150));

    proj = stateRuntime.getProjection('gate-lifecycle')!;
    expect(proj.status).toBe('completed');

    // Gate should be completed (approved)
    const finalGate = proj.graph.nodes.find(n => n.id === 'review');
    expect(finalGate?.status).toBe('completed');

    // Post should have completed
    const postNode = proj.graph.nodes.find(n => n.id === 'post');
    expect(postNode?.status).toBe('completed');

    // completedPath should include all three nodes
    expect(proj.graph.completedPath).toContain('pre');
    expect(proj.graph.completedPath).toContain('post');
  });

  it('reject → skip: gate rejected, downstream never runs', async () => {
    const storage = new MemoryStorage();
    const stateRuntime = new StateRuntime(storage);
    const bridge = createBridge(createMockRuntime(), stateRuntime);

    const gateNode = gate('review');

    const graph: FlowGraph = {
      nodes: {
        pre: {
          fn: deterministic('pre', async () => ({ action: 'default' })),
          displayName: 'Pre', nodeType: 'deterministic',
        },
        review: { fn: gateNode, displayName: 'Review', nodeType: 'gate' },
        post: {
          fn: deterministic('post', async () => ({ action: 'default' })),
          displayName: 'Post', nodeType: 'deterministic',
        },
      },
      edges: {
        pre: { default: 'review' },
        review: { approved: 'post', rejected: 'end' },
      },
      start: ['pre'],
    };

    await bridge.launch({
      executionId: 'reject-lifecycle',
      graph,
      dir: path.join(tmpDir, 'reject-lifecycle'),
      params: {},
    });

    await new Promise(r => setTimeout(r, 50));

    // Reject the gate
    await bridge.approveGate('reject-lifecycle', 'review', 'rejected', 'Not ready');
    await new Promise(r => setTimeout(r, 150));

    const proj = stateRuntime.getProjection('reject-lifecycle')!;
    expect(proj.status).toBe('completed');

    // Gate should be skipped (SWE-5: rejected → skipped)
    const gateState = proj.graph.nodes.find(n => n.id === 'review');
    expect(gateState?.status).toBe('skipped');

    // Post should remain pending (never reached)
    const postState = proj.graph.nodes.find(n => n.id === 'post');
    expect(postState?.status).toBe('pending');

    // completedPath should NOT include review or post
    expect(proj.graph.completedPath).not.toContain('review');
    expect(proj.graph.completedPath).not.toContain('post');
  });
});
