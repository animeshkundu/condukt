# Shortcomings Fix: Implementation Guide

> This is the implementation specification for agent teams. Each section is a self-contained brief.

## Repository: `Q:\Software\investigation\condukt\`
## Branch: `feat/shortcomings-0.2.2-0.3.1`

---

## Phase 1: Safe Additions → 0.2.2

### TASK 1A: HMR Singleton (#9)

**Create** `src/hmr-singleton.ts`:
```typescript
/**
 * HMR-safe singleton factory.
 * Uses Symbol.for() + globalThis to survive module reloads in Next.js dev mode.
 */
export function createHmrSingleton<T>(key: string, factory: () => T): T {
  const sym = Symbol.for(`condukt:hmr:${key}`);
  const g = globalThis as Record<symbol, unknown>;
  return (g[sym] ??= factory()) as T;
}
```

**Modify** `src/index.ts` — add after line 5 (the verify export):
```typescript
export { createHmrSingleton } from './hmr-singleton';
```

**Create** `__tests__/hmr-singleton.test.ts` with 4 test cases:
1. `'creates instance on first call'` — call factory, verify return value
2. `'returns cached instance on subsequent calls'` — call twice, `toBe()` same reference, factory called once
3. `'different keys return different instances'` — two keys, two different objects
4. `'preserves type safety'` — generic parameter flows (create `{ count: number }`, access `.count`)

Use `Symbol.for()` cleanup in `afterEach` to isolate tests:
```typescript
afterEach(() => {
  const g = globalThis as Record<symbol, unknown>;
  delete g[Symbol.for('condukt:hmr:test-key')];
  // ... other test keys
});
```

**Acceptance**: `npm test -- hmr-singleton` passes, `npm run typecheck` passes.

---

### TASK 1B: Setup Once (#8)

**Create** `src/setup-once.ts`:
```typescript
const CACHE_SYM = Symbol.for('condukt:setup-once-cache');

function getCache(): Map<string, Promise<void>> {
  const g = globalThis as Record<symbol, unknown>;
  return ((g[CACHE_SYM] as Map<string, Promise<void>>) ??= new Map());
}

export function setupOnce(dir: string, key: string, fn: () => Promise<void>): Promise<void> {
  const cache = getCache();
  const cacheKey = `${dir}\0${key}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;

  const promise = fn().catch((err) => {
    cache.delete(cacheKey);
    throw err;
  });
  cache.set(cacheKey, promise);
  return promise;
}

