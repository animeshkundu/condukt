# Shortcomings Fix: Detailed Design

## #9 — HMR-Safe Singleton Factory

### Interface

```typescript
/**
 * Create or retrieve an HMR-safe singleton.
 * Uses Symbol.for() + globalThis to survive module reloads.
 *
 * @param key - Unique identifier. Namespaced as `condukt:hmr:{key}`.
 * @param factory - Called once to create the instance. Never called again for same key.
 * @returns The singleton instance (created or cached).
 */
export function createHmrSingleton<T>(key: string, factory: () => T): T;
```

### Internal Design

```typescript
export function createHmrSingleton<T>(key: string, factory: () => T): T {
  const sym = Symbol.for(`condukt:hmr:${key}`);
  const g = globalThis as Record<symbol, unknown>;
  return (g[sym] ??= factory()) as T;
}
```

### Design Decisions

1. **`Symbol.for()` over string keys**: `Symbol.for()` returns the same symbol across module instances (even when loaded twice by different bundlers). String keys on `globalThis` risk naming collisions with other libraries. This matches the existing gate registry pattern in `src/nodes.ts`.

2. **`condukt:hmr:` namespace prefix**: Prevents collision with other `Symbol.for()` users. The prefix is framework-specific but generic within condukt.

3. **Synchronous factory**: Singletons are created eagerly on first access. Async factories would require a different API (`getOrCreateAsync`) that complicates the common case. Consumer setup hooks handle async initialization separately.

4. **No `dispose()` or `clear()`**: Singletons are permanent for the lifetime of the process. HMR survival is the whole point — clearing defeats the purpose. If a consumer needs to reset state, they should put a reset method on the singleton itself.

### Edge Cases

- **Concurrent module load**: Two modules call `createHmrSingleton('x', ...)` simultaneously. The `??=` operator is atomic within a single JS turn. Both get the same instance.
- **Different types for same key**: TypeScript catches this at compile time if the consumer uses proper typing. At runtime, the first factory wins — subsequent calls return the cached instance regardless of the generic parameter.

### Test Cases (4)

1. First call creates instance via factory
2. Second call returns same reference (factory not called again)
3. Different keys return different instances
4. Type safety: generic parameter flows through

---

## #8 — Per-Execution Setup Cache

### Interface

```typescript
/**
 * Execute a setup function at most once per (dir, key) pair.
 * Concurrent calls with the same (dir, key) return the same Promise (dedup).
 * Failed Promises are evicted so the next call retries.
 *
 * @param dir - Execution directory (first dimension of the cache key)
 * @param key - Setup identifier (second dimension, e.g., "repo-clone", "env-init")
 * @param fn - The setup function. Called at most once per unique (dir, key).
 */
export function setupOnce(dir: string, key: string, fn: () => Promise<void>): Promise<void>;

/**
 * Clear the setup cache. If dir is provided, clears only entries for that directory.
 * If no dir, clears everything. Useful for testing and teardown.
 */
export function clearSetupCache(dir?: string): void;
```

### Internal Design

```typescript
const CACHE_SYM = Symbol.for('condukt:setup-once-cache');
const g = globalThis as Record<symbol, unknown>;

function getCache(): Map<string, Promise<void>> {
  return ((g[CACHE_SYM] as Map<string, Promise<void>>) ??= new Map());
}

export function setupOnce(dir: string, key: string, fn: () => Promise<void>): Promise<void> {
  const cache = getCache();
  const cacheKey = `${dir}\0${key}`;  // null byte separator (can't appear in paths)

  const existing = cache.get(cacheKey);
  if (existing) return existing;

  const promise = fn().catch((err) => {
    cache.delete(cacheKey);  // Evict on failure — allow retry
    throw err;
  });

  cache.set(cacheKey, promise);
  return promise;
}

export function clearSetupCache(dir?: string): void {
  const cache = getCache();
  if (!dir) {
    cache.clear();
    return;
  }
  const prefix = `${dir}\0`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
```

