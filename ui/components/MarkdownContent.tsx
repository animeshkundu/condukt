'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

export interface MarkdownContentProps {
  /** Raw markdown string to render. */
  content: string;
  /** Optional additional className for the root container. */
  className?: string;
  /** Optional inline style override for the root container. */
  style?: React.CSSProperties;
}

import { SANS, MONO } from '../tool-display/constants';

const components: Components = {
  h1: ({ children }) => (
    <h2 style={{ fontSize: 17, fontWeight: 600, color: '#e8e6e3', margin: '20px 0 8px', letterSpacing: '-0.01em' }}>{children}</h2>
  ),
  h2: ({ children }) => (
    <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e8e6e3', margin: '20px 0 8px', letterSpacing: '-0.01em' }}>{children}</h3>
  ),
  h3: ({ children }) => (
    <h4 style={{ fontSize: 14, fontWeight: 600, color: '#e8e6e3', margin: '16px 0 6px' }}>{children}</h4>
  ),
  h4: ({ children }) => (
    <h5 style={{ fontSize: 13, fontWeight: 600, color: '#b1ada1', margin: '12px 0 4px' }}>{children}</h5>
  ),
  p: ({ children }) => (
    <p style={{ fontSize: 13, color: '#e8e6e3', lineHeight: 1.6, margin: '0 0 14px' }}>{children}</p>
  ),
  strong: ({ children }) => (
    <strong style={{ fontWeight: 600, color: '#e8e6e3' }}>{children}</strong>
  ),
  em: ({ children }) => (
    <em style={{ color: '#b1ada1' }}>{children}</em>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#D97757', textDecoration: 'none' }}>{children}</a>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      const lang = className?.replace('language-', '');
      const codeText = String(children);
      return (
        <div style={{ position: 'relative', margin: '8px 0' }}
          onMouseEnter={(e) => {
            const btn = e.currentTarget.querySelector('[data-copy-btn]') as HTMLElement;
            if (btn) btn.style.opacity = '1';
          }}
          onMouseLeave={(e) => {
            const btn = e.currentTarget.querySelector('[data-copy-btn]') as HTMLElement;
            if (btn) btn.style.opacity = '0';
          }}
        >
          <pre style={{
            fontSize: 12, lineHeight: 1.5, borderRadius: 8, overflowX: 'auto',
            padding: '12px 16px',
            background: '#161411', border: '1px solid #3d3a36', fontFamily: MONO,
          }}>
            {lang && (
              <div style={{ fontSize: 10, color: '#6b6660', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {lang}
              </div>
            )}
            <code style={{ color: '#b1ada1', fontFamily: MONO }} {...props}>{children}</code>
          </pre>
          <button
            data-copy-btn=""
            onClick={() => navigator.clipboard.writeText(codeText).catch(() => {})}
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              opacity: 0,
              transition: 'opacity 0.15s',
              background: '#2b2a27',
              border: '1px solid #3d3a36',
              borderRadius: 4,
              padding: '2px 6px',
              cursor: 'pointer',
              color: '#8a8578',
              fontSize: 11,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
          </button>
        </div>
      );
    }
    return (
      <code style={{
        fontSize: '0.9em', color: '#D97757', background: '#2b2a27',
        padding: '1px 5px', borderRadius: 4, fontFamily: MONO,
      }} {...props}>
        {children}
      </code>
    );
  },
  // react-markdown wraps code blocks in <pre><code>; our code handler renders <pre> itself
  pre: ({ children }) => <>{children}</>,
  blockquote: ({ children }) => (
    <blockquote style={{
      margin: '8px 0', paddingLeft: 16, paddingTop: 8, paddingBottom: 8,
      fontSize: 13, color: '#b1ada1', lineHeight: 1.6,
      borderLeft: '3px solid #D97757',
    }}>
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div style={{ overflowX: 'auto', margin: '8px 0' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%', fontFamily: SANS }}>
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th style={{
      textAlign: 'left', padding: '6px 12px',
      borderBottom: '2px solid #3d3a36', color: '#8a8578',
      fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td style={{ padding: '6px 12px', borderBottom: '1px solid #302e2b', color: '#b1ada1' }}>
      {children}
    </td>
  ),
  ul: ({ children }) => (
    <ul style={{ margin: '6px 0', paddingLeft: 20, fontSize: 13, color: '#e8e6e3', lineHeight: 1.6 }}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: '6px 0', paddingLeft: 20, fontSize: 13, color: '#e8e6e3', lineHeight: 1.6 }}>
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li style={{ margin: '3px 0' }}>{children}</li>
  ),
  hr: () => (
    <hr style={{ border: 'none', borderTop: '1px solid #3d3a36', margin: '16px 0' }} />
  ),
};

/**
 * Markdown content renderer using react-markdown + remark-gfm.
 * Renders full GitHub Flavored Markdown with custom component styling
 * matching the condukt design language (dark theme).
 */
export function MarkdownContent({ content, className, style }: MarkdownContentProps) {
  return (
    <div
      className={className}
      style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', background: '#161411', ...style }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
