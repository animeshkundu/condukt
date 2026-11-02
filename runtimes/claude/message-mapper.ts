/**
 * Pure mapping from Claude Agent SDK messages to condukt AgentSession events.
 *
 * The SDK and condukt describe the same stream differently:
 *
 * - Assistant frames carry `parent_tool_use_id`, so subagent tool calls and
 *   text can be nested in the UI exactly like the Copilot runtime.
 * - `assistant.message.usage` is a non-final, per-block snapshot. It is used
 *   only to estimate the current context size; token accounting comes from
 *   `result.modelUsage` (see `usage-ledger.ts`).
 * - `result.subtype === 'success'` is not proof of success: `is_error` can be
 *   set on a transient API failure. The mapper reports a `ResultOutcome` and
 *   leaves idle/error/recovery to the session.
 * - There is no `task_completed` system subtype; `task_notification` ends a
 *   subagent task.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ToolUsageData } from '../../src/types';
import { ModelUsageLedger } from './usage-ledger';

export interface ClaudeSessionEmitter {
  text(text: string, parentToolCallId?: string): void;
  reasoning(text: string): void;
  toolStart(
    tool: string,
    input: string,
    args: Record<string, unknown>,
    callId?: string,
    parentToolCallId?: string,
  ): void;
  toolComplete(tool: string, output: string, callId?: string, parentToolCallId?: string): void;
  /** Rich (non-text) tool result blocks, rendered by the UI. */
  toolCompleteRich(
    tool: string,
    contents: ReadonlyArray<Record<string, unknown>>,
    callId?: string,
  ): void;
  toolOutput(tool: string, output: string, parentToolCallId?: string): void;
  idle(): void;
  error(err: Error): void;
  usage(data: Record<string, unknown>): void;
  compaction(phase: 'start' | 'complete', summary?: string): void;
  subagentStart(name: string, data: Record<string, unknown>): void;
  subagentEnd(name: string, data: Record<string, unknown>): void;
  permission(data: Record<string, unknown>): void;
  toolUsage(data: ToolUsageData): void;
}

/** Session configuration read back from the `init` system message. */
export interface ClaudeInitInfo {
  readonly permissionMode: string;
  readonly tools: readonly string[];
  readonly agents: readonly string[];
  readonly model: string;
  readonly cwd: string;
}

/** SDK-native retry notification (`system` / `api_retry`). */
export interface ClaudeApiRetryInfo {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly status: number | null;
  readonly error: string;
  readonly noResponse: boolean;
}

/** Metadata attached to a completed compaction boundary. */
export interface ClaudeCompactionInfo {
  readonly trigger: 'manual' | 'auto';
  readonly preTokens: number;
  readonly postTokens?: number;
  readonly durationMs?: number;
}

/**
 * What a `result` message reported. The session decides whether this is a
 * clean finish, a recoverable failure, or a terminal one.
 */
export interface ClaudeResultOutcome {
  readonly subtype: string;
  /** `is_error` on a `success` result means a transient API failure. */
  readonly isError: boolean;
  readonly apiErrorStatus?: number | null;
  readonly errors: readonly string[];
  readonly terminalReason?: string;
  readonly startupFailureReason?: string;
  readonly resumeReason?: string;
  readonly stopReason: string | null;
  readonly numTurns: number;
  readonly durationMs: number;
}

/** Caller-supplied classification hints collected while streaming. */
export interface MapOptions {
  readonly includePartialMessages: boolean;
  /**
   * Session-lifetime usage ledger. When omitted, the mapper keeps one on the
   * per-turn `MapState` (handy for unit tests, wrong across turns).
   */
  readonly ledger?: ModelUsageLedger;
  /** Whether this turn continues an existing session (`resume` was passed). */
  readonly resumed?: boolean;
  /** Model from SessionConfig, for main-loop usage attribution. */
  readonly fallbackModel?: string;
  /** `system` / `init`: the actual permission mode and tool set. */
  readonly onInit?: (info: ClaudeInitInfo) => void;
  /** Terminal result; when absent the mapper falls back to idle/error. */
  readonly onResult?: (outcome: ClaudeResultOutcome) => void;
  /** `assistant.error` on a frame (classification hint). */
  readonly onAssistantError?: (error: string) => void;
  /** `system` / `api_retry`: the SDK is already retrying natively. */
  readonly onApiRetry?: (info: ClaudeApiRetryInfo) => void;
  /** A compaction completed (boundary or status success), once per event. */
  readonly onCompaction?: (info?: ClaudeCompactionInfo) => void;
  /** A compaction failed; no completion event follows. */
  readonly onCompactionFailed?: (error?: string) => void;
  /** Latest assistant frame's prompt size (input + cache reads/writes). */
  readonly onAssistantUsage?: (contextTokens: number, outputTokens: number) => void;
  /** Abort state, so crash-shaped frames do not look like fresh failures. */
  readonly isAborted?: () => boolean;
}

