'use client';

import { useEffect, useRef, useState } from 'react';
import { ansiToHtml, stripAnsi, hasAnsi } from '../../ansi';

export type OutputRenderer = 'plain' | 'ansi' | ((line: string, index: number) => React.ReactNode);

interface Props {
  lines: string[];
  total: number;
  loading?: boolean;
  /** Output rendering mode. Default: 'plain'. */
  renderer?: OutputRenderer;
  /** Max lines to keep in memory. Default: 50000. Oldest evicted first. */
  maxLines?: number;
  /** Auto-scroll to bottom on new lines. Default: true. */
  autoScroll?: boolean;
  /** Show running cursor animation. */
  isRunning?: boolean;
}

const MAX_LINES_DEFAULT = 50000;

/**
 * Scrollable output stream with configurable renderer (ADR-001).
 *
 * - 'plain' (default): renders lines as text nodes. No dangerouslySetInnerHTML.
 * - 'ansi': converts ANSI escape codes to colored HTML spans. Uses fast-path
 *   (hasAnsi check) to avoid unnecessary HTML for plain lines.
 * - function: custom renderer receives (line, index) and returns ReactNode.
 *
 * Features: auto-scroll toggle, copy button (strips ANSI), line count, line cap.
 */
export function Output({
  lines: rawLines,
  total,
  loading,
  renderer = 'plain',
  maxLines = MAX_LINES_DEFAULT,
  autoScroll: initialAutoScroll = true,
  isRunning,
}: Props) {
  const [autoScroll, setAutoScroll] = useState(initialAutoScroll);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  // Apply line cap
  const lines = rawLines.length > maxLines ? rawLines.slice(-maxLines) : rawLines;

  // Auto-scroll on new content
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length, autoScroll]);

  const handleCopy = () => {
    const text = lines.map(l => stripAnsi(l)).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    }).catch(() => { /* clipboard API may be blocked */ });
  };

  // Render a single line based on renderer mode
  const renderLine = (line: string, i: number) => {
    if (typeof renderer === 'function') {
      return <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', minHeight: 18 }}>{renderer(line, i)}</div>;
    }
    if (renderer === 'ansi' && hasAnsi(line)) {
      return <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', minHeight: 18 }} dangerouslySetInnerHTML={{ __html: ansiToHtml(line) || '\u00A0' }} />;
    }
    return <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', minHeight: 18 }}>{line || '\u00A0'}</div>;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Controls bar */}
      <div style={{
        padding: '12px 24px', fontSize: 11, color: '#6b6660', background: '#1a1815',
        borderBottom: '1px solid #302e2b',
        display: 'flex', justifyContent: 'space-between', gap: 8,
      }}>
        <span>
          {lines.length === total ? `${total} lines` : `${lines.length} of ${total} lines`}
          {loading && ' (loading...)'}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleCopy}
            onMouseEnter={e => { const btn = e.currentTarget as HTMLButtonElement; if (!copyFeedback) btn.style.color = '#c4bfb5'; btn.style.background = '#343230'; }}
            onMouseLeave={e => { const btn = e.currentTarget as HTMLButtonElement; if (!copyFeedback) btn.style.color = '#8a8578'; btn.style.background = 'none'; }}
            style={{ background: 'none', border: 'none', color: copyFeedback ? '#4ade80' : '#8a8578', cursor: 'pointer', fontSize: 11, transition: 'all 150ms', borderRadius: 4, padding: '2px 6px' }}
          >
            {copyFeedback ? 'Copied!' : 'Copy'}
          </button>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            onMouseEnter={e => { const btn = e.currentTarget as HTMLButtonElement; if (!autoScroll) btn.style.color = '#c4bfb5'; btn.style.background = '#343230'; }}
            onMouseLeave={e => { const btn = e.currentTarget as HTMLButtonElement; if (!autoScroll) btn.style.color = '#8a8578'; btn.style.background = 'none'; }}
            style={{ background: 'none', border: 'none', color: autoScroll ? '#4ade80' : '#8a8578', cursor: 'pointer', fontSize: 11, transition: 'all 150ms', borderRadius: 4, padding: '2px 6px' }}
          >
            {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
          </button>
        </div>
      </div>

      {/* Output area */}
      <div
        ref={scrollRef}
        style={{
          flex: 1, overflowY: 'auto', padding: '12px 24px',
          fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas", monospace',
          fontSize: 12, lineHeight: 1.5, background: '#161411',
        }}
      >
        {lines.length === 0 ? (
          <span style={{ color: '#585350' }}>{isRunning ? 'Waiting for output...' : 'No output'}</span>
        ) : (
          lines.map(renderLine)
        )}
        {isRunning && (
          <span style={{
            display: 'inline-block', width: 7, height: 14,
            background: '#4ade80', marginLeft: 2, verticalAlign: 'text-bottom',
            animation: 'flow-blink 1s step-end infinite',
          }} />
        )}
      </div>

      <style>{`@keyframes flow-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }`}</style>
    </div>
  );
}
