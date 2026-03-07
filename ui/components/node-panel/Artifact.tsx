'use client';

import React from 'react';
import { MarkdownContent } from '../MarkdownContent';

export interface ArtifactProps {
  /** Markdown content to display. */
  content: string | null;
  /** Filename shown in the header (default: 'output.md'). */
  filename?: string;
  /** Whether artifact is currently loading. */
  loading?: boolean;
  /** Optional style override. */
  style?: React.CSSProperties;
}

/**
 * NodePanel.Artifact — renders artifact content as formatted markdown.
 * Shows loading skeleton, empty state, or rendered content.
 */
export function Artifact({ content, filename = 'output.md', loading, style }: ArtifactProps) {
  if (loading) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#8a8578', fontSize: 13, background: '#161411', ...style,
      }}>
        Loading artifact...
      </div>
    );
  }

  if (!content) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#585350', fontSize: 13, background: '#161411', ...style,
      }}>
        No artifact content
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', ...style }}>
      <div style={{
        padding: '8px 24px', fontSize: 11, color: '#6b6660', background: '#1a1815',
        borderBottom: '1px solid #302e2b',
      }}>
        {filename}
      </div>
      <MarkdownContent content={content} />
    </div>
  );
}
