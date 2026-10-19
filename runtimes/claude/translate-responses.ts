/**
 * Anthropic ⇄ OpenAI Responses translation (reference-proxy parity).
 *
 * Pure functions plus a streaming state machine that consumes Responses
 * SSE event dicts and emits Anthropic SSE frames. Fail-closed semantics:
 * unknown terminal states, hollow completions, and invalid tool arguments
 * raise instead of reading as clean turns.
 */

import {
  extractCacheCreationTokens,
  extractCacheReadTokens,
  getOutputTokens,
  normalizeToolCallId,
  stableJson,
  upstreamUsageFromResponses,
  withReasoningSplit,
  type UpstreamTurnUsage,
} from './bridge-cache';
import { mapResponsesEffort, supportsToolChoice } from './protocol-router';
import { sseFrame } from './sse';
import { parseToolArgs } from './translate-chat';

const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

// ── tool_choice mapping ──────────────────────────────────────────────

export type ResponsesToolChoice = 'auto' | { type: 'function'; name: string } | null;

/**
 * Map an Anthropic tool_choice to Responses.
 *   auto → "auto" (omitted on the wire; every verified family accepts it)
 *   none → null sentinel: callers omit the tools array entirely
 *   named → only families verified to accept it (gpt/grok), else loud
 *   any/required → loud (unverified on every family)
 */
export function mapResponsesToolChoice(choice: unknown, model: string): ResponsesToolChoice {
  if (choice === null || choice === undefined || choice === 'auto') return 'auto';
  if (typeof choice === 'object') {
    const c = choice as Record<string, any>;
    const t = c['type'];
    if (t === 'auto') return 'auto';
    if (t === 'none') return null;
    if (t === 'tool' || t === 'function') {
      const name = String(c['name'] ?? c['function']?.name ?? '');
      if (!supportsToolChoice(model, { type: 'function', name })) {
        throw new Error(
          `model ${model} does not accept a named tool_choice (${JSON.stringify(name)}); use auto (verified surface)`,
        );
      }
      return { type: 'function', name };
    }
  }
  throw new Error(`tool_choice ${JSON.stringify(choice)} is not supported on the Responses path; use auto or none`);
}

// ── reasoning mapping ────────────────────────────────────────────────

export function responsesReasoning(body: Record<string, any>, model: string): { effort: string } | null {
  const thinking = body?.['thinking'];
  let effort: unknown = null;
  if (thinking && typeof thinking === 'object' && (thinking['type'] === 'enabled' || thinking['type'] === 'adaptive')) {
    effort = thinking['effort'] ?? null;
  } else {
    effort = body?.['effort'] ?? body?.['output_config']?.effort ?? null;
  }
  const wire = mapResponsesEffort(model, effort);
  if (wire === null) return null;
  return { effort: String(wire) };
}

// ── request translation ──────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        const x = (c ?? {}) as Record<string, unknown>;
        if (typeof x['text'] === 'string') return x['text'];
        if (typeof x['content'] === 'string') return x['content'];
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

function itemText(role: string, text: string): Record<string, unknown> {
  if (role === 'assistant') {
    return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
  }
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
}

/**
 * Convert an Anthropic messages body to an OpenAI Responses body.
 * Raises on shapes the Responses conversion cannot express (images,
 * documents, server tools, unsupported tool_choice/effort) — loud, never
 * silently dropped.
 */