export function clearSetupCache(dir?: string): void {
  const cache = getCache();
  if (!dir) { cache.clear(); return; }
  const prefix = `${dir}\0`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
```

**Modify** `src/index.ts` — add after the hmr-singleton export:
```typescript
export { setupOnce, clearSetupCache } from './setup-once';
```

**Create** `__tests__/setup-once.test.ts` with 5 test cases:
1. `'executes fn on first call'` — fn called, Promise resolves
2. `'deduplicates concurrent calls'` — two `setupOnce()` calls with same key, fn called once, both get same Promise
3. `'independent for different keys'` — different (dir, key) pairs each call fn
4. `'retries after failure'` — fn rejects, next call retries (fn called twice total)
5. `'clearSetupCache clears all or per-dir'` — after clear, fn is called again

Use `clearSetupCache()` in `afterEach` for test isolation.

**Acceptance**: `npm test -- setup-once` passes, `npm run typecheck` passes.

---

### TASK 1C: SSE Streaming (#7)

**Create** `bridge/sse.ts`:

Import types from `../src/types` (`ExecutionProjection`, `OutputPage`) and `../src/events` (`ExecutionEvent`, `OutputEvent`).

Define local interfaces (NOT imported from consumer):
```typescript
export interface EventBusLike {
  subscribe(fn: (event: ExecutionEvent | OutputEvent) => void): () => void;
}

export interface StateRuntimeLike {
  getProjection(execId: string): ExecutionProjection | null;
  getNodeOutput(execId: string, nodeId: string, offset: number, limit: number): OutputPage;
}
```

Implement shared helper `createSSEStream(replayFn, filterFn, eventBus, heartbeatMs)` → `ReadableStream<Uint8Array>`.

Implement two public functions:
- `createExecutionSSEStream(stateRuntime, eventBus, executionId, heartbeatMs = 30_000)`:
  - Replay: send `{ type: 'snapshot', projection }` from `stateRuntime.getProjection(executionId)`
  - Filter: `event.executionId === executionId`
- `createNodeSSEStream(stateRuntime, eventBus, executionId, nodeId, heartbeatMs = 30_000)`:
  - Replay: send each line from `stateRuntime.getNodeOutput(executionId, nodeId, 0, 10_000)` as `{ type: 'node:output', executionId, nodeId, content: line, ts: 0 }`
  - Filter: `event.executionId === executionId && ('nodeId' in event) && (event as { nodeId: string }).nodeId === nodeId`

**Modify** `bridge/index.ts` — add:
```typescript
export { createExecutionSSEStream, createNodeSSEStream } from './sse';
export type { EventBusLike, StateRuntimeLike } from './sse';
```

**Create** `__tests__/sse.test.ts` with 6 test cases:

Use mock implementations of `StateRuntimeLike` and `EventBusLike` (in-memory).

1. `'execution stream replays snapshot first'` — getProjection returns data, verify first chunk is snapshot
2. `'execution stream forwards live events'` — emit event after subscribe, verify stream receives it
3. `'heartbeat sent at configured interval'` — use fake timers, advance time, verify heartbeat chunk
4. `'cancel triggers cleanup'` — cancel stream reader, verify unsubscribe called
5. `'node stream filters by executionId and nodeId'` — emit events for different nodes, verify only matching ones pass
6. `'empty replay works'` — getProjection returns null, stream starts with live events

For reading the stream in tests, use `ReadableStream.getReader()` + `reader.read()`.

**Acceptance**: `npm test -- sse` passes, `npm run typecheck` passes.

---

### TASK 1D: Feedback Extractor (#1)

**Modify** `src/types.ts` line 71-76 — add field to `LoopFallbackEntry`:
```typescript
export interface LoopFallbackEntry {
  readonly source: string;
  readonly action: string;
  readonly fallbackTarget: EdgeTarget;
  readonly maxIterations?: number;
  /** Extract rich feedback from source node output for loop-back retry context. */
  readonly feedbackExtractor?: (
    sourceOutput: string | null,
    sourceMetadata: Record<string, unknown>,
  ) => string;
}
```

**Modify** `src/scheduler.ts` lines 699-702 — replace feedback construction:

Current code (lines 686-702):
```typescript
for (const target of loopBackTargets) {
  const entry = graph.nodes[target];
  let priorOutput: string | null = null;
  if (entry.output) {
    const artifactPath = path.join(dir, entry.output);
    try {
      if (fs.existsSync(artifactPath)) {
        priorOutput = fs.readFileSync(artifactPath, 'utf-8');
      }
    } catch { /* ignore */ }
  }
  loopRetryContexts.set(target, {
    priorOutput,
    feedback: `iteration ${currentIteration}`,
  });
}
```

Replace lines 699-702 (the `loopRetryContexts.set(...)` call) with:
```typescript
const fallback = graph.loopFallback?.[`${nodeId}:${action}`];
const feedback = fallback?.feedbackExtractor
  ? fallback.feedbackExtractor(output.artifact ?? null, output.metadata ?? {})
  : `iteration ${currentIteration}`;
loopRetryContexts.set(target, { priorOutput, feedback });
```

Note: `nodeId` and `action` are the SOURCE node's id and action (from the `newlyCompleted` loop at line 634). `output` is the source node's `NodeOutput` containing `.artifact` (the convergence report) and `.metadata`.

**IMPORTANT**: The variable `fallbackEntry` is already used at line 657 scoped inside the `if (currentIteration > maxIter)` block. To avoid shadowing, use `fallback` as the variable name in the new code, OR move the lookup above both branches.

**Modify** `__tests__/loop-back.test.ts` — add test case:
```typescript
it('uses feedbackExtractor for loop-back retry context', async () => {
  // Build a graph with a convergence loop:
  // A → C, B → C (fan-in), C:diverged → [A, B] (loop-back)
  // feedbackExtractor returns a custom string from C's artifact
  const graph: FlowGraph = {
    nodes: { ... },
    edges: {
      C: { diverged: ['A', 'B'], converged: 'D' },
    },
    start: ['A', 'B'],
    loopFallback: {
      'C:diverged': {
        source: 'C',
        action: 'diverged',
        fallbackTarget: 'D',
        maxIterations: 3,
        feedbackExtractor: (sourceOutput) =>
          `Convergence report: ${sourceOutput?.substring(0, 50) ?? 'none'}`,
      },
    },
  };

  // Run the graph with a mock runtime where C returns action 'diverged' on first iteration
  // and 'converged' on second iteration
  // Verify: A's retryContext.feedback on second run contains "Convergence report: ..."
  // Verify: Without feedbackExtractor, feedback would be "iteration 1"
});
```

Use the MockRuntime. The test should verify `input.retryContext?.feedback` received by A on the second iteration matches the feedbackExtractor's output.

**Acceptance**: `npm test -- loop-back` passes (all existing + new test), `npm run typecheck` passes.

---

### Post-Phase 1 Integration

After all 4 tasks pass:
1. `npm run build` in condukt
2. Bump version in `package.json` to `0.2.2`
3. `npm test` — all 427+ existing tests + ~20 new tests pass
4. `npm pack` — creates `condukt-0.2.2.tgz`
5. In taco-helper: `npm install Q:/Software/investigation/condukt/condukt-0.2.2.tgz`
6. Migrate taco-helper consumer code (separate task)
7. `npm run typecheck && npm test` in taco-helper

---

## Phase 2: Behavioral Changes → 0.3.0

### TASK 2A: Reasoning Token Streaming (#6)

This is the most complex task. Changes span 5 files across 2 layers.

**Step 1: Event type** — Modify `src/events.ts`:

After `NodeToolEvent` (line 208), before the `OutputEvent` union (line 211), add:
```typescript
export interface NodeReasoningEvent {
  readonly type: 'node:reasoning';
  readonly executionId: string;
  readonly nodeId: string;
  readonly content: string;
  readonly ts: number;
}
```

Update the `OutputEvent` union (line 211):
```typescript
export type OutputEvent = NodeOutputEvent | NodeToolEvent | NodeReasoningEvent;
```

**Step 2: AgentSession interface** — Modify `src/types.ts` line 152-161:

Add after line 159 (`on(event: 'error', ...)`):
```typescript
on(event: 'reasoning', handler: (text: string) => void): void;
```

**Step 3: CopilotSession interface** — Modify `runtimes/copilot/copilot-backend.ts` line 27-47:

Add after `on(event: 'error', ...)` (line 43):
```typescript
on(event: 'reasoning', handler: (text: string) => void): void;
```

**Step 4: SubprocessBackend** — Modify `runtimes/copilot/subprocess-backend.ts`:

4a. CLI args (line 94-101): Add `'--output-format', 'json'` to the args array:
```typescript
const args: string[] = [
  '--model', config.model,
  '--output-format', 'json',   // ← NEW: enables JSONL structured output
  '--allow-all',
  ...
];
```

4b. EventHandler type (line 152-157): Add `reasoning` variant:
```typescript
type EventHandler =
  | { event: 'text'; handler: (text: string) => void }
  | { event: 'reasoning'; handler: (text: string) => void }   // ← NEW
  | { event: 'tool_start'; handler: (tool: string, input: string) => void }
  | { event: 'tool_complete'; handler: (tool: string, output: string) => void }
  | { event: 'idle'; handler: () => void }
  | { event: 'error'; handler: (err: Error) => void };
```

4c. stdout handler (lines 227-233): Replace readline handler with JSONL parser:
```typescript
if (this.child.stdout) {
  const rl = createInterface({ input: this.child.stdout });
  rl.on('line', (line: string) => {
    this.resetHeartbeat();

    if (line.trim() === '') return;  // Skip empty lines

    let parsed: Record<string, unknown> | null = null;
    try {
      if (line.startsWith('{')) {
        parsed = JSON.parse(line);
      }
    } catch {
      // Not valid JSON — fall through
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
          // Unknown structured event — emit as text for visibility
          this.emit('text', line);
      }
    } else {
      // Non-JSON line — emit as text (backward compat, startup messages, etc.)
      this.emit('text', line);
    }
  });
}
```

4d. Event overloads (lines 272-279): Add `reasoning`:
```typescript
on(event: 'text', handler: (text: string) => void): void;
on(event: 'reasoning', handler: (text: string) => void): void;   // ← NEW
on(event: 'tool_start', handler: (tool: string, input: string) => void): void;
on(event: 'tool_complete', handler: (tool: string, output: string) => void): void;
on(event: 'idle', handler: () => void): void;
on(event: 'error', handler: (err: Error) => void): void;
on(event: 'text' | 'reasoning' | 'tool_start' | 'tool_complete' | 'idle' | 'error', handler: (...args: never[]) => void): void {
  this.handlers.push({ event, handler } as EventHandler);
}
```

**Step 5: Agent factory** — Modify `src/agent.ts` after line 161 (after `session.on('text', ...)`):
```typescript
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

