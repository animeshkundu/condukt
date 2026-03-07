# Reasoning Visibility & Artifact Tab: Architecture Integration

## How New Features Fit the Existing Architecture

condukt has strict dependency layers. Every change must slot into the right layer.

```
Existing layers (unchanged):

  ui/                          React components + hooks
  |  (peer deps: react)
  |  imports types from src/
  |
  |   bridge/                  Orchestration (launch, stop, resume, SSE)
  |   |  depends on state/, src/events
  |   |
  v   v
  state/                       State management + persistence
  |  depends on src/events, src/types
  v
  src/                         Core types, scheduler, node factories
  |
  runtimes/                    Agent session implementations
    depends on src/types
```

### Changes per layer:

```
  ui/
  |  MODIFY: hooks/useNodeOutput.ts      (handle node:reasoning)
  |  NEW:    hooks/useNodeArtifact.ts     (artifact fetch hook)
  |  NEW:    components/MarkdownContent   (generic markdown renderer)
  |  NEW:    components/node-panel/Artifact (compound component)
  |  MODIFY: components/node-panel/index  (wire Artifact)
  |  MODIFY: core/index.ts               (export new hook + component)
  |  MODIFY: index.ts                    (barrel re-export)
  |
  bridge/
  |  MODIFY: sse.ts                      (replay reasoning prefix)
  |
  state/
  |  MODIFY: state-runtime.ts            (onOutput callback, persist reasoning)
  |
  runtimes/mock/
     MODIFY: mock-runtime.ts             (reasoning in MockNodeConfig)
```

No new layer dependencies. No cross-layer violations.

## Per-Feature Architecture Placement

### Output Event Transport — `state/state-runtime.ts`

**Layer**: State (`state/`)
**Dependencies**: Unchanged — `src/types`, `src/events`, `./reducer`
**Change**: Add `onOutput` callback (third constructor parameter)

Rationale: `StateRuntime` already has an `onEvent` callback for execution events. Adding `onOutput` for output events is the minimal, symmetric extension. The callback fires for ALL output event types (node:output, node:tool, node:reasoning), even those not persisted — consumers decide what to forward.

The bridge layer (`bridge/bridge.ts`) already calls `stateRuntime.handleOutput(event)` on every output event. Adding the callback here means the bridge doesn't need modification — it already routes through the right choke point.

### Reasoning Persistence — `state/state-runtime.ts`

**Layer**: State (`state/`)
**Change**: `handleOutput()` now persists `node:reasoning` (in addition to `node:output`)

Rationale: The storage layer (`StorageEngine.appendOutput`) is type-agnostic — it stores strings. The type prefix (`\x00reasoning\x00`) is an encoding concern, not a storage concern. No changes to StorageEngine, FileStorage, or MemoryStorage.

### SSE Replay Reconstruction — `bridge/sse.ts`

**Layer**: Bridge (`bridge/`)
**Dependencies**: Unchanged — `src/types`, `src/events`
**Change**: `createNodeSSEStream()` replay loop parses the reasoning prefix

Rationale: SSE replay reads stored output lines and re-emits them as events. Without this change, historical reasoning lines would replay as `node:output` events (losing type identity). The bridge layer is the right place because it's the boundary between storage (raw lines) and transport (typed events).

### useNodeOutput Reasoning — `ui/hooks/useNodeOutput.ts`

**Layer**: UI (`ui/`)
**Dependencies**: Unchanged — React hooks, fetch API
**Change**: SSE handler accepts both `node:output` and `node:reasoning` event types

Rationale: The hook is the UI's interface to the output stream. Reasoning events get wrapped with ANSI dim styling (`\x1b[2m[thinking] ...\x1b[0m`) before being added to the lines array. The ANSI renderer (`ui/ansi.ts`) already handles SGR code 2 (dim → `opacity: 0.6`).

