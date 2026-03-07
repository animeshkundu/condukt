const CACHE_SYM = Symbol.for('condukt:setup-once-cache');

function getCache(): Map<string, Promise<void>> {
  const g = globalThis as Record<symbol, unknown>;
  return ((g[CACHE_SYM] as Map<string, Promise<void>>) ??= new Map());
}

/**
 * Execute a setup function at most once per (dir, key) pair.
 * Concurrent calls with the same (dir, key) return the same Promise (dedup).
 * Failed Promises are evicted so the next call retries.
 */
export function setupOnce(dir: string, key: string, fn: () => Promise<void>): Promise<void> {
  const cache = getCache();
  const cacheKey = `${dir}\0${key}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;

  const promise = fn().catch((err: unknown) => {
    cache.delete(cacheKey);
    throw err;
  });
  cache.set(cacheKey, promise);
  return promise;
}

/**
 * Clear the setup cache. If dir is provided, clears only that directory's entries.
 */
export function clearSetupCache(dir?: string): void {
  const cache = getCache();
  if (!dir) { cache.clear(); return; }
  const prefix = `${dir}\0`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
