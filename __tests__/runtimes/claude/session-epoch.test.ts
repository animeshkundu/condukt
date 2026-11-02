/**
 * Session compaction epochs + stagnation rotation (opencode.py
 * `_epoch_*` parity; ported from tests/test_session_epoch.py).
 *
 * Thresholds are small and deterministic, bodies are synthetic, the
 * clock is injected. All offline: no live models, no spend.
 */

import { describe, it, expect } from 'vitest';
import {
  SESSION_EPOCH_DEFAULTS,
  applySessionEpoch,
  bumpEpochOnCompaction,
  epochConstants,
  epochFingerprint,
  initialEpochState,
  noteTurn,
  rotationArmed,
  shouldFire,
  suffixedSession,
  trackLocked,
  type SessionEpochConstants,
  type SessionEpochState,
} from '../../../runtimes/claude/session-epoch';
import { cacheKeyFor } from '../../../runtimes/claude/bridge-cache';

/** Small deterministic thresholds (reference test fixture parity). */
const C: SessionEpochConstants = epochConstants({
  preFloor: 20,
  postFloor: 10,
  calm: 2,
  cooldown: 5,
  rotateBand: 2,
  rotateMinPin: 3,
  rotateMinGap: 4,
  rotateStreak: 2,
});

function body(tag: string, padWords = 0): Record<string, unknown> {
  return {
    system: 'sys',
    tools: [{ name: 't', description: 'd', input_schema: {} }],
    messages: [{ role: 'user', content: `turn-${tag} ` + 'word '.repeat(padWords) }],
  };
}

function mkState(patch: Partial<SessionEpochState> = {}): SessionEpochState {
  return { ...initialEpochState(0), ...patch };
}

interface ApplyPatch {
  enabled?: boolean;
  rotate?: boolean;
  constants?: SessionEpochConstants;
}

function apply(state: SessionEpochState, b: unknown, patch: ApplyPatch = {}) {
  return applySessionEpoch('sess', state, b, {
    enabled: patch.enabled ?? true,
    rotate: patch.rotate ?? true,
    constants: patch.constants ?? C,
    now: () => 0,
  });
}

function note(
  state: SessionEpochState,
  b: unknown,
  inTok: number,
  cached: number,
  measured = true,
): boolean {
  return noteTurn(state, b, inTok, cached, measured, C, 0);
}

// ── pure trigger predicate ───────────────────────────────────────────

describe('epoch trigger predicate', () => {
  it('fires on compaction shape (shrink below ratio, novel, calm)', () => {
    expect(shouldFire(mkState({ max: 200, calm: 5, seen: ['old'] }), 100, 'new', C)).toBe(true);
  });

  it('ratio boundary: exactly 0.6x is not below', () => {
    const st = mkState({ max: 200, calm: 5, seen: [] });
    expect(shouldFire(st, 120, 'n', C)).toBe(false);
    expect(shouldFire(st, 119, 'n', C)).toBe(true);
  });

  it('floors: tracked max and shrunken size', () => {
    expect(shouldFire(mkState({ max: 10, calm: 5, seen: [] }), 5, 'n', C)).toBe(false);
    expect(shouldFire(mkState({ max: 200, calm: 5, seen: [] }), 5, 'n', C)).toBe(false);
  });

  it('rewind to a familiar head never fires (novelty gate)', () => {
    expect(shouldFire(mkState({ max: 200, calm: 5, seen: ['h1'] }), 50, 'h1', C)).toBe(false);
  });

  it('calm and cooldown gates', () => {
    expect(shouldFire(mkState({ max: 200, calm: 1, seen: [] }), 50, 'n', C)).toBe(false);
    expect(shouldFire(mkState({ max: 200, calm: 5, seen: [], cooldown: 3 }), 50, 'n', C)).toBe(false);
  });

  it('seed predicates: fresh state never fires', () => {
    const st = mkState();
    expect(shouldFire(st, 100000, 'x', SESSION_EPOCH_DEFAULTS)).toBe(false);
  });
});

// ── tracking ─────────────────────────────────────────────────────────