export function anthropicToResponses(body: Record<string, any>, model: string): Record<string, any> {
  const items: Record<string, unknown>[] = [];
  const systems: string[] = [];
  const system = body?.['system'] ?? '';
  if (typeof system === 'string') {
    if (system) systems.push(system);
  } else if (Array.isArray(system)) {
    for (const b of system) {
      if (b && typeof b === 'object' && b['type'] === 'text' && b['text']) {
        systems.push(String(b['text']));
      }
    }
  }

  const pendingStableIds: string[] = [];
  const messages = Array.isArray(body?.['messages']) ? body['messages'] : [];

  for (let mi = 0; mi < messages.length; mi += 1) {
    const msg = messages[mi];
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg['role'] ?? 'user');
    const content = msg['content'] ?? '';
    if (typeof content === 'string') {
      if (content) items.push(itemText(role, content));
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (let bi = 0; bi < content.length; bi += 1) {
      const block = content[bi];
      if (typeof block === 'string') {
        if (block) items.push(itemText(role, block));
        continue;
      }
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, any>;
      const btype = b['type'];
      if (btype === 'text') {
        const t = String(b['text'] ?? '');
        if (t) items.push(itemText(role, t));
      } else if (btype === 'thinking' || btype === 'redacted_thinking') {
        continue;
      } else if (btype === 'image' || btype === 'document') {
        throw new Error(
          `model ${model} does not accept ${btype} content (Responses conversion is text-only in this build)`,
        );
      } else if (btype === 'tool_use' || btype === 'server_tool_use') {
        const name = typeof b['name'] === 'string' ? b['name'] : '';
        if (!name) continue;
        const input = b['input'] && typeof b['input'] === 'object' ? b['input'] : {};
        const cid = normalizeToolCallId(b['id'], 'call', `${mi}.${bi}`, input);
        if (!(typeof b['id'] === 'string' && b['id'])) pendingStableIds.push(cid);
        items.push({ type: 'function_call', call_id: cid, name, arguments: stableJson(input) });
      } else if (btype === 'tool_result' || btype === 'web_search_tool_result') {
        let cid: string | null = typeof b['tool_use_id'] === 'string' && b['tool_use_id'] ? b['tool_use_id'] : null;
        if (!cid && pendingStableIds.length > 0) cid = pendingStableIds.shift() ?? null;
        if (!cid) cid = normalizeToolCallId(undefined, 'call', `${mi}.${bi}`, 'tool_result');
        items.push({
          type: 'function_call_output',
          call_id: cid,
          output: extractText(b['content']),
        });
      }
      // unknown blocks drop (mirrors chat conversion)
    }
  }

  const out: Record<string, any> = {
    model,
    input: items,
    max_output_tokens: body?.['max_tokens'] ?? DEFAULT_MAX_OUTPUT_TOKENS,
    stream: !!body?.['stream'],
  };
  if (systems.length > 0) out['instructions'] = systems.join('\n\n');

  const tools: Record<string, unknown>[] = [];
  for (const t of Array.isArray(body?.['tools']) ? body['tools'] : []) {
    if (!t || typeof t !== 'object') continue;
    const name = t['name'];
    if (typeof name !== 'string' || !name) continue;
    const ttype = t['type'];
    if (typeof ttype === 'string' && ttype.startsWith('web_search_')) {
      throw new Error(
        'web search (server tool) is not supported directly on the Responses path; ' +
          'remove the tool or route to an Anthropic-protocol model',
      );
    }
    tools.push({
      type: 'function',
      name,
      description: t['description'] ?? '',
      parameters: t['input_schema'] && typeof t['input_schema'] === 'object' ? t['input_schema'] : {},
    });
  }
  if (tools.length > 0) {
    const choice = mapResponsesToolChoice(body?.['tool_choice'] ?? 'auto', model);
    if (choice !== null) {
      out['tools'] = tools;
      if (choice !== 'auto') out['tool_choice'] = choice;
    }
    // choice === null ("none"): omit tools entirely → zero calls.
  }

  const reasoning = responsesReasoning(body, model);
  if (reasoning) out['reasoning'] = reasoning;
  return out;
}

// ── non-streaming response translation ───────────────────────────────

