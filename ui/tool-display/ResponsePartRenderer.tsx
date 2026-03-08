'use client';

import React from 'react';
import type { ResponsePart } from './response-parts';
import { ToolGroupCard } from './ToolGroupCard';
import { ToolInvocationRow } from './ToolInvocationRow';
import { ThinkingBlock } from './ThinkingBlock';
import { StatusLine } from './StatusLine';

// ── Markdown content (inline, lightweight) ───────────────────────────────────

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
      // Safe: content is agent-generated markdown, not user HTML
      dangerouslySetInnerHTML={undefined}
    >
      {content}
    </div>
  );
}

// ── ResponsePartRenderer ─────────────────────────────────────────────────────

export interface ResponsePartRendererProps {
  parts: readonly ResponsePart[];
  /** Optional: called to render markdown content. Defaults to plain text. */
  renderMarkdown?: (content: string, key: string) => React.ReactNode;
  /** Optional: controls tool group collapsed state externally. */
  onToggleGroup?: (groupId: string) => void;
  /** Optional: controls thinking block collapsed state externally. */
  onToggleThinking?: (thinkingId: string) => void;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Maps ResponseParts to React components.
 *
 * Consumers can provide a custom `renderMarkdown` for rich markdown rendering
 * (e.g. using condukt's MarkdownContent component). The default renders plain text.
 */
export function ResponsePartRenderer({
  parts,
  renderMarkdown,
  onToggleGroup,
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

          case 'tool-group':
            return (
              <ToolGroupCard
                key={part.id}
                tools={part.tools}
                collapsed={part.collapsed}
                status={part.status}
                onToggle={onToggleGroup ? () => onToggleGroup(part.id) : undefined}
              >
                {part.tools.map(tool => (
                  <ToolInvocationRow key={tool.toolCallId} tool={tool} />
                ))}
              </ToolGroupCard>
            );

          case 'thinking':
            return (
              <ThinkingBlock
                key={part.id}
                content={part.content}
                collapsed={part.collapsed}
                onToggle={onToggleThinking ? () => onToggleThinking(part.id) : undefined}
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