describe('epoch tracking', () => {
  it('ratchets up, never drops; grows calm on steady turns', () => {
    const st = mkState({ max: 200, calm: 2, seen: ['a'] });
    trackLocked(st, 50, 'b', C);
    expect(st.max).toBe(200);
    expect(st.calm).toBe(0);
    expect(st.seen).toContain('b');
    trackLocked(st, 250, 'c', C);
    expect(st.max).toBe(250);
    expect(st.calm).toBe(1);
  });

  it('bounded seen history (64 entries max)', () => {
    const st = mkState({ seen: Array.from({ length: 200 }, (_, i) => `h${i}`) });
    trackLocked(st, 10, 'new', C);
    expect(st.seen.length).toBeLessThanOrEqual(SESSION_EPOCH_DEFAULTS.seenMax);
    expect(st.seen.at(-1)).toBe('new');
  });

  it('decrements cooldown only on non-firing turns', () => {
    const st = mkState({ cooldown: 2 });
    trackLocked(st, 1, 'a', C);
    expect(st.cooldown).toBe(1);
    trackLocked(st, 1, 'b', C);
    expect(st.cooldown).toBe(0);
    trackLocked(st, 1, 'c', C);
    expect(st.cooldown).toBe(0);
  });
});

// ── fingerprint ──────────────────────────────────────────────────────

describe('epoch fingerprint', () => {
  it('rejects unusable bodies', () => {
    expect(epochFingerprint(null)).toBeNull();
    expect(epochFingerprint(['not', 'a', 'dict'])).toBeNull();
    expect(epochFingerprint({ system: 'x' })).toBeNull();
    expect(epochFingerprint({ messages: 'not-an-array' })).toBeNull();
  });

  it('head is stable across message growth; msgs hash is not', () => {
    const a = epochFingerprint(body('a', 1))!;
    const b = epochFingerprint(body('b', 2))!;
    expect(a.head).toBe(b.head);
    expect(a.msgsHash).not.toBe(b.msgsHash);
    expect(b.size).toBeGreaterThan(a.size);
  });

  it('head changes when system or tools change', () => {
    const a = epochFingerprint(body('a'))!;
    const sys = { ...body('a'), system: 'different system entirely' };
    const tools = { ...body('a'), tools: [{ name: 'other' }] };
    expect(epochFingerprint(sys)!.head).not.toBe(a.head);
    expect(epochFingerprint(tools)!.head).not.toBe(a.head);
  });
});

// ── end-to-end application ───────────────────────────────────────────

