/**
 * Shared types for NodePanel compound components.
 */

import type { ProjectionNode } from '../../../src/types';

export type OnActionFn = (action: string, nodeId: string) => void;

export interface NodePanelContext {
  node: ProjectionNode;
  executionId: string;
  onAction: OnActionFn;
  onClose: () => void;
}

/** Status → inline style colors (no Tailwind dependency). */
export const STATUS_COLORS: Record<string, { dot: string; text: string; bg: string }> = {
  pending:   { dot: '#555', text: '#888', bg: '#252320' },
  running:   { dot: '#60a5fa', text: '#60a5fa', bg: '#1a2a40' },
  completed: { dot: '#4ade80', text: '#4ade80', bg: '#1a3528' },
  failed:    { dot: '#f87171', text: '#f87171', bg: '#3a1a1a' },
  killed:    { dot: '#666', text: '#888', bg: '#252320' },
  skipped:   { dot: '#555', text: '#888', bg: '#252320' },
  gated:     { dot: '#fbbf24', text: '#fbbf24', bg: '#352a15' },
  retrying:  { dot: '#fb923c', text: '#fb923c', bg: '#3a2515' },
  stopped:   { dot: '#fbbf24', text: '#fbbf24', bg: '#352a15' },
  crashed:   { dot: '#c084fc', text: '#c084fc', bg: '#2a1845' },
};

export function sc(status: string) {
  return STATUS_COLORS[status] ?? STATUS_COLORS.pending;
}