### Design Decisions

1. **`globalThis`-backed cache**: Survives HMR reloads (same rationale as #9). Uses `Symbol.for()` for isolation.

2. **Null byte separator**: `\0` cannot appear in filesystem paths or typical string keys. This prevents key collision between `(dir="a:b", key="c")` and `(dir="a", key="b:c")`.

3. **Failed Promise eviction**: If `fn()` rejects, the cache entry is deleted. The next call to `setupOnce(dir, key, fn)` will call `fn()` again. This handles transient failures (network errors, race conditions) without permanent cache poisoning.

4. **No TTL / expiration**: Setup operations (repo clone, env init) are idempotent and expensive. Once done, they don't need re-doing. The cache is cleared explicitly via `clearSetupCache()` or when the process restarts.

5. **Promise dedup (not mutex)**: Multiple concurrent calls get the same Promise instance. This is simpler than a mutex and provides the exact semantics needed: "run this once, share the result."

### Edge Cases

- **Concurrent calls**: Two nodes call `setupOnce(dir, "clone", cloneFn)` simultaneously. The first call creates the Promise and caches it. The second call finds the cached Promise and returns it. `cloneFn` is called exactly once.
- **Failed setup, then retry**: First call fails (Promise rejects). Cache entry is evicted in the `.catch()` handler. Second call finds no cache entry and calls `fn()` again.
- **Different dir, same key**: Each (dir, key) pair is independent. `setupOnce("/exec/1", "clone", fn)` and `setupOnce("/exec/2", "clone", fn)` each call `fn` once.

### Test Cases (5)

1. First call executes fn, returns resolved Promise
2. Second call returns same Promise (fn not called again)
3. Different dir+key pairs execute independently
4. Failed Promise evicted — next call retries
5. `clearSetupCache()` clears all; `clearSetupCache(dir)` clears per-dir

---

## #7 — SSE Streaming Route Export

### Interface

```typescript
/**
 * Minimal event-bus abstraction for SSE subscription.
 * Consumers pass their own pub-sub implementation.
 */
export interface EventBusLike {
  subscribe(fn: (event: ExecutionEvent | OutputEvent) => void): () => void;
}

/**
 * StateRuntime-like interface for reading stored state.
 * Matches StateRuntime's public API without importing it (avoids circular dep).
 */
export interface StateRuntimeLike {
  getProjection(execId: string): ExecutionProjection | null;
  getNodeOutput(execId: string, nodeId: string, offset: number, limit: number): OutputPage;
}

/**
 * Create a ReadableStream that:
 * 1. Replays the current execution projection as a 'snapshot' event
 * 2. Subscribes to live events filtered by executionId
 * 3. Sends heartbeat every heartbeatMs (default 30000)
 * 4. Cleans up on stream cancellation
 */
export function createExecutionSSEStream(
  stateRuntime: StateRuntimeLike,
  eventBus: EventBusLike,
  executionId: string,
  heartbeatMs?: number,
): ReadableStream<Uint8Array>;

/**
 * Create a ReadableStream that:
 * 1. Replays existing output lines for the node
 * 2. Subscribes to live events filtered by executionId AND nodeId
 * 3. Sends heartbeat every heartbeatMs (default 30000)
 * 4. Cleans up on stream cancellation
 */
export function createNodeSSEStream(
  stateRuntime: StateRuntimeLike,
  eventBus: EventBusLike,
  executionId: string,
  nodeId: string,
  heartbeatMs?: number,
): ReadableStream<Uint8Array>;
```

### Internal Design

Both functions share a common `createSSEStream` helper:

```typescript
function createSSEStream(
  replayFn: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  filterFn: (event: ExecutionEvent | OutputEvent) => boolean,
  eventBus: EventBusLike,
  heartbeatMs: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;

  return new ReadableStream({
    start(controller) {
      replayFn(controller);

      const unsubscribe = eventBus.subscribe((event) => {
        if (!filterFn(event)) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch { /* Stream closed */ }
      });

      const timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() })}\n\n`));
        } catch {
          clearInterval(timer);
        }
      }, heartbeatMs);

      cleanup = () => {
        unsubscribe();
        clearInterval(timer);
      };
    },
    cancel() {
      cleanup?.();
    },
  });
}
```

### Design Decisions

1. **`StateRuntimeLike` + `EventBusLike` interfaces**: Defined locally in `bridge/sse.ts`. Avoids importing the actual `StateRuntime` class (which would create a tight coupling). Consumers pass whatever object satisfies the interface.

2. **Returns `ReadableStream`, not `Response`**: The stream is framework-agnostic. Consumer wraps it in their framework's response object (Next.js `Response`, Express `res.pipe()`, etc.). This keeps the bridge layer free of HTTP framework dependencies.

3. **SSE format (`data: ...\n\n`)**: Standard SSE format. Consumers don't need to add their own SSE formatting.

4. **No `id:` or `event:` fields**: Simplicity. The event `type` field inside the JSON payload provides sufficient routing. SSE `id:` (for reconnection) is a consumer concern.

### Edge Cases

- **Empty projection**: `getProjection()` returns null. No snapshot event is sent. Live events start immediately.
- **Stream cancelled mid-write**: `enqueue()` throws. Caught silently — the `cancel()` callback handles cleanup.
- **Event bus emits after cancel**: `unsubscribe()` is called in `cancel()`. If a race occurs, the `try/catch` around `enqueue` handles it.

### Test Cases (6)

1. Snapshot replayed first (execution stream)
2. Live events streamed after snapshot
3. Heartbeat sent at configured interval
4. Cancel triggers cleanup (unsubscribe + clearInterval)
5. Node stream filters by both executionId and nodeId
6. Empty replay (no stored state) — stream starts with live events only

---

## #1 — Retry Context feedbackExtractor

### Interface Change

Add one optional field to `LoopFallbackEntry`:

```typescript
export interface LoopFallbackEntry {
  readonly source: string;
  readonly action: string;
  readonly fallbackTarget: EdgeTarget;
  readonly maxIterations?: number;
  /** NEW: Transform source node output into rich feedback for loop-back targets. */
  readonly feedbackExtractor?: (
    sourceOutput: string | null,
    sourceMetadata: Record<string, unknown>,
  ) => string;
}
```

### Scheduler Change

At `scheduler.ts` lines 699-702, replace:

```typescript
// BEFORE:
loopRetryContexts.set(target, {
  priorOutput,
  feedback: `iteration ${currentIteration}`,
});
```

With:

```typescript
// AFTER:
const loopKey = `${nodeId}:${action}`;
const fallbackEntry = graph.loopFallback?.[loopKey];
const feedback = fallbackEntry?.feedbackExtractor
  ? fallbackEntry.feedbackExtractor(output.artifact ?? null, output.metadata ?? {})
  : `iteration ${currentIteration}`;
