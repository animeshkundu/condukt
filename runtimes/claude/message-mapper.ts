/**
 * Pure mapping from Claude Agent SDK messages to condukt AgentSession events.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ToolUsageData } from '../../src/types';

export interface ClaudeSessionEmitter {
  text(text: string): void;
  reasoning(text: string): void;
  toolStart(tool: string, input: string, args: Record<string, unknown>, callId?: string): void;
  toolComplete(tool: string, output: string, callId?: string): void;
  toolOutput(tool: string, output: string): void;
  idle(): void;
  error(err: Error): void;
  usage(data: Record<string, unknown>): void;
  compaction(phase: 'start' | 'complete', summary?: string): void;
  subagentStart(name: string, data: Record<string, unknown>): void;
  subagentEnd(name: string, data: Record<string, unknown>): void;
  permission(data: Record<string, unknown>): void;
  toolUsage(data: ToolUsageData): void;
}

export interface MapOptions {
  readonly includePartialMessages: boolean;
}

export interface MapState {
  sawPartial: boolean;
  /** Maps tool call id -> tool name for attributing tool_complete events. */
  toolNames: Map<string, string>;
  /** In-flight tool blocks during streaming, keyed by content block index. */
  toolBlocks: Map<number, { name: string; id?: string; buffer: string }>;
}

export function createMapState(): MapState {
  return { sawPartial: false, toolNames: new Map(), toolBlocks: new Map() };
}

export function mapSdkMessage(
  msg: SDKMessage,
  emitter: ClaudeSessionEmitter,
  state: MapState,
  _options: MapOptions,
): boolean {
  if (!(state as { toolNames?: Map<string, string> }).toolNames) {
    (state as { toolNames: Map<string, string> }).toolNames = new Map();
  }
  if (!state.toolBlocks) state.toolBlocks = new Map();
  switch (msg.type) {
    case 'assistant': {
      const m = (msg as { message?: { content?: unknown[]; usage?: unknown } }).message;
      const content = Array.isArray(m?.content) ? m.content : [];
      if (!state.sawPartial) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            emitter.text(b.text);
          } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
            emitter.reasoning(b.thinking);
          } else if (b.type === 'tool_use') {
            const name = typeof b.name === 'string' ? b.name : 'tool';
            const input = b.input;
            const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
            const callId = typeof b.id === 'string' ? b.id : undefined;
            if (callId) state.toolNames.set(callId, name);
            emitter.toolStart(name, safeStringify(input), args, callId);
          }
        }
      }
      if (m?.usage && typeof m.usage === 'object') {
        emitter.usage({ ...(m.usage as Record<string, unknown>), source: 'assistant' });
      }
      return false;
    }
    case 'stream_event': {
      state.sawPartial = true;
      const ev = (msg as unknown as { event?: Record<string, unknown> }).event;
      if (!ev) return false;
      const t = ev.type;
      const idx = typeof ev.index === 'number' ? ev.index : 0;
      if (t === 'content_block_delta') {
        const delta = ev.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          emitter.text(delta.text);
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          emitter.reasoning(delta.thinking);
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const b = state.toolBlocks.get(idx);
          if (b) b.buffer += delta.partial_json;
        }
      } else if (t === 'content_block_start') {
        const cb = ev.content_block as Record<string, unknown> | undefined;
        if (cb?.type === 'tool_use') {
          const name = typeof cb.name === 'string' ? cb.name : 'tool';
          const callId = typeof cb.id === 'string' ? cb.id : undefined;
          if (callId) state.toolNames.set(callId, name);
          state.toolBlocks.set(idx, { name, id: callId, buffer: '' });
        }
      } else if (t === 'content_block_stop') {
        const b = state.toolBlocks.get(idx);
        if (b) {
          let args: Record<string, unknown> = {};
          if (b.buffer.trim()) {
            try { args = JSON.parse(b.buffer); } catch { args = { _raw: b.buffer }; }
          }
          emitter.toolStart(b.name, b.buffer, args, b.id);
          state.toolBlocks.delete(idx);
        }
      }
      return false;
    }
    case 'user': {
      const m = (msg as { message?: { content?: unknown[] } }).message;
      const content = Array.isArray(m?.content) ? m.content : [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_result') {
          const callId = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
          const name = callId ? (state.toolNames.get(callId) ?? '') : '';
          if (callId) state.toolNames.delete(callId);
          const output = extractToolResultContent(b.content);
          emitter.toolComplete(name, output, callId);
        }
      }
      return false;
    }
    case 'result': {
      const r = msg as Record<string, unknown>;
      const usage = r.usage;
      if (usage && typeof usage === 'object') {
        emitter.usage({ ...(usage as Record<string, unknown>), source: 'result', cost_usd: r.total_cost_usd });
      }
      if (r.subtype === 'success') {
        emitter.idle();
      } else {
        const errors = Array.isArray(r.errors) ? r.errors : [];
        const message = errors.length > 0 ? String(errors[0]) : 'Claude session failed';
        emitter.error(new Error(message));
      }
      state.sawPartial = false;
      return true;
    }
    case 'system': {
      const sub = (msg as { subtype?: string }).subtype;
      if (sub === 'compact_boundary') {
        emitter.compaction('complete');
      } else if (sub === 'task_started') {
        const m = msg as Record<string, unknown>;
        emitter.subagentStart(String(m.description ?? m.task_id ?? 'subagent'), {
          task_id: m.task_id,
          subagent_type: m.subagent_type,
        });
      } else if (sub === 'task_notification' || sub === 'task_completed') {
        const m = msg as Record<string, unknown>;
        emitter.subagentEnd(String(m.task_id ?? 'subagent'), {
          task_id: m.task_id,
          status: m.status,
        });
      } else if (sub === 'permission_denied') {
        emitter.permission(msg as unknown as Record<string, unknown>);
      }
      return false;
    }
    case 'tool_progress': {
      const m = msg as Record<string, unknown>;
      const name = typeof m.tool_name === 'string' ? m.tool_name : '';
      emitter.toolOutput(name, '');
      return false;
    }
    default:
      return false;
  }
}

function safeStringify(v: unknown): string {
  if (v === undefined) return '';
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function extractToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const x = c as Record<string, unknown>;
        if (typeof x.text === 'string') return x.text;
        if (typeof x.content === 'string') return x.content;
        try {
          return JSON.stringify(c);
        } catch {
          return String(c);
        }
      })
      .join('\n');
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return '';
}

export type { ToolUsageData } from '../../src/types';
