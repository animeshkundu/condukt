/**
 * Anthropic ⇄ OpenAI chat/completions translation (reference-proxy parity).
 *
 * Pure, side-effect-free functions plus a streaming state machine. The
 * bridge owns HTTP concerns; this module owns wire-shape semantics:
 *
 *   - anthropicToOpenAI:     Claude SDK request → chat/completions body
 *   - applyChatExtras:       DeepSeek/GLM thinking+effort extras (in place)
 *   - openAIToAnthropic:     non-streaming response → Anthropic message
 *   - ChatStreamTranslator:  streaming chunks → Anthropic SSE frames
 *   - estimateInputTokens:   pre-stream input estimate for message_start
 */

import { createHash } from 'node:crypto';
import {
  extractCacheCreationTokens,
  extractCacheReadTokens,
  getOutputTokens,
  normalizeToolCallId,
  stableJson,
  upstreamUsageFromOpenAI,
  withReasoningSplit,
  type UpstreamTurnUsage,
} from './bridge-cache';
import {
  chatFamilyOf,
  extractEffort,
  extractThinkingType,
  mapChatEffort,
  mapChatThinking,
  thinkingEnabled,
} from './protocol-router';
import { createLineReader, parseDataLine, sseFrame } from './sse';

// ── Media support (reference parity) ─────────────────────────────────

const IMAGE_FORMATS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const DOCUMENT_FORMATS = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const TEXT_FORMATS = new Set([
  'text/plain',
  'text/csv',
  'text/html',
  'text/markdown',
  'application/json',
  'text/xml',
]);

/** Chat models that only accept string content (media dropped with warning). */
export const NO_MULTIMODAL: ReadonlySet<string> = new Set<string>();

interface MediaBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

