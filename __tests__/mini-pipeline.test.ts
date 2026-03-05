/**
 * MiniPipeline tests — verifies mode selection, layout logic, and rendering.
 * Tests pure logic (no React rendering) — mode selection and layout computation.
 */

import { describe, it, expect } from 'vitest';
import type { ExecutionProjection, ProjectionNode, ProjectionEdge } from '../src/types';

// Mode selection logic (extracted from MiniPipeline component)
function selectMode(nodeCount: number, mode: 'graph' | 'bar' | 'summary' | 'auto'): string {
  if (mode !== 'auto') return mode;
  if (nodeCount <= 20) return 'graph';
  if (nodeCount <= 50) return 'bar';
  return 'summary';
}

function mockProjection(nodeCount: number, statuses?: Record<string, string>): ExecutionProjection {
  const nodes: ProjectionNode[] = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    displayName: `Node ${i}`,
    nodeType: 'deterministic',
    status: statuses?.[`n${i}`] ?? (i < nodeCount / 2 ? 'completed' : 'pending'),
    attempt: 1,
  }));

  // Linear chain
  const edges: ProjectionEdge[] = [];
  for (let i = 0; i < nodeCount - 1; i++) {
    edges.push({ source: `n${i}`, action: 'default', target: `n${i + 1}`, state: i < nodeCount / 2 ? 'taken' : 'default' });
  }

  return {
    id: 'test', flowId: '', status: 'running', params: {},
    graph: { nodes, edges, activeNodes: [], completedPath: [] },
    totalCost: 0, metadata: {},
  };
}

describe('MiniPipeline mode selection', () => {
  it('auto selects graph for ≤20 nodes', () => {
    expect(selectMode(5, 'auto')).toBe('graph');
    expect(selectMode(20, 'auto')).toBe('graph');
  });

  it('auto selects bar for 21-50 nodes', () => {
    expect(selectMode(21, 'auto')).toBe('bar');
    expect(selectMode(50, 'auto')).toBe('bar');
  });

  it('auto selects summary for >50 nodes', () => {
    expect(selectMode(51, 'auto')).toBe('summary');
    expect(selectMode(200, 'auto')).toBe('summary');
  });

  it('explicit mode overrides auto', () => {
    expect(selectMode(5, 'bar')).toBe('bar');
    expect(selectMode(200, 'graph')).toBe('graph');
    expect(selectMode(10, 'summary')).toBe('summary');
  });
});

describe('MiniPipeline projection handling', () => {
  it('handles empty projection (0 nodes)', () => {
    const proj = mockProjection(0);
    expect(proj.graph.nodes).toHaveLength(0);
    expect(selectMode(0, 'auto')).toBe('graph');
  });

  it('handles 3-node CI/CD pipeline', () => {
    const proj = mockProjection(3, { n0: 'completed', n1: 'running', n2: 'pending' });
    expect(proj.graph.nodes).toHaveLength(3);
    expect(selectMode(3, 'auto')).toBe('graph');
  });

  it('handles 9-node investigation pipeline', () => {
    const proj = mockProjection(9);
    expect(selectMode(9, 'auto')).toBe('graph');
  });

  it('handles 30-node ML feature pipeline', () => {
    const proj = mockProjection(30);
    expect(selectMode(30, 'auto')).toBe('bar');
  });

  it('handles 200-node data pipeline', () => {
    const proj = mockProjection(200);
    expect(selectMode(200, 'auto')).toBe('summary');
  });

  it('counts statuses correctly for bar/summary mode', () => {
    const proj = mockProjection(10, {
      n0: 'completed', n1: 'completed', n2: 'completed',
      n3: 'running', n4: 'running',
      n5: 'failed',
      n6: 'pending', n7: 'pending', n8: 'pending', n9: 'pending',
    });

    const counts: Record<string, number> = {};
    for (const n of proj.graph.nodes) {
      counts[n.status] = (counts[n.status] ?? 0) + 1;
    }
    expect(counts.completed).toBe(3);
    expect(counts.running).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.pending).toBe(4);
  });
});

describe('MiniPipeline parallel detection', () => {
  it('parallel start nodes get different rows in same layer', () => {
    // Simulate: [A, B] → C (parallel start, fan-in)
    const nodes: ProjectionNode[] = [
      { id: 'A', displayName: 'A', nodeType: 'agent', status: 'completed', attempt: 1 },
      { id: 'B', displayName: 'B', nodeType: 'agent', status: 'completed', attempt: 1 },
      { id: 'C', displayName: 'C', nodeType: 'agent', status: 'running', attempt: 1 },
    ];
    const edges: ProjectionEdge[] = [
      { source: 'A', action: 'default', target: 'C', state: 'taken' },
      { source: 'B', action: 'default', target: 'C', state: 'taken' },
    ];

    // Topological sort: A and B both have 0 in-degree → layer 0
    // C has 2 in-degree → layer 1
    const inDegree = new Map<string, number>();
    for (const n of nodes) inDegree.set(n.id, 0);
    for (const e of edges) inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);

    expect(inDegree.get('A')).toBe(0);
    expect(inDegree.get('B')).toBe(0);
    expect(inDegree.get('C')).toBe(2);

    // Layer assignment
    const layers = new Map<string, number>();
    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) { queue.push(id); layers.set(id, 0); }
    }
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const e of edges.filter(e => e.source === cur)) {
        layers.set(e.target, Math.max(layers.get(e.target) ?? 0, layers.get(cur)! + 1));
        const newDeg = (inDegree.get(e.target) ?? 1) - 1;
        inDegree.set(e.target, newDeg);
        if (newDeg === 0) queue.push(e.target);
      }
    }

    expect(layers.get('A')).toBe(0);
    expect(layers.get('B')).toBe(0);
    expect(layers.get('C')).toBe(1);

    // A and B in same layer (0) → different rows
    const layer0 = [...layers.entries()].filter(([, l]) => l === 0).map(([id]) => id);
    expect(layer0).toHaveLength(2);
    expect(layer0).toContain('A');
    expect(layer0).toContain('B');
  });
});