export function responsesToAnthropic(resp: Record<string, any>, requested: string, messageId?: string): Record<string, any> {
  if (!resp || typeof resp !== 'object') {
    throw new Error('upstream returned a malformed response envelope');
  }
  const blocks: Record<string, unknown>[] = [];
  const dropped: string[] = [];
  const output = Array.isArray(resp['output']) ? resp['output'] : [];
  for (const outItem of output) {
    if (!outItem || typeof outItem !== 'object') {
      dropped.push('non-dict');
      continue;
    }
    const otype = outItem['type'];
    if (otype === 'message') {
      const parts = Array.isArray(outItem['content']) ? outItem['content'] : [];
      for (const part of parts) {
        if (part && typeof part === 'object' && part['type'] === 'output_text') {
          const t = String(part['text'] ?? '');
          if (t) blocks.push({ type: 'text', text: t });
        }
      }
    } else if (otype === 'function_call') {
      const name = outItem['name'];
      if (typeof name !== 'string' || !name) continue;
      let input: Record<string, unknown>;
      try {
        input = parseToolArgs(String(outItem['arguments'] ?? ''));
      } catch {
        throw new Error('upstream returned invalid function-call arguments');
      }
      blocks.push({
        type: 'tool_use',
        id: normalizeToolCallId(outItem['call_id'], name, blocks.length, input),
        name,
        input,
      });
    } else {
      dropped.push(String(otype));
    }
  }

  const status = String(resp['status'] ?? 'completed');
  let stop: string;
  if (status === 'completed') {
    stop = blocks.some((b) => b['type'] === 'tool_use') ? 'tool_use' : 'end_turn';
  } else if (status === 'incomplete') {
    const reason = String((resp['incomplete_details'] ?? {})?.['reason'] ?? '');
    if (reason === 'max_output_tokens') stop = 'max_tokens';
    else if (reason === 'content_filter') stop = 'content_filter';
    else throw new Error(`upstream response incomplete with unknown reason: ${JSON.stringify(reason)}`);
  } else {
    const err = resp['error'];
    const msg = (err && typeof err === 'object' ? err['message'] : null) ?? status;
    throw new Error(`upstream response failed: ${msg}`);
  }

  if (blocks.length === 0 && status === 'completed') {
    const seen = [...new Set(dropped)].sort();
    const detail = seen.length > 0 ? ` (dropped: ${seen.join(',')})` : '';
    throw new Error(`upstream response completed with no content blocks${detail}`);
  }

  const usage = resp['usage'] && typeof resp['usage'] === 'object' ? resp['usage'] : {};
  const details = usage['input_tokens_details'];
  const cacheRead = (details && typeof details === 'object' ? details['cached_tokens'] : 0) || extractCacheReadTokens(usage);
  const cacheCreate = usage['cache_write_tokens'] || extractCacheCreationTokens(usage);
  const outUsage = withReasoningSplit(
    {
      input_tokens: Number(usage['input_tokens'] ?? 0) || 0,
      output_tokens: getOutputTokens(usage),
      cache_creation_input_tokens: cacheCreate,
      cache_read_input_tokens: cacheRead,
    },
    usage,
  );

  return {
    id: messageId ?? `msg_${Math.random().toString(16).slice(2, 26)}`,
    type: 'message',
    role: 'assistant',
    content: blocks,
    model: requested,
    stop_reason: stop,
    stop_sequence: null,
    usage: outUsage,
  };
}

// ── streaming translator ─────────────────────────────────────────────

export class StreamTranslationError extends Error {
  readonly frames: string[];
  constructor(message: string, frames: string[] = []) {
    super(message);
    this.name = 'StreamTranslationError';
    this.frames = frames;
  }
}

interface ToolAcc {
  readonly blockIdx: number;
  readonly id: string;
  readonly name: string;
  args: string;
}

export interface ResponsesStreamOptions {
  readonly requestedModel: string;
  readonly estimatedInput?: number;
  readonly messageId?: string;
  /**
   * Called once on a clean terminal event with the final upstream usage
   * (null when the upstream gave none). Observability only: never lets
   * an exception reach the translator.
   */
  readonly onFinalUsage?: (usage: UpstreamTurnUsage | null) => void;
}

export class ResponsesStreamTranslator {
  private readonly requestedModel: string;
  private readonly estimatedInput: number;
  private readonly messageId: string;
  private readonly onFinalUsage?: (usage: UpstreamTurnUsage | null) => void;
  private started = false;
  private textBlockIdx: number | null = null;
  private nextBlockIdx = 0;
  private readonly openBlocks = new Set<number>();
  private readonly toolAcc = new Map<number, ToolAcc>();
  private readonly validated = new Set<number>();
  private calledTools = false;
  private terminal = false;

  constructor(opts: ResponsesStreamOptions) {
    this.requestedModel = opts.requestedModel;
    this.estimatedInput = opts.estimatedInput ?? 0;
    this.messageId = opts.messageId ?? `msg_${Math.random().toString(16).slice(2, 26)}`;
    this.onFinalUsage = opts.onFinalUsage;
  }