describe('epoch application', () => {
  it('epoch zero is suffixed at birth', () => {
    expect(apply(mkState(), body('a')).effectiveSession).toBe('sess-e0');
  });

  it('compaction advances the epoch exactly once', () => {
    const st = mkState();
    for (const [tag, pad] of [
      ['t1', 100],
      ['t2', 110],
      ['t3', 120],
    ] as const) {
      expect(apply(st, body(tag, pad)).effectiveSession).toBe('sess-e0');
    }
    expect(apply(st, body('compacted', 20)).effectiveSession).toBe('sess-e1');
    // Same shrunken head again: no double bump (seen + cooldown).
    expect(apply(st, body('compacted', 20)).effectiveSession).toBe('sess-e1');
  });

  it('rewind to the pre-compaction head keeps the epoch', () => {
    const st = mkState();
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 100 + i));
    expect(apply(st, body('compacted', 20)).effectiveSession).toBe('sess-e1');
    expect(apply(st, body('big', 100)).effectiveSession).toBe('sess-e1');
  });

  it('interleaved subagent-scale bursts never fire', () => {
    const st = mkState();
    for (let i = 0; i < 4; i += 1) apply(st, body(`main${i}`, 100));
    for (let i = 0; i < 6; i += 1) {
      expect(apply(st, body(`sub${i}`, 0)).effectiveSession).toBe('sess-e0');
    }
    for (let i = 0; i < 2; i += 1) {
      expect(apply(st, body(`mainx${i}`, 100)).effectiveSession).toBe('sess-e0');
    }
    expect(apply(st, body('compacted', 20)).effectiveSession).toBe('sess-e1');
  });

  it('cooldown suppresses a double compaction', () => {
    const st = mkState();
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 100));
    expect(apply(st, body('c1', 20)).effectiveSession).toBe('sess-e1');
    expect(apply(st, body('c2', 8)).effectiveSession).toBe('sess-e1');
  });

  it('kill switch off: tracking continues, verdict stays verbatim; re-enabling fires', () => {
    const st = mkState();
    for (let i = 0; i < 3; i += 1) {
      expect(apply(st, body(`g${i}`, 100), { enabled: false }).effectiveSession).toBe('sess');
    }
    expect(apply(st, body('compacted', 20)).effectiveSession).toBe('sess-e1');
  });

  it('kill switch restores verbatim with an established epoch, then resumes', () => {
    const st = mkState();
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 100));
    expect(apply(st, body('c', 20)).effectiveSession).toBe('sess-e1');
    expect(apply(st, body('c', 20), { enabled: false }).effectiveSession).toBe('sess');
    expect(apply(st, body('g0', 100), { enabled: false }).effectiveSession).toBe('sess');
    expect(apply(st, body('c', 20)).effectiveSession).toBe('sess-e1');
  });

  it('snapshot failure is read-only: keeps the stored epoch and calm', () => {
    const st = mkState();
    expect(apply(st, ['not', 'a', 'dict']).effectiveSession).toBe('sess-e0');
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 100));
    expect(apply(st, body('c', 20)).effectiveSession).toBe('sess-e1');
    expect(apply(st, null).effectiveSession).toBe('sess-e1');
  });

  it('junk between steadies preserves calm (F3 regression)', () => {
    const st = mkState();
    apply(st, body('g0', 100));
    apply(st, body('g1', 100));
    expect(apply(st, null).effectiveSession).toBe('sess-e0');
    expect(apply(st, ['junk']).effectiveSession).toBe('sess-e0');
    apply(st, body('g2', 100));
    expect(apply(st, body('c', 20)).effectiveSession).toBe('sess-e1');
  });

  it('post-rewind second compaction still fires (F1 regression)', () => {
    const st = mkState();
    const c = { ...C, cooldown: 2 };
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 100), { constants: c });
    expect(apply(st, body('c1', 20), { constants: c }).effectiveSession).toBe('sess-e1');
    // Rewind excursion to the old large head: no fire, no max adoption.
    expect(apply(st, body('big', 100), { constants: c }).effectiveSession).toBe('sess-e1');
    for (let i = 0; i < 3; i += 1) {
      expect(apply(st, body(`s${i}`, 20), { constants: c }).effectiveSession).toBe('sess-e1');
    }
    expect(apply(st, body('c2', 6), { constants: c }).effectiveSession).toBe('sess-e2');
  });

  it('rebase adopts a persistent new level after calm turns', () => {
    const st = mkState();
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 100));
    for (let i = 0; i < 3; i += 1) {
      expect(apply(st, body(`big${i}`, 220)).effectiveSession).toBe('sess-e0');
    }
    expect(apply(st, body('c', 120)).effectiveSession).toBe('sess-e1');
  });

  it('rebase abandons non-consecutive blips (max stays put)', () => {
    const st = mkState();
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 30));
    for (let i = 0; i < 3; i += 1) {
      expect(apply(st, body(`blip${i}`, 200)).effectiveSession).toBe('sess-e0');
      expect(apply(st, body(`ok${i}`, 30)).effectiveSession).toBe('sess-e0');
    }
    expect(st.max).toBeLessThan(150);
  });

  it('rebase adopts a jittery persistent level (band match)', () => {
    const st = mkState();
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 30));
    const pads = [200, 205, 202];
    for (let i = 0; i < pads.length; i += 1) {
      expect(apply(st, body(`lvl${i}`, pads[i])).effectiveSession).toBe('sess-e0');
    }
    expect(st.max).toBeGreaterThan(300);
    expect(apply(st, body('c', 100)).effectiveSession).toBe('sess-e1');
  });

  it('evicted seen hash reads as novel again (bounded history semantics)', () => {
    const st = mkState();
    apply(st, body('g0', 100));
    for (let i = 1; i < 75; i += 1) apply(st, body(`g${i}`, 100 + i));
    const out = apply(st, body('g0', 100)).effectiveSession;
    expect(['sess-e0', 'sess-e1']).toContain(out);
  });

  it('exact compaction bump advances era, drops rotation, restarts max', () => {
    const st = mkState();
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 100));
    expect(apply(st, body('c', 20)).effectiveSession).toBe('sess-e1');
    bumpEpochOnCompaction(st, C, 0);
    expect(st.epoch).toBe(2);
    expect(st.rot).toBe(0);
    expect(st.max).toBe(0);
    expect(st.cooldown).toBe(C.cooldown);
    expect(apply(st, body('n')).effectiveSession).toBe('sess-e2');
  });
});

// ── stagnation rotation (-rM) ────────────────────────────────────────