loopRetryContexts.set(target, { priorOutput, feedback });
```

Note: `loopKey` is already computed at line 652. `output` is from the `newlyCompleted` loop at line 634 — it's the source node's (convergenceCheck's) output, which contains the convergence report as `artifact`. The `fallbackEntry` variable already exists at line 657 but is scoped to the `if (currentIteration > maxIter)` branch — we need to hoist it or recompute it.

### Design Decisions

1. **Callback on `LoopFallbackEntry`, not on `FlowGraph`**: The feedback extraction is specific to a particular loop edge (e.g., `convergenceCheck:diverged`), not global. Different loops in the same graph may need different extractors.

2. **Receives `(sourceOutput, sourceMetadata)`, not `(NodeOutput)`**: The callback gets the string artifact and metadata dict — the consumer doesn't need to import `NodeOutput` type. This keeps the callback signature simple and decoupled.

3. **Fallback to `"iteration N"`**: If no `feedbackExtractor` is provided, behavior is identical to current. Full backward compatibility.

4. **Source output, not target output**: The extractor receives the output from the SOURCE node (the convergence checker), not the TARGET node (the investigator). The source decided "diverged" and its artifact explains why — that's the feedback the targets need.

### Test Case

Add to `__tests__/loop-back.test.ts`:
- Graph with `feedbackExtractor` that returns `"Disagree on: metric X"` from source artifact
- Verify loop-back target's `input.retryContext.feedback === "Disagree on: metric X"`
- Verify without feedbackExtractor, feedback is still `"iteration 1"`

---

## #6 — Thinking/Reasoning Token Streaming

### JSONL Format (from `--output-format json`)

The copilot CLI with `--output-format json` emits one JSON object per line:

```jsonl
{"type":"assistant.reasoning_delta","content":"Let me think about..."}
{"type":"assistant.message_delta","content":"The investigation shows..."}
{"type":"assistant.tool_start","tool":"Read","input":"/path/to/file"}
{"type":"assistant.tool_complete","tool":"Read","output":"file contents..."}
{"type":"result","result":"idle","cost":{"tokens":1500,"model":"claude-opus-4.6"}}
```

### Event Type

```typescript
export interface NodeReasoningEvent {
  readonly type: 'node:reasoning';
  readonly executionId: string;
  readonly nodeId: string;
  readonly content: string;
  readonly ts: number;
}

