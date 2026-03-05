'use client';

import type { ProjectionNode } from '../../../src/types';
import { sc } from './types';

interface Props {
  node: ProjectionNode;
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function Info({ node }: Props) {
  const c = sc(node.status);

  return (
    <div style={{
      padding: '12px 24px', fontSize: 11, color: '#8a8578',
      borderBottom: '1px solid #302e2b',
      display: 'flex', gap: 16, flexWrap: 'wrap',
    }}>
      <span>Status: <b style={{ color: c.text }}>{node.status}</b></span>
      {node.model && <span>Model: {node.model}</span>}
      {node.elapsedMs != null && <span>Duration: {fmt(node.elapsedMs)}</span>}
      {node.attempt > 1 && <span>Attempt: {node.attempt}</span>}
    </div>
  );
}
