'use client';

import { useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  type Node,
  type Edge,
  useNodesState,
  useEdgesState,
  type NodeTypes,
  type EdgeTypes,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
} from '@xyflow/react';
// Styles: consumers import 'condukt/ui/style.css' in their layout (see COMPOSITION_GUIDE.md).
// We do NOT import CSS here — tsc can't process it, and runtime imports break webpack consumers.
import type { ExecutionProjection, ProjectionNode, ProjectionEdge } from '../../src/types';
import { NodeCard } from './NodeCard';
import { FlowEdge } from './FlowEdge';

// ---------------------------------------------------------------------------
// Layout computation (simple layered layout)
// ---------------------------------------------------------------------------

interface LayoutResult {
  nodes: Node[];
  edges: Edge[];
}

/** Detect back-edges via DFS. Returns set of "source:target" keys. */
export function detectBackEdges(
  nodeIds: readonly string[],
  edges: readonly { source: string; target: string }[],
): Set<string> {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const backEdgeKeys = new Set<string>();
  const nodeSet = new Set(nodeIds);

  for (const id of nodeIds) color.set(id, WHITE);

  const adj = new Map<string, Array<{ source: string; target: string }>>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    if (e.target !== 'end' && nodeSet.has(e.target)) {
      adj.get(e.source)?.push(e);
    }
  }

  function dfs(node: string): void {
    color.set(node, GRAY);
    for (const edge of adj.get(node) ?? []) {
      const c = color.get(edge.target);
      if (c === GRAY) {
        backEdgeKeys.add(`${edge.source}:${edge.target}`);
      } else if (c === WHITE) {
        dfs(edge.target);
      }
    }
    color.set(node, BLACK);
  }

  for (const id of nodeIds) {
    if (color.get(id) === WHITE) dfs(id);
  }

  return backEdgeKeys;
}

function computeLayout(projection: ExecutionProjection): LayoutResult {
  const { nodes: projNodes, edges: projEdges } = projection.graph;

  // Detect back-edges via DFS before running Kahn's
  const nodeIds = projNodes.map(n => n.id);
  const backEdgeKeys = detectBackEdges(nodeIds, projEdges);

  // Build adjacency for topological ordering, excluding back-edges
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();
  for (const n of projNodes) {
    inDegree.set(n.id, 0);
    adjList.set(n.id, []);
  }
  for (const e of projEdges) {
    if (e.target !== 'end' && !backEdgeKeys.has(`${e.source}:${e.target}`)) {
      adjList.get(e.source)?.push(e.target);
      inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    }
  }

  // Assign layers via BFS (Kahn's algorithm)
  const layers = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
      layers.set(id, 0);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentLayer = layers.get(current)!;
    for (const next of adjList.get(current) ?? []) {
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      layers.set(next, Math.max(layers.get(next) ?? 0, currentLayer + 1));
      if (newDeg === 0) queue.push(next);
    }
  }

  // Group by layer
  const layerGroups = new Map<number, string[]>();
  for (const [id, layer] of layers) {
    if (!layerGroups.has(layer)) layerGroups.set(layer, []);
    layerGroups.get(layer)!.push(id);
  }

  // Position nodes
  const NODE_WIDTH = 200;
  const NODE_HEIGHT = 70;
  const X_GAP = 60;
  const Y_GAP = 30;

  const nodes: Node[] = [];
  for (const [layer, ids] of layerGroups) {
    const totalHeight = ids.length * NODE_HEIGHT + (ids.length - 1) * Y_GAP;
    const startY = -totalHeight / 2;

    ids.forEach((id, index) => {
      const projNode = projNodes.find((n) => n.id === id);
      nodes.push({
        id,
        type: 'nodeCard',
        position: {
          x: layer * (NODE_WIDTH + X_GAP),
          y: startY + index * (NODE_HEIGHT + Y_GAP),
        },
        data: { ...(projNode ?? { id, displayName: id, nodeType: 'unknown', status: 'pending', attempt: 0 }) } as Record<string, unknown>,
      });
    });
  }

  // Map edges (mark back-edges for distinct rendering)
  const edges: Edge[] = projEdges
    .filter((e) => e.target !== 'end')
    .map((e, i) => ({
      id: `e-${e.source}-${e.target}-${i}`,
      source: e.source,
      target: e.target,
      type: 'flowEdge',
      data: { state: e.state, action: e.action, isBackEdge: backEdgeKeys.has(`${e.source}:${e.target}`) },
      animated: e.state === 'taken',
    }));

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Node and Edge type registrations
// ---------------------------------------------------------------------------

const nodeTypes: NodeTypes = {
  nodeCard: NodeCard,
};

const edgeTypes: EdgeTypes = {
  flowEdge: FlowEdge,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface FlowGraphProps {
  projection: ExecutionProjection;
  selectedNodeId: string | null;
  onNodeSelect: (nodeId: string) => void;
}

export function FlowGraph({ projection, selectedNodeId, onNodeSelect }: FlowGraphProps) {
  const layout = useMemo(() => computeLayout(projection), [projection]);
  const [nodes, setNodes, onNodesChange] = useNodesState(layout.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layout.edges);

  // Update when projection changes
  useEffect(() => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
  }, [layout, setNodes, setEdges]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onNodeSelect(node.id);
    },
    [onNodeSelect],
  );

  return (
    <div className="h-full w-full" style={{ minHeight: 400 }}>
      <ReactFlow
        nodes={nodes.map((n) => ({
          ...n,
          selected: n.id === selectedNodeId,
        }))}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="hsl(var(--muted))" />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => {
            const status = (n.data as unknown as ProjectionNode)?.status ?? 'pending';
            switch (status) {
              case 'completed': return 'hsl(142 76% 36%)';
              case 'running': return 'hsl(217 91% 60%)';
              case 'failed': return 'hsl(0 84% 60%)';
              case 'gated': return 'hsl(48 96% 53%)';
              case 'killed': return 'hsl(0 0% 45%)';
              default: return 'hsl(0 0% 30%)';
            }
          }}
          zoomable
          pannable
        />
      </ReactFlow>
    </div>
  );
}