export type OutputEvent = NodeOutputEvent | NodeToolEvent | NodeReasoningEvent;
```

### AgentSession Interface Extension

```typescript
// In src/types.ts - AgentSession
on(event: 'reasoning', handler: (text: string) => void): void;

// In runtimes/copilot/copilot-backend.ts - CopilotSession
on(event: 'reasoning', handler: (text: string) => void): void;
```

### SubprocessBackend Changes

1. Add `'--output-format', 'json'` to CLI args
2. Replace readline text handler with JSONL parser:

```typescript
rl.on('line', (line: string) => {
  this.resetHeartbeat();

  // Try to parse as JSONL
  let parsed: Record<string, unknown> | null = null;
  try {
    if (line.startsWith('{')) {
      parsed = JSON.parse(line);
    }
  } catch {
    // Not JSON — fall through to text handler
  }

  if (parsed && typeof parsed.type === 'string') {
    switch (parsed.type) {
      case 'assistant.reasoning_delta':
        this.emit('reasoning', String(parsed.content ?? ''));
        break;
      case 'assistant.message_delta':
        this.emit('text', String(parsed.content ?? ''));
        break;
      case 'assistant.tool_start':
        this.emit('tool_start', String(parsed.tool ?? ''), String(parsed.input ?? ''));
        break;
      case 'assistant.tool_complete':
        this.emit('tool_complete', String(parsed.tool ?? ''), String(parsed.output ?? ''));
        break;
      default:
        // Unknown JSONL event — emit as text for visibility
        this.emit('text', line);
    }
  } else {
    // Non-JSON line — emit as text (robustness)
    this.emit('text', line);
  }
});
```

### Agent Factory Wiring

```typescript
// In src/agent.ts, after session.on('text', ...) block:
session.on('reasoning', (text: string) => {
  ctx.emitOutput({
    type: 'node:reasoning',
    executionId: ctx.executionId,
    nodeId: ctx.nodeId,
    content: text,
    ts: Date.now(),
  });
});
```

Note: reasoning tokens are NOT added to `outputLines[]` — they should not be included in GT-3 crash recovery artifact reconstruction. Only message content goes into the artifact.

### Design Decisions

1. **JSONL over raw text**: The `--output-format json` flag is the copilot CLI's structured output mode. It's the correct way to distinguish event types. Raw text parsing (regex for `[thinking]` markers) is fragile.

2. **Non-JSON fallback**: Lines that don't parse as JSON are emitted as `text` events. This handles startup messages, errors, and future CLI output that isn't JSONL-formatted. The system degrades gracefully.

3. **`node:reasoning` is OutputEvent (not ExecutionEvent)**: Reasoning tokens are streamed, not persisted to the JSONL event log. They're ephemeral — valuable during live observation, not for state reconstruction.

4. **`reasoning` not added to `outputLines`**: The GT-3 crash recovery system reconstructs artifacts from `outputLines`. Reasoning tokens are internal to the model's thinking process and should not appear in artifacts.

5. **EventHandler union extension**: The `EventHandler` discriminated union in subprocess-backend.ts needs a new member for `reasoning`.

### Test Cases (8)

1. `assistant.reasoning_delta` → `reasoning` event emitted
2. `assistant.message_delta` → `text` event emitted
3. `assistant.tool_start` → `tool_start` event emitted
4. `assistant.tool_complete` → `tool_complete` event emitted
5. Non-JSON line → `text` event (fallback)
6. Empty line → skipped (no event)
7. Malformed JSON → `text` event (fallback)
8. Interleaved reasoning + message deltas → correct event sequence

---

## #3 — State Barrel Split

### New File: `state/server.ts`

```typescript
export { FileStorage } from './storage';
```

### Modified: `state/index.ts`

```typescript
// BEFORE:
export { reduce, createEmptyProjection, replayEvents } from './reducer';
export { FileStorage } from './storage';
export { MemoryStorage } from './storage-memory';
export { StateRuntime } from './state-runtime';

