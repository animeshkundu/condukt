/**
 * Epoch sidecar persistence (opencode.py `_epoch_load` /
 * `_epoch_write_snapshot` parity): strict shape validation, TTL GC on
 * the write path, atomic temp+rename writes, shared in-process stores.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearSharedEpochStores,
  epochEntry,
  readEpochStore,
  sharedEpochStore,
  validateEpochEntry,
  writeEpochStore,
} from '../../../runtimes/claude/epoch-store';
import { epochConstants, initialEpochState } from '../../../runtimes/claude/session-epoch';

const C = epochConstants({ ttlMs: 7 * 86400_000 });

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'condukt-epochs-'));
  file = path.join(dir, 'epochs.json');
  clearSharedEpochStores();
});

afterEach(() => {
  clearSharedEpochStores();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function goodEntry(now: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { epoch: 2, max: 500, calm: 1, seen: ['h'], cooldown: 0, lastSeen: now, ...patch };
}

describe('epoch store validation', () => {
  it('accepts a well-formed entry and defaults absent optional fields', () => {
    const now = Date.now();
    const st = validateEpochEntry(goodEntry(now), now, C);
    expect(st).not.toBeNull();
    expect(st!.epoch).toBe(2);
    expect(st!.max).toBe(500);
    expect(st!.rot).toBe(0);
    expect(st!.streak).toBe(0);
    expect(st!.prevIn).toBeNull();
    expect(st!.streakHead).toBeNull();
  });

  it('skips wrong shapes, bools, negatives, future and ancient timestamps', () => {
    const now = Date.now();
    expect(validateEpochEntry(goodEntry(now, { lastSeen: undefined }), now, C)).toBeNull();
    expect(validateEpochEntry(goodEntry(now, { epoch: true }), now, C)).toBeNull();
    expect(validateEpochEntry(goodEntry(now, { epoch: -1 }), now, C)).toBeNull();
    expect(validateEpochEntry(goodEntry(now, { max: 'big' }), now, C)).toBeNull();
    expect(validateEpochEntry(goodEntry(now, { lastSeen: now + 3600 }), now, C)).toBeNull();
    expect(validateEpochEntry(goodEntry(now, { lastSeen: now - 8 * 86400_000 }), now, C)).toBeNull();
    expect(validateEpochEntry(goodEntry(now, { prevSize: true }), now, C)).toBeNull();
    expect(validateEpochEntry(goodEntry(now, { streakHead: 42 }), now, C)).toBeNull();
    expect(validateEpochEntry([1, 2, 3], now, C)).toBeNull();
    expect(validateEpochEntry(null, now, C)).toBeNull();
  });

  it('filters non-string seen entries and caps history', () => {
    const now = Date.now();
    const seen = [1, 'a', null, 'b', ...Array.from({ length: 90 }, (_, i) => `h${i}`)];
    const st = validateEpochEntry(goodEntry(now, { seen }), now, C);
    expect(st).not.toBeNull();
    expect(st!.seen.every((h) => typeof h === 'string')).toBe(true);
    expect(st!.seen.length).toBeLessThanOrEqual(64);
  });

  it('corrupt or missing files read as empty (fail open)', () => {
    fs.writeFileSync(file, '{not json', 'utf8');
    expect(readEpochStore(file, Date.now(), C)).toEqual({});
    fs.writeFileSync(file, JSON.stringify([1, 2]), 'utf8');
    expect(readEpochStore(file, Date.now(), C)).toEqual({});
    expect(readEpochStore(path.join(dir, 'nope.json'), Date.now(), C)).toEqual({});
  });

  it('loads a mixed document: only the valid entry survives', () => {
    const now = Date.now();
    fs.writeFileSync(
      file,
      JSON.stringify({
        good: goodEntry(now),
        'no-ts': { epoch: 1, max: 500, calm: 0, seen: [], cooldown: 0 },
        'bool-epoch': goodEntry(now, { epoch: true }),
        negative: goodEntry(now, { epoch: -1 }),
        ancient: goodEntry(now, { lastSeen: now - 8 * 86400_000 }),
        future: goodEntry(now, { lastSeen: now + 3600 }),
        'bool-size': goodEntry(now, { prevSize: true }),
        junk: [1, 2, 3],
      }),
      'utf8',
    );
    const store = readEpochStore(file, now, C);
    expect(Object.keys(store)).toEqual(['good']);
    expect(store['good'].epoch).toBe(2);
  });
});

describe('epoch store writes', () => {
  it('writes atomically and drops TTL-stale entries on the write path', () => {
    const now = Date.now();
    const store = {
      live: { ...initialEpochState(now), epoch: 1 },
      stale: { ...initialEpochState(now - 8 * 86400_000), epoch: 5 },
    };
    writeEpochStore(file, store, now, C);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(onDisk)).toEqual(['live']);
    expect(onDisk['live'].epoch).toBe(1);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('never throws on an unwritable target', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x', 'utf8');
    expect(() => writeEpochStore(path.join(blocker, 'nested', 'x.json'), {}, Date.now(), C)).not.toThrow();
  });

  it('round-trips full state through disk', () => {
    const now = Date.now();
    const st = {
      ...initialEpochState(now),
      epoch: 3,
      rot: 2,
      max: 12345,
      calm: 1,
      cooldown: 4,
      seen: ['a', 'b'],
      streak: 6,
      prevIn: 55000,
      prevCached: 30000,
      prevSize: 200,
      streakHead: 'h',
    };
    writeEpochStore(file, { s1: st }, now, C);
    clearSharedEpochStores();
    const loaded = readEpochStore(file, now, C);
    expect(loaded['s1']).toEqual(st);
  });
});

describe('shared stores', () => {
  it('returns one store object per resolved path', () => {
    const now = Date.now();
    const a = sharedEpochStore(file, now, C);
    a['s'] = initialEpochState(now);
    const b = sharedEpochStore(file, now, C);
    expect(b).toBe(a);
    expect(b['s']).toBeDefined();
  });

  it('epochEntry creates missing entries and preserves existing ones', () => {
    const now = Date.now();
    const store = sharedEpochStore(file, now, C);
    const st = epochEntry(store, 's', now);
    st.epoch = 4;
    expect(epochEntry(store, 's', now + 1000)).toBe(st);
    expect(epochEntry(store, 's', now + 1000).epoch).toBe(4);
  });

  it('clearing shared caches forces a fresh disk load (restart simulation)', () => {
    const now = Date.now();
    const store = sharedEpochStore(file, now, C);
    store['s'] = { ...initialEpochState(now), epoch: 2 };
    writeEpochStore(file, store, now, C);
    clearSharedEpochStores();
    const reloaded = sharedEpochStore(file, now, C);
    expect(reloaded['s'].epoch).toBe(2);
  });

  it('TTL-GC evicts stale sessions from the shared in-memory store on write', () => {
    const now = Date.now();
    const store = sharedEpochStore(file, now, C);
    store['old'] = { ...initialEpochState(now), lastSeen: now - C.ttlMs - 1 };
    store['fresh'] = initialEpochState(now);
    writeEpochStore(file, store, now, C);
    expect(store['old']).toBeUndefined();
    expect(store['fresh']).toBeDefined();
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk['old']).toBeUndefined();
    expect(onDisk['fresh']).toBeDefined();
  });
});
