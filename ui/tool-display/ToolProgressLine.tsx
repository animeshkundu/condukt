'use client';

import React, { useState } from 'react';
import type { ToolInvocation } from './types';
import { isSimpleData, isTerminalData } from './types';
import { ensureAnimations } from './ThinkingSection';
import { ansiToHtml, hasAnsi } from '../ansi';
import { getToolIcon } from './tool-icons';
import { SANS, MONO } from './constants';

// -- Status icon --------------------------------------------------------------

function ProgressIcon({ tool }: { tool: ToolInvocation }) {
  if (!tool.isComplete) {
    return (
      <span style={{ display: 'inline-flex', width: 12, height: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <svg width="12" height="12" viewBox="0 0 12 12" style={{ animation: 'spin 1s linear infinite' }}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeDasharray="20 8" />
        </svg>
      </span>
    );
  }
  if (tool.isError) {
    return <span style={{ color: '#f87171', fontSize: 12, lineHeight: 1, flexShrink: 0 }}>&#10007;</span>;
  }
  return <span style={{ color: '#4ade80', fontSize: 12, lineHeight: 1, flexShrink: 0 }}>&#10003;</span>;
}

// -- Code badge ---------------------------------------------------------------

function CodeBadge({ text }: { text: string }) {
  return (
    <code style={{
      fontFamily: MONO,
      fontSize: 11,
      padding: '1px 4px',
      borderRadius: 4,
      background: '#2b2a27',
      border: '1px solid #3d3a36',
      color: '#b1ada1',
    }}>
      {text}
    </code>
  );
}

// -- Exit code badge ----------------------------------------------------------

function ExitCodeBadge({ exitCode }: { exitCode: number }) {
  const isSuccess = exitCode === 0;
  return (
    <span style={{
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: '0.08em',
      color: isSuccess ? '#4ade80' : '#f87171',
      background: isSuccess ? '#4ade8018' : '#f8717118',
      padding: '1px 6px',
      borderRadius: 4,
    }}>
      EXIT {exitCode}
    </span>
  );
}

// -- ANSI-aware output rendering ----------------------------------------------

function TerminalOutput({ text }: { text: string }) {
  if (hasAnsi(text)) {
    return (
      <span dangerouslySetInnerHTML={{ __html: ansiToHtml(text) }} />
    );
  }
  return <>{text}</>;
}

// -- ToolProgressLine ---------------------------------------------------------

export interface ToolProgressLineProps {
  tool: ToolInvocation;
  /** Optional callback to render custom expanded content. Return undefined to fall through to default. */
  renderToolExpanded?: (tool: ToolInvocation) => React.ReactNode | undefined;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Flat progress line for standalone (non-pinned) tools.
 * Pattern 1 from VS Code: icon + message, single line.
 *
 * MCP format: "check Ran `tool_name` -- server (MCP Server)"
 * Default: "check Read src/app/page.tsx"
 */
export function ToolProgressLine({ tool, renderToolExpanded, className, style }: ToolProgressLineProps) {
  ensureAnimations();

  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const [outputCopied, setOutputCopied] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const hasDetails = tool.isComplete && !!tool.toolSpecificData;

  // Running verb: when not complete, show active verb
  const isMcp = tool.category === 'mcp' || !!tool.serverName;
  let message: string;
  if (!tool.isComplete) {
    if (isMcp) {
      message = `Calling \`${tool.toolName}\`...`;
    } else {
      message = tool.invocationMessage;
    }
  } else {
    message = tool.pastTenseMessage ?? tool.invocationMessage;
  }

  // Resolve the tool result text for expanded view
  function getResultText(): string {
    if (!tool.toolSpecificData) {
      return tool.output.join('\n');
    }
    if (isSimpleData(tool.toolSpecificData)) {
      return tool.toolSpecificData.output;
    }
    if (isTerminalData(tool.toolSpecificData)) {
      return tool.toolSpecificData.output?.text ?? '';
    }
    return tool.output.join('\n');
  }

  const chevronChar = expanded ? '\u25BE' : '\u25B8'; // down / right

  // Check for terminal exit code
  const terminalState = tool.toolSpecificData && isTerminalData(tool.toolSpecificData)
    ? tool.toolSpecificData.state
    : undefined;

  return (
    <div
      className={className}
      style={{
        fontFamily: SANS,
        margin: '0 0 6px',
        ...style,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Header line */}
      <div
        onClick={hasDetails ? () => setExpanded(e => !e) : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 13,
          paddingTop: 2,
          paddingLeft: 8,
          cursor: hasDetails ? 'pointer' : 'default',
          minWidth: 0,
        }}
      >
        <ProgressIcon tool={tool} />
        <span style={{ display: 'inline-flex', color: '#8a8578', flexShrink: 0 }}>
          {getToolIcon(tool.category)}
        </span>
        <span style={{ color: '#8a8578', fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isMcp && tool.isComplete ? (
            <>
              {tool.verb}{' '}
              <CodeBadge text={tool.toolName} />
              {tool.serverName && (
                <span style={{ opacity: 0.7 }}> -- {tool.serverName} (MCP Server)</span>
              )}
            </>
          ) : isMcp && !tool.isComplete ? (
            <>
              Calling <CodeBadge text={tool.toolName} />
              {tool.serverName && (
                <span style={{ opacity: 0.7 }}> -- {tool.serverName} (MCP Server)</span>
              )}
              <span style={{ opacity: 0.7 }}>...</span>
            </>
          ) : (
            <>
              {tool.friendlyName}
              {message && message !== tool.friendlyName && (
                <span style={{ opacity: 0.7 }}>: {message}</span>
              )}
            </>
          )}
        </span>
        {hasDetails && (
          <span style={{
            color: '#6b6660',
            fontSize: 11,
            opacity: hovered || expanded ? 1 : 0,
            transition: 'opacity 150ms',
            flexShrink: 0,
          }}>
            {chevronChar}
          </span>
        )}
      </div>

      {/* Expanded content area */}
      {expanded && hasDetails && (() => {
        // Check custom renderer first
        const customContent = renderToolExpanded?.(tool);
        if (customContent !== undefined) {
          return (
            <div style={{
              border: '1px solid #3d3a36',
              borderRadius: 8,
              margin: '4px 0 4px 20px',
              overflow: 'hidden',
            }}>
              {customContent}
            </div>
          );
        }

        // Default expanded rendering
        const resultText = getResultText();
        const isTerminal = tool.toolSpecificData && isTerminalData(tool.toolSpecificData);

        return (
          <div style={{
            border: '1px solid #3d3a36',
            borderRadius: 8,
            margin: '4px 0 4px 20px',
            overflow: 'hidden',
          }}>
            {/* Input section */}
            <div style={{ padding: '8px 12px' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 4,
              }}>
                <div style={{
                  color: '#6b6660',
                  fontSize: 11,
                  fontWeight: 500,
                  textTransform: 'uppercase' as const,
                  letterSpacing: '0.08em',
                }}>
                  Input
                </div>
              </div>
              <pre style={{
                fontFamily: MONO,
                background: '#161411',
                border: '1px solid #302e2b',
                borderRadius: 6,
                padding: '8px 12px',
                fontSize: 11,
                color: '#b1ada1',
                margin: 0,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'break-word',
              }}>
                {tool.category === 'file' ? (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      const path = tool.toolSpecificData && isSimpleData(tool.toolSpecificData)
                        ? tool.toolSpecificData.input
                        : tool.invocationMessage;
                      navigator.clipboard.writeText(path).then(() => {
                        setPathCopied(true);
                        setTimeout(() => setPathCopied(false), 1500);
                      }).catch(() => {});
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        const path = tool.toolSpecificData && isSimpleData(tool.toolSpecificData)
                          ? tool.toolSpecificData.input
                          : tool.invocationMessage;
                        navigator.clipboard.writeText(path).then(() => {
                          setPathCopied(true);
                          setTimeout(() => setPathCopied(false), 1500);
                        }).catch(() => {});
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label="Copy file path"
                    style={{
                      color: pathCopied ? '#4ade80' : '#D97757',
                      cursor: 'pointer',
                      fontFamily: MONO,
                    }}
                  >
                    {pathCopied ? 'Copied!' : tool.invocationMessage}
                  </span>
                ) : (
                  tool.invocationMessage
                )}
              </pre>
            </div>

            {/* Output section */}
            <div style={{ padding: '4px 12px 8px' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 4,
              }}>
                <div style={{
                  color: '#6b6660',
                  fontSize: 11,
                  fontWeight: 500,
                  textTransform: 'uppercase' as const,
                  letterSpacing: '0.08em',
                }}>
                  Output
                </div>
                {terminalState?.exitCode !== undefined && (
                  <ExitCodeBadge exitCode={terminalState.exitCode} />
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(resultText).then(() => {
                      setOutputCopied(true);
                      setTimeout(() => setOutputCopied(false), 1500);
                    }).catch(() => {});
                  }}
                  style={{
                    marginLeft: 'auto',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: SANS,
                    fontSize: 10,
                    color: outputCopied ? '#4ade80' : '#8a8578',
                    padding: '0 4px',
                    transition: 'color 150ms',
                  }}
                >
                  {outputCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div style={{ position: 'relative' }}>
                <pre style={{
                  fontFamily: MONO,
                  background: '#161411',
                  border: '1px solid #302e2b',
                  borderRadius: 6,
                  padding: '8px 12px',
                  fontSize: 11,
                  color: '#b1ada1',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'break-word',
                  ...(outputExpanded ? {} : { maxHeight: 500, overflow: 'hidden' }),
                }}>
                  {isTerminal ? <TerminalOutput text={resultText} /> : resultText}
                </pre>
                {!outputExpanded && resultText.split('\n').length > 30 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOutputExpanded(true);
                    }}
                    style={{
                      display: 'block',
                      width: '100%',
                      padding: '6px 8px',
                      marginTop: 4,
                      background: 'transparent',
                      border: '1px solid #3d3a36',
                      borderRadius: 6,
                      cursor: 'pointer',
                      fontFamily: SANS,
                      fontSize: 11,
                      color: '#8a8578',
                      textAlign: 'center',
                      transition: 'all 150ms',
                    }}
                  >
                    Show full output ({resultText.split('\n').length} lines)
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
