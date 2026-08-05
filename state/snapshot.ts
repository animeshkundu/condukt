/**
 * Execution state snapshots — capture and restore an execution's durable event history
 * without exposing where or how it is stored.
 *
 * A consumer that checkpoints a long-running execution needs three things: the events that are
 * durable right now, a way to prove the set it later restores is the set it captured, and a way
 * to put that set back under a possibly different execution id. Doing this by reaching into the
 * storage layout couples the consumer to a private on-disk contract: the JSONL framing, the
 * sibling projection file, the fact that a crash can leave a torn final record. Every one of
 * those is condukt's business, not the consumer's.
 *
 * What stays the consumer's business is policy: which executions to capture, how to redact
 * secrets, where to put the bytes, and how long to keep them. `transform` is the hook for the
 * redaction half; the rest is outside this module entirely.
 */

import { createHash } from 'node:crypto';

import type { ExecutionEvent } from '../src/events';

/**
 * A captured execution history. Opaque by intent: the shape says what the events are and proves
 * integrity, and says nothing about how they were stored.
 */
export interface ExecutionStateSnapshot {
  readonly schemaVersion: 1;
  readonly executionId: string;
  /** Count of durable, complete events at capture. Monotonic per execution. */
  readonly sequence: number;
  readonly events: readonly ExecutionEvent[];
  /** sha256 over the canonical serialization of `events`, in order. */
  readonly digest: string;
  readonly capturedAt: number;
}

export interface SnapshotCaptureOptions {
  /**
   * Per-event transform applied during capture, e.g. credential redaction. The digest is
   * computed over the transformed events, so a restore verifies what was actually stored
   * rather than what was in memory beforehand.
   */
  readonly transform?: (event: ExecutionEvent) => ExecutionEvent;
  /** Wall clock, injectable so a caller can stamp deterministically. */
  readonly now?: () => number;
}

export interface SnapshotRestoreOptions {
  /**
   * Restore under a different execution id. Every event's executionId is rewritten to match,
   * so a resumed run does not collide with the one it was captured from.
   */
  readonly targetExecutionId?: string;
  /**
   * Rewrites the params on the run:started event. Use for re-pointing a restored run at a new
   * workspace or a supplied intent. Returning the input unchanged is a no-op.
   */
  readonly mapRunParams?: (
    params: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
}

/**
 * sha256 over the events in order.
 *
 * Hashes incrementally rather than serializing the whole history into one string: a long run's
 * log is exactly where a single `JSON.stringify` of everything hits the engine's maximum string
 * length, and a checkpoint that throws on the biggest runs is worse than no checkpoint at all.
 */
export function snapshotDigest(events: readonly ExecutionEvent[]): string {
  const hash = createHash('sha256');
  for (const event of events) {
    hash.update(JSON.stringify(event));
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Throws if the snapshot is malformed or its events do not match its digest. */
export function validateSnapshot(snapshot: ExecutionStateSnapshot): void {
  if (snapshot.schemaVersion !== 1) {
    throw new Error(`Unsupported snapshot schemaVersion: ${String(snapshot.schemaVersion)}`);
  }
  if (typeof snapshot.executionId !== 'string' || snapshot.executionId === '') {
    throw new Error('Snapshot is missing an executionId');
  }
  if (!Array.isArray(snapshot.events)) {
    throw new Error('Snapshot events must be an array');
  }
  if (snapshot.sequence !== snapshot.events.length) {
    throw new Error(
      `Snapshot sequence ${snapshot.sequence} does not match ${snapshot.events.length} events`,
    );
  }
  const actual = snapshotDigest(snapshot.events);
  if (actual !== snapshot.digest) {
    throw new Error(`Snapshot digest mismatch: expected ${snapshot.digest}, computed ${actual}`);
  }
}

/**
 * Re-point a snapshot at a different execution id and/or rewrite its run params.
 *
 * Pure: returns a new snapshot with a recomputed digest, so the result verifies on restore.
 */
export function rebaseSnapshot(
  snapshot: ExecutionStateSnapshot,
  options: SnapshotRestoreOptions,
): ExecutionStateSnapshot {
  const executionId = options.targetExecutionId ?? snapshot.executionId;
  const events = snapshot.events.map((event) => {
    const rebased: ExecutionEvent = event.executionId === executionId
      ? event
      : { ...event, executionId };
    if (options.mapRunParams && rebased.type === 'run:started') {
      return { ...rebased, params: options.mapRunParams(rebased.params) };
    }
    return rebased;
  });

  return {
    schemaVersion: 1,
    executionId,
    sequence: events.length,
    events,
    digest: snapshotDigest(events),
    capturedAt: snapshot.capturedAt,
  };
}

/**
 * Build a snapshot from an already-read event list.
 *
 * Exposed for storage engines and tests; consumers should prefer
 * `StateRuntime.captureExecutionSnapshot`, which takes the per-execution lock so the capture
 * cannot interleave with an in-flight append.
 */
export function buildSnapshot(
  executionId: string,
  events: readonly ExecutionEvent[],
  options?: SnapshotCaptureOptions,
): ExecutionStateSnapshot {
  const transformed = options?.transform ? events.map(options.transform) : [...events];
  return {
    schemaVersion: 1,
    executionId,
    sequence: transformed.length,
    events: transformed,
    digest: snapshotDigest(transformed),
    capturedAt: (options?.now ?? Date.now)(),
  };
}