export interface MapState {
  /** True once a streamed delta was seen; complete frames are then echoes. */
  sawPartial: boolean;
  /** Maps tool call id -> tool name for attributing tool_complete events. */
  toolNames: Map<string, string>;
  /** In-flight tool blocks during streaming, keyed by parent + block index. */
  toolBlocks: Map<string, { name: string; id?: string; buffer: string; parentToolCallId?: string }>;
  /** Maps task id -> display name for subagent_start / subagent_end pairing. */
  subagentNames: Map<string, string>;
  /** Model of the latest assistant frame (main-loop usage attribution). */
  lastModel?: string;
  /** Prompt size of the latest assistant frame, in tokens. */
  lastCallContextTokens: number;
  /** A compaction is running; suppresses duplicate `start` markers. */
  compactionInFlight: boolean;
  /** The current compaction already reported completion (status vs boundary). */
  compactionCompleted: boolean;
  /** Per-turn ledger fallback when MapOptions.ledger is not supplied. */
  ledger?: ModelUsageLedger;
}

export function createMapState(): MapState {
  return {
    sawPartial: false,
    toolNames: new Map(),
    toolBlocks: new Map(),
    subagentNames: new Map(),
    lastCallContextTokens: 0,
    compactionInFlight: false,
    compactionCompleted: false,
  };
}

export function mapSdkMessage(
  msg: SDKMessage,
  emitter: ClaudeSessionEmitter,
  state: MapState,
  options: MapOptions,
): boolean {
  switch (msg.type) {
    case 'assistant':
      mapAssistant(msg as unknown as Record<string, unknown>, emitter, state, options);
      return false;
    case 'stream_event':
      mapStreamEvent(msg as unknown as Record<string, unknown>, emitter, state, options);
      return false;
    case 'user':
      mapUserMessage(msg as unknown as Record<string, unknown>, emitter, state);
      return false;
    case 'result':
      mapResult(msg as unknown as Record<string, unknown>, emitter, state, options);
      return true;
    case 'system':
      mapSystemMessage(msg as unknown as Record<string, unknown>, emitter, state, options);
      return false;
    case 'tool_progress':
      // The SDK publishes elapsed time, never partial output. Emitting an
      // empty tool_output here (the previous behaviour) only spammed the UI.
      return false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Assistant frames and streaming deltas
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parentOf(frame: Record<string, unknown>): string | undefined {
  return optionalString(frame.parent_tool_use_id);
}

function mapAssistant(
  frame: Record<string, unknown>,
  emitter: ClaudeSessionEmitter,
  state: MapState,
  options: MapOptions,
): void {
  const message = asRecord(frame.message);
  const parent = parentOf(frame);
  const model = optionalString(message?.model);
  // Only main-loop frames name the model that `result.usage` bills. A
  // subagent frame carries its own model, and using it would attribute the
  // main-loop usage of a resumed first result to the wrong model.
  if (model !== undefined && parent === undefined) state.lastModel = model;

  const error = optionalString(frame.error);
  if (error !== undefined) options.onAssistantError?.(error);

  const usage = asRecord(message?.usage);
  if (usage !== undefined) {
    const contextTokens =
      nonNegative(usage.input_tokens)
      + nonNegative(usage.cache_read_input_tokens)
      + nonNegative(usage.cache_creation_input_tokens);
    if (contextTokens > 0) {
      state.lastCallContextTokens = contextTokens;
      options.onAssistantUsage?.(contextTokens, nonNegative(usage.output_tokens));
    }
  }

  if (state.sawPartial) return;
  for (const block of asArray(message?.content)) {
    const b = asRecord(block);
    if (b === undefined) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      emitter.text(b.text, parent);
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      emitter.reasoning(b.thinking);
    } else if (b.type === 'tool_use') {
      const name = optionalString(b.name) ?? 'tool';
      const callId = optionalString(b.id);
      if (callId !== undefined) state.toolNames.set(callId, name);
      emitter.toolStart(name, safeStringify(b.input), recordOf(b.input), callId, parent);
    }
  }
}

function mapStreamEvent(
  frame: Record<string, unknown>,
  emitter: ClaudeSessionEmitter,
  state: MapState,
  _options: MapOptions,
): void {
  const event = asRecord(frame.event);
  if (event === undefined) return;
  const parent = parentOf(frame);
  const blockKey = `${parent ?? ''}#${typeof event.index === 'number' ? event.index : 0}`;

  if (event.type === 'message_start') {
    const message = asRecord(event.message);
    const model = optionalString(message?.model);
    if (model !== undefined && parent === undefined) state.lastModel = model;
    return;
  }

  if (event.type === 'content_block_start') {
    state.sawPartial = true;
    const block = asRecord(event.content_block);
    if (block?.type === 'tool_use') {
      const name = optionalString(block.name) ?? 'tool';
      const callId = optionalString(block.id);
      if (callId !== undefined) state.toolNames.set(callId, name);
      state.toolBlocks.set(blockKey, { name, id: callId, buffer: '', parentToolCallId: parent });
    }
    return;
  }

  if (event.type === 'content_block_delta') {
    state.sawPartial = true;
    const delta = asRecord(event.delta);
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      emitter.text(delta.text, parent);
    } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      emitter.reasoning(delta.thinking);
    } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const block = state.toolBlocks.get(blockKey);
      if (block !== undefined) block.buffer += delta.partial_json;
    }
    return;
  }

  if (event.type === 'content_block_stop') {
    const block = state.toolBlocks.get(blockKey);
    if (block === undefined) return;
    state.toolBlocks.delete(blockKey);
    let args: Record<string, unknown> = {};
    if (block.buffer.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(block.buffer);
        args = recordOf(parsed);
      } catch {
        args = { _raw: block.buffer };
      }
    }
    emitter.toolStart(block.name, block.buffer, args, block.id, block.parentToolCallId);
  }
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

