'use client';

import React from 'react';
import { SANS } from './constants';

// ── StatusLine ───────────────────────────────────────────────────────────────

export interface StatusLineProps {
  text: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Dim metadata / status line — used for intent, progress, and other
 * informational tool outputs that don't warrant a full tool group.
 */
export function StatusLine({ text, className, style }: StatusLineProps) {
  if (!text) { return null; }
  return (
    <div
      className={className}
      style={{
        fontFamily: SANS,
        fontSize: 12,
        color: '#6b6660',
        padding: '1px 8px',
        lineHeight: 1.5,
        ...style,
      }}
    >
      {text}
    </div>
  );
}
