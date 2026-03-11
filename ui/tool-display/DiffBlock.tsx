'use client';

import React from 'react';
import { MONO } from './constants';

export interface DiffBlockProps {
  content: string;
  filePath?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function classifyLine(line: string): 'add' | 'remove' | 'header' | 'context' {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return 'header';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

const LINE_STYLES: Record<ReturnType<typeof classifyLine>, React.CSSProperties> = {
  add: { color: '#4ade80', background: '#4ade8010' },
  remove: { color: '#f87171', background: '#f8717110' },
  header: { color: '#6b6660', fontStyle: 'italic' },
  context: { color: '#b1ada1' },
};

export function DiffBlock({ content, filePath, className, style }: DiffBlockProps) {
  const lines = content.split('\n');

  return (
    <div className={className} style={{ background: '#161411', borderRadius: 8, overflow: 'hidden', ...style }}>
      {filePath && (
        <div style={{
          padding: '6px 12px',
          fontSize: 11,
          color: '#8a8578',
          borderBottom: '1px solid #302e2b',
          fontFamily: MONO,
        }}>
          {filePath}
        </div>
      )}
      <pre style={{
        fontFamily: MONO,
        fontSize: 11,
        lineHeight: 1.5,
        padding: '8px 12px',
        margin: 0,
        overflowX: 'auto',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
      }}>
        {lines.map((line, i) => {
          const type = classifyLine(line);
          return (
            <div key={i} style={{ ...LINE_STYLES[type], padding: '0 4px' }}>
              {line || '\u00A0'}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