const RICH_BLOCK_TYPES: ReadonlySet<string> = new Set(['image', 'document']);

function mapUserMessage(
  frame: Record<string, unknown>,
  emitter: ClaudeSessionEmitter,
  state: MapState,
): void {
  const message = asRecord(frame.message);
  const parent = parentOf(frame);
  for (const block of asArray(message?.content)) {
    const b = asRecord(block);
    if (b === undefined) continue;
    if (b.type !== 'tool_result') continue;
    const callId = optionalString(b.tool_use_id);
    const name = callId !== undefined ? state.toolNames.get(callId) : undefined;
    if (callId !== undefined) state.toolNames.delete(callId);
    const output = extractToolResultContent(b.content);
    emitter.toolComplete(name ?? '', output, callId, parent);
    const rich = richToolResultContents(b.content);
    if (rich.length > 0) emitter.toolCompleteRich(name ?? '', rich, callId);
  }
}

function extractToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        const block = asRecord(entry);
        if (block === undefined) {
          try {
            return JSON.stringify(entry);
          } catch {
            return String(entry);
          }
        }
        if (typeof block.text === 'string') return block.text;
        if (block.type === 'image' || block.type === 'document') {
          const label = typeof block.type === 'string' ? block.type : 'content';
          return `[${label}]`;
        }
        if (typeof block.content === 'string') return block.content;
        try {
          return JSON.stringify(block);
        } catch {
          return String(block);
        }
      })
      .filter((text) => text.length > 0)
      .join('\n');
  }
  if (content !== null && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return '';
}

/**
 * Converts non-text Anthropic tool-result blocks into condukt `ContentBlock`
 * shapes so the UI can render them. Only blocks the UI understands are
 * returned; anything else stays in the textual summary.
 */
