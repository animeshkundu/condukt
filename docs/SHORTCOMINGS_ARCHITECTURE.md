# Shortcomings Fix: Architecture Integration

## How New Features Fit the Existing Architecture

condukt's architecture has strict dependency layers and clear boundaries. Every new feature must slot into the right layer without creating new dependencies or violating existing contracts.

```
                         NEW: condukt/utils
                         (ansi utilities, no deps)
                              |
                    ui/ ------+
                    |  (peer deps: react, @xyflow/react)
                    |  imports types from src/
                    |
   bridge/          |          NEW: bridge/sse.ts
   |    \           |          (SSE streaming, depends on state/ + src/events)
   |     \          |
   v      v         |
 state/   src/ <----+
   |       ^
   |       |         NEW: src/hmr-singleton.ts (zero deps)
   +-------+         NEW: src/setup-once.ts (zero deps)

 runtimes/copilot/    MODIFY: subprocess-backend.ts (JSONL parser)
   |
   v
  src/types           MODIFY: AgentSession + LoopFallbackEntry

 NEW: state/server.ts (FileStorage, depends on fs)
 MODIFY: state/index.ts (remove FileStorage)
```

## Per-Feature Architecture Placement

### #9 HMR Singleton — `src/hmr-singleton.ts`

**Layer**: Core (`src/`)
**Dependencies**: None (pure `globalThis` + `Symbol.for`)
**Exported via**: `condukt` (main barrel)

Rationale: HMR survival is a runtime utility, not tied to state, bridge, or UI. Lives alongside the core types. Existing precedent: the gate registry in `src/nodes.ts` already uses `Symbol.for` + `globalThis` for HMR survival.

### #8 Setup Once — `src/setup-once.ts`

**Layer**: Core (`src/`)
**Dependencies**: None (pure `globalThis`-backed Map)
**Exported via**: `condukt` (main barrel)

Rationale: Setup caching is a per-execution lifecycle concern. It's used in `agent()` setup hooks but isn't specific to any runtime or storage mechanism. The `globalThis` backing ensures setup state survives HMR (same as gate registry, same as HMR singleton).

### #7 SSE Streaming — `bridge/sse.ts`

**Layer**: Bridge (`bridge/`)
**Dependencies**: `state/state-runtime` (for `getProjection`, `getNodeOutput`), `src/events` (for event types)
**Exported via**: `condukt/bridge`

Rationale: SSE streaming is an orchestration concern — it bridges execution events to HTTP clients. It depends on StateRuntime (to replay stored state) and EventBus (to subscribe to live events). Both are already available in the bridge layer.

The `EventBusLike` interface is defined locally (not imported from consumer code) so the bridge layer doesn't depend on any specific pub-sub implementation. Consumers pass their event bus instance.

```
bridge/sse.ts depends on:
  - StateRuntime (from state/)         — for getProjection(), getNodeOutput()
  - ExecutionEvent, OutputEvent types  — from src/events
  - EventBusLike interface             — defined locally in bridge/sse.ts
```

This follows the existing dependency pattern: `bridge/bridge.ts` already imports from both `src/` and `state/`.

### #1 Feedback Extractor — `src/types.ts` + `src/scheduler.ts`

**Layer**: Core (`src/`)
**Dependencies**: No new dependencies
**Exported via**: `condukt` (existing `LoopFallbackEntry` type)

The feedbackExtractor callback is added to `LoopFallbackEntry` (the type already exported). The scheduler reads it during loop-back processing (scheduler.ts lines 699-702) and passes source node output through it. No new imports needed — the source node's `output` is already available in the `newlyCompleted` loop.

### #6 Reasoning Events — Multiple files across layers

**Runtime layer** (`runtimes/copilot/`):
- `subprocess-backend.ts` — JSONL parser, `reasoning` event emission
- `copilot-backend.ts` — `reasoning` event on `CopilotSession` interface

**Core layer** (`src/`):
- `types.ts` — `reasoning` event on `AgentSession` interface
- `events.ts` — `NodeReasoningEvent` in `OutputEvent` union
- `agent.ts` — wire `session.on('reasoning')` to `ctx.emitOutput()`

