'use client';

import { useMemo } from 'react';
import type { ProjectionNode } from '../../src/types';

const PRIORITY: Record<string, number> = {
  running: 1,
  retrying: 2,
  gated: 3,
  failed: 4,
};

export function useAutoSelectNode(nodes: ProjectionNode[]): string | null {
  return useMemo(() => {
    if (nodes.length === 0) return null;

    // Find highest-priority active node
    let best: ProjectionNode | null = null;
    let bestPriority = Infinity;

    for (const node of nodes) {
      const p = PRIORITY[node.status];
      if (p != null && p < bestPriority) {
        best = node;
        bestPriority = p;
      }
    }

    if (best) return best.id;

    // Fall back to last completed node (last in array order with status completed)
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].status === 'completed') return nodes[i].id;
    }

    return null;
  }, [nodes]);
}