function dataUrl(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`;
}

/** Convert an Anthropic image/document block to a chat-compatible block. */
function convertMediaBlock(block: Record<string, unknown>): MediaBlock | null {
  const source = (block['source'] ?? {}) as Record<string, unknown>;
  const mt = String(source['media_type'] ?? '').toLowerCase();
  const sourceType = String(source['type'] ?? '');
  const isUrl = sourceType === 'url';
  const data = typeof source['data'] === 'string' ? source['data'] : '';
  const url = typeof source['url'] === 'string' ? source['url'] : '';

  if (IMAGE_FORMATS.has(mt)) {
    const imageUrl = isUrl ? url : data ? dataUrl(mt, data) : '';
    if (!imageUrl) return null;
    return { type: 'image_url', image_url: { url: imageUrl } };
  }
  if (TEXT_FORMATS.has(mt)) {
    if (!isUrl && data) {
      try {
        return { type: 'text', text: Buffer.from(data, 'base64').toString('utf8') };
      } catch {
        return null;
      }
    }
    if (isUrl && url) return { type: 'text', text: url };
    return null;
  }
  if (DOCUMENT_FORMATS.has(mt)) {
    const filename =
      mt === 'application/pdf'
        ? 'document.pdf'
        : mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          ? 'document.docx'
          : 'document.xlsx';
    const fileData = isUrl ? url : data ? dataUrl(mt, data) : '';
    if (!fileData) return null;
    return { type: 'file', file: { filename, file_data: fileData } };
  }
  return null;
}

function isMediaBlock(block: Record<string, unknown>): boolean {
  const t = block['type'];
  return t === 'image' || t === 'document';
}

function extractToolResultText(content: unknown): string {
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

// ── Request translation ──────────────────────────────────────────────

export interface AnthropicToOpenAIOptions {
  /** Models that only accept string content; media is dropped for them. */
  readonly noMultimodal?: ReadonlySet<string>;
}

/**
 * Convert an Anthropic messages body to an OpenAI chat/completions body.
 * Ported 1:1 from the reference proxy (system media, thinking replay,
 * tool ordering, tool_choice, thinking budget → max_completion_tokens).
 */
export function anthropicToOpenAI(body: Record<string, any>, model: string, opts: AnthropicToOpenAIOptions = {}): Record<string, any> {
  const noMulti = opts.noMultimodal ?? NO_MULTIMODAL;
  const thinking = thinkingEnabled(body);
  const messages: Record<string, unknown>[] = [];

  // System prompt.
  const system = body['system'] ?? '';
  if (typeof system === 'string') {
    if (system) messages.push({ role: 'system', content: system });
  } else if (Array.isArray(system)) {
    const sysBlocks: Record<string, unknown>[] = [];
    for (const block of system) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const btype = b['type'];
      if (btype === 'text') {
        sysBlocks.push({ type: 'text', text: b['text'] ?? '' });
      } else if (isMediaBlock(b)) {
        const converted = convertMediaBlock(b);
        if (converted) sysBlocks.push(converted);
      }
    }
    if (sysBlocks.length > 0) {
      const hasMedia = sysBlocks.some((b) => b['type'] !== 'text');
      if (hasMedia && !noMulti.has(model)) {
        messages.push({ role: 'system', content: sysBlocks });
      } else {
        const texts = sysBlocks.filter((b) => b['type'] === 'text').map((b) => String(b['text'] ?? ''));
        messages.push({ role: 'system', content: texts.join('\n') });
      }
    }
  }

  const rawMessages = Array.isArray(body['messages']) ? body['messages'] : [];
  for (let mi = 0; mi < rawMessages.length; mi += 1) {
    const msg = rawMessages[mi];
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg['role'] ?? 'user');
    const isAssistant = role === 'assistant';
    const content = msg['content'] ?? '';

    if (typeof content === 'string') {
      const out: Record<string, unknown> = { role, content };
      if (thinking && isAssistant) out['reasoning_content'] = ' ';
      messages.push(out);
      continue;
    }
    if (!Array.isArray(content)) continue;

    const textParts: string[] = [];
    const contentBlocks: Record<string, unknown>[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    const thinkingParts: string[] = [];
    const toolResults: Record<string, unknown>[] = [];
    let hasMedia = false;

    for (const block of content) {
      if (typeof block === 'string') {
        textParts.push(block);
        contentBlocks.push({ type: 'text', text: block });
        continue;
      }
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const btype = b['type'];
      if (btype === 'text') {
        const t = String(b['text'] ?? '');
        textParts.push(t);
        contentBlocks.push({ type: 'text', text: t });
      } else if (isMediaBlock(b)) {
        const converted = convertMediaBlock(b);
        if (converted) {
          hasMedia = true;
          contentBlocks.push(converted);
        }
      } else if (btype === 'thinking') {
        thinkingParts.push(String(b['thinking'] ?? ''));
      } else if (btype === 'tool_use') {
        toolCalls.push({
          id: normalizeToolCallId(b['id'], String(b['name'] ?? ''), `${mi}.${toolCalls.length}`, b['input'] ?? {}),
          type: 'function',
          function: {
            name: b['name'] ?? '',
            arguments: stableJson(b['input'] ?? {}),
          },
        });
      } else if (btype === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: b['tool_use_id'] ?? '',
          content: extractToolResultText(b['content']),
        });
      }
    }

    // Tool results must immediately follow the assistant tool_calls they
    // answer — emit them before this message's own content.
    messages.push(...toolResults);

    const joinedThinking = thinkingParts.join('\n');
    const forceString = noMulti.has(model);
    if (toolCalls.length > 0) {
      const out: Record<string, unknown> = { role, content: null, tool_calls: toolCalls };
      if (joinedThinking) out['reasoning_content'] = joinedThinking;
      else if (thinking && isAssistant) out['reasoning_content'] = ' ';
      messages.push(out);
    } else if (hasMedia && !forceString) {
      const out: Record<string, unknown> = { role, content: contentBlocks };
      if (joinedThinking) out['reasoning_content'] = joinedThinking;
      else if (thinking && isAssistant) out['reasoning_content'] = ' ';
      messages.push(out);
    } else if (textParts.length > 0 || thinkingParts.length > 0 || (thinking && isAssistant) || hasMedia) {
      const out: Record<string, unknown> = { role, content: textParts.length > 0 ? textParts.join('\n') : '' };
      if (joinedThinking) out['reasoning_content'] = joinedThinking;
      else if (thinking && isAssistant) out['reasoning_content'] = ' ';
      messages.push(out);
    }
  }

  const oai: Record<string, any> = {
    model,
    messages,
    max_tokens: body['max_tokens'] ?? 16384,
    stream: body['stream'] ?? false,
  };

  const thinkingCfg = body['thinking'];
  // Only reasoning families (deepseek/glm) accept max_completion_tokens;
  // non-reasoning chat models reject the field when max_tokens is also set.
  if (
    thinking &&
    thinkingCfg &&
    typeof thinkingCfg === 'object' &&
    thinkingCfg['budget_tokens'] &&
    chatFamilyOf(model) !== null
  ) {
    oai['max_completion_tokens'] = thinkingCfg['budget_tokens'];
  }

  for (const [key, oaiKey] of [
    ['temperature', 'temperature'],
    ['top_p', 'top_p'],
    ['stop_sequences', 'stop'],
  ] as const) {
    if (key in body) oai[oaiKey] = body[key];
  }

  if (Array.isArray(body['tools'])) {
    oai['tools'] = body['tools']
      .filter((t: any) => t && typeof t === 'object' && typeof t.name === 'string' && t.name)
      .map((t: any) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.input_schema ?? {},
        },
      }));
    const tc = body['tool_choice'] ?? 'auto';
    if (tc && typeof tc === 'object') {
      const tcType = tc['type'] ?? 'auto';
      if (tcType === 'tool') {
        oai['tool_choice'] = { type: 'function', function: { name: tc['name'] ?? '' } };
      } else if (tcType === 'any') {
        oai['tool_choice'] = 'required';
      } else {
        oai['tool_choice'] = 'auto';
      }
    } else {
      oai['tool_choice'] = tc;
    }
  }

  return oai;
}

// ── Chat reasoning extras (DeepSeek / GLM) ───────────────────────────

const MAX_TOKENS_FLOOR: Readonly<Record<string, number>> = {
  low: 16384,
  high: 65536,
  max: 131072,
};

export function maxTokensFloorFor(effort: string | null): number {
  return MAX_TOKENS_FLOOR[effort ?? 'low'] ?? 16384;
}

function sanitizeUserId(session: string): string {
  const s = String(session ?? '');
  if (!s) return 'default';
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);
}

export interface ChatExtrasSent {
  readonly effortSent: string | null;
  readonly thinkingSent: string | null;
}

/**
 * Family-gated chat extras, in place (reference parity).
 *
 * Emits thinking + reasoning_effort + user_id for deepseek-/glm- families
 * only; sets top_p 0.95 default (DeepSeek, client wins); floors max_tokens
 * by sent effort (never lowers); rejects required/named tool_choice with
 * thinking on (upstream 400s). Returns the wire truth for telemetry.
 */
export function applyChatExtras(
  oaiBody: Record<string, any>,
  modelId: string,
  session: string,
  clientEffort: string | null = null,
  clientThinking: string | null = null,
): ChatExtrasSent {
  const fam = chatFamilyOf(modelId);
  if (!fam) return { effortSent: null, thinkingSent: null };

  const wireEffort = mapChatEffort(modelId, clientEffort);
  let wireThinking = mapChatThinking(modelId, clientThinking) as string | null;
  // GLM always-on; DeepSeek defaults enabled when unset.
  if (fam === 'glm') wireThinking = 'enabled';
  else if (fam === 'deepseek' && wireThinking === null && (clientThinking === null || clientThinking === '' || clientThinking === 'none')) {
    wireThinking = 'enabled';
  }
  // Explicit-off shapes: DeepSeek disable drops effort; GLM cannot
  // disable (thinking stays on; a client 'none' effort just omits it).
  let effortSent = wireEffort;
  if (clientEffort === 'none' || clientThinking === 'disabled') {
    if (fam === 'deepseek') {
      wireThinking = 'disabled';
      effortSent = null;
    }
  }

  if (wireThinking !== null) oaiBody['thinking'] = { type: wireThinking };
  if (effortSent !== null) oaiBody['reasoning_effort'] = effortSent;

  try {
    oaiBody['user_id'] = sanitizeUserId(session);
  } catch {
    /* ignore */
  }

  if (fam === 'deepseek' && !('top_p' in oaiBody)) oaiBody['top_p'] = 0.95;

  // max_tokens floors by SENT effort (raise only; never coerce odd shapes).
  try {
    const floor = maxTokensFloorFor(effortSent ?? 'low');
    const cur = oaiBody['max_tokens'];
    if (cur === undefined || cur === null) {
      oaiBody['max_tokens'] = floor;
    } else if (typeof cur === 'number' && Number.isInteger(cur) && cur < floor) {
      oaiBody['max_tokens'] = floor;
    }
  } catch {
    /* ignore */
  }

  // Tool-choice guard: required/named + thinking on → upstream 400.
  try {
    const tc = oaiBody['tool_choice'];
    const thinkingOn = wireThinking === 'enabled';
    if (thinkingOn && tc !== undefined && tc !== null) {
      let bad = false;
      if (tc && typeof tc === 'object') {
        const t = (tc as Record<string, unknown>)['type'];
        if (t === 'required') bad = true;
        if (t === 'function') {
          const fn = (tc as Record<string, unknown>)['function'];
          if (fn && typeof fn === 'object' && typeof (fn as any).name === 'string') bad = true;
        }
      } else if (tc === 'required') {
        bad = true;
      }
      if (bad) {
        throw new Error(
          `model ${modelId} rejects required/named tool_choice with thinking on (upstream 400); ` +
            'use auto/none or disable thinking',
        );
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('rejects required/named')) throw e;
    // Shape errors are ignored (defensive total function).
  }

  return { effortSent, thinkingSent: wireThinking };
}

// ── Response translation (non-streaming) ─────────────────────────────

const FINISH_TO_STOP: Readonly<Record<string, string>> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'content_filter',
};

export function mapFinishReason(finish: unknown): string {
  return FINISH_TO_STOP[String(finish ?? '')] ?? 'end_turn';
}

function oaiUsageToAnthropic(usage: unknown): Record<string, unknown> {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>;
  const input = Number(u['prompt_tokens'] ?? u['input_tokens'] ?? 0) || 0;
  const output = getOutputTokens(u);
  return withReasoningSplit(
    {
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: extractCacheCreationTokens(u),
      cache_read_input_tokens: extractCacheReadTokens(u),
    },
    u,
  );
}

/**
 * Convert a non-streaming chat/completions response to an Anthropic
 * message. Loud on malformed tool-call arguments.
 */
export function openAIToAnthropic(resp: Record<string, any>, requested: string, messageId?: string): Record<string, any> {
  if (!resp || typeof resp !== 'object') {
    throw new Error('upstream returned a malformed response envelope');
  }
  const choices = resp['choices'];
  const choice =
    Array.isArray(choices) && choices.length > 0 && choices[0] && typeof choices[0] === 'object' ? choices[0] : {};
  const msg = choice['message'] && typeof choice['message'] === 'object' ? choice['message'] : {};
  const usage = resp['usage'] && typeof resp['usage'] === 'object' ? resp['usage'] : {};

  const blocks: Record<string, unknown>[] = [];
  const reasoning = msg['reasoning_content'];
  if (typeof reasoning === 'string' && reasoning) {
    blocks.push({ type: 'thinking', thinking: reasoning });
  }
  const content = msg['content'];
  if (content) {
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((p: any) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).join('')
          : '';
    if (text) blocks.push({ type: 'text', text });
  }
  const toolCalls = Array.isArray(msg['tool_calls']) ? msg['tool_calls'] : [];
  for (let ti = 0; ti < toolCalls.length; ti += 1) {
    const tc = toolCalls[ti];
    if (!tc || typeof tc !== 'object') {
      throw new Error('upstream returned invalid function-call arguments');
    }
    const fn = tc['function'] && typeof tc['function'] === 'object' ? tc['function'] : {};
    let input: Record<string, unknown>;
    try {
      input = parseToolArgs(String(fn['arguments'] ?? '{}'));
    } catch {
      throw new Error('upstream returned invalid function-call arguments');
    }
    blocks.push({
      type: 'tool_use',
      id: normalizeToolCallId(tc['id'], String(fn['name'] ?? ''), ti, input),
      name: fn['name'] ?? '',
      input,
    });
  }

  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });

  let stop = mapFinishReason(choice['finish_reason']);
  if (toolCalls.length > 0) stop = 'tool_use';

  return {
    id: messageId ?? `msg_${Math.random().toString(16).slice(2, 26)}`,
    type: 'message',
    role: 'assistant',
    content: blocks,
    model: requested,
    stop_reason: stop,
    stop_sequence: null,
    usage: oaiUsageToAnthropic(usage),
  };
}

export function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  const obj = JSON.parse(raw);
  if (Array.isArray(obj)) {
    // Some servers stream bare arrays for a single positional argument;
    // fail loudly rather than silently reshaping (reference parity).
    throw new Error('upstream function-call arguments are not a JSON object');
  }
  if (!obj || typeof obj !== 'object') {
    throw new Error('upstream function-call arguments are not a JSON object');
  }
  return obj as Record<string, unknown>;
}

function countInvalidToolArgs(toolBlocks: Iterable<{ args: string }>): number {
  let bad = 0;
  for (const b of toolBlocks) {
    try {
      parseToolArgs(b.args);
    } catch {
      bad += 1;
    }
  }
  return bad;
}

// ── Streaming translator ─────────────────────────────────────────────

interface ToolBlockState {
  readonly blockIdx: number;
  id: string;
  name: string;
  args: string;
}

export interface ChatStreamOptions {
  /** Client-facing model id echoed in message_start. */
  readonly requestedModel: string;
  /** Estimated input tokens for message_start (reference: stream_in_est). */
  readonly estimatedInput?: number;
  /** Fixed message id (tests); otherwise generated. */
  readonly messageId?: string;
  /**
   * Called once on clean stream close with the final upstream usage
   * (null when the upstream gave none). Observability only: never lets
   * an exception reach the translator.
   */
  readonly onFinalUsage?: (usage: UpstreamTurnUsage | null) => void;
}

export class ChatStreamTranslator {
  private readonly requestedModel: string;
  private readonly estimatedInput: number;
  private readonly messageId: string;
  private readonly reader = createLineReader();
  private started = false;
  private textBlockIdx: number | null = null;
  private reasoningBlockIdx: number | null = null;
  private nextBlockIdx = 0;
  private readonly openBlocks = new Set<number>();
  private readonly toolBlocks = new Map<number, ToolBlockState>();
  private finishReason: string | null = null;
  private usage: Record<string, unknown> | null = null;
  private stopped = false;
  private readonly onFinalUsage?: (usage: UpstreamTurnUsage | null) => void;

  constructor(opts: ChatStreamOptions) {
    this.requestedModel = opts.requestedModel;
    this.estimatedInput = opts.estimatedInput ?? 0;
    this.messageId = opts.messageId ?? `msg_${Math.random().toString(16).slice(2, 26)}`;
    this.onFinalUsage = opts.onFinalUsage;
  }

  get messageStarted(): boolean {
    return this.started;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Feed decoded upstream bytes; returns Anthropic SSE frames to forward. */
  push(text: string): string[] {
    if (this.stopped) return [];
    return this.consume(this.reader.push(text));
  }

  /**
   * Parse complete SSE lines into Anthropic frames. `finish()` also
   * drains the reader's unterminated trailing line, so a usage-only
   * event at EOF (no final newline) still reaches `onFinalUsage`.
   */
  private consume(lines: readonly string[]): string[] {
    const frames: string[] = [];
    for (const line of lines) {
      const data = parseDataLine(line);
      if (!data) continue;
      let chunk: Record<string, any>;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      frames.push(...this.handleChunk(chunk));
    }
    return frames;
  }

  /** Upstream ended ([DONE] or EOF): emit closing frames. */
  finish(): string[] {
    if (this.stopped) return [];
    const frames = this.consume(this.reader.flush());
    this.stopped = true;
    if (!this.started) {
      frames.push(...this.startMessage());
    }
    for (const idx of [...this.openBlocks]) {
      frames.push(sseFrame('content_block_stop', { type: 'content_block_stop', index: idx }));
    }
    this.openBlocks.clear();

    const hasTools = this.toolBlocks.size > 0;
    let stop = mapFinishReason(this.finishReason);
    if (hasTools) {
      if (this.finishReason === 'length' && countInvalidToolArgs(this.toolBlocks.values()) > 0) {
        const bad = countInvalidToolArgs(this.toolBlocks.values());
        const msg =
          `upstream cut off ${bad} tool call(s) mid-arguments (length): ` +
          'raise max_tokens or shorten context';
        frames.push(sseFrame('error', { type: 'error', error: { type: 'api_error', message: msg } }));
        return frames; // reference: error close breaks the stream (no delta/stop)
      }
      stop = 'tool_use';
    }
    frames.push(...this.terminalFrames(stop));
    return frames;
  }

  /** Transport/upstream failure: emit the reference error close. */
  fail(message: string): string[] {
    if (this.stopped) return [];
    this.stopped = true;
    const frames: string[] = [];
    const payload = { type: 'error', error: { type: 'api_error', message } };
    if (!this.started) {
      frames.push(sseFrame('error', payload));
      return frames;
    }
    for (const idx of [...this.openBlocks]) {
      frames.push(sseFrame('content_block_stop', { type: 'content_block_stop', index: idx }));
    }
    this.openBlocks.clear();
    frames.push(
      sseFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'error' },
        usage: { output_tokens: this.finalOutputTokens() },
      }),
    );
    frames.push(sseFrame('message_stop', { type: 'message_stop' }));
    return frames;
  }

  // ── internals ──────────────────────────────────────────────────────

  private handleChunk(chunk: Record<string, any>): string[] {
    const frames: string[] = [];
    const u = chunk['usage'];
    if (u && typeof u === 'object') {
      this.usage = { ...(this.usage ?? {}), ...(u as Record<string, unknown>) };
    }
    const choices = chunk['choices'];
    if (!Array.isArray(choices) || choices.length === 0) return frames;
    const choice = choices[0] && typeof choices[0] === 'object' ? choices[0] : {};
    if (choice['finish_reason']) this.finishReason = String(choice['finish_reason']);
    const delta = choice['delta'] && typeof choice['delta'] === 'object' ? choice['delta'] : {};

    if (!this.started) {
      frames.push(...this.startMessage());
    }

    // Text.
    let text = '';
    const c = delta['content'];
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      text = c
        .map((p: any) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
        .join('');
    }
    if (text) {
      if (this.textBlockIdx === null) {
        this.textBlockIdx = this.nextBlockIdx++;
        this.openBlocks.add(this.textBlockIdx);
        frames.push(
          sseFrame('content_block_start', {
            type: 'content_block_start',
            index: this.textBlockIdx,
            content_block: { type: 'text', text: '' },
          }),
        );
      }
      frames.push(
        sseFrame('content_block_delta', {
          type: 'content_block_delta',
          index: this.textBlockIdx,
          delta: { type: 'text_delta', text },
        }),
      );
    }

    // Reasoning.
    const reasoning = delta['reasoning_content'];
    if (typeof reasoning === 'string' && reasoning) {
      if (this.reasoningBlockIdx === null) {
        this.reasoningBlockIdx = this.nextBlockIdx++;
        this.openBlocks.add(this.reasoningBlockIdx);
        frames.push(
          sseFrame('content_block_start', {
            type: 'content_block_start',
            index: this.reasoningBlockIdx,
            content_block: { type: 'thinking', thinking: '' },
          }),
        );
      }
      frames.push(
        sseFrame('content_block_delta', {
          type: 'content_block_delta',
          index: this.reasoningBlockIdx,
          delta: { type: 'thinking_delta', thinking: reasoning },
        }),
      );
    }

    // Tool calls.
    const toolCalls = delta['tool_calls'];
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const apiIdx = typeof tc['index'] === 'number' ? tc['index'] : 0;
        const fn = tc['function'] && typeof tc['function'] === 'object' ? tc['function'] : {};
        let state = this.toolBlocks.get(apiIdx);
        if (!state) {
          const blockIdx = this.nextBlockIdx++;
          const providedId = typeof tc['id'] === 'string' && tc['id'] ? tc['id'] : undefined;
          const name = typeof fn['name'] === 'string' ? fn['name'] : '';
          const id = providedId ?? `toolu_${normalizeToolCallId(undefined, name || 'tool', apiIdx, '').slice(7)}`;
          state = { blockIdx, id, name, args: '' };
          this.toolBlocks.set(apiIdx, state);
          this.openBlocks.add(blockIdx);
          frames.push(
            sseFrame('content_block_start', {
              type: 'content_block_start',
              index: blockIdx,
              content_block: { type: 'tool_use', id, name, input: {} },
            }),
          );
        }
        if (typeof fn['name'] === 'string' && fn['name'] && !state.name) state.name = fn['name'];
        if (typeof fn['arguments'] === 'string' && fn['arguments']) {
          state.args += fn['arguments'];
          frames.push(
            sseFrame('content_block_delta', {
              type: 'content_block_delta',
              index: state.blockIdx,
              delta: { type: 'input_json_delta', partial_json: fn['arguments'] },
            }),
          );
        }
      }
    }

    return frames;
  }

  private startMessage(): string[] {
    this.started = true;
    return [
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
    ];
  }

  private finalOutputTokens(): number {
    if (this.usage) {
      const n = this.usage['completion_tokens'] ?? this.usage['output_tokens'];
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    }
    return 0;
  }

  private terminalFrames(stop: string): string[] {
    try {
      this.onFinalUsage?.(upstreamUsageFromOpenAI(this.usage));
    } catch {
      /* observability only: never fail the stream on a usage callback */
    }
    const u = this.usage ?? {};
    const finalIn = Number(u['prompt_tokens'] ?? u['input_tokens'] ?? this.estimatedInput) || this.estimatedInput;
    const finalOut = this.finalOutputTokens();
    const cache = extractCacheReadTokens(u) + extractCacheCreationTokens(u);
    const usage = withReasoningSplit(
      { output_tokens: finalOut, input_tokens: finalIn, cache_read_input_tokens: cache },
      u,
    );
    return [
      sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage }),
      sseFrame('message_stop', { type: 'message_stop' }),
    ];
  }
}

// ── Input estimation ─────────────────────────────────────────────────

/** Rough pre-stream input estimate (reference `_estimate_input_tokens`). */
export function estimateInputTokens(body: Record<string, any>): number {
  const chunks: string[] = [];
  const system = body?.['system'] ?? '';
  if (typeof system === 'string') chunks.push(system);
  else if (Array.isArray(system)) {
    for (const s of system) {
      if (typeof s === 'string') chunks.push(s);
      else if (s && typeof s === 'object') {
        const src = (s['source'] ?? {}) as Record<string, unknown>;
        chunks.push(String(src['data'] ?? src['url'] ?? s['text'] ?? ''));
      }
    }
  }
  for (const t of Array.isArray(body?.['tools']) ? body['tools'] : []) {
    if (!t || typeof t !== 'object') continue;
    chunks.push(String(t['name'] ?? ''), String(t['description'] ?? ''), stableJson(t['input_schema'] ?? {}));
  }
  for (const msg of Array.isArray(body?.['messages']) ? body['messages'] : []) {
    const content = msg?.['content'] ?? '';
    if (typeof content === 'string') chunks.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'string') chunks.push(block);
        else if (block && typeof block === 'object') {
          const btype = block['type'];
          if (btype === 'tool_result') chunks.push(extractToolResultText(block['content']));
          else if (btype === 'thinking') chunks.push(String(block['thinking'] ?? ''));
          else if (btype === 'image' || btype === 'document') {
            const src = (block['source'] ?? {}) as Record<string, unknown>;
            chunks.push(String(src['data'] ?? src['url'] ?? ''));
          } else {
            chunks.push(String(block['text'] ?? ''));
            chunks.push(stableJson(block['input'] ?? ''));
          }
        }
      }
    }
  }
  const combined = chunks.join('\n');
  return Math.max(1, Math.floor(combined.length / 3));
}

export { extractEffort, extractThinkingType };
