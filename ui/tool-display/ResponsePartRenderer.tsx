'use client';

import React from 'react';
import type { ResponsePart } from './response-parts';
import type { ToolInvocation } from './types';
import { ToolProgressLine } from './ToolProgressLine';
import { ThinkingSection } from './ThinkingSection';
import { StatusLine } from './StatusLine';
import { SubagentSection } from './SubagentSection';
import { SANS, MONO } from './constants';

// -- Markdown content (inline, lightweight fallback) --------------------------

function InlineMarkdown({ content }: { content: string }) {
  return (
    <div
      style={{
        fontFamily: SANS,
        fontSize: 13,
        lineHeight: 1.6,
        color: '#e8e6e3',
        padding: '2px 8px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {content}
    </div>
  );
}

// -- ResponsePartRenderer -----------------------------------------------------

export interface ResponsePartRendererProps {
  parts: readonly ResponsePart[];
  /** Optional: called to render markdown content. Defaults to plain text. */
  renderMarkdown?: (content: string, key: string) => React.ReactNode;
  /** Optional: called to render custom expanded tool content. Return undefined to fall through to default. */
  renderToolExpanded?: (tool: ToolInvocation) => React.ReactNode | undefined;
  /** Optional: controls thinking section collapsed state externally. */
  onToggleThinking?: (sectionId: string) => void;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Maps ResponseParts to React components.
 *
 * Routes:
 * - markdown -> renderMarkdown callback or InlineMarkdown
 * - tool-progress -> ToolProgressLine (flat standalone line)
 * - thinking-section -> ThinkingSection (collapsible block)
 * - status -> StatusLine (dim metadata)
 */
export function ResponsePartRenderer({
  parts,
  renderMarkdown,
  renderToolExpanded,
  onToggleThinking,
  className,
  style,
}: ResponsePartRendererProps) {
  return (
    <div className={className} style={style} role="list">
      {parts.map(part => {
        let child: React.ReactNode;
        switch (part.kind) {
          case 'markdown':
            child = renderMarkdown
              ? <React.Fragment>{renderMarkdown(part.content, part.id)}</React.Fragment>
              : <InlineMarkdown content={part.content} />;
            break;

          case 'tool-progress':
            child = (
              <ToolProgressLine
                tool={part.tool}
                renderToolExpanded={renderToolExpanded}
              />
            );
            break;

          case 'thinking-section':
            child = (
              <ThinkingSection
                items={part.items}
                title={part.title}
                verb={part.verb}
                collapsed={part.collapsed}
                active={part.active}
                onToggle={onToggleThinking ? () => onToggleThinking(part.id) : undefined}
                renderMarkdown={renderMarkdown}
              />
            );
            break;

          case 'subagent-section':
            child = (
              <SubagentSection
                section={part}
                renderToolExpanded={renderToolExpanded}
                renderMarkdown={renderMarkdown}
              />
            );
            break;

          case 'status':
            child = <StatusLine text={part.text} />;
            break;

          default:
            return null;
        }
        return <div key={part.id} role="listitem" tabIndex={0}>{child}</div>;
      })}
    </div>
  );
}
