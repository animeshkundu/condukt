/**
 * Session compaction epochs — reference-proxy parity (opencode.py
 * `_epoch_*`, tests/test_session_epoch.py).
 *
 * A post-compaction conversation must read as a NEW session upstream
 * (fresh routing affinity + cache namespace), and every session is
 * era-labeled from birth (`{id}-e0`; the kill-switch restores verbatim).
 * A frozen cache pin (cached flat while input grows) with no compaction
 * in sight never recovers on its own, so N consecutive materially
 * deficient frozen turns rotate a persistent `-rM` marker (superseded by
 * the next compaction bump). The suffix advances only on shrink +
 * novelty + calm (compaction) or on a confirmed stagnation streak, never
 * mid-conversation otherwise.
 *
 * Pure logic only: no I/O, no clocks. Callers own the per-session state
 * map, persistence, and logging.
 */

import { createHash } from 'node:crypto';
import { stableJson } from './bridge-cache';
import { estimateInputTokens } from './translate-chat';

export const SESSION_EPOCH_DEFAULTS = {
  /** Fire only below 60% of the tracked max. */
  ratio: 0.6,
  /** Tracked max must reach 40K est tokens (compaction-scale only). */
  preFloor: 40000,
  /** Shrunken request must still be 25K+ (excludes subagent-scale traffic). */
  postFloor: 25000,
  /** Pre-shrink head steady this many consecutive turns. */
  calm: 3,
  /** "Steady" = size within 75% of tracked max (growth counts). */
  steady: 0.75,
  /** Adopt upward jumps only within 1.5x (rewind guard / rebase). */
  growthCap: 1.5,
  /** Requests before another bump/rotation may fire. */
  cooldown: 5,
  /** Bounded msgs-hash history per session (rewind guard). */
  seenMax: 64,
  /** GC sessions unseen this long. */
  ttlMs: 7 * 86400_000,
  /** Cached flat within ±this many tokens across turns. */
  rotateBand: 5000,
  /** Frozen value must exceed this (cold all-zero streaks never fire). */
  rotateMinPin: 10000,
  /** input − cached must exceed this (near-whole-prefix eras never fire). */
  rotateMinGap: 10000,
  /** Consecutive frozen turns to arm (6th continuing turn rotates). */
  rotateStreak: 5,
  /** input − cached at/above this takes the fast tier. */
  rotateFastGap: 25000,
  /** Consecutive frozen turns to arm the fast tier. */
  rotateFastStreak: 3,
} as const;

export type SessionEpochConstants = {
  readonly [K in keyof typeof SESSION_EPOCH_DEFAULTS]: number;
};

export function epochConstants(overrides?: Partial<SessionEpochConstants>): SessionEpochConstants {
  return { ...SESSION_EPOCH_DEFAULTS, ...(overrides ?? {}) };
}

/** Per-base-session epoch + stagnation tracking state. */
export interface SessionEpochState {
  epoch: number;
  rot: number;
  max: number;
  calm: number;
  seen: string[];
  cooldown: number;
  lastSeen: number;
  rebaseSize: number;
  rebaseHits: number;
  streak: number;
  prevIn: number | null;
  prevCached: number | null;
  prevSize: number | null;
  streakHead: string | null;
}

export function initialEpochState(now: number = Date.now()): SessionEpochState {
  return {
    epoch: 0,
    rot: 0,
    max: 0,
    calm: 0,
    seen: [],
    cooldown: 0,
    lastSeen: now,
    rebaseSize: 0,
    rebaseHits: 0,
    streak: 0,
    prevIn: null,
    prevCached: null,
    prevSize: null,
    streakHead: null,
  };
}

/** (size_est_tokens, msgs_hash, head) for triggers, or null on failure. */
export interface EpochFingerprint {
  readonly size: number;
  readonly msgsHash: string;
  readonly head: string;
}

function hash16(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex').slice(0, 16);
}

/**
 * `head` is the (system, tools) hash pair — stable across normal turns
 * (messages grow; sys/tools don't), so it names the conversation phase
 * for both novelty (compaction) and head-stability (stagnation) checks.
 */
export function epochFingerprint(body: unknown): EpochFingerprint | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b['messages'])) return null;
  try {
    return {
      size: Math.max(0, Math.floor(estimateInputTokens(b as Record<string, any>))),
      msgsHash: hash16(b['messages']),
      head: hash16([b['system'] ?? null, b['tools'] ?? null]),
    };
  } catch {
    return null;
  }
}

