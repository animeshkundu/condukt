'use client';

import type { ProjectionNode } from '../../../src/types';
import { sc } from './types';

interface Props {
  node: ProjectionNode;
  onClose: () => void;
  /** Optional action buttons (Redo/Retry/Skip) rendered inline in the header */
  actions?: React.ReactNode;
}

export function Header({ node, onClose, actions }: Props) {
  const c = sc(node.status);
  const isActive = node.status === 'running' || node.status === 'gated';

  return (
    <div style={{
      padding: '16px 24px', borderBottom: '1px solid #302e2b',
      background: 'linear-gradient(to bottom, #201d18, #1a1815)',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 10, height: 10, borderRadius: '50%', background: c.dot,
          boxShadow: isActive ? `0 0 8px ${c.dot}, 0 0 20px ${c.dot}33` : 'none',
        }} />
        <span style={{ fontWeight: 600, fontSize: 16, letterSpacing: '-0.01em' }}>{node.displayName}</span>
        <span style={{ fontSize: 11, color: '#8a8578', background: '#2b2a27', padding: '2px 8px', borderRadius: 6, marginLeft: 6 }}>{node.nodeType}</span>
        {actions && <div style={{ marginLeft: 8, display: 'flex', gap: 6 }}>{actions}</div>}
      </div>
      <button
        onClick={onClose}
        aria-label="Close panel"
        style={{ background: 'none', border: 'none', color: '#8a8578', cursor: 'pointer', fontSize: 18, padding: '8px 8px', minWidth: 32, minHeight: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6 }}
      >
        &times;
      </button>
    </div>
  );
}
