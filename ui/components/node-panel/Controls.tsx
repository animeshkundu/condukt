'use client';

import type { ProjectionNode } from '../../../src/types';

interface Props {
  node: ProjectionNode;
  onRetry: () => void;
  onSkip: () => void;
  /** Is the execution still running? Controls are hidden while running. */
  executionRunning?: boolean;
}

/**
 * Node lifecycle controls: Retry/Redo/Skip.
 * Shows different buttons based on node status.
 * Hidden while the execution is actively running (can't retry a running node).
 */
export function Controls({ node, onRetry, onSkip, executionRunning }: Props) {
  if (executionRunning) return null;

  const showRetry = node.status === 'failed' || node.status === 'killed';
  const showRedo = node.status === 'completed';
  const showSkip = node.status === 'failed' || node.status === 'killed' || node.status === 'pending';

  if (!showRetry && !showRedo && !showSkip) return null;

  return (
    <div style={{ padding: '12px 24px', borderBottom: '1px solid #302e2b', display: 'flex', gap: 8 }}>
      {showRetry && (
        <Btn label="Retry" color="#3b82f6" onClick={onRetry} />
      )}
      {showRedo && (
        <Btn label="Redo" color="#a855f7" onClick={onRetry} />
      )}
      {showSkip && (
        <Btn label="Skip" color="#888" onClick={onSkip} />
      )}
    </div>
  );
}

function Btn({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      background: color + '18', color, border: `1px solid ${color}33`,
      borderRadius: 6, padding: '4px 12px', fontSize: 11, cursor: 'pointer', fontWeight: 500,
      transition: 'all 150ms',
    }}>
      {label}
    </button>
  );
}
