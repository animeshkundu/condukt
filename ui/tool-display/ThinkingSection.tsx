'use client';

import React, { useState, useCallback } from 'react';
import type { ThinkingSectionItem } from './response-parts';
import type { ToolInvocation } from './types';
import { getToolIcon, renderInlineCode } from './tool-icons';
import { SANS, MONO } from './constants';

// ── Shared animation keyframes (HMR-safe via globalThis) ─────────────────────

const ANIMATIONS_CSS = `
@keyframes thinkingShimmer {
  0% { background-position: 120% 0; }
  100% { background-position: -20% 0; }
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes pulse-status {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
`;

declare const globalThis: Record<string, unknown>;

/** Inject shared CSS keyframes. Safe for SSR, HMR-resilient via globalThis flag. */
export function ensureAnimations(): void {
  if (typeof document === 'undefined') return;
  if (globalThis.__conduktAnimationsInjected) return;
  const style = document.createElement('style');
  style.setAttribute('data-condukt-animations', '');
  style.textContent = ANIMATIONS_CSS;
  document.head.appendChild(style);
  globalThis.__conduktAnimationsInjected = true;
}

// ── Progressive disclosure threshold ─────────────────────────────────────────

const VISIBLE_TOOLS = 5;

// ── Category friendly names for progressive disclosure summary ───────────────

const CATEGORY_NAMES: Record<string, [string, string]> = {
  file: ['file read', 'file reads'],
  search: ['search', 'searches'],
  edit: ['edit', 'edits'],
  shell: ['shell command', 'shell commands'],
  mcp: ['MCP call', 'MCP calls'],
  subagent: ['sub-agent', 'sub-agents'],
  task: ['task', 'tasks'],
  default: ['tool', 'tools'],
};

function pluralize(count: number, category: string): string {
  const [singular, plural] = CATEGORY_NAMES[category] ?? CATEGORY_NAMES.default;
  return `${count} ${count === 1 ? singular : plural}`;
}

// ── Thinking section item renderers ──────────────────────────────────────────

function ThinkingTextItemView({ content, renderMarkdown }: { content: string; renderMarkdown?: (content: string, key: string) => React.ReactNode }) {
  return (
    <div style={{
      padding: '4px 0',
      color: '#b1ada1',
      fontSize: 13,
      fontFamily: SANS,
      lineHeight: 1.5,
      whiteSpace: renderMarkdown ? undefined : 'pre-wrap',
      overflowWrap: 'break-word',
    }}>
      {renderMarkdown ? renderMarkdown(content, `thinking-text-${content.slice(0, 20)}`) : content}
    </div>
  );
}