Note: Do NOT add reasoning text to `outputLines[]`. Only message text goes into artifact reconstruction.

**Step 6: Update barrel exports** — Modify `src/index.ts`:

Add `NodeReasoningEvent` to the Events type export block (line 29):
```typescript
export type {
  ExecutionEvent, OutputEvent,
  ...
  NodeResetEvent,
  NodeOutputEvent, NodeToolEvent, NodeReasoningEvent,   // ← ADD NodeReasoningEvent
  GraphNodeSkeleton, GraphEdgeSkeleton,
} from './events';
```

**Create** `__tests__/subprocess-jsonl.test.ts` with 8 test cases.

Test setup: create a mock process (or use SubprocessSession internals) that feeds JSONL lines and verify emitted events. The simplest approach is to test the JSONL parsing logic in isolation by extracting it to a testable function, or by mocking `child_process.spawn` to emit lines on stdout.

1. `'parses reasoning_delta as reasoning event'`
2. `'parses message_delta as text event'`
3. `'parses tool_start event'`
4. `'parses tool_complete event'`
5. `'falls back to text for non-JSON lines'`
6. `'skips empty lines'`
7. `'falls back to text for malformed JSON'`
8. `'handles interleaved reasoning and message deltas'`

**Acceptance**: `npm test` all pass, `npm run typecheck` passes, `npm run build` succeeds.