/** Pure trigger predicate: shrink + novelty + calm (+ cooldown + floors). */
export function shouldFire(
  state: SessionEpochState,
  size: number,
  msgsHash: string,
  c: SessionEpochConstants,
): boolean {
  if (state.cooldown > 0) return false;
  if (state.max < c.preFloor) return false;
  if (size < c.postFloor) return false;
  if (size >= c.ratio * state.max) return false;
  if (state.seen.includes(msgsHash)) return false;
  if (state.calm < c.calm) return false;
  return true;
}

/**
 * Non-firing update. `max` ratchets up only within the growth cap — an
 * abrupt multi-x jump is a rewind-to-old and adopts only if the new
 * level persists `calm` consecutive (band-matched) turns (rebase); a
 * one-turn excursion is abandoned on return. Small/interleaved traffic
 * resets calm.
 */
export function trackLocked(
  state: SessionEpochState,
  size: number,
  msgsHash: string | null,
  c: SessionEpochConstants,
): void {
  if (size > state.max) {
    if (state.max === 0 || size <= c.growthCap * state.max) {
      state.max = size;
      state.rebaseSize = 0;
      state.rebaseHits = 0;
    } else if (
      state.rebaseSize > 0 &&
      Math.abs(size - state.rebaseSize) <= (1 - c.steady) * state.rebaseSize
    ) {
      state.rebaseSize = size;
      state.rebaseHits += 1;
      if (state.rebaseHits >= c.calm) {
        state.max = size;
        state.rebaseSize = 0;
        state.rebaseHits = 0;
      }
    } else {
      state.rebaseSize = size;
      state.rebaseHits = 1;
    }
  } else {
    state.rebaseSize = 0;
    state.rebaseHits = 0;
  }
  if (msgsHash !== null && !state.seen.includes(msgsHash)) {
    state.seen.push(msgsHash);
    if (state.seen.length > c.seenMax) state.seen.splice(0, state.seen.length - c.seenMax);
  }
  state.calm = size >= c.steady * state.max ? state.calm + 1 : 0;
  if (state.cooldown > 0) state.cooldown -= 1;
}

/**
 * Pure stagnation predicate: the pin is frozen AND the freeze is
 * material AND the turn continues the run. Shares the epoch cooldown;
 * `gap` (previous measured input − cached) selects the tier: at/above
 * 25K the fast tier (3-turn streak), above 10K the slow tier (5).
 */
export function rotationArmed(
  state: SessionEpochState,
  size: number,
  head: string | null,
  c: SessionEpochConstants,
): boolean {
  if (state.cooldown > 0) return false;
  const pi = state.prevIn;
  const pc = state.prevCached;
  if (pi === null || pc === null) return false;
  const gap = pi - pc;
  let required: number;
  if (gap >= c.rotateFastGap) required = c.rotateFastStreak;
  else if (gap > c.rotateMinGap) required = c.rotateStreak;
  else return false;
  if (state.streak < required) return false;
  if (size < c.postFloor) return false;
  if (pc < c.rotateMinPin) return false;
  if (state.prevSize === null || size <= state.prevSize) return false;
  if (head === null || head !== state.streakHead) return false;
  return true;
}

/**
 * Record a completed turn's outcome for the stagnation detector.
 * `measured` false (estimated/failed usage) skips WITHOUT touching
 * state — an observation gap must neither confirm nor reset the streak.
 * Streak counts consecutive frozen turns with baseline 1 (the first
 * observed turn adopts the head as the run baseline); any violation
 * (cache jump, input drop, head change) restarts at 0. Never throws.
 */
