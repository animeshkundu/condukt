'use client';

import React, { useState, useCallback } from 'react';
import type { SubagentSectionPart, SubagentSectionItem, ToolInvocation } from './types';
import { ToolProgressLine } from './ToolProgressLine';
import { ensureAnimations } from './ThinkingSection';

const SANS = 'Inter, system-ui, -apple-system, sans-serif';
const MONO = '"JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas", monospace';

// -- Status colors from design language ----------------------------------------

const STATUS_COLORS: Record<SubagentSectionPart['status'], string> = {
  running: '#60a5fa',
  completed: '#4ade80',
  failed: '#f87171',
};

// -- Status dot ----------------------------------------------------------------

function StatusDot({ status }: { status: SubagentSectionPart['status'] }) {
  const color = STATUS_COLORS[status];
  return (
    <span style={{
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      backgroundColor: color,
      flexShrink: 0,
      animation: status === 'running' ? 'pulse-status 1.5s ease-in-out infinite' : undefined,
    }} />
  );
}

// -- SubagentSection -----------------------------------------------------------

export interface SubagentSectionProps {
  section: SubagentSectionPart;
  /** Optional: called to render custom expanded tool content. */
  renderToolExpanded?: (tool: ToolInvocation) => React.ReactNode | undefined;
  /** Optional: called to render markdown content. */
  renderMarkdown?: (content: string, key: string) => React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/** Default number of tool items shown before progressive disclosure. */
const VISIBLE_TOOLS = 8;

/**
 * Collapsible sub-agent section with status-colored left border,
 * tool list with progressive disclosure, and agent text output.
 */
export function SubagentSection({
  section,
  renderToolExpanded,
  renderMarkdown,
  className,
  style,
}: SubagentSectionProps) {
  ensureAnimations();

  const [collapsed, setCollapsed] = useState(section.collapsed);
  const [showAllTools, setShowAllTools] = useState(false);

  const handleToggle = useCallback(() => {
    setCollapsed(prev => !prev);
  }, []);

  const borderColor = STATUS_COLORS[section.status];
  const chevronChar = collapsed ? '\u25B8' : '\u25BE'; // right / down

  // Separate tool items and text items for rendering
  const toolItems: Array<{ kind: 'pinned-tool'; tool: ToolInvocation }> = [];
  const textSegments: Array<{ kind: 'agent-text'; content: string; idx: number }> = [];

  section.items.forEach((item, idx) => {
    if (item.kind === 'pinned-tool') {
      toolItems.push(item);
    } else {
      textSegments.push({ ...item, idx });
    }
  });

  const visibleTools = showAllTools ? toolItems : toolItems.slice(0, VISIBLE_TOOLS);
  const hiddenCount = toolItems.length - VISIBLE_TOOLS;

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
      {/* Header */}
      <button
        onClick={handleToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          padding: '12px 16px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          gap: 8,
          textAlign: 'left',
        }}
        aria-expanded={!collapsed}
        aria-label={`Sub-agent: ${section.agentDisplayName}`}
      >
        <StatusDot status={section.status} />
        <span style={{
          fontFamily: SANS,
          fontSize: 15,
          fontWeight: 600,
          letterSpacing: '-0.01em',
          color: '#e8e6e3',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {section.agentDisplayName}
        </span>
        {toolItems.length > 0 && (
          <span style={{
            fontFamily: MONO,
            fontSize: 11,
            color: '#8a8578',
            flexShrink: 0,
          }}>
            {toolItems.length} tool{toolItems.length !== 1 ? 's' : ''}
          </span>
        )}
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
      {!collapsed && (
        <div style={{ padding: '0 16px 12px' }}>
          {/* Description */}
          {section.description && (
            <div style={{
              fontFamily: SANS,
              fontSize: 13,
              color: '#b1ada1',
              lineHeight: 1.5,
              marginBottom: 8,
            }}>
              {section.description}
            </div>
          )}

          {/* Error message */}
          {section.error && (
            <div style={{
              fontFamily: MONO,
              fontSize: 12,
              color: '#f87171',
              background: '#3a1a1a',
              border: '1px solid #f8717133',
              borderRadius: 6,
              padding: '8px 12px',
              marginBottom: 8,
              lineHeight: 1.5,
            }}>
              {section.error}
            </div>
          )}

          {/* Agent text segments + tools rendered in document order */}
          {section.items.length > 0 && (
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {/* Render items in order: agent text inline, tools with progressive disclosure */}
              {section.items.map((item, idx) => {
                if (item.kind === 'agent-text') {
                  return (
                    <div key={`text-${idx}`} style={{
                      fontFamily: SANS,
                      fontSize: 13,
                      lineHeight: 1.6,
                      color: '#e8e6e3',
                      padding: '4px 0',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}>
                      {renderMarkdown
                        ? renderMarkdown(item.content, `subagent-text-${section.id}-${idx}`)
                        : item.content
                      }
                    </div>
                  );
                }

                if (item.kind === 'pinned-tool') {
                  // Determine if this tool is within the visible range
                  const toolIdx = toolItems.indexOf(item);
                  if (!showAllTools && toolIdx >= VISIBLE_TOOLS) {
                    return null;
                  }

                  return (
                    <ToolProgressLine
                      key={`tool-${item.tool.toolCallId}`}
                      tool={item.tool}
                      renderToolExpanded={renderToolExpanded}
                      style={{ margin: '2px 0' }}
                    />
                  );
                }

                return null;
              })}

              {/* Progressive disclosure */}
              {!showAllTools && hiddenCount > 0 && (
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
                    fontFamily: MONO,
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
                  Show {hiddenCount} more tool{hiddenCount !== 1 ? 's' : ''}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
