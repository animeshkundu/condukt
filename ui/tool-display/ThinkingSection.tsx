'use client';

import React, { useState, useCallback } from 'react';
import type { ThinkingSectionItem } from './response-parts';
import type { ToolInvocation } from './types';

const MONO = '"JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas", monospace';

/** Render simple inline markdown: convert `backtick` patterns to <code> elements. */
function renderInlineCode(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} style={{
          fontSize: '0.846em',
          padding: '1px 3px',
          borderRadius: 4,
          background: '#2b2a27',
          color: '#d4d0c8',
        }}>{part.slice(1, -1)}</code>
      );
    }
    return part;
  });
}

// ── Tool icon mapping (from VS Code getToolInvocationIcon) ───────────────────

function getToolIcon(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (/search|grep|find|glob|list/.test(lower)) return '\uD83D\uDD0D'; // 🔍
  if (/read|get_file|view|show/.test(lower)) return '\uD83D\uDCD6';    // 📖
  if (/edit|create|replace|write|insert|str_replace/.test(lower)) return '\u270F\uFE0F'; // ✏️
  if (/bash|powershell|terminal|shell/.test(lower)) return '\uD83D\uDCBB'; // 💻
  return '\uD83D\uDD27'; // 🔧
}

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

// ── Thinking section item renderers ──────────────────────────────────────────

function ThinkingTextItemView({ content, renderMarkdown }: { content: string; renderMarkdown?: (content: string, key: string) => React.ReactNode }) {
  return (
    <div style={{
      padding: '6px 12px 6px 24px',
      position: 'relative',
      color: '#8a8578',
      fontSize: 12,
      fontFamily: MONO,
      lineHeight: 1.5,
      whiteSpace: renderMarkdown ? undefined : 'pre-wrap',
      wordBreak: 'break-word',
    }}>
      <span style={{
        position: 'absolute',
        left: 5,
        top: 9,
        color: '#6b6660',
        fontSize: 8,
        lineHeight: 1,
      }}>&#9679;</span>
      {renderMarkdown ? renderMarkdown(content, `thinking-text-${content.slice(0, 20)}`) : content}
    </div>
  );
}

function PinnedToolItemView({ tool }: { tool: ToolInvocation }) {
  const icon = getToolIcon(tool.toolName);
  const message = tool.isComplete
    ? (tool.pastTenseMessage ?? tool.invocationMessage)
    : tool.invocationMessage;

  return (
    <div style={{
      padding: '4px 12px 4px 24px',
      position: 'relative',
      color: '#8a8578',
      fontSize: 12,
      fontFamily: MONO,
      lineHeight: 1.5,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    }}>
      <span style={{
        position: 'absolute',
        left: 3,
        fontSize: 11,
      }}>{icon}</span>
      <span style={{ color: '#b1ada1' }}>{renderInlineCode(message)}</span>
      {!tool.isComplete && (
        <span style={{ display: 'inline-flex', width: 10, height: 10, flexShrink: 0, marginLeft: 2 }}>
          <svg width="10" height="10" viewBox="0 0 10 10" style={{ animation: 'spin 1s linear infinite' }}>
            <circle cx="5" cy="5" r="3.5" fill="none" stroke="#60a5fa" strokeWidth="1.2" strokeDasharray="16 6" />
          </svg>
        </span>
      )}
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
 * Collapsible thinking section that groups reasoning + pinned tool invocations.
 * Pattern 2 from VS Code: chain-of-thought vertical lines, tool icons, shimmer title.
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
  const [hovered, setHovered] = useState(false);

  const handleToggle = useCallback(() => {
    if (onToggle) {
      onToggle();
    } else {
      setInternalCollapsed(prev => !prev);
    }
  }, [onToggle]);

  const chevronChar = collapsed ? '\u25B8' : '\u25BE'; // ▸ / ▾

  return (
    <div
      className={className}
      style={{
        margin: '4px 8px',
        marginBottom: 16,
        position: 'relative',
        fontFamily: MONO,
        ...style,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Title button */}
      <button
        onClick={handleToggle}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        style={{
          display: collapsed ? 'inline-flex' : 'flex',
          alignItems: 'center',
          width: collapsed ? 'fit-content' : '100%',
          padding: collapsed ? '2px 6px 2px 2px' : '8px 12px',
          borderRadius: collapsed ? 4 : 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontFamily: MONO,
          fontSize: 13,
          lineHeight: '1.5em',
          textAlign: 'left',
          gap: 6,
          color: '#b1ada1',
        }}
        aria-expanded={!collapsed}
        aria-label={`Thinking section: ${title}`}
      >
        {active ? (
          // Active: "Working:" with shimmer animation
          <>
            <span style={{
              fontWeight: 500,
              background: 'linear-gradient(90deg, #6b6660 0%, #6b6660 30%, #8a8578 50%, #6b6660 70%, #6b6660 100%)',
              backgroundSize: '400% 100%',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              animation: 'thinkingShimmer 2s linear infinite',
            }}>
              Working:
            </span>
            <span style={{ color: '#8a8578', opacity: 0.7, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title}
            </span>
          </>
        ) : (
          // Finalized: summary title (no verb prefix — title is self-descriptive)
          <span style={{ color: '#8a8578', opacity: 0.7, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
        )}
        <span style={{
          color: '#6b6660',
          fontSize: 11,
          opacity: hovered || !collapsed ? 1 : 0,
          transition: 'opacity 150ms',
          flexShrink: 0,
        }}>
          {chevronChar}
        </span>
      </button>

      {/* Content area */}
      {!collapsed && items.length > 0 && (
        <div style={{ border: '1px solid #3d3a36', borderRadius: 8, marginTop: 4, overflow: 'hidden' }}>
          {items.map((item, idx) => {
            const isFirst = idx === 0;
            const isLast = idx === items.length - 1;
            const isOnly = items.length === 1;

            // Chain-of-thought vertical line via wrapper
            return (
              <div key={idx} style={{ position: 'relative' }}>
                {/* Vertical chain line */}
                {!isOnly && (
                  <div style={{
                    position: 'absolute',
                    left: 10.5,
                    top: isFirst ? 25 : 0,
                    height: isLast ? 14 : undefined,
                    bottom: isLast ? undefined : 0,
                    width: 1,
                    background: '#3d3a36',
                    maskImage: isFirst
                      ? 'linear-gradient(to bottom, transparent 0px, #000 4px, #000 calc(100% - 4px), transparent 100%)'
                      : isLast
                        ? 'linear-gradient(to bottom, transparent 0px, #000 4px, #000 100%)'
                        : 'linear-gradient(to bottom, transparent 0px, #000 4px, #000 calc(100% - 4px), transparent 100%)',
                    WebkitMaskImage: isFirst
                      ? 'linear-gradient(to bottom, transparent 0px, #000 4px, #000 calc(100% - 4px), transparent 100%)'
                      : isLast
                        ? 'linear-gradient(to bottom, transparent 0px, #000 4px, #000 100%)'
                        : 'linear-gradient(to bottom, transparent 0px, #000 4px, #000 calc(100% - 4px), transparent 100%)',
                  }} />
                )}
                {item.kind === 'thinking-text' && <ThinkingTextItemView content={item.content} renderMarkdown={renderMarkdown} />}
                {item.kind === 'pinned-tool' && <PinnedToolItemView tool={item.tool} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