This follows the exact same pattern as the existing `text`, `tool_start`, `tool_complete` events:
1. Runtime emits it (subprocess-backend)
2. Runtime interface declares it (CopilotSession → AgentSession)
3. Event type defines it (NodeReasoningEvent)
4. Agent factory wires it to the output stream

### #3 State Barrel Split — `state/`

**Layer**: State (`state/`)
**Dependencies**: `FileStorage` gains its own sub-export entry
**Exported via**: `condukt/state/server` (new), `condukt/state` (modified — no FileStorage)

The split creates a clean boundary:
- `condukt/state` = client-safe (StateRuntime, MemoryStorage, reduce, types)
- `condukt/state/server` = server-only (FileStorage, requires `fs`)

This mirrors the existing `ui/core` vs `ui/graph` split (core = no @xyflow dep, graph = requires it).

### #4 ANSI Utils Export — `utils/`

**Layer**: New top-level directory (`utils/`)
**Dependencies**: Re-exports from `ui/ansi.ts`
**Exported via**: `condukt/utils` (new)

The `utils/` directory is a thin re-export layer. It doesn't duplicate code — `utils/index.ts` re-exports the ANSI functions from `ui/ansi.ts`. Consumers who need ANSI utilities without React/CSS dependencies import from `condukt/utils`.

### #2 CSS Resolution — `ui/style.css`

**Layer**: UI (`ui/`)
**Dependencies**: None (physical redirect file)
**Exported via**: `condukt/ui/style.css` (existing export, now with physical file)

### #5 Turbopack Compat — `package.json`

**Layer**: Package metadata
**Dependencies**: None
**Changes**: Export condition fields

## New Export Map (after all phases)

```json
{
  ".": { "types": "...", "import": "...", "require": "...", "default": "..." },
  "./state": { "types": "...", "import": "...", "require": "...", "default": "..." },
  "./state/server": { "types": "...", "import": "...", "require": "...", "default": "..." },
  "./bridge": { "types": "...", "import": "...", "require": "...", "default": "..." },
  "./runtimes/copilot": { ... },
  "./runtimes/mock": { ... },
  "./ui": { ... },
  "./ui/core": { ... },
  "./ui/graph": { ... },
  "./theme": { ... },
  "./utils": { "types": "...", "import": "...", "require": "...", "default": "..." },
  "./ui/style.css": "./dist/ui/style.css"
}
```

## Event Model Extension

### Current OutputEvent union (2 types)
```
OutputEvent = NodeOutputEvent | NodeToolEvent
```

### After #6 (3 types)
```
OutputEvent = NodeOutputEvent | NodeToolEvent | NodeReasoningEvent
```

`NodeReasoningEvent` is streamed (not persisted in JSONL event log), same as the other two OutputEvents. The UI can choose to display reasoning tokens in a collapsible "Thinking" section, or ignore them entirely.

## Type System Extension

### Current LoopFallbackEntry
```typescript
interface LoopFallbackEntry {
  readonly source: string;
  readonly action: string;
  readonly fallbackTarget: EdgeTarget;
  readonly maxIterations?: number;
}
```

### After #1 (one new optional field)
```typescript
interface LoopFallbackEntry {
  readonly source: string;
  readonly action: string;
  readonly fallbackTarget: EdgeTarget;
  readonly maxIterations?: number;
  readonly feedbackExtractor?: (
    sourceOutput: string | null,
    sourceMetadata: Record<string, unknown>
  ) => string;
}
```

### Current AgentSession events
```
text | tool_start | tool_complete | idle | error
```

### After #6 (one new event)
```
text | reasoning | tool_start | tool_complete | idle | error
```

Both extensions are backward-compatible: the new field is optional, the new event is additive.

## Dependency Invariants (must hold after all changes)

1. `src/` has zero imports from `state/`, `bridge/`, `runtimes/`, `ui/`, `utils/`
2. `state/` imports only from `src/` (types + events)
3. `bridge/` imports from `src/` and `state/` (never `runtimes/` or `ui/`)
4. `runtimes/` imports only from `src/` (types)
5. `ui/` imports only from `src/` (types + events, type-only)
6. `utils/` imports only from `ui/` (re-exports ANSI utils)
7. No circular dependencies between any layers