---

### TASK 2B: State Barrel Split (#3)

**Create** `state/server.ts`:
```typescript
export { FileStorage } from './storage';
```

**Modify** `state/index.ts` — remove `FileStorage` export:
```typescript
export { reduce, createEmptyProjection, replayEvents } from './reducer';
// FileStorage moved to condukt/state/server — it requires fs (server-only)
export { MemoryStorage } from './storage-memory';
export { StateRuntime } from './state-runtime';
```

**Modify** `package.json` — add `./state/server` export entry after `./state`:
```json
"./state/server": {
  "types": "./dist/state/server.d.ts",
  "import": "./dist/state/server.js",
  "require": "./dist/state/server.js",
  "default": "./dist/state/server.js"
}
```

**Modify** `tsconfig.build.json` if needed — ensure `state/server.ts` is in the `include` pattern (it should be, since `state/**/*` is already included).

**Create** `__tests__/state-barrel-import.test.ts`:
```typescript
it('state barrel does not export FileStorage', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const stateExports = require('../state/index');
  expect(stateExports.FileStorage).toBeUndefined();
  expect(stateExports.StateRuntime).toBeDefined();
  expect(stateExports.MemoryStorage).toBeDefined();
});

it('state/server exports FileStorage', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const serverExports = require('../state/server');
  expect(serverExports.FileStorage).toBeDefined();
});
```

**IMPORTANT**: Check all existing tests and code within condukt that import `FileStorage` from `state/index`. Update them to import from `state/server` instead. Key files to check:
- `__tests__/storage.test.ts`
- `__tests__/state-runtime.test.ts`
- `__tests__/integration.test.ts`
- `__tests__/integration-comprehensive.test.ts`
- `__tests__/bridge.test.ts`
- `__tests__/bridge-comprehensive.test.ts`
- `bridge/bridge.ts` (if it imports FileStorage)

