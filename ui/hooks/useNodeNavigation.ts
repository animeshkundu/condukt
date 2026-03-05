'use client';

import { useEffect } from 'react';
import type { ProjectionNode } from '../../src/types';

export function useNodeNavigation(
  nodes: ProjectionNode[],
  selectedId: string | null,
  onSelect: (id: string | null) => void,
): void {
  useEffect(() => {
    if (nodes.length === 0) return;

    function handleKeyDown(e: KeyboardEvent) {
      // Skip when focus is in an input or textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        onSelect(null);
        return;
      }

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const idx = selectedId ? nodes.findIndex(n => n.id === selectedId) : -1;
        const next = (idx + 1) % nodes.length;
        onSelect(nodes[next].id);
        return;
      }

      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = selectedId ? nodes.findIndex(n => n.id === selectedId) : 0;
        const prev = (idx - 1 + nodes.length) % nodes.length;
        onSelect(nodes[prev].id);
        return;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [nodes, selectedId, onSelect]);
}