// AFTER:
export { reduce, createEmptyProjection, replayEvents } from './reducer';
export { MemoryStorage } from './storage-memory';
export { StateRuntime } from './state-runtime';
// FileStorage moved to condukt/state/server (requires fs)
```

### Design Decisions

1. **`state/server` not `state/node`**: "server" is clearer — this is for server-side code. Matches Next.js convention (`'use server'`).

2. **StateRuntime stays in `state/`**: StateRuntime depends on `StorageEngine` interface, not on `FileStorage` directly. Client code can use `StateRuntime` with `MemoryStorage`. Only `FileStorage` needs `fs`.

3. **Verify**: The test confirms `condukt/state` can be imported without `fs` available. This validates the split works correctly.

---

## #4 — ANSI Utilities Separate Export

### New File: `utils/index.ts`

```typescript
export { ansiToHtml, stripAnsi, hasAnsi } from '../ui/ansi';
```

### Design Decision

Re-export, not copy. Single source of truth remains `ui/ansi.ts`. The `utils/` path is a lighter import for consumers who don't need React components or CSS.

---

## #2 — postcss-import CSS Resolution

### New File: `ui/style.css`

```css
@import '../dist/ui/style.css';
```

This is a physical redirect file. When postcss-import resolves `condukt/ui/style.css`, it finds this file in the package root (via the `files` array including `ui/style.css`), follows the `@import`, and resolves the actual CSS from `dist/`.

### Design Decision

The `@import` redirect is the standard postcss-import pattern for packages with build output in a `dist/` directory. It avoids duplicating the CSS file and works with all CSS tooling (postcss, webpack css-loader, Turbopack).

---

## #5 — Turbopack Compatibility

### Export Condition Schema

Each export entry gets three conditions:

```json
{
  "types": "./dist/.../index.d.ts",
  "import": "./dist/.../index.js",
  "require": "./dist/.../index.js",
  "default": "./dist/.../index.js"
}
```

Since condukt currently builds to CJS only, `import` and `require` point to the same file. When ESM build is added later, `import` would point to the ESM output.

### Design Decision

Turbopack's resolver requires explicit `import` and `require` conditions. The current `types` + `default` is insufficient. Adding all three conditions ensures resolution works in all bundlers: webpack, Turbopack, esbuild, Vite.