**Acceptance**: `npm test` all pass, `npm run typecheck` passes, `npm run build` succeeds.

---

### TASK 2C: ANSI Utils Export (#4)

**Create** `utils/index.ts`:
```typescript
export { ansiToHtml, stripAnsi, hasAnsi } from '../ui/ansi';
```

**Modify** `package.json` — add `./utils` export entry:
```json
"./utils": {
  "types": "./dist/utils/index.d.ts",
  "import": "./dist/utils/index.js",
  "require": "./dist/utils/index.js",
  "default": "./dist/utils/index.js"
}
```

**Modify** `tsconfig.json` — ensure `utils` directory is in `include`:
Check if the include pattern covers `utils/**/*`. If not, add it.

**Verify** `tsconfig.build.json` similarly includes `utils/`.

**No new test needed** — ANSI utilities are already tested in `__tests__/ui/` tests. Just verify the re-export resolves.

**Acceptance**: `npm run build` succeeds (utils/ compiled to dist/), `npm run typecheck` passes.

---

### Post-Phase 2 Integration

1. `npm run build` in condukt
2. Bump version to `0.3.0`
3. `npm test` — all tests pass
4. `npm pack` → `condukt-0.3.0.tgz`
5. In taco-helper:
   - `npm install Q:/Software/investigation/condukt/condukt-0.3.0.tgz`
   - Update `import { FileStorage } from 'condukt/state'` → `import { FileStorage } from 'condukt/state/server'`
   - Replace `src/lib/ansi.ts` imports with `import { ... } from 'condukt/utils'`
   - Remove `fs: false` fallback from `next.config.ts` (if state barrel split works)
6. `npm run typecheck && npm test` in taco-helper

---

## Phase 3: Packaging Polish → 0.3.1

### TASK 3A: CSS Resolution (#2)

**Create** `ui/style.css`:
```css
@import '../dist/ui/style.css';
```

**Modify** `package.json` `files` array — change from:
```json
"files": ["dist"]
```
to:
```json
"files": ["dist", "ui/style.css"]
```

**No test needed** — this is a packaging fix. Verify by checking `npm pack --dry-run` includes `ui/style.css`.

**Acceptance**: `npm pack --dry-run` shows `ui/style.css` in the file list.

---

### TASK 3B: Turbopack Compatibility (#5)

**Modify** `package.json` — update every export entry to include `import` and `require` conditions.

Current pattern:
```json
".": {
  "types": "./dist/src/index.d.ts",
  "default": "./dist/src/index.js"
}
```

Target pattern (for ALL entries except `./ui/style.css`):
```json
".": {
  "types": "./dist/src/index.d.ts",
  "import": "./dist/src/index.js",
  "require": "./dist/src/index.js",
  "default": "./dist/src/index.js"
}
```

Apply this pattern to: `.`, `./state`, `./state/server`, `./bridge`, `./runtimes/copilot`, `./runtimes/mock`, `./ui`, `./ui/core`, `./ui/graph`, `./theme`, `./utils`.

The `./ui/style.css` entry stays as-is (it's a direct file reference, not a conditional export).

**No test needed** — this is a metadata change. Verify by checking `node -e "require.resolve('condukt')"` works.

**Acceptance**: `npm run build` succeeds, exports resolve correctly.

---

### Post-Phase 3 Integration

1. `npm run build` in condukt
2. Bump version to `0.3.1`
3. `npm test` — all tests pass
4. `npm pack` → `condukt-0.3.1.tgz`
5. In taco-helper: `npm install Q:/Software/investigation/condukt/condukt-0.3.1.tgz`
6. Remove webpack aliases from `next.config.ts` (test Turbopack resolution)
7. Remove CSS copy workaround from `dev.ps1`
8. `npm run typecheck && npm test` in taco-helper
9. Test: `npx next dev` (Turbopack mode) resolves all imports

---

## Test Count Expectations

| Phase | New Tests | Running Total |
|-------|-----------|---------------|
| Baseline | 0 | 427 |
| Phase 1 | ~20 (4 + 5 + 6 + 2 + existing loop-back) | ~447 |
| Phase 2 | ~10 (8 + 2) | ~457 |
| Phase 3 | 0 | ~457 |
