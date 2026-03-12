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

  // ---------------------------------------------------------------------------
  // New CLI event types (multi-emit parser)
  //
  // The new CLI JSONL format uses nested `data` objects and can emit multiple
  // events from a single line (e.g. assistant.message with content + toolRequests).
  // These tests use processLine(), which mirrors the updated parsing logic and
  // collects emitted events into an array.
  // ---------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let events: Array<{ event: string; args: any[] }>;

  /**
   * Mirror of the updated parsing logic from subprocess-backend.ts.
   * Handles both legacy (flat) and new (nested data) CLI event formats.
   * Pushes emitted events into the `events` array for assertion.
   */
  function processLine(line: string): void {
    events = [];
    if (line.trim() === '') return;

    let parsed: Record<string, unknown> | null = null;
    try {
      if (line.startsWith('{')) {
        parsed = JSON.parse(line);
      }
    } catch {
      // Not valid JSON — fall through to text
    }

    if (!parsed || typeof parsed.type !== 'string') {
      events.push({ event: 'text', args: [line] });
      return;
    }

    const data = parsed.data as Record<string, unknown> | undefined;

    switch (parsed.type) {
      // --- Legacy flat format ---
      case 'assistant.reasoning_delta':
        events.push({ event: 'reasoning', args: [String(parsed.content ?? '')] });
        break;
      case 'assistant.message_delta':
        events.push({ event: 'text', args: [String(parsed.content ?? '')] });
        break;
      case 'assistant.tool_start':
        events.push({ event: 'tool_start', args: [String(parsed.tool ?? ''), String(parsed.input ?? '')] });
        break;
      case 'assistant.tool_complete':
        events.push({ event: 'tool_complete', args: [String(parsed.tool ?? ''), String(parsed.output ?? '')] });
        break;

      // --- New nested data format ---
      case 'assistant.message': {
        const content = String(data?.content ?? '');
        const toolRequests = Array.isArray(data?.toolRequests) ? data.toolRequests : [];
        if (content) events.push({ event: 'text', args: [content] });
        for (const req of toolRequests) {
          const name = String(req.name ?? '');
          const args = JSON.stringify(req.arguments ?? {});
          events.push({ event: 'tool_start', args: [name, args] });
        }
        break;
      }
      case 'assistant.reasoning': {
        const content = String(data?.content ?? '');
        if (content) events.push({ event: 'reasoning', args: [content] });
        break;
      }
      case 'tool.execution_start': {
        const toolName = String(data?.toolName ?? '');
        const args = JSON.stringify(data?.arguments ?? {});
        events.push({ event: 'tool_start', args: [toolName, args] });
        break;
      }
      case 'tool.execution_complete': {
        const toolName = String(data?.toolName ?? '');
        const result = data?.result as Record<string, unknown> | undefined;
        const output = String(result?.content ?? result?.detailedContent ?? '');
        events.push({ event: 'tool_complete', args: [toolName, output] });
        break;
      }
      case 'subagent.started': {
        const displayName = String(data?.agentDisplayName ?? data?.agentName ?? '');
        events.push({ event: 'tool_start', args: [`subagent:${displayName}`, ''] });
        break;
      }
      case 'subagent.completed': {
        const displayName = String(data?.agentDisplayName ?? data?.agentName ?? '');
        events.push({ event: 'tool_complete', args: [`subagent:${displayName}`, ''] });
        break;
      }

      // --- Silently consumed (lifecycle events) ---
      case 'user.message':
      case 'assistant.turn_start':
      case 'assistant.turn_end':
        break;

      default: {
        // Three-tier: lifecycle → content extraction → stderr log
        const LIFECYCLE = new Set([
          'session.start', 'session.resume', 'session.shutdown', 'session.task_complete',
          'session.info', 'session.warning', 'session.title_changed',
          'session.context_changed', 'session.usage_info', 'session.model_change',
          'session.compaction_start', 'session.compaction_complete',
          'session.mode_changed', 'session.plan_changed',
          'session.truncation', 'session.snapshot_rewind',
          'session.workspace_file_changed', 'session.handoff',
          'session.background_tasks_changed',
          'pending_messages.modified', 'system.message', 'abort', 'result',
          'skill.invoked', 'subagent.selected', 'subagent.deselected',
          'user_input.requested', 'user_input.completed',
          'elicitation.requested', 'elicitation.completed',
          'external_tool.requested', 'external_tool.completed',
          'command.queued', 'command.completed',
          'exit_plan_mode.requested', 'exit_plan_mode.completed',
          'tool.user_requested', 'tool.execution_progress',
          'permission.completed',
        ]);
        if (LIFECYCLE.has(parsed.type)) break;
        const evtData = parsed.data as Record<string, unknown> | undefined;
        const content = typeof parsed.content === 'string' ? parsed.content
          : typeof evtData?.content === 'string' ? evtData.content : null;
        if (content) {
          events.push({ event: 'text', args: [content] });
        }
        // else: unknown event with no content — would log to stderr in production
        break;
      }
    }
  }

  it('assistant.message with data.content emits text', () => {
    processLine('{"type":"assistant.message","data":{"content":"Hello world","toolRequests":[]}}');
    expect(events).toEqual([{ event: 'text', args: ['Hello world'] }]);
  });

  it('assistant.message with toolRequests emits tool_start per request', () => {
    processLine('{"type":"assistant.message","data":{"content":"","toolRequests":[{"name":"bash","arguments":{"cmd":"ls"}},{"name":"fetch","arguments":{"url":"http://x"}}]}}');
    expect(events).toEqual([
      { event: 'tool_start', args: ['bash', '{"cmd":"ls"}'] },
      { event: 'tool_start', args: ['fetch', '{"url":"http://x"}'] },
    ]);
  });

  it('assistant.message with content + toolRequests emits both', () => {
    processLine('{"type":"assistant.message","data":{"content":"Analyzing...","toolRequests":[{"name":"search","arguments":{}}]}}');
    expect(events).toEqual([
      { event: 'text', args: ['Analyzing...'] },
      { event: 'tool_start', args: ['search', '{}'] },
    ]);
  });

  it('assistant.message with empty content and no toolRequests emits nothing', () => {
    processLine('{"type":"assistant.message","data":{"content":"","toolRequests":[]}}');
    expect(events).toEqual([]);
  });

  it('assistant.reasoning with data.content emits reasoning', () => {
    processLine('{"type":"assistant.reasoning","data":{"content":"Thinking about it"}}');
    expect(events).toEqual([{ event: 'reasoning', args: ['Thinking about it'] }]);
  });

  it('assistant.reasoning with empty content emits nothing', () => {
    processLine('{"type":"assistant.reasoning","data":{"content":""}}');
    expect(events).toEqual([]);
  });

  it('tool.execution_start emits tool_start with name and args', () => {
    processLine('{"type":"tool.execution_start","data":{"toolName":"search_file_content","arguments":{"query":"error"}}}');
    expect(events).toEqual([{ event: 'tool_start', args: ['search_file_content', '{"query":"error"}'] }]);
  });

  it('tool.execution_complete emits tool_complete with name and result', () => {
    processLine('{"type":"tool.execution_complete","data":{"toolName":"bash","result":{"content":"5 files found"}}}');
    expect(events).toEqual([{ event: 'tool_complete', args: ['bash', '5 files found'] }]);
  });

  it('tool.execution_complete uses detailedContent fallback', () => {
    processLine('{"type":"tool.execution_complete","data":{"toolName":"report_intent","result":{"detailedContent":"Classifying repo"}}}');
    expect(events).toEqual([{ event: 'tool_complete', args: ['report_intent', 'Classifying repo'] }]);
  });

  it('subagent.started maps to tool_start with subagent: prefix', () => {
    processLine('{"type":"subagent.started","data":{"agentName":"implementer","agentDisplayName":"Implementer"}}');
    expect(events).toEqual([{ event: 'tool_start', args: ['subagent:Implementer', ''] }]);
  });

  it('subagent.completed maps to tool_complete with subagent: prefix', () => {
    processLine('{"type":"subagent.completed","data":{"agentName":"implementer","agentDisplayName":"Implementer"}}');
    expect(events).toEqual([{ event: 'tool_complete', args: ['subagent:Implementer', ''] }]);
  });

  it('user.message is silently consumed', () => {
    processLine('{"type":"user.message","data":{"content":"Hello"}}');
    expect(events).toEqual([]);
  });

  it('assistant.turn_start is silently consumed', () => {
    processLine('{"type":"assistant.turn_start","data":{"turnId":"0"}}');
    expect(events).toEqual([]);
  });

  it('assistant.turn_end is silently consumed', () => {
    processLine('{"type":"assistant.turn_end","data":{"turnId":"0"}}');
    expect(events).toEqual([]);
  });

  it('session.background_tasks_changed is silently consumed', () => {
    processLine('{"type":"session.background_tasks_changed","data":{"tasks":[]}}');
    expect(events).toEqual([]);
  });

  it('session.info is silently consumed', () => {
    processLine('{"type":"session.info","data":{"message":"hello"}}');
    expect(events).toEqual([]);
  });

  it('unknown event with data.content extracts it as text', () => {
    processLine('{"type":"some.new_event","data":{"content":"extracted text"}}');
    expect(events).toEqual([{ event: 'text', args: ['extracted text'] }]);
  });

  it('unknown event with top-level content extracts it as text', () => {
    processLine('{"type":"some.new_event","content":"top level text"}');
    expect(events).toEqual([{ event: 'text', args: ['top level text'] }]);
  });

  it('unknown event without content emits nothing', () => {
    processLine('{"type":"some.new_event","data":{"foo":"bar"}}');
    expect(events).toEqual([]);
  });
});
