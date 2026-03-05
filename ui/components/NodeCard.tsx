'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ProjectionNode } from '../../src/types';
import { cn } from '../utils';
import { formatElapsed } from '../core/utils';

// ---------------------------------------------------------------------------
// Status styling
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, { bg: string; border: string; icon: string; animate?: string }> = {
  pending:   { bg: 'bg-muted/30',           border: 'border-muted',    icon: '○' },
  running:   { bg: 'bg-blue-500/10',        border: 'border-blue-500', icon: '●', animate: 'animate-pulse-status' },
  completed: { bg: 'bg-green-500/10',       border: 'border-green-500', icon: '✓' },
  failed:    { bg: 'bg-red-500/10',         border: 'border-red-500',  icon: '✗' },
  killed:    { bg: 'bg-muted/30',           border: 'border-muted',    icon: '■' },
  skipped:   { bg: 'bg-muted/20',           border: 'border-muted/50', icon: '→' },
  gated:     { bg: 'bg-yellow-500/10',      border: 'border-yellow-500', icon: '⏸', animate: 'animate-pulse-status' },
  retrying:  { bg: 'bg-orange-500/10',      border: 'border-orange-500', icon: '↻', animate: 'animate-pulse-status' },
};

const TYPE_BADGES: Record<string, { label: string; color: string }> = {
  agent:         { label: 'Agent',         color: 'bg-blue-500/20 text-blue-400' },
  deterministic: { label: 'Check',         color: 'bg-purple-500/20 text-purple-400' },
  gate:          { label: 'Gate',          color: 'bg-yellow-500/20 text-yellow-400' },
  verify:        { label: 'Verify',        color: 'bg-orange-500/20 text-orange-400' },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function NodeCardInner({ data, selected }: NodeProps) {
  const node = data as unknown as ProjectionNode;
  const style = STATUS_STYLES[node.status] ?? STATUS_STYLES.pending;
  const badge = TYPE_BADGES[node.nodeType] ?? { label: node.nodeType, color: 'bg-muted text-muted-foreground' };

  return (
    <>
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground !w-2 !h-2" />

      <div
        className={cn(
          'rounded-lg border px-3 py-2 shadow-sm transition-all w-[200px]',
          style.bg,
          style.border,
          selected && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
        )}
      >
        {/* Header: status icon + name */}
        <div className="flex items-center gap-2">
          <span className={cn('text-sm', style.animate)}>{style.icon}</span>
          <span className="text-sm font-medium truncate flex-1">{node.displayName}</span>
        </div>

        {/* Footer: type badge + elapsed time + model */}
        <div className="flex items-center justify-between mt-1.5 gap-1">
          <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', badge.color)}>
            {badge.label}
          </span>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {node.model && <span>{node.model}</span>}
            {node.elapsedMs && <span>{formatElapsed(node.elapsedMs)}</span>}
            {node.attempt > 1 && <span>×{node.attempt}</span>}
          </div>
        </div>

        {/* Error indicator */}
        {node.error && (
          <div className="mt-1 text-[10px] text-red-400 truncate" title={node.error}>
            {node.error}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="!bg-muted-foreground !w-2 !h-2" />
    </>
  );
}

export const NodeCard = memo(NodeCardInner);