export function noteTurn(
  state: SessionEpochState,
  body: unknown,
  inTokens: number,
  cacheTokens: number,
  measured: boolean,
  c: SessionEpochConstants,
  now: number = Date.now(),
): boolean {
  if (!measured) return false;
  try {
    if (!Number.isFinite(inTokens) || !Number.isFinite(cacheTokens)) return false;
    const fp = epochFingerprint(body);
    if (!fp) return false;
    state.lastSeen = now;
    if (state.streakHead === null || fp.head !== state.streakHead) {
      state.streakHead = fp.head;
      state.prevIn = inTokens;
      state.prevCached = cacheTokens;
      state.prevSize = fp.size;
      state.streak = 1;
    } else {
      const prevIn = state.prevIn;
      const prevCached = state.prevCached;
      const frozen =
        prevCached !== null &&
        prevIn !== null &&
        Math.abs(cacheTokens - prevCached) <= c.rotateBand &&
        inTokens > prevIn;
      state.streak = frozen ? state.streak + 1 : 0;
      state.prevIn = inTokens;
      state.prevCached = cacheTokens;
      state.prevSize = fp.size;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Exact-compaction bump (the in-process bridge observes the SDK's
 * compact boundary; the reference proxy bumps heuristically on shrink).
 * Mirrors the reference fire path with an unknown post-compaction body:
 * `max` re-learns the new level, `seen` starts fresh, rotation is
 * dropped, and the shared cooldown suppresses a duplicate heuristic
 * fire on the immediately following shrunken request.
 */
export function bumpEpochOnCompaction(
  state: SessionEpochState,
  c: SessionEpochConstants,
  now: number = Date.now(),
): void {
  state.epoch += 1;
  state.max = 0;
  state.seen = [];
  state.calm = 0;
  state.cooldown = c.cooldown;
  state.rebaseSize = 0;
  state.rebaseHits = 0;
  state.rot = 0;
  state.streak = 0;
  state.prevIn = null;
  state.prevCached = null;
  state.prevSize = null;
  state.streakHead = null;
  state.lastSeen = now;
}

export interface EpochVerdict {
  readonly effectiveSession: string;
  readonly fired: boolean;
  readonly rotated: boolean;
  /**
   * True when the request carried a usable fingerprint (state was
   * read/tracked); false for unusable bodies, which are read-only.
   */
  readonly observed: boolean;
  /** Diagnostics for logging/metrics when fired/rotated. */
  readonly firedDetail?: { readonly prevMax: number; readonly size: number; readonly epoch: number };
  readonly rotatedDetail?: {
    readonly prevCached: number | null;
    readonly gap: number | null;
    readonly prevStreak: number;
    readonly rot: number;
  };
}

/** The single verdict point: suffixed whenever enabled, verbatim otherwise. */
export function suffixedSession(session: string, epoch: number, rot: number, enabled: boolean): string {
  if (!enabled) return session;
  let s = `${session}-e${epoch}`;
  if (rot > 0) s += `-r${rot}`;
  return s;
}

export interface ApplyEpochOptions {
  readonly enabled: boolean;
  readonly rotate: boolean;
  readonly constants: SessionEpochConstants;
  readonly now?: () => number;
}

/**
 * Resolve the effective upstream session for one request, mutating
 * `state`. Fail-open throughout: kill-switch off returns the verbatim
 * session (tracking continues); unusable fingerprints return the stored
 * epoch with zero state mutation.
 */
export function applySessionEpoch(
  base: string,
  state: SessionEpochState,
  body: unknown,
  opts: ApplyEpochOptions,
): EpochVerdict {
  const c = opts.constants;
  const now = opts.now ?? Date.now;
  const rotateOn = opts.enabled && opts.rotate;
  let fp: EpochFingerprint | null = null;
  try {
    fp = epochFingerprint(body);
  } catch {
    fp = null;
  }
  if (!fp) {
    return {
      effectiveSession: suffixedSession(base, state.epoch, state.rot, opts.enabled),
      fired: false,
      rotated: false,
      observed: false,
    };
  }
  state.lastSeen = now();
  try {
    if (opts.enabled && shouldFire(state, fp.size, fp.msgsHash, c)) {
      const prevMax = state.max;
      state.epoch += 1;
      state.max = fp.size;
      state.seen = [fp.msgsHash];
      state.calm = 0;
      state.cooldown = c.cooldown;
      state.rebaseSize = 0;
      state.rebaseHits = 0;
      state.rot = 0;
      state.streak = 0;
      state.prevIn = null;
      state.prevCached = null;
      state.prevSize = null;
      state.streakHead = null;
      return {
        effectiveSession: suffixedSession(base, state.epoch, state.rot, opts.enabled),
        fired: true,
        rotated: false,
        observed: true,
        firedDetail: { prevMax, size: fp.size, epoch: state.epoch },
      };
    }
    if (rotateOn && rotationArmed(state, fp.size, fp.head, c)) {
      const prevCached = state.prevCached;
      const prevIn = state.prevIn;
      const prevStreak = state.streak;
      state.rot += 1;
      state.streak = 0;
      state.prevIn = null;
      state.prevCached = null;
      state.prevSize = null;
      state.streakHead = null;
      state.cooldown = c.cooldown;
      return {
        effectiveSession: suffixedSession(base, state.epoch, state.rot, opts.enabled),
        fired: false,
        rotated: true,
        observed: true,
        rotatedDetail: {
          prevCached,
          gap: prevIn !== null && prevCached !== null ? prevIn - prevCached : null,
          prevStreak,
          rot: state.rot,
        },
      };
    }
    trackLocked(state, fp.size, fp.msgsHash, c);
  } catch {
    /* fail-open: return the stored-epoch verdict below */
  }
  return {
    effectiveSession: suffixedSession(base, state.epoch, state.rot, opts.enabled),
    fired: false,
    rotated: false,
    observed: true,
  };
}
