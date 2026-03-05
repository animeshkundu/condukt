'use client';

import { useMemo } from 'react';
import { useNodeOutput } from '../hooks/useNodeOutput';
import type { ExecutionProjection, ProjectionNode } from '../../src/types';
import { cn } from '../utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NodeDetailPanelProps {
  projection: ExecutionProjection;
  nodeId: string;
  onClose: () => void;
  onAction: (action: 'retry' | 'skip' | 'approve' | 'reject', nodeId: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeDetailPanel({ projection, nodeId, onClose, onAction }: NodeDetailPanelProps) {
  const node = useMemo(
    () => projection.graph.nodes.find((n) => n.id === nodeId),
    [projection, nodeId],
  );

  const { lines, total, loading, scrollRef } = useNodeOutput({
    executionId: projection.id,
    nodeId,
  });

  if (!node) return null;

  return (
    <div className="flex h-full flex-col border-l border-border bg-background animate-slide-in" style={{ width: '40%', minWidth: 360 }}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <StatusDot status={node.status} />
          <span className="font-medium">{node.displayName}</span>
          <span className="text-xs text-muted-foreground">({node.nodeType})</span>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg">
          ×
        </button>
      </div>

      {/* Node info */}
      <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground space-y-1">
        <div className="flex justify-between">
          <span>Status: <span className="text-foreground">{node.status}</span></span>
          {node.attempt > 0 && <span>Attempt: {node.attempt}</span>}
        </div>
        {node.model && <div>Model: {node.model}</div>}
        {node.elapsedMs && <div>Duration: {(node.elapsedMs / 1000).toFixed(1)}s</div>}
        {node.error && <div className="text-red-400">Error: {node.error}</div>}
      </div>

      {/* Gate controls */}
      {node.status === 'gated' && (
        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-medium mb-2">Awaiting Approval</div>
          {node.gateData && (
            <pre className="text-xs bg-muted/30 rounded p-2 mb-2 max-h-32 overflow-auto">
              {JSON.stringify(node.gateData, null, 2)}
            </pre>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => onAction('approve', nodeId)}
              className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded"
            >
              Approve
            </button>
            <button
              onClick={() => onAction('reject', nodeId)}
              className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded"
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {/* Node controls */}
      {(node.status === 'failed' || node.status === 'completed' || node.status === 'killed') && (
        <div className="border-b border-border px-4 py-2 flex gap-2">
          <button
            onClick={() => onAction('retry', nodeId)}
            className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded"
          >
            Retry
          </button>
          {node.status !== 'completed' && (
            <button
              onClick={() => onAction('skip', nodeId)}
              className="px-3 py-1 text-xs bg-muted hover:bg-muted/80 text-foreground rounded"
            >
              Skip
            </button>
          )}
        </div>
      )}

      {/* Output stream */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="px-4 py-2 text-xs text-muted-foreground border-b border-border flex justify-between">
          <span>Output ({total} lines)</span>
          {loading && <span className="animate-pulse-status">Loading...</span>}
        </div>
        <div
          ref={scrollRef as React.RefObject<HTMLDivElement>}
          className="flex-1 overflow-y-auto px-4 py-2 font-mono text-xs leading-relaxed"
        >
          {lines.length === 0 ? (
            <span className="text-muted-foreground">No output yet</span>
          ) : (
            lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">{line}</div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-muted-foreground',
    running: 'bg-blue-500 animate-pulse-status',
    completed: 'bg-green-500',
    failed: 'bg-red-500',
    killed: 'bg-muted-foreground',
    skipped: 'bg-muted-foreground/50',
    gated: 'bg-yellow-500 animate-pulse-status',
    retrying: 'bg-orange-500 animate-pulse-status',
  };

  return <div className={cn('w-2 h-2 rounded-full', colors[status] ?? 'bg-muted')} />;
}
