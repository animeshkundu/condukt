'use client';

import React from 'react';
import type { ResponsePart } from './response-parts';
import type { ToolInvocation } from './types';
import { ToolProgressLine } from './ToolProgressLine';
import { ThinkingSection } from './ThinkingSection';
import { StatusLine } from './StatusLine';
import { SubagentSection } from './SubagentSection';

// -- Markdown content (inline, lightweight fallback) --------------------------

const MONO = '"JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas", monospace';

function InlineMarkdown({ content }: { content: string }) {
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: 12,
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
    <div className={className} style={style}>
      {parts.map(part => {
        switch (part.kind) {
          case 'markdown':
            return renderMarkdown
              ? <React.Fragment key={part.id}>{renderMarkdown(part.content, part.id)}</React.Fragment>
              : <InlineMarkdown key={part.id} content={part.content} />;

          case 'tool-progress':
            return (
              <ToolProgressLine
                key={part.id}
                tool={part.tool}
                renderToolExpanded={renderToolExpanded}
              />
            );

          case 'thinking-section':
            return (
              <ThinkingSection
                key={part.id}
                items={part.items}
                title={part.title}
                verb={part.verb}
                collapsed={part.collapsed}
                active={part.active}
                onToggle={onToggleThinking ? () => onToggleThinking(part.id) : undefined}
                renderMarkdown={renderMarkdown}
              />
            );

          case 'subagent-section':
            return (
              <SubagentSection
                key={part.id}
                section={part}
                renderToolExpanded={renderToolExpanded}
                renderMarkdown={renderMarkdown}
              />
            );

          case 'status':
            return <StatusLine key={part.id} text={part.text} />;

          default:
            return null;
        }
      })}
    </div>
  );
}
