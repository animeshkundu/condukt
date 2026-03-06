'use client';

import { useMemo } from 'react';
import type { ExecutionProjection } from '../../src/types';
import { cn } from '../utils';

interface FlowStatusBarProps {
  projection: ExecutionProjection;
}

export function FlowStatusBar({ projection }: FlowStatusBarProps) {
  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const node of projection.graph.nodes) {
      result[node.status] = (result[node.status] ?? 0) + 1;
    }
    return result;
  }, [projection.graph.nodes]);

  const maxIteration = useMemo(() => {
    let max = 0;
    for (const node of projection.graph.nodes) {
      if ((node.iteration ?? 0) > max) max = node.iteration ?? 0;
    }
    return max;
  }, [projection.graph.nodes]);

  const totalCost = projection.totalCost;
  const duration = projection.startedAt && projection.finishedAt
    ? ((projection.finishedAt - projection.startedAt) / 1000).toFixed(0)
    : projection.startedAt
      ? ((Date.now() - projection.startedAt) / 1000).toFixed(0)
      : null;

  return (
    <div className="flex items-center gap-4 px-4 py-1.5 text-xs text-muted-foreground border-t border-border bg-background">
      <div className="flex items-center gap-3">
        {counts.completed && <StatusCount label="completed" count={counts.completed} color="text-green-400" />}
        {counts.running && <StatusCount label="running" count={counts.running} color="text-blue-400" />}
        {counts.pending && <StatusCount label="pending" count={counts.pending} color="text-muted-foreground" />}
        {counts.failed && <StatusCount label="failed" count={counts.failed} color="text-red-400" />}
        {counts.gated && <StatusCount label="gated" count={counts.gated} color="text-yellow-400" />}
        {counts.skipped && <StatusCount label="skipped" count={counts.skipped} color="text-muted-foreground/50" />}
        {counts.killed && <StatusCount label="killed" count={counts.killed} color="text-muted-foreground" />}
      </div>

      <div className="w-px h-3 bg-border" />

      <span className={cn(
        projection.status === 'running' && 'text-blue-400',
        projection.status === 'completed' && 'text-green-400',
        projection.status === 'failed' && 'text-red-400',
        projection.status === 'stopped' && 'text-yellow-400',
      )}>
        {projection.status === 'running' && maxIteration > 0
          ? `Running (iteration ${maxIteration})`
          : projection.status}
      </span>

      {duration && (
        <>
          <div className="w-px h-3 bg-border" />
          <span>{duration}s</span>
        </>
      )}

      {totalCost > 0 && (
        <>
          <div className="w-px h-3 bg-border" />
          <span>${totalCost.toFixed(2)}</span>
        </>
      )}
    </div>
  );
}

function StatusCount({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <span className={cn('flex items-center gap-1', color)}>
      <span className="font-medium">{count}</span>
      <span>{label}</span>
    </span>
  );
}
