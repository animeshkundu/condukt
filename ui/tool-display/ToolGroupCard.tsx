'use client';

import React, { useState, useCallback } from 'react';
import type { ToolInvocation } from './types';

// ── Status indicator ─────────────────────────────────────────────────────────

type GroupStatus = 'running' | 'complete' | 'error';

function StatusIcon({ status }: { status: GroupStatus }) {
  switch (status) {
    case 'running':
      return (
        <span style={{ display: 'inline-block', width: 12, height: 12, marginRight: 6, verticalAlign: 'middle' }}>
          <svg width="12" height="12" viewBox="0 0 12 12" style={{ animation: 'spin 1s linear infinite' }}>
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeDasharray="20 8" />
          </svg>
        </span>
      );
    case 'complete':
      return <span style={{ color: '#4ade80', marginRight: 6, fontSize: 12, verticalAlign: 'middle' }}>&#10003;</span>;
    case 'error':
      return <span style={{ color: '#f87171', marginRight: 6, fontSize: 12, verticalAlign: 'middle' }}>&#10007;</span>;
  }
}

// ── Tool summary ─────────────────────────────────────────────────────────────

function buildSummary(tools: ToolInvocation[]): string {
  if (tools.length === 0) { return ''; }

  const subagent = tools.find(t => t.category === 'subagent');
  const names = tools.slice(0, 3).map(t => {
    if (t.category === 'shell') { return '$ ' + (t.invocationMessage || t.toolName).slice(0, 40); }
    return t.toolName;
  });

  if (tools.length <= 3) { return names.join(', '); }

  if (subagent) {
    const agentLabel = subagent.invocationMessage || subagent.toolName;
    return `◆ ${agentLabel} + ${tools.length - 1} tools`;
  }

  return `${tools.length} tools`;
}

// ── ToolGroupCard ────────────────────────────────────────────────────────────

export interface ToolGroupCardProps {
  tools: ToolInvocation[];
  collapsed?: boolean;
  status: GroupStatus;
  onToggle?: () => void;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

const MONO = '"JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas", monospace';

/**
 * Collapsible tool group card — header shows status + tool summary,
 * expands to show individual tool invocation rows.
 */
export function ToolGroupCard({
  tools,
  collapsed: controlledCollapsed,
  status,
  onToggle,
  children,
  className,
  style,
}: ToolGroupCardProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(true);
  const collapsed = controlledCollapsed ?? internalCollapsed;

  const handleToggle = useCallback(() => {
    if (onToggle) {
      onToggle();
    } else {
      setInternalCollapsed(prev => !prev);
    }
  }, [onToggle]);

  const summary = buildSummary(tools);
  const chevron = collapsed ? '\u25B8' : '\u25BE'; // ▸ / ▾

  return (
    <div
      className={className}
      style={{
        fontFamily: MONO,
        fontSize: 12,
        borderLeft: '2px solid #3d3a36',
        marginLeft: 8,
        ...style,
      }}
    >
      {/* Header */}
      <button
        onClick={handleToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          padding: '4px 8px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: '#8a8578',
          fontFamily: MONO,
          fontSize: 12,
          textAlign: 'left',
          gap: 4,
        }}
        aria-expanded={!collapsed}
        aria-label={`Tool group: ${summary}`}
      >
        <span style={{ color: '#6b6660', fontSize: 11, width: 12, textAlign: 'center' }}>{chevron}</span>
        <StatusIcon status={status} />
        <span style={{ color: '#b1ada1', fontWeight: 500 }}>Tools</span>
        <span style={{ color: '#6b6660', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
        <span style={{ color: '#6b6660', fontSize: 11, flexShrink: 0 }}>
          ({tools.length})
        </span>
      </button>

      {/* Expanded children */}
      {!collapsed && (
        <div style={{ paddingLeft: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}
