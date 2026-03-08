'use client';

import React, { useState, useCallback } from 'react';
import type { ToolInvocation } from './types';
import { isTerminalData, isSimpleData, isSubagentData, isTodoData } from './types';

const MONO = '"JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas", monospace';

// ── Shared styles ────────────────────────────────────────────────────────────

const rowStyle: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 12,
  padding: '3px 8px',
  lineHeight: 1.5,
};

const dimStyle: React.CSSProperties = { color: '#6b6660' };
const labelStyle: React.CSSProperties = { color: '#8a8578', marginRight: 6 };

// ── Exit code badge ──────────────────────────────────────────────────────────

function ExitCodeBadge({ code }: { code: number }) {
  const ok = code === 0;
  return (
    <span style={{
      display: 'inline-block',
      fontSize: 10,
      fontFamily: MONO,
      padding: '0 4px',
      borderRadius: 3,
      marginLeft: 6,
      background: ok ? '#1a3528' : '#3a1a1a',
      color: ok ? '#4ade80' : '#f87171',
      verticalAlign: 'middle',
    }}>
      {ok ? '0' : `exit ${code}`}
    </span>
  );
}

// ── Collapsible content block ────────────────────────────────────────────────

function CollapsibleContent({ label, content, defaultCollapsed = true }: {
  label: string;
  content: string;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const toggle = useCallback(() => setCollapsed(c => !c), []);
  const chevron = collapsed ? '\u25B8' : '\u25BE';

  if (!content) { return null; }

  return (
    <div style={{ marginTop: 2 }}>
      <button
        onClick={toggle}
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: '#6b6660', fontFamily: MONO, fontSize: 11, padding: 0,
        }}
        aria-expanded={!collapsed}
      >
        {chevron} {label}
      </button>
      {!collapsed && (
        <pre style={{
          margin: '2px 0 0 12px',
          padding: '6px 8px',
          background: '#161411',
          border: '1px solid #302e2b',
          borderRadius: 4,
          fontSize: 11,
          color: '#b1ada1',
          fontFamily: MONO,
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 300,
          overflowY: 'auto',
        }}>
          {content}
        </pre>
      )}
    </div>
  );
}

// ── Category-specific renderers ──────────────────────────────────────────────

function TerminalRow({ tool }: { tool: ToolInvocation }) {
  const data = tool.toolSpecificData;
  if (!data || !isTerminalData(data)) { return null; }

  const cmd = data.presentationOverrides?.commandLine ?? data.commandLine.original;
  const exitCode = data.state?.exitCode;

  return (
    <div style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ color: '#fbbf24', marginRight: 6, fontWeight: 600 }}>$</span>
        <span style={{ color: '#e8e6e3', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {cmd}
        </span>
        {exitCode !== undefined && <ExitCodeBadge code={exitCode} />}
        {!tool.isComplete && (
          <span style={{ color: '#60a5fa', marginLeft: 6, fontSize: 11 }}>running…</span>
        )}
      </div>
      {data.output?.text && (
        <CollapsibleContent label="output" content={data.output.text} />
      )}
    </div>
  );
}

function SimpleRow({ tool }: { tool: ToolInvocation }) {
  const data = tool.toolSpecificData;
  if (!data || !isSimpleData(data)) { return null; }

  return (
    <div style={rowStyle}>
      <div>
        <span style={labelStyle}>{tool.toolName}</span>
        <span style={{ color: '#b1ada1' }}>{tool.invocationMessage}</span>
      </div>
      {data.output && <CollapsibleContent label="result" content={data.output} />}
    </div>
  );
}

function SubagentRow({ tool }: { tool: ToolInvocation }) {
  const data = tool.toolSpecificData;
  if (!data || !isSubagentData(data)) { return null; }

  return (
    <div style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ color: '#22d3ee', fontWeight: 600, marginRight: 6 }}>&#9670;</span>
        <span style={{ color: '#22d3ee', fontWeight: 500 }}>{data.agentName ?? 'agent'}</span>
        {data.description && <span style={{ ...dimStyle, marginLeft: 8 }}>{data.description}</span>}
        {!tool.isComplete && <span style={{ color: '#60a5fa', marginLeft: 6, fontSize: 11 }}>working…</span>}
      </div>
      {data.result && <CollapsibleContent label="result" content={data.result} defaultCollapsed={false} />}
    </div>
  );
}

function TodoRow({ tool }: { tool: ToolInvocation }) {
  const data = tool.toolSpecificData;
  if (!data || !isTodoData(data)) { return null; }

  const statusIcon = (s: string) => {
    switch (s) {
      case 'completed': return '\u2611'; // ☑
      case 'in-progress': return '\u25CB'; // ○
      default: return '\u2610'; // ☐
    }
  };

  const statusColor = (s: string) => {
    switch (s) {
      case 'completed': return '#4ade80';
      case 'in-progress': return '#60a5fa';
      default: return '#6b6660';
    }
  };

  return (
    <div style={rowStyle}>
      <div style={{ color: '#b1ada1', fontWeight: 500, marginBottom: 2 }}>{data.title}</div>
      {data.todoList.map(item => (
        <div key={item.id} style={{ display: 'flex', alignItems: 'center', paddingLeft: 8, gap: 6 }}>
          <span style={{ color: statusColor(item.status) }}>{statusIcon(item.status)}</span>
          <span style={{ color: item.status === 'completed' ? '#6b6660' : '#b1ada1', textDecoration: item.status === 'completed' ? 'line-through' : 'none' }}>
            {item.title}
          </span>
        </div>
      ))}
    </div>
  );
}

function DefaultRow({ tool }: { tool: ToolInvocation }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{tool.toolName}</span>
      <span style={{ color: '#b1ada1' }}>{tool.invocationMessage || `Used tool: ${tool.toolName}`}</span>
      {tool.isComplete && tool.output.length > 0 && (
        <CollapsibleContent label="output" content={tool.output.join('\n')} />
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export interface ToolInvocationRowProps {
  tool: ToolInvocation;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Renders a single tool invocation with category-specific display:
 * - Shell: command as monospace header, output as terminal block, exit code badge
 * - File/Search: message + collapsible result
 * - Subagent: diamond glyph + name + collapsible result
 * - Todo: checklist with status icons
 * - Default: tool name + message + collapsible output
 */
export function ToolInvocationRow({ tool, className, style }: ToolInvocationRowProps) {
  const data = tool.toolSpecificData;

  // Route to category-specific renderer
  if (data && isTerminalData(data)) { return <TerminalRow tool={tool} />; }
  if (data && isSubagentData(data)) { return <SubagentRow tool={tool} />; }
  if (data && isTodoData(data)) { return <TodoRow tool={tool} />; }
  if (data && isSimpleData(data)) { return <SimpleRow tool={tool} />; }

  // Incomplete tools with no data yet — show the invocation message
  if (!tool.isComplete && !data) {
    return (
      <div className={className} style={{ ...rowStyle, ...style }}>
        <span style={labelStyle}>{tool.toolName}</span>
        <span style={{ color: '#b1ada1' }}>{tool.invocationMessage}</span>
        <span style={{ color: '#60a5fa', marginLeft: 6, fontSize: 11 }}>…</span>
      </div>
    );
  }

  return <DefaultRow tool={tool} />;
}
