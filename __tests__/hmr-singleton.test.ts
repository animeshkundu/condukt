/**
 * HMR-safe singleton factory tests.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmrSingleton } from '../src/hmr-singleton';

// ---------------------------------------------------------------------------
// Cleanup — remove globalThis symbols after each test
// ---------------------------------------------------------------------------

afterEach(() => {
  const g = globalThis as Record<symbol, unknown>;
  for (const key of ['test-create', 'test-cached', 'test-key-a', 'test-key-b', 'test-typed']) {
    delete g[Symbol.for(`condukt:hmr:${key}`)];
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createHmrSingleton', () => {
  it('creates instance on first call', () => {
    const instance = createHmrSingleton('test-create', () => ({ value: 42 }));
    expect(instance).toEqual({ value: 42 });
  });

  it('returns cached instance on subsequent calls', () => {
    const factory = vi.fn(() => ({ value: 99 }));

    const first = createHmrSingleton('test-cached', factory);
    const second = createHmrSingleton('test-cached', factory);

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('different keys return different instances', () => {
    const a = createHmrSingleton('test-key-a', () => ({ id: 'a' }));
    const b = createHmrSingleton('test-key-b', () => ({ id: 'b' }));

    expect(a).not.toBe(b);
    expect(a.id).toBe('a');
    expect(b.id).toBe('b');
  });

  it('preserves type safety', () => {
    const instance = createHmrSingleton('test-typed', () => ({ count: 7 }));
    // TypeScript ensures .count is accessible as number
    expect(instance.count).toBe(7);
    expect(typeof instance.count).toBe('number');
  });
});
