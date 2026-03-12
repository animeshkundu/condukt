'use client';

import React from 'react';
import type { ToolCategory } from './types';
import { MONO } from './constants';

/** Render simple inline markdown: convert `backtick` patterns to <code> elements. */
export function renderInlineCode(text: string): React.ReactNode {
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
          fontFamily: MONO,
        }}>{part.slice(1, -1)}</code>
      );
    }
    return part;
  });
}

/** Map tool category to a semantic SVG icon. */
export function getToolIcon(category: ToolCategory): React.ReactNode {
  const props = { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

  switch (category) {
    case 'search':
      return <svg {...props}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>;
    case 'file':
      return <svg {...props}><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /></svg>;
    case 'edit':
      return <svg {...props}><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></svg>;
    case 'shell':
      return <svg {...props}><polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" /></svg>;
    default:
      return <svg {...props}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>;
  }
}
