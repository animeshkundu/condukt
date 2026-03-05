import { describe, it, expect } from 'vitest';
import { reduce, createEmptyProjection, replayEvents } from '../state/reducer';
import type { ExecutionEvent } from '../src/events';
import type { ExecutionProjection } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runStarted(executionId = 'exec-1'): ExecutionEvent {
  return {
    type: 'run:started',
    executionId,
    flowId: 'test-flow',
    params: { repo: 'test-repo', ask: 'investigate' },
    graph: {
      nodes: [
        { id: 'A', displayName: 'Step A', nodeType: 'agent', model: 'opus', output: 'a.md' },
        { id: 'B', displayName: 'Step B', nodeType: 'deterministic' },
        { id: 'C', displayName: 'Step C', nodeType: 'gate' },
      ],
      edges: [
        { source: 'A', action: 'default', target: 'B' },
        { source: 'A', action: 'fail', target: 'C' },
        { source: 'B', action: 'default', target: 'C' },
      ],
    },
    ts: 1000,
  };
}

function withRunStarted(id = 'exec-1'): ExecutionProjection {
  return reduce(createEmptyProjection(id), runStarted(id));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reducer', () => {
  describe('createEmptyProjection', () => {
    it('returns correct shape with defaults', () => {
      const p = createEmptyProjection('e1');
      expect(p).toEqual({
        id: 'e1',
        flowId: '',
        status: 'pending',
        params: {},
        graph: { nodes: [], edges: [], activeNodes: [], completedPath: [] },
        totalCost: 0,
        metadata: {},
      });
    });
  });

  describe('run:started', () => {
    it('sets status, params, flowId, and seeds graph', () => {
      const state = withRunStarted();
      expect(state.status).toBe('running');
      expect(state.flowId).toBe('test-flow');
      expect(state.params).toEqual({ repo: 'test-repo', ask: 'investigate' });
      expect(state.startedAt).toBe(1000);
      expect(state.graph.nodes).toHaveLength(3);
      expect(state.graph.edges).toHaveLength(3);
      expect(state.graph.nodes[0]).toMatchObject({
        id: 'A',
        displayName: 'Step A',
        nodeType: 'agent',
        model: 'opus',
        status: 'pending',
        attempt: 0,
        output: 'a.md',
      });
      expect(state.graph.edges[0]).toMatchObject({
        source: 'A',
        action: 'default',
        target: 'B',
        state: 'default',
      });
    });
  });

  describe('node:started', () => {
    it('updates status to running and increments attempt', () => {
      const state = reduce(withRunStarted(), {
        type: 'node:started',
        executionId: 'exec-1',
        nodeId: 'A',
        ts: 2000,
      });
      const nodeA = state.graph.nodes.find((n) => n.id === 'A')!;
      expect(nodeA.status).toBe('running');
      expect(nodeA.startedAt).toBe(2000);
      expect(nodeA.attempt).toBe(1);
      expect(state.graph.activeNodes).toContain('A');
    });
  });

  describe('node:completed', () => {
    it('updates status, adds to completedPath, removes from activeNodes', () => {
      let state = reduce(withRunStarted(), {
        type: 'node:started',
        executionId: 'exec-1',
        nodeId: 'A',
        ts: 2000,
      });
      state = reduce(state, {
        type: 'node:completed',
        executionId: 'exec-1',
        nodeId: 'A',
        action: 'default',
        elapsedMs: 5000,
        ts: 7000,
      });
      const nodeA = state.graph.nodes.find((n) => n.id === 'A')!;
      expect(nodeA.status).toBe('completed');
      expect(nodeA.finishedAt).toBe(7000);
      expect(nodeA.elapsedMs).toBe(5000);
      expect(state.graph.activeNodes).not.toContain('A');
      expect(state.graph.completedPath).toContain('A');
    });
  });

  describe('node:failed', () => {
    it('updates status and records error', () => {
      const state = reduce(withRunStarted(), {
        type: 'node:failed',
        executionId: 'exec-1',
        nodeId: 'A',
        error: 'Timeout exceeded',
        ts: 3000,
      });
      const nodeA = state.graph.nodes.find((n) => n.id === 'A')!;
      expect(nodeA.status).toBe('failed');
      expect(nodeA.finishedAt).toBe(3000);
      expect(nodeA.error).toBe('Timeout exceeded');
    });
  });

  describe('node:killed', () => {
    it('updates status to killed', () => {
      const state = reduce(withRunStarted(), {
        type: 'node:killed',
        executionId: 'exec-1',
        nodeId: 'A',
        ts: 3500,
      });
      const nodeA = state.graph.nodes.find((n) => n.id === 'A')!;
      expect(nodeA.status).toBe('killed');
      expect(nodeA.finishedAt).toBe(3500);
    });
  });

  describe('node:skipped', () => {
    it('updates status to skipped', () => {
      const state = reduce(withRunStarted(), {
        type: 'node:skipped',
        executionId: 'exec-1',
        nodeId: 'B',
        ts: 4000,
      });
      const nodeB = state.graph.nodes.find((n) => n.id === 'B')!;
      expect(nodeB.status).toBe('skipped');
      expect(nodeB.finishedAt).toBe(4000);
    });
  });

  describe('node:gated', () => {
    it('sets status to gated and records gateData, adds to activeNodes', () => {
      const state = reduce(withRunStarted(), {
        type: 'node:gated',
        executionId: 'exec-1',
        nodeId: 'C',
        gateType: 'quality',
        gateData: { score: 7, threshold: 8 },
        ts: 5000,
      });
      const nodeC = state.graph.nodes.find((n) => n.id === 'C')!;
      expect(nodeC.status).toBe('gated');
      expect(nodeC.gateData).toEqual({ score: 7, threshold: 8 });
      expect(state.graph.activeNodes).toContain('C');
    });
  });

  describe('gate:resolved', () => {
    it('approved — sets completed and adds to completedPath', () => {
      let state = reduce(withRunStarted(), {
        type: 'node:gated',
        executionId: 'exec-1',
        nodeId: 'C',
        gateType: 'quality',
        ts: 5000,
      });
      state = reduce(state, {
        type: 'gate:resolved',
        executionId: 'exec-1',
        nodeId: 'C',
        resolution: 'approved',
        ts: 6000,
      });
      const nodeC = state.graph.nodes.find((n) => n.id === 'C')!;
      expect(nodeC.status).toBe('completed');
      expect(nodeC.finishedAt).toBe(6000);
      expect(state.graph.completedPath).toContain('C');
      expect(state.graph.activeNodes).not.toContain('C');
    });

    it('rejected — sets skipped', () => {
      let state = reduce(withRunStarted(), {
        type: 'node:gated',
        executionId: 'exec-1',
        nodeId: 'C',
        gateType: 'quality',
        ts: 5000,
      });
      state = reduce(state, {
        type: 'gate:resolved',
        executionId: 'exec-1',
        nodeId: 'C',
        resolution: 'rejected',
        ts: 6000,
      });
      const nodeC = state.graph.nodes.find((n) => n.id === 'C')!;
      expect(nodeC.status).toBe('skipped');
      expect(nodeC.finishedAt).toBe(6000);
      expect(state.graph.completedPath).not.toContain('C');
    });
  });

  describe('node:retrying', () => {
    it('resets status, sets attempt, clears error/finishedAt/elapsedMs', () => {
      let state = reduce(withRunStarted(), {
        type: 'node:failed',
        executionId: 'exec-1',
        nodeId: 'A',
        error: 'boom',
        ts: 3000,
      });
      state = reduce(state, {
        type: 'node:retrying',
        executionId: 'exec-1',
        nodeId: 'A',
        attempt: 2,
        ts: 4000,
      });
      const nodeA = state.graph.nodes.find((n) => n.id === 'A')!;
      expect(nodeA.status).toBe('retrying');
      expect(nodeA.attempt).toBe(2);
      expect(nodeA.error).toBeUndefined();
      expect(nodeA.finishedAt).toBeUndefined();
      expect(nodeA.elapsedMs).toBeUndefined();
    });
  });

  describe('edge:traversed', () => {
    it('marks edge as taken and siblings from same source as not_taken', () => {
      const state = reduce(withRunStarted(), {
        type: 'edge:traversed',
        executionId: 'exec-1',
        source: 'A',
        target: 'B',
        action: 'default',
        ts: 5000,
      });
      const edgeAB = state.graph.edges.find(
        (e) => e.source === 'A' && e.target === 'B',
      )!;
      const edgeAC = state.graph.edges.find(
        (e) => e.source === 'A' && e.target === 'C',
      )!;
      const edgeBC = state.graph.edges.find(
        (e) => e.source === 'B' && e.target === 'C',
      )!;
      expect(edgeAB.state).toBe('taken');
      expect(edgeAC.state).toBe('not_taken');
      // Edge from B→C is unaffected (different source)
      expect(edgeBC.state).toBe('default');
    });
  });

  describe('cost:recorded', () => {
    it('accumulates totalCost', () => {
      let state = withRunStarted();
      state = reduce(state, {
        type: 'cost:recorded',
        executionId: 'exec-1',
        nodeId: 'A',
        tokens: 1000,
        model: 'opus',
        cost: 0.05,
        ts: 2000,
      });
      state = reduce(state, {
        type: 'cost:recorded',
        executionId: 'exec-1',
        nodeId: 'B',
        tokens: 500,
        model: 'sonnet',
        cost: 0.02,
        ts: 3000,
      });
      expect(state.totalCost).toBeCloseTo(0.07);
    });
  });

  describe('metadata (CR1)', () => {
    it('arrays accumulate, scalars overwrite', () => {
      let state = withRunStarted();
      // First array metadata
      state = reduce(state, {
        type: 'metadata',
        executionId: 'exec-1',
        key: 'tags',
        value: ['a', 'b'],
        ts: 2000,
      });
      expect(state.metadata.tags).toEqual(['a', 'b']);

      // Array merge — accumulate
      state = reduce(state, {
        type: 'metadata',
        executionId: 'exec-1',
        key: 'tags',
        value: ['c'],
        ts: 3000,
      });
      expect(state.metadata.tags).toEqual(['a', 'b', 'c']);

      // Scalar overwrite
      state = reduce(state, {
        type: 'metadata',
        executionId: 'exec-1',
        key: 'priority',
        value: 'high',
        ts: 4000,
      });
      expect(state.metadata.priority).toBe('high');

      state = reduce(state, {
        type: 'metadata',
        executionId: 'exec-1',
        key: 'priority',
        value: 'low',
        ts: 5000,
      });
      expect(state.metadata.priority).toBe('low');
    });
  });

  describe('replayEvents — full pipeline', () => {
    it('sequence of events produces correct final projection', () => {
      const events: ExecutionEvent[] = [
        runStarted(),
        { type: 'node:started', executionId: 'exec-1', nodeId: 'A', ts: 1100 },
        { type: 'node:completed', executionId: 'exec-1', nodeId: 'A', action: 'default', elapsedMs: 500, ts: 1600 },
        { type: 'edge:traversed', executionId: 'exec-1', source: 'A', target: 'B', action: 'default', ts: 1601 },
        { type: 'node:started', executionId: 'exec-1', nodeId: 'B', ts: 1700 },
        { type: 'cost:recorded', executionId: 'exec-1', nodeId: 'A', tokens: 100, model: 'opus', cost: 0.01, ts: 1750 },
        { type: 'node:completed', executionId: 'exec-1', nodeId: 'B', action: 'default', elapsedMs: 200, ts: 1900 },
        { type: 'edge:traversed', executionId: 'exec-1', source: 'B', target: 'C', action: 'default', ts: 1901 },
        { type: 'node:started', executionId: 'exec-1', nodeId: 'C', ts: 2000 },
        { type: 'node:gated', executionId: 'exec-1', nodeId: 'C', gateType: 'quality', gateData: { score: 9 }, ts: 2100 },
        { type: 'gate:resolved', executionId: 'exec-1', nodeId: 'C', resolution: 'approved', ts: 2200 },
        { type: 'run:completed', executionId: 'exec-1', status: 'completed', ts: 2300 },
      ];

      const projection = replayEvents('exec-1', events);

      expect(projection.status).toBe('completed');
      expect(projection.flowId).toBe('test-flow');
      expect(projection.startedAt).toBe(1000);
      expect(projection.finishedAt).toBe(2300);
      expect(projection.totalCost).toBeCloseTo(0.01);

      expect(projection.graph.completedPath).toEqual(['A', 'B', 'C']);
      expect(projection.graph.activeNodes).toEqual([]);

      const nodeA = projection.graph.nodes.find((n) => n.id === 'A')!;
      expect(nodeA.status).toBe('completed');
      expect(nodeA.attempt).toBe(1);

      const nodeC = projection.graph.nodes.find((n) => n.id === 'C')!;
      expect(nodeC.status).toBe('completed');

      // Edge A→B taken, A→C not_taken (sibling), B→C taken
      const edgeAB = projection.graph.edges.find((e) => e.source === 'A' && e.target === 'B')!;
      expect(edgeAB.state).toBe('taken');
      const edgeAC = projection.graph.edges.find((e) => e.source === 'A' && e.target === 'C')!;
      expect(edgeAC.state).toBe('not_taken');
      const edgeBC = projection.graph.edges.find((e) => e.source === 'B' && e.target === 'C')!;
      expect(edgeBC.state).toBe('taken');
    });
  });
});
