import { describe, it, expect, vi, afterEach } from 'vitest';
import { setupOnce, clearSetupCache } from '../src/setup-once';

afterEach(() => {
  clearSetupCache();
});

// ---------------------------------------------------------------------------
// setupOnce() tests
// ---------------------------------------------------------------------------

describe('setupOnce', () => {
  it('executes fn on first call', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const result = setupOnce('/dir', 'key', fn);
    await result;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent calls', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const p1 = setupOnce('/dir', 'key', fn);
    const p2 = setupOnce('/dir', 'key', fn);
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('different keys execute independently', async () => {
    const fn1 = vi.fn().mockResolvedValue(undefined);
    const fn2 = vi.fn().mockResolvedValue(undefined);
    const fn3 = vi.fn().mockResolvedValue(undefined);

    await Promise.all([
      setupOnce('/dir1', 'keyA', fn1),
      setupOnce('/dir2', 'keyA', fn2),
      setupOnce('/dir1', 'keyB', fn3),
    ]);

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
    expect(fn3).toHaveBeenCalledTimes(1);
  });

  it('retries after failure', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('setup failed'))
      .mockResolvedValueOnce(undefined);

    await expect(setupOnce('/dir', 'key', fn)).rejects.toThrow('setup failed');
    await setupOnce('/dir', 'key', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clearSetupCache clears all or per-dir', async () => {
    const fn1 = vi.fn().mockResolvedValue(undefined);
    const fn2 = vi.fn().mockResolvedValue(undefined);

    // Populate cache
    await setupOnce('dir1', 'keyA', fn1);
    await setupOnce('dir2', 'keyA', fn2);
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);

    // Clear only dir1
    clearSetupCache('dir1');

    // dir1 entry was cleared — fn should be called again
    const fn1b = vi.fn().mockResolvedValue(undefined);
    await setupOnce('dir1', 'keyA', fn1b);
    expect(fn1b).toHaveBeenCalledTimes(1);

    // dir2 entry still cached — fn should NOT be called
    const fn2b = vi.fn().mockResolvedValue(undefined);
    await setupOnce('dir2', 'keyA', fn2b);
    expect(fn2b).not.toHaveBeenCalled();

    // Clear everything
    clearSetupCache();
    const fn2c = vi.fn().mockResolvedValue(undefined);
    await setupOnce('dir2', 'keyA', fn2c);
    expect(fn2c).toHaveBeenCalledTimes(1);
  });
});
