/**
 * HMR-safe singleton factory.
 * Uses Symbol.for() + globalThis to survive module reloads in Next.js dev mode.
 */
export function createHmrSingleton<T>(key: string, factory: () => T): T {
  const sym = Symbol.for(`condukt:hmr:${key}`);
  const g = globalThis as Record<symbol, unknown>;
  return (g[sym] ??= factory()) as T;
}
