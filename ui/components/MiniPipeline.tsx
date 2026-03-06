'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
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

function GraphMode({ projection, height = 40 }: { projection: ExecutionProjection; height: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const filterId = useId();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { miniNodes, maxLayer, maxRow, backEdgeKeys } = useMemo(
    () => computeMiniLayout(projection.graph.nodes, projection.graph.edges),
    [projection.graph.nodes, projection.graph.edges],
  );

  // --- Pill layout constants ---
  const pillH = 18;
  const pillR = pillH / 2;
  const pillGap = 5;          // gap between stacked pills in same column
  const colPad = 16;           // horizontal padding from edges
  const hasBackEdges = backEdgeKeys.size > 0;

  // Column positions
  const effectiveWidth = containerWidth || 200;
  const colWidth = maxLayer > 0
    ? (effectiveWidth - colPad * 2) / (maxLayer + 1)
    : effectiveWidth - colPad * 2;
  const pillW = Math.min(colWidth * 0.55, 60); // pill width: 55% of column or max 60px
  const connGap = colWidth - pillW;             // horizontal gap between pill columns

  // SVG height: tallest column determines it
  const layerCounts = new Map<number, number>();
  for (const n of miniNodes) layerCounts.set(n.layer, (layerCounts.get(n.layer) ?? 0) + 1);
  const maxInLayer = Math.max(1, ...layerCounts.values());
  const tallestCol = maxInLayer * pillH + (maxInLayer - 1) * pillGap;
  const svgHeight = Math.max(height, tallestCol + colPad * 2 + (hasBackEdges ? 16 : 0));
  const centerY = (svgHeight - (hasBackEdges ? 16 : 0)) / 2;

  // Position each pill (center x, center y)
  const pillPos = new Map<string, { cx: number; cy: number }>();
  for (const n of miniNodes) {
    const cx = colPad + n.layer * colWidth + colWidth / 2;
    const count = layerCounts.get(n.layer) ?? 1;
    const blockH = count * pillH + (count - 1) * pillGap;
    const topY = centerY - blockH / 2;
    const cy = topY + n.row * (pillH + pillGap) + pillH / 2;
    pillPos.set(n.id, { cx, cy });
  }

  // Column center X by layer
  const colCenterX = (layer: number) => colPad + layer * colWidth + colWidth / 2;

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      {containerWidth > 0 && (
        <svg width={containerWidth} height={svgHeight} style={{ display: 'block' }}>
          <defs>
            <filter id={`gc-${filterId}`} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <filter id={`ga-${filterId}`} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {/* Horizontal connector lines between columns */}
          {Array.from({ length: maxLayer }, (_, i) => {
            const x1 = colCenterX(i) + pillW / 2;
            const x2 = colCenterX(i + 1) - pillW / 2;
            // Check if any taken edge connects these layers
            const hasTaken = projection.graph.edges.some(e => {
              const sLayer = miniNodes.find(n => n.id === e.source)?.layer;
              const tLayer = miniNodes.find(n => n.id === e.target)?.layer;
              return sLayer === i && tLayer === i + 1 && e.state === 'taken';
            });
            return (
              <line key={`conn-${i}`}
                x1={x1} y1={centerY} x2={x2} y2={centerY}
                stroke={hasTaken ? '#4ade80' : '#3d3a36'}
                strokeWidth={hasTaken ? 2 : 1.5}
                strokeOpacity={hasTaken ? 0.7 : 0.4}
                strokeLinecap="round"
              />
            );
          })}

          {/* Back-edge arcs (convergence loops) — subtle curve below */}
          {projection.graph.edges
            .filter(e => e.target !== 'end' && backEdgeKeys.has(`${e.source}:${e.target}`))
            .map((e, i) => {
              const sPos = pillPos.get(e.source);
              const tPos = pillPos.get(e.target);
              if (!sPos || !tPos) return null;
              const y = svgHeight - 8;
              const d = `M ${sPos.cx},${sPos.cy + pillH / 2} C ${sPos.cx},${y} ${tPos.cx},${y} ${tPos.cx},${tPos.cy + pillH / 2}`;
              return (
                <path key={`bk-${i}`} d={d} fill="none"
                  stroke="#585350" strokeWidth={1.5}
                  strokeDasharray="4 5" strokeOpacity={0.3}
                  strokeLinecap="round"
                />
              );
            })}

          {/* Node pills */}
          {miniNodes.map(n => {
            const pos = pillPos.get(n.id)!;
            const color = STATUS_COLORS[n.status]?.dot ?? '#555';
            const isActive = n.status === 'running' || n.status === 'gated';
            const isCompleted = n.status === 'completed';
            const isPending = n.status === 'pending' || n.status === 'killed' || n.status === 'skipped';

            return (
              <g key={n.id}
                filter={isActive ? `url(#ga-${filterId})` : isCompleted ? `url(#gc-${filterId})` : undefined}>
                <rect
                  x={pos.cx - pillW / 2} y={pos.cy - pillH / 2}
                  width={pillW} height={pillH}
                  rx={pillR} ry={pillR}
                  fill={isPending ? 'none' : color}
                  fillOpacity={isPending ? 0 : isCompleted ? 0.9 : 0.85}
                  stroke={isPending ? '#585350' : color}
                  strokeWidth={isPending ? 1.5 : 0.5}
                  strokeOpacity={isPending ? 0.6 : 0.3}
                >
                  {isActive && (
                    <animate attributeName="opacity" values="1;0.4;1" dur="1.5s" repeatCount="indefinite" />
                  )}
                </rect>
                <title>{n.id}: {n.status}</title>
              </g>
            );
          })}
        </svg>
      )}
    </div>
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
      return <GraphMode projection={projection} height={height ?? 40} />;
    case 'bar':
      return <BarMode projection={projection} height={height ?? 8} />;
    case 'summary':
      return <SummaryMode projection={projection} height={height ?? 20} />;
  }
}
