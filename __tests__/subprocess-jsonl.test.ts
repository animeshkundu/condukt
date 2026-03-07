/**
 * JSONL parsing tests for SubprocessBackend stdout handler.
 *
 * Tests the line-by-line parsing logic that converts copilot CLI
 * --output-format json output into typed events (reasoning, text,
 * tool_start, tool_complete). Exercises the same branching logic
 * as SubprocessSession without spawning a real subprocess.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Mirror of the parsing logic from subprocess-backend.ts.
// Kept in-test to avoid exporting internal helpers from production code.
// ---------------------------------------------------------------------------

type EmittedEvent =
  | { event: 'text'; args: [string] }
  | { event: 'reasoning'; args: [string] }
  | { event: 'tool_start'; args: [string, string] }
  | { event: 'tool_complete'; args: [string, string] }
  | null; // null = line skipped (empty)

function parseJsonlLine(line: string): EmittedEvent {
  if (line.trim() === '') return null;

  let parsed: Record<string, unknown> | null = null;
  try {
    if (line.startsWith('{')) {
      parsed = JSON.parse(line);
    }
  } catch {
    // Not valid JSON — fall through to text
  }

  if (parsed && typeof parsed.type === 'string') {
    switch (parsed.type) {
      case 'assistant.reasoning_delta':
        return { event: 'reasoning', args: [String(parsed.content ?? '')] };
      case 'assistant.message_delta':
        return { event: 'text', args: [String(parsed.content ?? '')] };
      case 'assistant.tool_start':
        return { event: 'tool_start', args: [String(parsed.tool ?? ''), String(parsed.input ?? '')] };
      case 'assistant.tool_complete':
        return { event: 'tool_complete', args: [String(parsed.tool ?? ''), String(parsed.output ?? '')] };
      default:
        return { event: 'text', args: [line] };
    }
  }

  return { event: 'text', args: [line] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JSONL line parser (subprocess stdout)', () => {
  it('parses reasoning_delta as reasoning event', () => {
    const line = JSON.stringify({ type: 'assistant.reasoning_delta', content: 'thinking...' });
    const result = parseJsonlLine(line);
    expect(result).toEqual({ event: 'reasoning', args: ['thinking...'] });
  });

  it('parses message_delta as text event', () => {
    const line = JSON.stringify({ type: 'assistant.message_delta', content: 'response' });
    const result = parseJsonlLine(line);
    expect(result).toEqual({ event: 'text', args: ['response'] });
  });

  it('parses tool_start event', () => {
    const line = JSON.stringify({ type: 'assistant.tool_start', tool: 'Read', input: '/file' });
    const result = parseJsonlLine(line);
    expect(result).toEqual({ event: 'tool_start', args: ['Read', '/file'] });
  });

  it('parses tool_complete event', () => {
    const line = JSON.stringify({ type: 'assistant.tool_complete', tool: 'Read', output: 'contents' });
    const result = parseJsonlLine(line);
    expect(result).toEqual({ event: 'tool_complete', args: ['Read', 'contents'] });
  });

  it('falls back to text for non-JSON lines', () => {
    const line = 'plain text output';
    const result = parseJsonlLine(line);
    expect(result).toEqual({ event: 'text', args: ['plain text output'] });
  });

  it('skips empty lines', () => {
    expect(parseJsonlLine('')).toBeNull();
    expect(parseJsonlLine('  ')).toBeNull();
  });

  it('falls back to text for malformed JSON', () => {
    const line = '{invalid json';
    const result = parseJsonlLine(line);
    expect(result).toEqual({ event: 'text', args: ['{invalid json'] });
  });

  it('handles interleaved reasoning and message deltas', () => {
    const lines = [
      JSON.stringify({ type: 'assistant.reasoning_delta', content: 'let me think' }),
      JSON.stringify({ type: 'assistant.reasoning_delta', content: 'about this' }),
      JSON.stringify({ type: 'assistant.message_delta', content: 'Here is the answer' }),
    ];

    const results = lines.map(parseJsonlLine);

    expect(results).toEqual([
      { event: 'reasoning', args: ['let me think'] },
      { event: 'reasoning', args: ['about this'] },
      { event: 'text', args: ['Here is the answer'] },
    ]);
  });

  it('falls back to text for unknown JSON event types', () => {
    const line = JSON.stringify({ type: 'assistant.unknown_event', data: 'foo' });
    const result = parseJsonlLine(line);
    expect(result).toEqual({ event: 'text', args: [line] });
  });

  it('handles missing content field with empty string fallback', () => {
    const line = JSON.stringify({ type: 'assistant.reasoning_delta' });
    const result = parseJsonlLine(line);
    expect(result).toEqual({ event: 'reasoning', args: [''] });
  });
});