The `[thinking]` prefix provides semantic meaning in plain text. The ANSI dim provides visual hierarchy in rendered output. Both degrade gracefully — plain text renderers show `[thinking]` as text, ANSI renderers show it dimmed.

### Artifact Hook — `ui/hooks/useNodeArtifact.ts`

**Layer**: UI (`ui/`)
**Dependencies**: React hooks, fetch API
**New file**: Yes

Rationale: Mirrors `useNodeOutput` in structure — fetch initial state, return reactive data. The `urlBuilder` option exists because consumers may have non-standard API routes (the default assumes `/api/executions/{id}/nodes/{nodeId}/artifact`).

### MarkdownContent — `ui/components/MarkdownContent.tsx`

**Layer**: UI (`ui/`)
**Dependencies**: React only
**New file**: Yes

Rationale: Extracted from taco-helper's proven `rca-display.tsx` pattern (in production since the ICM pipeline launch). Uses inline styles (not Tailwind) for zero-dependency portability. HTML-escapes all text content to prevent XSS.

### NodePanel.Artifact — `ui/components/node-panel/Artifact.tsx`

**Layer**: UI (`ui/`)
**Dependencies**: React, `MarkdownContent`
**New file**: Yes

Rationale: Follows the established compound component pattern (ADR-003). `NodePanel.Artifact` joins `NodePanel.Header`, `NodePanel.Info`, `NodePanel.Error`, `NodePanel.Gate`, `NodePanel.Controls`, `NodePanel.Output` as a composable piece of the node detail view.

### MockRuntime Reasoning — `runtimes/mock/mock-runtime.ts`

**Layer**: Runtimes (`runtimes/mock/`)
**Dependencies**: Unchanged — `src/types`
**Change**: Add `reasoning?: string[]` to `MockNodeConfig`, emit before text

Rationale: The `reasoning` session event already exists in the `SessionEvent` type union and the `AgentSession.on()` overloads. MockRuntime just didn't have config to trigger it. Reasoning emits before text (matching real agent behavior — thinking happens before response).

## Event Flow Diagram

### Before (broken):

```
agent.ts:163 → ctx.emitOutput({type: 'node:reasoning', ...})
    ↓
bridge.ts:99 → stateRuntime.handleOutput(event)
    ↓
state-runtime.ts:64 → if (event.type === 'node:output') store it
    ↓
DROPPED — node:reasoning doesn't match, no callback
```

### After (fixed):

```
agent.ts:163 → ctx.emitOutput({type: 'node:reasoning', ...})
    ↓
bridge.ts:99 → stateRuntime.handleOutput(event)
    ↓
state-runtime.ts:63-67 →
  if (node:output || node:reasoning) {
    store with prefix → storage.appendOutput(execId, nodeId, '\x00reasoning\x00' + content)
  }
  this.onOutput?.(event)  ← NEW: callback fires for ALL output types
    ↓
flow-state.ts → bus.emitOutput(event)  ← consumer wires callback to event bus
    ↓
sse.ts → subscribers receive typed event  ← SSE push to browser
    ↓
useNodeOutput.ts → dim [thinking] prefix → lines[]  ← React state update
    ↓
Output renderer → ANSI dim rendering → opacity: 0.6  ← visual hierarchy
```

### Replay (historical):

```
createNodeSSEStream → stateRuntime.getNodeOutput()
    ↓
storage returns lines including '\x00reasoning\x00...' prefix
    ↓
sse.ts replay loop:
  line.startsWith('\x00reasoning\x00') ? type='node:reasoning' : type='node:output'
    ↓
Correct typed event pushed to SSE client
    ↓
useNodeOutput.ts handles node:reasoning → dim [thinking] prefix
```

## Export Map Changes

```json
{
  "./ui/core": {
    "NEW EXPORTS": [
      "useNodeArtifact",
      "MarkdownContent",
      "NodePanel.Artifact (via compound)"
    ]
  }
}
```

No new entry points. No new sub-path exports. All new APIs export through existing barrels.
