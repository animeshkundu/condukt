'use client';

import React from 'react';

const MONO = '"JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas", monospace';

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
        fontFamily: MONO,
        fontSize: 11,
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