function PinnedToolItemView({ tool }: { tool: ToolInvocation }) {
  const icon = getToolIcon(tool.category);
  const message = tool.isComplete
    ? (tool.pastTenseMessage ?? tool.invocationMessage)
    : tool.invocationMessage;

  return (
    <div style={{
      padding: '3px 0',
      color: '#8a8578',
      fontSize: 12,
      fontFamily: SANS,
      lineHeight: 1.5,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    }}>
      {/* Status icon */}
      {tool.isComplete ? (
        tool.isError ? (
          <span style={{ color: '#f87171', fontSize: 12, lineHeight: 1, flexShrink: 0 }}>&#10007;</span>
        ) : (
          <span style={{ color: '#4ade80', fontSize: 12, lineHeight: 1, flexShrink: 0 }}>&#10003;</span>
        )
      ) : (
        <span style={{ display: 'inline-flex', width: 12, height: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg width="12" height="12" viewBox="0 0 12 12" style={{ animation: 'spin 1s linear infinite' }}>
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeDasharray="20 8" />
          </svg>
        </span>
      )}
      {/* Category icon */}
      <span style={{ display: 'inline-flex', color: '#8a8578', flexShrink: 0 }}>
        {icon}
      </span>
      {/* Message */}
      <span style={{ color: '#b1ada1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {renderInlineCode(message)}
      </span>
    </div>
  );
}

// ── ThinkingSection ──────────────────────────────────────────────────────────

export interface ThinkingSectionProps {
  items: ThinkingSectionItem[];
  title: string;
  verb: string;
  collapsed?: boolean;
  active?: boolean;
  onToggle?: () => void;
  renderMarkdown?: (content: string, key: string) => React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Collapsible thinking section with contained card design.
 * Groups reasoning + pinned tool invocations with a status-colored left border.
 */
export function ThinkingSection({
  items,
  title,
  verb,
  collapsed: controlledCollapsed,
  active = false,
  onToggle,
  renderMarkdown,
  className,
  style,
}: ThinkingSectionProps) {
  ensureAnimations();

  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const [showAllTools, setShowAllTools] = useState(false);

  const handleToggle = useCallback(() => {
    if (onToggle) {
      onToggle();
    } else {
      setInternalCollapsed(prev => !prev);
    }
  }, [onToggle]);

  const chevronChar = collapsed ? '\u25B8' : '\u25BE'; // right / down

  // Count pinned tools for badge
  const pinnedTools = items.filter(item => item.kind === 'pinned-tool');
  const toolCount = pinnedTools.length;

  // Border color: active vs finalized
  const borderColor = active ? '#8a8578' : '#6b6660';

  // Build active title from latest tool invocation message
  const latestToolMessage = active && pinnedTools.length > 0
    ? pinnedTools[pinnedTools.length - 1].tool.invocationMessage
    : '';

  // Progressive disclosure: separate visible vs hidden pinned tools
  const visibleItems: ThinkingSectionItem[] = [];
  const hiddenTools: ToolInvocation[] = [];
  let toolIdx = 0;

  for (const item of items) {
    if (item.kind === 'thinking-text') {
      visibleItems.push(item);
    } else if (item.kind === 'pinned-tool') {
      if (showAllTools || toolIdx < VISIBLE_TOOLS) {
        visibleItems.push(item);
      } else {
        hiddenTools.push(item.tool);
      }
      toolIdx++;
    }
  }

  // Build category summary for hidden tools
  let hiddenSummary = '';
  if (hiddenTools.length > 0) {
    const catCounts = new Map<string, number>();
    for (const t of hiddenTools) {
      catCounts.set(t.category, (catCounts.get(t.category) ?? 0) + 1);
    }
    const parts: string[] = [];
    for (const [cat, count] of catCounts) {
      parts.push(pluralize(count, cat));
    }
    hiddenSummary = parts.join(', ');
  }

  return (
    <div
      className={className}
      style={{
        margin: '8px 0',
        borderLeft: `3px solid ${borderColor}`,
        background: '#2b2a27',
        borderRadius: 8,
        overflow: 'hidden',
        ...style,
      }}
    >
      {/* Header button */}
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
          fontFamily: SANS,
          fontSize: 13,
          lineHeight: '1.5em',
          textAlign: 'left',
          gap: 8,
        }}
        aria-expanded={!collapsed}
        aria-label={`Thinking section: ${title}`}
      >
        {active ? (
          <>
            {/* Spinner */}
            <span style={{ display: 'inline-flex', width: 12, height: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="12" height="12" viewBox="0 0 12 12" style={{ animation: 'spin 1s linear infinite' }}>
                <circle cx="6" cy="6" r="4.5" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeDasharray="20 8" />
              </svg>
            </span>
            {/* "Working:" shimmer */}
            <span style={{
              fontWeight: 500,
              background: 'linear-gradient(90deg, #6b6660 0%, #6b6660 30%, #8a8578 50%, #6b6660 70%, #6b6660 100%)',
              backgroundSize: '400% 100%',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              animation: 'thinkingShimmer 2s linear infinite',
              flexShrink: 0,
            }}>
              Working:
            </span>
            {/* Latest tool message */}
            <span style={{ color: '#8a8578', opacity: 0.7, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {latestToolMessage || title}
            </span>
          </>
        ) : (
          <>
            {/* Check icon */}
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {/* Generated title */}
            <span style={{ color: '#8a8578', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title}
            </span>
          </>
        )}
        {/* Tool count badge */}
        {toolCount > 0 && (
          <span style={{
            color: '#8a8578',
            fontSize: 11,
            flexShrink: 0,
          }}>
            {toolCount} tool{toolCount !== 1 ? 's' : ''}
          </span>
        )}
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

      {/* Content area */}
      {!collapsed && items.length > 0 && (
        <div style={{
          padding: '0 12px 12px',
          transition: 'max-height 200ms ease, opacity 150ms ease',
        }}>
          {visibleItems.map((item, idx) => {
            if (item.kind === 'thinking-text') {
              return <ThinkingTextItemView key={`text-${idx}`} content={item.content} renderMarkdown={renderMarkdown} />;
            }
            if (item.kind === 'pinned-tool') {
              return <PinnedToolItemView key={`tool-${item.tool.toolCallId}`} tool={item.tool} />;
            }
            return null;
          })}

          {/* Progressive disclosure */}
          {!showAllTools && hiddenTools.length > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowAllTools(true);
              }}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 8px',
                marginTop: 4,
                background: 'transparent',
                border: '1px solid #3d3a36',
                borderRadius: 6,
                cursor: 'pointer',
                fontFamily: SANS,
                fontSize: 11,
                color: '#8a8578',
                textAlign: 'center',
                transition: 'all 150ms',
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.borderColor = '#4a4742';
                (e.target as HTMLElement).style.color = '#b1ada1';
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.borderColor = '#3d3a36';
                (e.target as HTMLElement).style.color = '#8a8578';
              }}
            >
              Show {hiddenTools.length} more ({hiddenSummary})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