function richToolResultContents(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  const rich: Array<Record<string, unknown>> = [];
  for (const entry of content) {
    const block = asRecord(entry);
    if (block === undefined || typeof block.type !== 'string') continue;
    if (!RICH_BLOCK_TYPES.has(block.type)) continue;
    const source = asRecord(block.source);
    if (block.type === 'image' && source?.type === 'base64' && typeof source.data === 'string') {
      rich.push({
        type: 'image',
        data: source.data,
        mimeType: optionalString(source.media_type) ?? optionalString(block.mimeType) ?? 'image/png',
      });
      continue;
    }
    const uri = optionalString(source?.url) ?? optionalString(block.uri);
    rich.push({
      type: 'resource',
      ...(uri !== undefined ? { uri } : {}),
      name: optionalString(block.title) ?? optionalString(block.name) ?? String(block.type),
      ...(optionalString(source?.media_type) !== undefined
        ? { mimeType: optionalString(source?.media_type) }
        : {}),
    });
  }
  return rich;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function mapResult(
  frame: Record<string, unknown>,
  emitter: ClaudeSessionEmitter,
  state: MapState,
  options: MapOptions,
): void {
  const ledger = options.ledger
    ?? (state.ledger ??= new ModelUsageLedger({ fallbackModel: options.fallbackModel }));
  const modelUsage = asRecord(frame.modelUsage) as
    | Readonly<Record<string, Partial<import('@anthropic-ai/claude-agent-sdk').ModelUsage>>>
    | undefined;
  for (const record of ledger.observe({
    uuid: optionalString(frame.uuid) ?? '',
    durationMs: typeof frame.duration_ms === 'number' ? frame.duration_ms : undefined,
    modelUsage,
    mainLoopUsage: asRecord(frame.usage),
    mainLoopModel: state.lastModel,
  }, { resumed: options.resumed === true })) {
    emitter.usage(record);
  }

  const subtype = optionalString(frame.subtype) ?? 'error_during_execution';
  const errors = asArray(frame.errors)
    .filter((entry): entry is string => typeof entry === 'string');
  const outcome: ClaudeResultOutcome = {
    subtype,
    isError: frame.is_error === true,
    apiErrorStatus: typeof frame.api_error_status === 'number' ? frame.api_error_status : undefined,
    errors,
    terminalReason: optionalString(frame.terminal_reason),
    startupFailureReason: optionalString(frame.startup_failure_reason),
    resumeReason: optionalString(frame.resume_reason),
    stopReason: optionalString(frame.stop_reason) ?? null,
    numTurns: typeof frame.num_turns === 'number' ? frame.num_turns : 0,
    durationMs: typeof frame.duration_ms === 'number' ? frame.duration_ms : 0,
  };

  state.sawPartial = false;
  state.toolBlocks.clear();
  state.compactionInFlight = false;
  state.compactionCompleted = false;

  if (options.onResult !== undefined) {
    options.onResult(outcome);
    return;
  }
  // Standalone use (tests, non-recovering callers): no recovery decisions are
  // possible, so keep the old terminal behaviour.
  if (subtype === 'success' && !outcome.isError) {
    emitter.idle();
    return;
  }
  const message = errors[0]
    ?? (outcome.apiErrorStatus !== undefined
      ? `Claude API error (status ${outcome.apiErrorStatus})`
      : `Claude session failed (${subtype})`);
  emitter.error(new Error(message));
}

// ---------------------------------------------------------------------------
// System messages
// ---------------------------------------------------------------------------

function mapSystemMessage(
  frame: Record<string, unknown>,
  emitter: ClaudeSessionEmitter,
  state: MapState,
  options: MapOptions,
): void {
  switch (frame.subtype) {
    case 'init': {
      options.onInit?.({
        permissionMode: optionalString(frame.permissionMode) ?? 'unknown',
        tools: asArray(frame.tools).filter((t): t is string => typeof t === 'string'),
        agents: asArray(frame.agents).filter((a): a is string => typeof a === 'string'),
        model: optionalString(frame.model) ?? '',
        cwd: optionalString(frame.cwd) ?? '',
      });
      return;
    }
    case 'status':
      mapStatusMessage(frame, emitter, state, options);
      return;
    case 'compact_boundary': {
      const metadata = asRecord(frame.compact_metadata);
      const info: ClaudeCompactionInfo | undefined = metadata === undefined
        ? undefined
        : {
          trigger: metadata.trigger === 'manual' ? 'manual' : 'auto',
          preTokens: nonNegative(metadata.pre_tokens),
          ...(typeof metadata.post_tokens === 'number'
            ? { postTokens: nonNegative(metadata.post_tokens) }
            : {}),
          ...(typeof metadata.duration_ms === 'number'
            ? { durationMs: nonNegative(metadata.duration_ms) }
            : {}),
        };
      completeCompaction(emitter, state, options, info);
      return;
    }
    case 'api_retry': {
      const noResponse = asRecord(frame.no_response);
      options.onApiRetry?.({
        attempt: nonNegative(frame.attempt),
        maxRetries: nonNegative(frame.max_retries),
        delayMs: nonNegative(frame.retry_delay_ms),
        status: typeof frame.error_status === 'number' ? frame.error_status : null,
        error: optionalString(frame.error) ?? 'unknown',
        noResponse: noResponse !== undefined,
      });
      return;
    }
    case 'task_started': {
      const taskId = optionalString(frame.task_id);
      const name = optionalString(frame.subagent_type)
        ?? optionalString(frame.description)
        ?? taskId
        ?? 'subagent';
      if (taskId !== undefined) state.subagentNames.set(taskId, name);
      emitter.subagentStart(name, {
        ...(taskId !== undefined ? { taskId } : {}),
        toolCallId: optionalString(frame.tool_use_id) ?? taskId,
        ...(optionalString(frame.subagent_type) !== undefined
          ? { subagentType: optionalString(frame.subagent_type) }
          : {}),
        ...(typeof frame.spawn_depth === 'number' ? { spawnDepth: frame.spawn_depth } : {}),
        ...(optionalString(frame.description) !== undefined
          ? { description: optionalString(frame.description) }
          : {}),
        ...(typeof frame.is_backgrounded === 'boolean'
          ? { isBackgrounded: frame.is_backgrounded }
          : {}),
        ...(optionalString(frame.task_type) !== undefined
          ? { taskType: optionalString(frame.task_type) }
          : {}),
      });
      return;
    }
    case 'task_notification': {
      const taskId = optionalString(frame.task_id);
      const name = (taskId !== undefined ? state.subagentNames.get(taskId) : undefined)
        ?? optionalString(frame.subagent_type)
        ?? taskId
        ?? 'subagent';
      if (taskId !== undefined) state.subagentNames.delete(taskId);
      const usage = asRecord(frame.usage);
      emitter.subagentEnd(name, {
        ...(taskId !== undefined ? { taskId } : {}),
        toolCallId: optionalString(frame.tool_use_id) ?? taskId,
        status: optionalString(frame.status) ?? 'completed',
        ...(usage !== undefined && typeof usage.total_tokens === 'number'
          ? { totalTokens: nonNegative(usage.total_tokens) }
          : {}),
        ...(usage !== undefined && typeof usage.duration_ms === 'number'
          ? { duration: nonNegative(usage.duration_ms) }
          : {}),
        ...(optionalString(frame.summary) !== undefined
          ? { summary: optionalString(frame.summary) }
          : {}),
      });
      return;
    }
    case 'permission_denied': {
      const reasonType = optionalString(frame.decision_reason_type);
      const reason = optionalString(frame.decision_reason);
      emitter.permission({
        kind: reasonType ?? 'permission_denied',
        detail: reason ?? optionalString(frame.message) ?? optionalString(frame.tool_name),
        approved: false,
        tool: optionalString(frame.tool_name),
        toolCallId: optionalString(frame.tool_use_id),
        ...(optionalString(frame.agent_id) !== undefined
          ? { agentId: optionalString(frame.agent_id) }
          : {}),
        ...(reasonType !== undefined ? { reasonType } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(optionalString(frame.message) !== undefined
          ? { message: optionalString(frame.message) }
          : {}),
      });
      return;
    }
    default:
      return;
  }
}

function mapStatusMessage(
  frame: Record<string, unknown>,
  emitter: ClaudeSessionEmitter,
  state: MapState,
  options: MapOptions,
): void {
  const compactResult = optionalString(frame.compact_result);
  if (compactResult === 'failed') {
    state.compactionInFlight = false;
    // A failure is not a completion: no marker, no count increment. If a
    // boundary still follows, it counts as a real completion.
    state.compactionCompleted = false;
    options.onCompactionFailed?.(optionalString(frame.compact_error));
    return;
  }
  if (compactResult === 'success') {
    completeCompaction(emitter, state, options);
    return;
  }
  if (frame.status === 'compacting' && !state.compactionInFlight && !state.compactionCompleted) {
    state.compactionInFlight = true;
    emitter.compaction('start');
  }
}

function completeCompaction(
  emitter: ClaudeSessionEmitter,
  state: MapState,
  options: MapOptions,
  info?: ClaudeCompactionInfo,
): void {
  if (state.compactionCompleted) {
    // A status success and a boundary describe the same compaction. Counting
    // it twice would overstate `compactions.count`, so the first completion
    // wins even when the second carries richer metadata.
    return;
  }
  state.compactionCompleted = true;
  state.compactionInFlight = false;
  emitter.compaction('complete');
  options.onCompaction?.(info);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function recordOf(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function safeStringify(value: unknown): string {
  if (value === undefined) return '';
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type { ToolUsageData } from '../../src/types';