  get messageStarted(): boolean {
    return this.started;
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  /** Feed one parsed upstream event; returns frames to forward. */
  push(event: Record<string, any>): string[] {
    if (this.terminal) return [];
    const frames: string[] = [];
    try {
      this.handle(event, frames);
      return frames;
    } catch (e) {
      throw new StreamTranslationError(e instanceof Error ? e.message : String(e), frames);
    }
  }

  /** Upstream transport failure: reference error close. */
  fail(message: string): string[] {
    if (this.terminal) return [];
    this.terminal = true;
    const frames: string[] = [];
    if (this.messageStarted) {
      for (const idx of [...this.openBlocks]) {
        frames.push(sseFrame('content_block_stop', { type: 'content_block_stop', index: idx }));
      }
      this.openBlocks.clear();
    }
    frames.push(sseFrame('error', { type: 'error', error: { type: 'api_error', message } }));
    return frames;
  }

  /** Upstream EOF without a terminal event: fail closed. */
  endOfStream(): string[] {
    if (this.terminal) return [];
    return this.fail('upstream stream ended without a terminal event');
  }

  // ── internals ──────────────────────────────────────────────────────

  private startMessage(frames: string[]): void {
    if (this.started) return;
    this.started = true;
    frames.push(
      sseFrame('message_start', {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: this.requestedModel,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: this.estimatedInput,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
    );
  }

  private openBlock(frames: string[], block: Record<string, unknown>): number {
    const idx = this.nextBlockIdx++;
    this.openBlocks.add(idx);
    frames.push(sseFrame('content_block_start', { type: 'content_block_start', index: idx, content_block: block }));
    return idx;
  }

  private closeBlock(frames: string[], idx: number | null): void {
    if (idx === null) return;
    if (!this.openBlocks.has(idx)) return;
    this.openBlocks.delete(idx);
    frames.push(sseFrame('content_block_stop', { type: 'content_block_stop', index: idx }));
  }

  private handle(event: Record<string, any>, frames: string[]): void {
    const etype = event['type'];
    if (etype === 'response.created' || etype === 'response.in_progress') return;

    if (etype === 'response.output_item.added') {
      const item = event['item'] ?? {};
      const itype = item['type'];
      if (itype === 'message') return; // text opens lazily on first delta
      if (itype === 'function_call') {
        const name = item['name'];
        if (typeof name !== 'string' || !name) return;
        this.startMessage(frames);
        this.closeBlock(frames, this.textBlockIdx);
        this.textBlockIdx = null;
        this.calledTools = true;
        const cid =
          typeof item['call_id'] === 'string' && item['call_id']
            ? item['call_id']
            : `toolu_${Math.random().toString(16).slice(2, 10)}`;
        const blockIdx = this.openBlock(frames, { type: 'tool_use', id: cid, name, input: {} });
        const oidx = typeof event['output_index'] === 'number' ? event['output_index'] : this.toolAcc.size;
        this.toolAcc.set(oidx, {
          blockIdx,
          id: cid,
          name,
          args: typeof item['arguments'] === 'string' ? item['arguments'] : '',
        });
      }
      return;
    }

    if (etype === 'response.content_part.added') {
      const part = event['part'] ?? {};
      if (part['type'] === 'output_text' && this.textBlockIdx === null) {
        this.startMessage(frames);
        this.textBlockIdx = this.openBlock(frames, { type: 'text', text: '' });
      }
      return;
    }

    if (etype === 'response.output_text.delta') {
      const delta = String(event['delta'] ?? '');
      this.startMessage(frames);
      if (this.textBlockIdx === null) {
        this.textBlockIdx = this.openBlock(frames, { type: 'text', text: '' });
      }
      if (delta) {
        frames.push(
          sseFrame('content_block_delta', {
            type: 'content_block_delta',
            index: this.textBlockIdx,
            delta: { type: 'text_delta', text: delta },
          }),
        );
      }
      return;
    }

    if (etype === 'response.content_part.done' || etype === 'response.output_text.done') {
      if (this.textBlockIdx !== null) {
        this.closeBlock(frames, this.textBlockIdx);
        this.textBlockIdx = null;
      }
      return;
    }

    if (etype === 'response.function_call_arguments.delta') {
      const acc = this.toolAcc.get(event['output_index']);
      if (!acc) return;
      const delta = String(event['delta'] ?? '');
      if (delta) {
        acc.args += delta;
        frames.push(
          sseFrame('content_block_delta', {
            type: 'content_block_delta',
            index: acc.blockIdx,
            delta: { type: 'input_json_delta', partial_json: delta },
          }),
        );
      }
      return;
    }

    if (etype === 'response.function_call_arguments.done') {
      const acc = this.toolAcc.get(event['output_index']);
      if (acc) {
        if (!acc.args && typeof event['arguments'] === 'string' && event['arguments']) {
          acc.args = event['arguments'];
          frames.push(
            sseFrame('content_block_delta', {
              type: 'content_block_delta',
              index: acc.blockIdx,
              delta: { type: 'input_json_delta', partial_json: acc.args },
            }),
          );
        }
        parseToolArgs(acc.args); // loud on invalid arguments
        this.validated.add(event['output_index']);
      }
      return;
    }

    if (etype === 'response.output_item.done') {
      const item = event['item'] ?? {};
      const itype = item['type'];
      if (itype === 'message') {
        this.closeBlock(frames, this.textBlockIdx);
        this.textBlockIdx = null;
      } else if (itype === 'function_call') {
        const oidx = event['output_index'];
        const acc = this.toolAcc.get(oidx);
        if (acc) {
          if (!acc.args && typeof item['arguments'] === 'string' && item['arguments']) {
            acc.args = item['arguments'];
            frames.push(
              sseFrame('content_block_delta', {
                type: 'content_block_delta',
                index: acc.blockIdx,
                delta: { type: 'input_json_delta', partial_json: acc.args },
              }),
            );
          }
          if (!this.validated.has(oidx)) {
            parseToolArgs(acc.args);
            this.validated.add(oidx);
          }
          this.closeBlock(frames, acc.blockIdx);
        }
      }
      return;
    }

    if (etype === 'response.completed') {
      const resp = event['response'] ?? {};
      const usage = resp['usage'] && typeof resp['usage'] === 'object' ? resp['usage'] : null;
      this.finish(frames, this.calledTools ? 'tool_use' : 'end_turn', usage);
      this.terminal = true;
      return;
    }

    if (etype === 'response.incomplete') {
      const resp = event['response'] ?? {};
      const reason = String((resp['incomplete_details'] ?? {})?.['reason'] ?? '');
      if (reason === 'max_output_tokens' || reason === 'content_filter') {
        if (this.calledTools && reason === 'max_output_tokens') {
          let bad = 0;
          for (const acc of this.toolAcc.values()) {
            try {
              parseToolArgs(acc.args);
            } catch {
              bad += 1;
            }
          }
          if (bad > 0) {
            throw new Error(
              `upstream truncated a turn with ${this.toolAcc.size} incomplete tool call(s) (max_output_tokens): ` +
                'raise max_tokens or shorten context',
            );
          }
        }
        const stop = reason === 'max_output_tokens' ? 'max_tokens' : 'content_filter';
        const usage = resp['usage'] && typeof resp['usage'] === 'object' ? resp['usage'] : null;
        this.finish(frames, stop, usage);
        this.terminal = true;
        return;
      }
      throw new Error(`upstream stream incomplete with unknown reason: ${JSON.stringify(reason)}`);
    }

    if (etype === 'response.failed') {
      const resp = event['response'] ?? {};
      const err = resp['error'];
      const msg = (err && typeof err === 'object' ? err['message'] : null) ?? 'upstream response failed';
      throw new Error(String(msg));
    }

    if (etype === 'error') {
      throw new Error(String(event['message'] ?? '') || 'upstream streaming error');
    }
    // Unknown event types are ignored (forward compatible).
  }

  private finish(frames: string[], stop: string, usage: Record<string, any> | null): void {
    try {
      this.onFinalUsage?.(upstreamUsageFromResponses(usage));
    } catch {
      /* observability only: never fail the stream on a usage callback */
    }
    this.startMessage(frames);
    this.closeBlock(frames, this.textBlockIdx);
    this.textBlockIdx = null;
    for (const idx of [...this.openBlocks]) this.closeBlock(frames, idx);

    const u = usage ?? {};
    const details = u['input_tokens_details'];
    const cacheRead = (details && typeof details === 'object' ? details['cached_tokens'] : 0) || extractCacheReadTokens(u);
    const cacheCreate = u['cache_write_tokens'] || extractCacheCreationTokens(u);
    const inTok = Number(u['input_tokens'] ?? 0) || this.estimatedInput;
    const outTok = getOutputTokens(u);
    frames.push(
      sseFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stop },
        usage: withReasoningSplit(
          {
            output_tokens: outTok,
            input_tokens: inTok,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheCreate,
          },
          u,
        ),
      }),
    );
    frames.push(sseFrame('message_stop', { type: 'message_stop' }));
  }
}
