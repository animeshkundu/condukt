import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileStorage } from '../state/storage';
import { MemoryStorage } from '../state/storage-memory';
import { StateRuntime } from '../state/state-runtime';
import { rebaseSnapshot, snapshotDigest, validateSnapshot } from '../state/snapshot';
import type { ExecutionEvent } from '../src/events';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-'));
}

function started(execId: string, params: Record<string, unknown> = {}): ExecutionEvent {
  return {
    type: 'run:started',
    executionId: execId,
    flowId: 'f',
    params,
    graph: { nodes: [], edges: [] },
    ts: 1,
  };
}

function nodeStarted(execId: string, nodeId: string, ts: number): ExecutionEvent {
  return { type: 'node:started', executionId: execId, nodeId, ts };
}

describe('execution state snapshots', () => {
  it('round-trips an execution history and rebuilds its projection', async () => {
    const root = tempRoot();
    const runtime = new StateRuntime(new FileStorage(root));
    await runtime.handleEvent(started('exec-a', { workspace: '/one' }));
    await runtime.handleEvent(nodeStarted('exec-a', 'alpha', 2));

    const snapshot = await runtime.captureExecutionSnapshot('exec-a');
    expect(snapshot.sequence).toBe(2);
    expect(() => validateSnapshot(snapshot)).not.toThrow();

    const restoredRoot = tempRoot();
    const restoredRuntime = new StateRuntime(new FileStorage(restoredRoot));
    const projection = await restoredRuntime.restoreExecutionSnapshot(snapshot);

    expect(projection.id).toBe('exec-a');
    expect(restoredRuntime.readEvents('exec-a')).toHaveLength(2);
    expect(restoredRuntime.getProjection('exec-a')?.params).toEqual({ workspace: '/one' });
  });

  it('restores under a new execution id and rewritten run params', async () => {
    const runtime = new StateRuntime(new FileStorage(tempRoot()));
    await runtime.handleEvent(started('exec-original', { workspace: '/old', ask: 'first' }));
    await runtime.handleEvent(nodeStarted('exec-original', 'alpha', 2));
    const snapshot = await runtime.captureExecutionSnapshot('exec-original');

    const target = new StateRuntime(new FileStorage(tempRoot()));
    const projection = await target.restoreExecutionSnapshot(snapshot, {
      targetExecutionId: 'exec-resumed',
      mapRunParams: (params) => ({ ...params, workspace: '/new' }),
    });

    expect(projection.id).toBe('exec-resumed');
    expect(projection.params).toEqual({ workspace: '/new', ask: 'first' });
    // Every event follows the new id, so a resumed run cannot collide with its source.
    expect(target.readEvents('exec-resumed').every((e) => e.executionId === 'exec-resumed'))
      .toBe(true);
    expect(target.readEvents('exec-original')).toHaveLength(0);
  });

  it('refuses a snapshot whose events do not match its digest', async () => {
    const runtime = new StateRuntime(new FileStorage(tempRoot()));
    await runtime.handleEvent(started('exec-tamper'));
    const snapshot = await runtime.captureExecutionSnapshot('exec-tamper');

    const tampered = {
      ...snapshot,
      events: [...snapshot.events, nodeStarted('exec-tamper', 'injected', 9)],
    };

    expect(() => validateSnapshot(tampered)).toThrow(/sequence 1 does not match 2 events/u);
    await expect(
      new StateRuntime(new FileStorage(tempRoot())).restoreExecutionSnapshot(tampered),
    ).rejects.toThrow(/sequence/u);

    const swapped = { ...snapshot, digest: snapshotDigest([]) };
    expect(() => validateSnapshot(swapped)).toThrow(/digest mismatch/u);
  });

  it('captures under the per-execution lock, so an in-flight append cannot be half-seen',
    async () => {
      const root = tempRoot();
      const runtime = new StateRuntime(new FileStorage(root));
      await runtime.handleEvent(started('exec-race'));

      // Queue an append and a capture in the same tick. The lock is a promise chain, so the
      // capture must observe the append as fully applied or not at all -- never a log whose
      // last record is still being written. Reading the file directly is what cannot promise
      // this, and is why capture lives on StateRuntime rather than on the storage engine.
      const append = runtime.handleEvent(nodeStarted('exec-race', 'beta', 2));
      const capture = runtime.captureExecutionSnapshot('exec-race');
      const [, snapshot] = await Promise.all([append, capture]);

      expect(snapshot.sequence).toBe(2);
      expect(() => validateSnapshot(snapshot)).not.toThrow();
    });

  it('applies the redaction transform before digesting', async () => {
    const runtime = new StateRuntime(new FileStorage(tempRoot()));
    await runtime.handleEvent(started('exec-secret', { token: 'super-secret' }));

    const snapshot = await runtime.captureExecutionSnapshot('exec-secret', {
      transform: (event) => (event.type === 'run:started'
        ? { ...event, params: { ...event.params, token: '[redacted]' } }
        : event),
    });

    expect(JSON.stringify(snapshot.events)).not.toContain('super-secret');
    // The digest covers what was actually stored, so a restore verifies the redacted set.
    expect(() => validateSnapshot(snapshot)).not.toThrow();
    expect(snapshot.digest).toBe(snapshotDigest(snapshot.events));
  });

  it('rejects a storage engine that cannot replace a log rather than appending a second copy',
    async () => {
      const runtime = new StateRuntime(new FileStorage(tempRoot()));
      await runtime.handleEvent(started('exec-append-only'));
      const snapshot = await runtime.captureExecutionSnapshot('exec-append-only');

      const memoryRuntime = new StateRuntime(new MemoryStorage());
      await expect(memoryRuntime.restoreExecutionSnapshot(snapshot))
        .rejects.toThrow(/replaceEvents is not implemented/u);
    });

  it('replaces the log atomically, leaving no partial file behind', () => {
    const root = tempRoot();
    const storage = new FileStorage(root);
    storage.appendEvent('exec-atomic', started('exec-atomic'));
    storage.appendEvent('exec-atomic', nodeStarted('exec-atomic', 'alpha', 2));

    storage.replaceEvents('exec-atomic', [started('exec-atomic', { replaced: true })]);

    expect(storage.readEvents('exec-atomic')).toHaveLength(1);
    const leftovers = fs.readdirSync(path.join(root, 'exec-atomic'))
      .filter((name) => name.includes('.restore-'));
    expect(leftovers).toEqual([]);
  });

  it('digests incrementally rather than serializing the whole history at once', () => {
    // A long run's log is exactly where a single JSON.stringify of everything hits the engine's
    // maximum string length. Guard the property by digesting a history far larger than any
    // single string this would otherwise build.
    const events = Array.from({ length: 20_000 }, (_, i) =>
      nodeStarted('exec-big', `node-${i}`, i));
    const spy = vi.spyOn(JSON, 'stringify');

    const digest = snapshotDigest(events);

    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // One stringify per event, never one over the whole array.
    expect(spy.mock.calls.every((call) => !Array.isArray(call[0]))).toBe(true);
    spy.mockRestore();
  });

  it('rebase is pure and recomputes the digest', () => {
    const events = [started('exec-pure', { a: 1 })];
    const snapshot = {
      schemaVersion: 1 as const,
      executionId: 'exec-pure',
      sequence: 1,
      events,
      digest: snapshotDigest(events),
      capturedAt: 5,
    };

    const rebased = rebaseSnapshot(snapshot, { targetExecutionId: 'exec-new' });

    expect(snapshot.executionId).toBe('exec-pure');
    expect(snapshot.events[0]!.executionId).toBe('exec-pure');
    expect(rebased.executionId).toBe('exec-new');
    expect(() => validateSnapshot(rebased)).not.toThrow();
    expect(rebased.capturedAt).toBe(5);
  });
});
