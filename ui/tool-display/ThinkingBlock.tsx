'use client';

import React, { useState, useCallback } from 'react';

const MONO = '"JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas", monospace';

// ── ThinkingBlock ────────────────────────────────────────────────────────────

export interface ThinkingBlockProps {
  content: string;
  collapsed?: boolean;
  onToggle?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Collapsible reasoning / thinking block.
 * Collapsed by default — dim purple styling to distinguish from output.
 */
export function ThinkingBlock({
  content,
  collapsed: controlledCollapsed,
  onToggle,
  className,
  style,
}: ThinkingBlockProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(true);
  const collapsed = controlledCollapsed ?? internalCollapsed;

  const handleToggle = useCallback(() => {
    if (onToggle) {
      onToggle();
    } else {
      setInternalCollapsed(prev => !prev);
    }
  }, [onToggle]);

  const chevron = collapsed ? '\u25B8' : '\u25BE';
  const lines = content.split('\n').length;

  return (
    <div className={className} style={{ fontFamily: MONO, fontSize: 12, ...style }}>
      <button
        onClick={handleToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: '#6b6660',
          fontFamily: MONO,
          fontSize: 11,
          padding: '2px 8px',
          gap: 4,
        }}
        aria-expanded={!collapsed}
        aria-label="Reasoning"
      >
        <span style={{ width: 12, textAlign: 'center' }}>{chevron}</span>
        <span style={{ color: '#c084fc' }}>&#9675;</span>
        <span>Thinking</span>
        <span style={{ color: '#504d48', fontSize: 10 }}>({lines} lines)</span>
      </button>

      {!collapsed && (
        <pre style={{
          margin: '2px 0 0 20px',
          padding: '6px 8px',
          color: '#c084fc',
          opacity: 0.6,
          fontFamily: MONO,
          fontSize: 11,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 400,
          overflowY: 'auto',
        }}>
          {content}
        </pre>
      )}
    </div>
  );
}
