'use client';

import React, { useState, useCallback } from 'react';
import type { ToolInvocation } from './types';
import { ToolProgressLine } from './ToolProgressLine';
import { ensureAnimations } from './ThinkingSection';
import { SANS, MONO } from './constants';

// ── ToolGroupSection ─────────────────────────────────────────────────────────

export interface ToolGroupSectionProps {
  tools: ToolInvocation[];
  collapsed: boolean;
  categories: string[];
  /** Optional callback to render custom expanded content per tool. */
  renderToolExpanded?: (tool: ToolInvocation) => React.ReactNode | undefined;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * "Used N tools" container for consecutive standalone tool invocations.
 * Mirrors SubagentSection's contained card structure.
 */
export function ToolGroupSection({
  tools,
  collapsed: initialCollapsed,
  categories,
  renderToolExpanded,
  className,
  style,
}: ToolGroupSectionProps) {
  ensureAnimations();

  const [collapsed, setCollapsed] = useState(initialCollapsed);

  const handleToggle = useCallback(() => {
    setCollapsed(prev => !prev);
  }, []);

  const allComplete = tools.every(t => t.isComplete);
  const chevronChar = collapsed ? '\u25B8' : '\u25BE'; // right / down

  return (
    <div
      className={className}
      style={{
        margin: '8px 0',
        borderLeft: '3px solid #6b6660',
        background: '#2b2a27',
        borderRadius: 8,
        overflow: 'hidden',
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
          padding: '10px 16px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          gap: 8,
          textAlign: 'left',
        }}
        aria-expanded={!collapsed}
        aria-label={`Tool group: ${tools.length} tools`}
      >
        {/* Status icon */}
        {allComplete ? (
          <span style={{ color: '#4ade80', fontSize: 12, lineHeight: 1, flexShrink: 0 }}>&#10003;</span>
        ) : (
          <span style={{ display: 'inline-flex', width: 12, height: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="12" height="12" viewBox="0 0 12 12" style={{ animation: 'spin 1s linear infinite' }}>
              <circle cx="6" cy="6" r="4.5" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeDasharray="20 8" />
            </svg>
          </span>
        )}
        {/* "Used N tools" text */}
        <span style={{
          fontFamily: SANS,
          fontSize: 13,
          color: '#8a8578',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          Used {tools.length} tool{tools.length !== 1 ? 's' : ''}
        </span>
        {/* Category badges */}
        {categories.map(cat => (
          <span key={cat} style={{
            fontSize: 10,
            fontFamily: MONO,
            color: '#8a8578',
            background: '#2b2a27',
            border: '1px solid #3d3a36',
            borderRadius: 6,
            padding: '1px 6px',
            flexShrink: 0,
          }}>
            {cat}
          </span>
        ))}
        {/* Chevron */}
        <span style={{
          color: '#6b6660',
          fontSize: 11,
          flexShrink: 0,
          transition: 'opacity 150ms',
        }}>
          {chevronChar}
        </span>
      </button>

      {/* Expanded content */}
      {!collapsed && (
        <div style={{ padding: '0 12px 12px' }}>
          {tools.map(tool => (
            <ToolProgressLine
              key={tool.toolCallId}
              tool={tool}
              renderToolExpanded={renderToolExpanded}
              style={{ margin: '2px 0 2px 8px' }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