describe('stagnation rotation', () => {
  it('fires after the streak: baseline + streak frozen turns', () => {
    const st = mkState();
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 100));
    const b = body('steady', 100);
    for (const inp of [200, 210, 220, 230, 240, 250]) note(st, b, inp, 150);
    expect(st.streak).toBe(6);
    expect(apply(st, body('next', 200)).effectiveSession).toBe('sess-e0-r1');
  });

  it('band boundary: within ±band holds, one beyond resets', () => {
    const st = mkState();
    const b = body('steady', 50);
    note(st, b, 100, 150);
    note(st, b, 110, 152);
    expect(st.streak).toBe(2);
    note(st, b, 120, 155);
    expect(st.streak).toBe(0);
  });

  it('a reported zero-input turn is an observation (streak reset), not a gap', () => {
    const st = mkState();
    const b = body('steady', 50);
    for (const inp of [100, 110, 120]) note(st, b, inp, 150);
    expect(st.streak).toBe(3);
    expect(note(st, b, 0, 150)).toBe(true);
    expect(st.streak).toBe(0);
  });

  it('resets on cache jump, input drop and head change', () => {
    const st = mkState();
    const b = body('steady', 50);
    for (const inp of [100, 110, 120]) note(st, b, inp, 150);
    expect(st.streak).toBe(3);
    note(st, b, 130, 900);
    expect(st.streak).toBe(0);
    for (const inp of [140, 150, 160]) note(st, b, inp, 150);
    note(st, body('other-sys', 50), 170, 150); // identical sys/tools: same head
    expect(st.streak).toBe(3);
    const diff = { ...body('steady', 50), system: 'different system entirely' };
    note(st, diff, 180, 150);
    expect(st.streak).toBe(1);
  });

  it('cold all-zero streaks never fire (min-pin floor)', () => {
    const st = mkState();
    const b = body('steady', 50);
    let inp = 100;
    while (inp < 200) {
      note(st, b, inp, 0);
      inp += 10;
    }
    expect(st.streak).toBe(10);
    expect(apply(st, body('next', 200)).effectiveSession).toBe('sess-e0');
  });

  it('gap floor is exclusive: equal gap holds, greater fires', () => {
    const st = mkState();
    const b = body('steady', 100);
    for (const inp of [200, 210, 220, 230, 240, 250]) note(st, b, inp, 150);
    expect(st.streak).toBe(6);
    const probe = body('next', 200);
    expect(apply(st, probe, { constants: { ...C, rotateMinGap: 100 } }).effectiveSession).toBe('sess-e0');
    expect(apply(st, probe, { constants: { ...C, rotateMinGap: 99 } }).effectiveSession).toBe('sess-e0-r1');
  });

  it('cooldown suppresses the immediate continuation', () => {
    const st = mkState();
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 100));
    const b = body('steady', 100);
    for (const inp of [200, 210, 220, 230, 240, 250]) note(st, b, inp, 150);
    expect(apply(st, body('next', 200)).effectiveSession).toBe('sess-e0-r1');
    expect(apply(st, body('next2', 210)).effectiveSession).toBe('sess-e0-r1');
  });

  it('compaction supersedes rotation: rot dropped, era advances', () => {
    const st = mkState();
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 100));
    const b = body('steady', 100);
    for (const inp of [200, 210, 220, 230, 240, 250]) note(st, b, inp, 150);
    expect(apply(st, body('next', 200)).effectiveSession).toBe('sess-e0-r1');
    for (let i = 0; i < 6; i += 1) apply(st, body(`h${i}`, 100));
    expect(apply(st, body('c', 8)).effectiveSession).toBe('sess-e1');
  });

  it('rotate flag matrix: off tracks but never suffixes; kill off verbatim', () => {
    const st = mkState();
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 100));
    const b = body('steady', 100);
    for (const inp of [200, 210, 220, 230, 240, 250]) note(st, b, inp, 150);
    expect(apply(st, body('next', 200), { rotate: false }).effectiveSession).toBe('sess-e0');
    expect(apply(st, body('next', 200), { enabled: false }).effectiveSession).toBe('sess');
    expect(apply(st, body('next', 200)).effectiveSession).toBe('sess-e0-r1');
  });

  it('unmeasured turns are observation gaps: no confirm, no reset', () => {
    const st = mkState();
    const b = body('steady', 50);
    note(st, b, 100, 150);
    note(st, b, 110, 150, false);
    note(st, b, 120, 150, false);
    expect(st.streak).toBe(1);
    expect(st.prevIn).toBe(100);
  });

  it('notes filed under an orphan state never arm the base (wiring contract)', () => {
    const base = mkState();
    const orphan = mkState();
    expect(apply(base, body('g', 100)).effectiveSession).toBe('sess-e0');
    for (const inp of [200, 210, 220, 230, 240, 250]) note(orphan, body('steady', 100), inp, 150);
    expect(apply(base, body('next', 200)).effectiveSession).toBe('sess-e0');
  });

  it('noteTurn ignores unusable bodies and invalid numbers', () => {
    const st = mkState();
    expect(note(st, null, 100, 50)).toBe(false);
    expect(note(st, body('x'), Number.NaN, 50)).toBe(false);
    expect(st.streak).toBe(0);
  });
});

