'use client';

import { useMemo } from 'react';
import type { ExecutionProjection, ProjectionNode, ProjectionEdge } from '../../src/types';
import { STATUS_COLORS } from './node-panel/types';
import { detectBackEdges } from './FlowGraph';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MiniPipelineProps {
  projection: ExecutionProjection;
  /** Rendering mode. auto: graph ≤20, bar ≤50, summary >50. */
  mode?: 'graph' | 'bar' | 'summary' | 'auto';
  /** Height in px. Default: 32 for graph, 8 for bar, 20 for summary. */
  height?: number;
}

// ---------------------------------------------------------------------------
// Layout (simplified topological sort for mini graph)
// ---------------------------------------------------------------------------

interface MiniNode {
  id: string;
  status: string;
  layer: number;
  row: number; // position within layer (for parallel nodes)
}

function computeMiniLayout(nodes: readonly ProjectionNode[], edges: readonly ProjectionEdge[]): {
  miniNodes: MiniNode[];
  maxLayer: number;
  maxRow: number;
  backEdgeKeys: Set<string>;
} {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const nodeIds = nodes.map(n => n.id);

  // Detect back-edges before Kahn's
  const backEdgeKeys = detectBackEdges(nodeIds, edges);

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (e.target !== 'end' && nodeMap.has(e.target) && !backEdgeKeys.has(`${e.source}:${e.target}`)) {
      adj.get(e.source)?.push(e.target);
      inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    }
  }

  // Kahn's algorithm for layer assignment
  const layers = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) { queue.push(id); layers.set(id, 0); }
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curLayer = layers.get(cur)!;
    for (const next of adj.get(cur) ?? []) {
      layers.set(next, Math.max(layers.get(next) ?? 0, curLayer + 1));
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  // Assign rows within each layer
  const layerGroups = new Map<number, string[]>();
  for (const [id, layer] of layers) {
    if (!layerGroups.has(layer)) layerGroups.set(layer, []);
    layerGroups.get(layer)!.push(id);
  }

  const miniNodes: MiniNode[] = [];
  let maxRow = 0;
  for (const [layer, ids] of layerGroups) {
    ids.forEach((id, row) => {
      miniNodes.push({ id, status: nodeMap.get(id)?.status ?? 'pending', layer, row });
      if (row > maxRow) maxRow = row;
    });
  }

  const maxLayer = Math.max(0, ...[...layers.values()]);
  return { miniNodes, maxLayer, maxRow, backEdgeKeys };
}

// ---------------------------------------------------------------------------
// Graph mode — compact SVG mini-DAG
// ---------------------------------------------------------------------------

