/**
 * Sidecar persistence for session epoch state (reference parity with
 * opencode.py `_epoch_load` / `_epoch_write_snapshot`).
 *
 * Strict shape validation: any entry that is not a well-formed state
 * with ints >= 0, a `lastSeen` within [0, now] and inside the TTL, a
 * list-of-strings `seen`, and a string-or-null `streakHead` is skipped —
 * a predating/hand-edited file must never wipe an established epoch
 * into bare reuse. Missing/corrupt files start empty. All IO is
 * best-effort and never throws into the request path; writes go through
 * a temp file + rename so a torn read is impossible.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  initialEpochState,
  type SessionEpochConstants,
  type SessionEpochState,
} from './session-epoch';

const STATE_KEYS = [
  'epoch',
  'rot',
  'max',
  'calm',
  'seen',
  'cooldown',
  'lastSeen',
  'rebaseSize',
  'rebaseHits',
  'streak',
  'prevIn',
  'prevCached',
  'prevSize',
  'streakHead',
] as const;

function nonNegativeInt(value: unknown): number | null {
  if (typeof value === 'boolean' || typeof value !== 'number') return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function nullableNonNegativeInt(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  const n = nonNegativeInt(value);
  return n === null ? undefined : n;
}

/** Validate one raw entry; returns a normalized state or null (skip). */
export function validateEpochEntry(
  raw: unknown,
  now: number,
  c: SessionEpochConstants,
): SessionEpochState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const epoch = nonNegativeInt(r['epoch'] ?? 0);
  const rot = nonNegativeInt(r['rot'] ?? 0);
  const max = nonNegativeInt(r['max'] ?? 0);
  const calm = nonNegativeInt(r['calm'] ?? 0);
  const cooldown = nonNegativeInt(r['cooldown'] ?? 0);
  const rebaseSize = nonNegativeInt(r['rebaseSize'] ?? 0);
  const rebaseHits = nonNegativeInt(r['rebaseHits'] ?? 0);
  const streak = nonNegativeInt(r['streak'] ?? 0);
  if (
    epoch === null ||
    rot === null ||
    max === null ||
    calm === null ||
    cooldown === null ||
    rebaseSize === null ||
    rebaseHits === null ||
    streak === null
  ) {
    return null;
  }
  const lastSeen = r['lastSeen'];
  if (typeof lastSeen !== 'number' || !Number.isFinite(lastSeen)) return null;
  if (lastSeen < 0 || lastSeen > now || now - lastSeen > c.ttlMs) return null;

  const prevIn = nullableNonNegativeInt(r['prevIn']);
  const prevCached = nullableNonNegativeInt(r['prevCached']);
  const prevSize = nullableNonNegativeInt(r['prevSize']);
  if (prevIn === undefined || prevCached === undefined || prevSize === undefined) return null;

  const streakHead = r['streakHead'];
  if (streakHead !== null && streakHead !== undefined && typeof streakHead !== 'string') return null;

  const seenRaw = r['seen'];
  // Keep the NEWEST hashes (matching the in-memory trim in trackLocked;
  // the reference's load path keeps the oldest, conflicting with its own
  // runtime behavior — we keep the run-relevant suffix instead).
  const seen = Array.isArray(seenRaw)
    ? seenRaw.filter((h): h is string => typeof h === 'string').slice(-c.seenMax)
    : [];

  return {
    epoch,
    rot,
    max,
    calm,
    seen,
    cooldown,
    lastSeen,
    rebaseSize,
    rebaseHits,
    streak,
    prevIn,
    prevCached,
    prevSize,
    streakHead: typeof streakHead === 'string' ? streakHead : null,
  };
}

/** Read + validate + TTL-GC a sidecar. Missing/corrupt → empty map. */
export function readEpochStore(
  file: string,
  now: number,
  c: SessionEpochConstants,
): Record<string, SessionEpochState> {
  const out: Record<string, SessionEpochState> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [session, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!session) continue;
      const state = validateEpochEntry(raw, now, c);
      if (state) out[session] = state;
    }
  } catch {
    /* missing/corrupt starts empty */
  }
  return out;
}

/** TTL-GC + atomic write (temp file + rename). Never throws. */
export function writeEpochStore(
  file: string,
  store: Record<string, SessionEpochState>,
  now: number,
  c: SessionEpochConstants,
): void {
  try {
    const data: Record<string, SessionEpochState> = {};
    for (const [session, st] of Object.entries(store)) {
      if (now - st.lastSeen > c.ttlMs) {
        // Python parity: TTL-GC evicts stale sessions from the live map
        // on the write path, so a session idle beyond the TTL restarts
        // at -e0 instead of resurrecting its old era from the sidecar.
        delete store[session];
        continue;
      }
      data[session] = st;
    }
    const dir = path.dirname(file);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* best effort */
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* persistence is best effort; the in-memory ratchet rebuilds */
  }
}

// ── Shared in-process stores ─────────────────────────────────────────
// One bridge per Claude session: several bridges in one process may
// share a sidecar file, so their in-memory copies must be the same
// object or a write from one would clobber the other's keys.

const sharedStores = new Map<string, Record<string, SessionEpochState>>();

/** Shared (per resolved path) store, loaded once from disk. */
export function sharedEpochStore(
  file: string,
  now: number,
  c: SessionEpochConstants,
): Record<string, SessionEpochState> {
  const key = path.resolve(file);
  let store = sharedStores.get(key);
  if (!store) {
    store = readEpochStore(key, now, c);
    sharedStores.set(key, store);
  }
  return store;
}

/** Test helper: forget shared stores (forces a fresh disk load). */
export function clearSharedEpochStores(): void {
  sharedStores.clear();
}

/** Get-or-create the tracked entry for `session` in a store. */
export function epochEntry(
  store: Record<string, SessionEpochState>,
  session: string,
  now: number,
): SessionEpochState {
  let state = store[session];
  if (!state) {
    state = initialEpochState(now);
    store[session] = state;
  }
  return state;
}

export { STATE_KEYS };