// ── fast-tier rotation (large-gap shortcut) ──────────────────────────

describe('fast-tier rotation', () => {
  it('production constants stay sane', () => {
    expect(SESSION_EPOCH_DEFAULTS.rotateFastGap).toBe(25000);
    expect(SESSION_EPOCH_DEFAULTS.rotateFastStreak).toBe(3);
    expect(SESSION_EPOCH_DEFAULTS.rotateFastGap).toBeGreaterThan(SESSION_EPOCH_DEFAULTS.rotateMinGap);
    expect(SESSION_EPOCH_DEFAULTS.rotateFastStreak).toBeLessThan(SESSION_EPOCH_DEFAULTS.rotateStreak);
  });

  function fastState(patch: Partial<SessionEpochState> = {}): SessionEpochState {
    return mkState({ cooldown: 0, prevCached: 30000, prevIn: 55000, prevSize: 200, streakHead: 'h', ...patch });
  }

  it('arms at the fast streak with a >= 25K gap, not below', () => {
    expect(rotationArmed(fastState({ streak: 3 }), 300, 'h', { ...C, rotateStreak: 5 })).toBe(true);
    expect(rotationArmed(fastState({ streak: 2 }), 300, 'h', { ...C, rotateStreak: 5 })).toBe(false);
  });

  it('gap boundary: 25K takes fast tier, below falls back to slow rules', () => {
    const c = { ...C, rotateStreak: 5 };
    expect(rotationArmed(fastState({ streak: 3 }), 300, 'h', c)).toBe(true);
    expect(rotationArmed(fastState({ streak: 3, prevIn: 54999 }), 300, 'h', c)).toBe(false);
    expect(rotationArmed(fastState({ streak: 5, prevIn: 54999 }), 300, 'h', c)).toBe(true);
  });

  it('floors, pin, monotonic and head gates still apply', () => {
    const c = { ...C, rotateStreak: 5 };
    expect(rotationArmed(fastState({ streak: 3 }), 5, 'h', c)).toBe(false); // below post floor
    expect(rotationArmed(fastState({ streak: 3, prevCached: 2 }), 300, 'h', c)).toBe(false); // pin
    expect(rotationArmed(fastState({ streak: 3, prevSize: 999 }), 300, 'h', c)).toBe(false); // monotonic
    expect(rotationArmed(fastState({ streak: 3 }), 300, 'other', c)).toBe(false); // head
    expect(rotationArmed(fastState({ streak: 3, cooldown: 1 }), 300, 'h', c)).toBe(false); // cooldown
    expect(rotationArmed(fastState({ streak: 3, prevIn: null }), 300, 'h', c)).toBe(false); // no measurement
  });

  it('end to end: fewer turns needed when the gap is large', () => {
    const st = mkState();
    const c = { ...C, rotateStreak: 5, rotateFastGap: 100, rotateFastStreak: 2 };
    for (let i = 0; i < 3; i += 1) apply(st, body(`g${i}`, 100), { constants: c });
    const b = body('steady', 100);
    noteTurn(st, b, 200, 150, true, c, 0);
    noteTurn(st, b, 260, 150, true, c, 0);
    expect(st.streak).toBe(2);
    expect(apply(st, body('next', 200), { constants: c }).effectiveSession).toBe('sess-e0-r1');
    expect(apply(st, body('next2', 210), { constants: c }).effectiveSession).toBe('sess-e0-r1');
  });
});

// ── suffix + cache-key composition ───────────────────────────────────

describe('suffix composition', () => {
  it('suffixes by era, verbatim only when disabled', () => {
    expect(suffixedSession('s', 0, 0, true)).toBe('s-e0');
    expect(suffixedSession('s', 2, 0, true)).toBe('s-e2');
    expect(suffixedSession('s', 2, 3, true)).toBe('s-e2-r3');
    expect(suffixedSession('s', 2, 3, false)).toBe('s');
  });

  it('suffixed sessions survive cache-key derivation verbatim', () => {
    expect(cacheKeyFor('115e81c5-60ae-45f8-97f6-a88af4e27083-e1')).toBe(
      '115e81c5-60ae-45f8-97f6-a88af4e27083-e1',
    );
    const long = 'x'.repeat(150) + '-e12';
    const k1 = cacheKeyFor(long);
    expect(k1).toBe(cacheKeyFor(long));
    expect(k1!.length).toBeLessThanOrEqual(64);
  });
});