function GraphMode({ projection, height = 32 }: { projection: ExecutionProjection; height: number }) {
  const { miniNodes, maxLayer, maxRow, backEdgeKeys } = useMemo(
    () => computeMiniLayout(projection.graph.nodes, projection.graph.edges),
    [projection.graph.nodes, projection.graph.edges],
  );

  const dotSize = 6;
  const xGap = 16;
  const yGap = 10;
  const padding = 4;
  const width = (maxLayer + 1) * (dotSize + xGap) + padding * 2;
  const svgHeight = Math.max(height, (maxRow + 1) * (dotSize + yGap) + padding * 2);

  const nodePos = new Map<string, { x: number; y: number }>();
  for (const n of miniNodes) {
    const x = padding + n.layer * (dotSize + xGap) + dotSize / 2;
    const totalRows = miniNodes.filter(m => m.layer === n.layer).length;
    const layerHeight = totalRows * (dotSize + yGap) - yGap;
    const startY = (svgHeight - layerHeight) / 2;
    const y = startY + n.row * (dotSize + yGap) + dotSize / 2;
    nodePos.set(n.id, { x, y });
  }

  return (
    <svg width={width} height={svgHeight} style={{ display: 'block', overflow: 'visible' }}>
      {/* Edges */}
      {projection.graph.edges.filter(e => e.target !== 'end').map((e, i) => {
        const from = nodePos.get(e.source);
        const to = nodePos.get(e.target);
        if (!from || !to) return null;
        const isBack = backEdgeKeys.has(`${e.source}:${e.target}`);
        if (isBack) {
          // Dashed arc above the graph
          const midX = (from.x + to.x) / 2;
          const arcY = Math.min(from.y, to.y) - 14;
          const d = `M ${from.x + dotSize / 2},${from.y} C ${from.x + dotSize / 2},${arcY} ${to.x - dotSize / 2},${arcY} ${to.x - dotSize / 2},${to.y}`;
          return (
            <path key={`back-${i}`} d={d}
              fill="none" stroke="#585350" strokeWidth={0.75}
              strokeDasharray="3 2"
            />
          );
        }
        return (
          <line key={i}
            x1={from.x + dotSize / 2} y1={from.y}
            x2={to.x - dotSize / 2} y2={to.y}
            stroke={e.state === 'taken' ? '#4ade80' : '#333'}
            strokeWidth={e.state === 'taken' ? 1.5 : 0.5}
            strokeDasharray={e.state === 'not_taken' ? '2 2' : undefined}
          />
        );
      })}
      {/* Nodes */}
      {miniNodes.map(n => {
        const pos = nodePos.get(n.id)!;
        const color = STATUS_COLORS[n.status]?.dot ?? '#555';
        const isActive = n.status === 'running' || n.status === 'gated';
        return (
          <g key={n.id}>
            <circle cx={pos.x} cy={pos.y} r={dotSize / 2} fill={color}
              style={isActive ? { filter: `drop-shadow(0 0 3px ${color})` } : undefined}>
              {isActive && (
                <animate attributeName="opacity" values="1;0.4;1" dur="1.5s" repeatCount="indefinite" />
              )}
            </circle>
            <title>{n.id}: {n.status}</title>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Bar mode — proportional status bar
// ---------------------------------------------------------------------------

function BarMode({ projection, height = 8 }: { projection: ExecutionProjection; height: number }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of projection.graph.nodes) {
      c[n.status] = (c[n.status] ?? 0) + 1;
    }
    return c;
  }, [projection.graph.nodes]);

  const total = projection.graph.nodes.length;
  if (total === 0) return null;

  const segments = Object.entries(counts)
    .sort(([a], [b]) => {
      const order = ['completed', 'running', 'gated', 'retrying', 'failed', 'killed', 'skipped', 'pending'];
      return order.indexOf(a) - order.indexOf(b);
    });

  return (
    <div style={{ display: 'flex', height, borderRadius: height / 2, overflow: 'hidden', background: '#1a1a1a' }}>
      {segments.map(([status, count]) => (
        <div
          key={status}
          title={`${count} ${status}`}
          style={{
            width: `${(count / total) * 100}%`,
            background: STATUS_COLORS[status]?.dot ?? '#555',
            transition: 'width 0.3s',
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary mode — text counts
// ---------------------------------------------------------------------------

function SummaryMode({ projection, height = 20 }: { projection: ExecutionProjection; height: number }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of projection.graph.nodes) {
      c[n.status] = (c[n.status] ?? 0) + 1;
    }
    return c;
  }, [projection.graph.nodes]);

  const parts = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort(([a], [b]) => {
      const order = ['completed', 'running', 'gated', 'failed', 'pending', 'killed', 'skipped'];
      return order.indexOf(a) - order.indexOf(b);
    });

  return (
    <div style={{ height, display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
      {parts.map(([status, count]) => (
        <span key={status} style={{ color: STATUS_COLORS[status]?.dot ?? '#888' }}>
          {count} {status}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MiniPipeline — main component (ADR-004)
// ---------------------------------------------------------------------------

export function MiniPipeline({ projection, mode = 'auto', height }: MiniPipelineProps) {
  const nodeCount = projection.graph.nodes.length;

  const resolvedMode = mode === 'auto'
    ? nodeCount <= 20 ? 'graph' : nodeCount <= 50 ? 'bar' : 'summary'
    : mode;

  switch (resolvedMode) {
    case 'graph':
      return <GraphMode projection={projection} height={height ?? 32} />;
    case 'bar':
      return <BarMode projection={projection} height={height ?? 8} />;
    case 'summary':
      return <SummaryMode projection={projection} height={height ?? 20} />;
  }
}
