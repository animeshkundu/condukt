'use client';

import React from 'react';
import type { ToolInvocation } from './types';
import { ensureAnimations } from './ThinkingSection';

const MONO = '"JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas", monospace';

// ── Status icon ──────────────────────────────────────────────────────────────

function ProgressIcon({ tool }: { tool: ToolInvocation }) {
  if (!tool.isComplete) {
    return (
      <span style={{ display: 'inline-flex', width: 12, height: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <svg width="12" height="12" viewBox="0 0 12 12" style={{ animation: 'spin 1s linear infinite' }}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeDasharray="20 8" />
        </svg>
      </span>
    );
  }
  if (tool.isError) {
    return <span style={{ color: '#f87171', fontSize: 12, lineHeight: 1, flexShrink: 0 }}>&#10007;</span>;
  }
  return <span style={{ color: '#4ade80', fontSize: 12, lineHeight: 1, flexShrink: 0 }}>&#10003;</span>;
}

// ── Code badge ───────────────────────────────────────────────────────────────

function CodeBadge({ text }: { text: string }) {
  return (
    <code style={{
      fontFamily: MONO,
      fontSize: 11,
      padding: '1px 4px',
      borderRadius: 4,
      background: '#2b2a27',
      border: '1px solid #3d3a36',
      color: '#b1ada1',
    }}>
      {text}
    </code>
  );
}

// ── ToolProgressLine ─────────────────────────────────────────────────────────

export interface ToolProgressLineProps {
  tool: ToolInvocation;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Flat progress line for standalone (non-pinned) tools.
 * Pattern 1 from VS Code: icon + message, single line.
 *
 * MCP format: "✓ Ran `tool_name` – server (MCP Server)"
 * Default: "✓ Read src/app/page.tsx"
 */
export function ToolProgressLine({ tool, className, style }: ToolProgressLineProps) {
  ensureAnimations();

  const message = tool.isComplete
    ? (tool.pastTenseMessage ?? tool.invocationMessage)
    : tool.invocationMessage;

  const isMcp = tool.category === 'mcp' || !!tool.serverName;

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: MONO,
        fontSize: 13,
        margin: '0 0 6px',
        paddingTop: 2,
        paddingLeft: 8,
        ...style,
      }}
    >
      <ProgressIcon tool={tool} />
      <span style={{ color: '#8a8578', fontSize: 12 }}>
        {isMcp ? (
          <>
            {tool.verb}{' '}
            <CodeBadge text={tool.toolName} />
            {tool.serverName && (
              <span style={{ opacity: 0.7 }}> – {tool.serverName} (MCP Server)</span>
            )}
          </>
        ) : (
          message
        )}
      </span>
    </div>
  );
}
