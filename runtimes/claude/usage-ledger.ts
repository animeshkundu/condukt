/**
 * Token accounting for the Claude Agent SDK.
 *
 * The SDK exposes three usage surfaces, and only one is authoritative:
 *
 * - `assistant.message.usage` — the API's non-final, per-block snapshot. It
 *   must never be summed (doing so double-counts every streamed turn) and it
 *   carries no subagent attribution.
 * - `result.usage` — the main agent loop only, excluding subagents, sidechains,
 *   compaction and Workflow calls.
 * - `result.modelUsage` — per-model totals for every call made through the
 *   query pipeline, subagents included. These totals are **cumulative**: each
 *   result carries the running total for the session so far, and a resumed or
 *   forked session continues from the totals its transcript saved.
 *
 * condukt's usage events are per-turn charges (the scheduler sums them), so
 * this ledger differences successive cumulative snapshots. It also seeds a
 * baseline when the first result after a resume arrives with no earlier
 * snapshot in this process — the transcript, not this process, holds the
 * earlier turns, and reporting the whole cumulative total as one turn would
 * overstate the node by the entire session.
 */

import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';

/** Per-model token counts in condukt's vocabulary. */
export interface TokenCounts {
  /** Prompt tokens, including cache reads and cache writes. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/**
 * One `node:usage` payload. Extends the emitter's `Record<string, unknown>`
 * contract so `agent.ts` can consume it without a cast.
 */
export interface ClaudeUsageRecord extends Record<string, unknown> {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly model: string;
  readonly apiCallId: string;
  /** Wall-clock duration of the whole turn, in milliseconds (result-level). */
  readonly duration?: number;
}

export interface ModelUsageObservation {
  /** `result.uuid`; combined with the model for a stable dedupe key. */
  readonly uuid: string;
  /** `result.duration_ms`. The SDK does not break duration down per model. */
  readonly durationMs?: number;
  /** `result.modelUsage` (camelCase, cumulative). */
  readonly modelUsage: Readonly<Record<string, Partial<ModelUsage>>> | undefined;
  /** `result.usage` (snake_case, main loop only, per turn). */
  readonly mainLoopUsage: Readonly<Record<string, unknown>> | undefined;
  /** Model of the latest assistant frame, when one was seen. */
  readonly mainLoopModel?: string;
}

export interface ModelUsageObservationContext {
  /**
   * Whether this turn continued an existing session (`resume`). Only used for
   * the very first observation, where it decides between "this snapshot is the
   * turn" and "this snapshot is the session baseline".
   */
  readonly resumed: boolean;
}

const ZERO: TokenCounts = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

let fallbackSequence = 0;

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function totalOf(counts: TokenCounts): number {
  return counts.inputTokens + counts.outputTokens;
}

function countsFromModelUsage(usage: Partial<ModelUsage> | undefined): TokenCounts {
  return {
    // ModelUsage.inputTokens excludes cached prompt tokens; condukt's
    // `inputTokens` is the whole prompt.
    inputTokens:
      count(usage?.inputTokens)
      + count(usage?.cacheReadInputTokens)
      + count(usage?.cacheCreationInputTokens),
    outputTokens: count(usage?.outputTokens),
    cacheReadTokens: count(usage?.cacheReadInputTokens),
    cacheWriteTokens: count(usage?.cacheCreationInputTokens),
  };
}

/** Reads the main-loop `result.usage`, accepting either spelling. */
function countsFromMainLoop(usage: Readonly<Record<string, unknown>> | undefined): TokenCounts {
  if (usage === undefined) return ZERO;
  const cacheRead = count(usage['cache_read_input_tokens'] ?? usage['cacheReadTokens']);
  const cacheWrite = count(usage['cache_creation_input_tokens'] ?? usage['cacheWriteTokens']);
  return {
    inputTokens: count(usage['input_tokens'] ?? usage['inputTokens']) + cacheRead + cacheWrite,
    outputTokens: count(usage['output_tokens'] ?? usage['outputTokens']),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

function subtractClamped(cumulative: TokenCounts, previous: TokenCounts): TokenCounts {
  return {
    inputTokens: Math.max(0, cumulative.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, cumulative.outputTokens - previous.outputTokens),
    cacheReadTokens: Math.max(0, cumulative.cacheReadTokens - previous.cacheReadTokens),
    cacheWriteTokens: Math.max(0, cumulative.cacheWriteTokens - previous.cacheWriteTokens),
  };
}

function toRecord(
  model: string,
  counts: TokenCounts,
  uuid: string,
  durationMs: number | undefined,
): ClaudeUsageRecord {
  const callId = uuid.length > 0 ? `${uuid}:${model}` : `claude-${Date.now().toString(36)}-${++fallbackSequence}`;
  return {
    inputTokens: counts.inputTokens,
    outputTokens: counts.outputTokens,
    totalTokens: counts.inputTokens + counts.outputTokens,
    cacheReadTokens: counts.cacheReadTokens,
    cacheWriteTokens: counts.cacheWriteTokens,
    model,
    apiCallId: callId,
    ...(durationMs !== undefined ? { duration: durationMs } : {}),
  };
}

/**
 * Differences the SDK's cumulative `modelUsage` snapshots into per-turn usage.
 *
 * One ledger lives for the whole session: turn N's delta is turn N's snapshot
 * minus turn N-1's. A zeroed/empty error result never overwrites the baseline,
 * so a crash cannot resurrect already-billed tokens on the next turn.
 */
export class ModelUsageLedger {
  private snapshot: Map<string, TokenCounts> | null = null;
  /**
   * Turns that billed each model. The session cannot derive this from the
   * snapshot alone, and reporting the session's total turn count against
   * every model would claim requests a model never served.
   */
  private readonly requestCounts = new Map<string, number>();
  private readonly fallbackModel: string;

  constructor(options?: { readonly fallbackModel?: string }) {
    this.fallbackModel = options?.fallbackModel ?? 'claude';
  }

  /**
   * Records one result and returns the usage records for the turn it closed.
   *
   * - Fresh session, first result: the snapshot *is* this turn.
   * - Resumed session with no earlier snapshot (process restart): seed the
   *   baseline from the snapshot and report only the main-loop usage, which is
   *   per-turn. Subagent tokens from this one turn stay unattributed until the
   *   next result's delta; the plan records this gap rather than inventing a
   *   number.
   * - Later results: per-model deltas, clamped at zero so a mid-session
   *   `/clear` (which resets the running total) cannot produce negative usage.
   */
  observe(
    observation: ModelUsageObservation,
    context: ModelUsageObservationContext,
  ): ClaudeUsageRecord[] {
    const cumulative = new Map<string, TokenCounts>();
    for (const [model, usage] of Object.entries(observation.modelUsage ?? {})) {
      cumulative.set(model, countsFromModelUsage(usage));
    }
    const snapshotHasUsage = [...cumulative.values()].some((counts) => totalOf(counts) > 0);
    const mainLoop = countsFromMainLoop(observation.mainLoopUsage);
    const mainLoopHasUsage = totalOf(mainLoop) > 0;

    if (this.snapshot === null) {
      if (snapshotHasUsage) {
        this.snapshot = cumulative;
        if (context.resumed) {
          return mainLoopHasUsage
            ? [this.record(
              this.attributeMainLoop(observation.mainLoopModel, cumulative),
              mainLoop,
              observation.uuid,
              observation.durationMs,
            )]
            : [];
        }
        return [...cumulative.entries()]
          .filter(([, counts]) => totalOf(counts) > 0)
          .map(([model, counts]) => this.record(model, counts, observation.uuid, observation.durationMs));
      }
      // No per-model snapshot at all: the main loop is the only accounting
      // left. Do not seed anything — the next result's cumulative total will
      // still be baselined on its own first observation.
      return mainLoopHasUsage
        ? [this.record(
          this.attributeMainLoop(observation.mainLoopModel, cumulative),
          mainLoop,
          observation.uuid,
          observation.durationMs,
        )]
        : [];
    }

    if (!snapshotHasUsage) {
      // Crash / startup-error results may carry a zeroed snapshot. Treating it
      // as real would reset the baseline and re-bill every earlier turn.
      return [];
    }

    const records: ClaudeUsageRecord[] = [];
    for (const [model, counts] of cumulative) {
      const previous = this.snapshot.get(model) ?? ZERO;
      this.snapshot.set(model, counts);
      const delta = subtractClamped(counts, previous);
      if (totalOf(delta) > 0) {
        records.push(this.record(model, delta, observation.uuid, observation.durationMs));
      }
    }
    // Models absent from this snapshot keep their last-seen totals: they may
    // return in a later turn, and their earlier usage is already accounted.
    return records;
  }

  /** Cumulative per-model totals as of the last non-zeroed result. */
  getSnapshot(): ReadonlyMap<string, TokenCounts> {
    return this.snapshot ?? new Map<string, TokenCounts>();
  }

  /** Turns that produced usage for each model. */
  getRequestCounts(): ReadonlyMap<string, number> {
    return this.requestCounts;
  }

  /** True once at least one result with real usage has been observed. */
  hasUsage(): boolean {
    return this.snapshot !== null && [...this.snapshot.values()].some((counts) => totalOf(counts) > 0);
  }

  private record(
    model: string,
    counts: TokenCounts,
    uuid: string,
    durationMs: number | undefined,
  ): ClaudeUsageRecord {
    this.requestCounts.set(model, (this.requestCounts.get(model) ?? 0) + 1);
    return toRecord(model, counts, uuid, durationMs);
  }

  private attributeMainLoop(
    observedModel: string | undefined,
    cumulative: ReadonlyMap<string, TokenCounts>,
  ): string {
    if (observedModel !== undefined && observedModel.length > 0) return observedModel;
    if (cumulative.size === 1) {
      const only = cumulative.keys().next();
      if (!only.done) return only.value;
    }
    return this.fallbackModel;
  }
}
