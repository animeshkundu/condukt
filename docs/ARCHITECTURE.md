# Architecture

## Overview

The flow framework is a composable AI agent workflow engine organized around three decoupled systems: a stateless execution engine, an event-sourced state manager, and a reactive UI layer. The framework is 100% generic -- zero domain vocabulary leaks into any module.

## Three Systems

```
+---------------------------------------------------------------------+
|                     Composition Layer (user code)                    |
|   defines: FlowGraph { nodes, edges, start }                       |
|   uses: agent(), deterministic(), gate(), verify()                  |
+------------------------------------+--------------------------------+
                                     |
                                     v
+------------------------------------+--------------------------------+
|               1. EXECUTION SYSTEM  (src/)                           |
|                                                                     |
|   run(graph, options) -> RunResult                                  |
|   - Validates graph structure                                       |
|   - Walks DAG: computes frontier, dispatches parallel batches       |
|   - Per-node timeout via Promise.race                               |
|   - Fan-in: waits for all predecessors before dispatching target    |
|   - Abort: responds to AbortSignal, emits node:killed               |
|   - Resume: accepts ResumeState, skips completed nodes              |
|                                                                     |
|   EMITS: ExecutionEvent stream (15 event types)                     |
|   EMITS: OutputEvent stream (2 event types, not persisted)          |
+------------------------------------+--------------------------------+
                                     |
                         emitState() | emitOutput()
                                     v
+------------------------------------+--------------------------------+
|               2. STATE SYSTEM  (state/)                             |
|                                                                     |
|   StateRuntime                                                      |
|   - handleEvent(): append to JSONL log, reduce, cache, notify       |
|   - handleOutput(): route streaming output to per-node log files    |
|   - getProjection(): read from cache or storage                     |
|   - recoverOnStartup(): replay event logs, mark crashed executions  |
|   - Per-execution async mutex (SYS-1: event serialization)          |
|                                                                     |
|   StorageEngine (interface)                                         |
|   - FileStorage: JSONL event logs, atomic projection writes         |
|   - MemoryStorage: in-memory, for tests                             |
|                                                                     |
|   Reducer: pure fold  event -> projection (exhaustive switch)       |
+------------------------------------+--------------------------------+
                                     |
                         getProjection() | handleEvent()
                                     v
+------------------------------------+--------------------------------+
|               3. INTERFACE SYSTEM                                   |
|                                                                     |
|   Bridge (bridge/)                                                  |
|   - createBridge(runtime, stateRuntime) -> BridgeApi                |
|   - launch, stop, resume, retryNode, skipNode, approveGate          |
|   - Concurrency limit (10), dedup check, dir creation               |
|   - Per-bridge tracking of running executions (ARCH-2)              |
|                                                                     |
|   UI (ui/)                                                          |
|   - Visualization: FlowGraph (full interactive DAG)                 |
|   -                MiniPipeline (compact: graph/bar/summary modes)  |
|   - Detail: NodePanel.* compound components (ADR-003)               |
|   -         NodeDetailPanel (zero-config convenience default)       |
|   - Hooks: useFlowExecution (SSE+REST), useNodeOutput (streaming)   |
|   - Utilities: ansiToHtml (opt-in, ADR-001), STATUS_COLORS          |
|   - Status bar with live node counts, duration, cost                |
+---------------------------------------------------------------------+
```

## Six Sub-path Exports

The package exposes six import paths via the `exports` field in `package.json`. Each is independently importable and has a clear dependency direction.

| Sub-path | Directory | Purpose | Key Exports |
|----------|-----------|---------|-------------|
| `condukt` | `src/` | Core execution engine | `run`, `agent`, `deterministic`, `gate`, `verify`, `property`, `resolveGate`, `validateGraph`, `computeFrontier`, types, events |
| `condukt/state` | `state/` | Event-sourced persistence | `StateRuntime`, `FileStorage`, `MemoryStorage`, `reduce`, `createEmptyProjection`, `replayEvents` |
| `condukt/bridge` | `bridge/` | Orchestration API | `createBridge`, `BridgeApi`, `LaunchParams` |
| `condukt/runtimes/copilot` | `runtimes/copilot/` | Copilot CLI runtime | `SubprocessBackend`, `adaptCopilotBackend`, `CopilotBackend`, `isProcessAlive`, `killProcessTree` |
| `condukt/runtimes/mock` | `runtimes/mock/` | Test runtime | `MockRuntime`, `MockNodeConfig` |
| `condukt/ui` | `ui/` | React visualization | `FlowGraph`, `NodeCard`, `FlowEdge`, `NodeDetailPanel`, `FlowStatusBar`, `MiniPipeline`, `NodePanel` (compound: `.Header`, `.Info`, `.Error`, `.Gate`, `.Controls`, `.Output`), `STATUS_COLORS`, `OutputRenderer`, `ansiToHtml`, `stripAnsi`, `hasAnsi`, `useFlowExecution`, `useNodeOutput`, `cn` |

## Dependency Graph

Dependencies flow strictly downward. No cycles exist. Arrows indicate `import` relationships.

```
                    ui/
                    |  (peer deps: react, @xyflow/react)
                    |  imports types from src/
                    |
   bridge/          |
   |    \           |
   |     \          |
   v      v         |
 state/   src/ <----+
   |       ^
   |       |
   +-------+  (state/reducer.ts imports types + events from src/)
              (bridge/bridge.ts imports from src/ and state/)

 runtimes/copilot/
   |
   v
  src/types  (AgentRuntime, AgentSession, SessionConfig)

 runtimes/mock/
   |
   v
  src/types  (AgentRuntime, AgentSession, SessionConfig)
```

Detailed import map:

```
src/index.ts         --> src/scheduler, src/agent, src/nodes, src/verify, src/types, src/events
src/scheduler.ts     --> src/types, src/events
src/agent.ts         --> src/types
src/nodes.ts         --> src/types
src/verify.ts        --> src/types

state/index.ts       --> state/reducer, state/storage, state/storage-memory, state/state-runtime
state/reducer.ts     --> src/types, src/events
state/state-runtime.ts --> src/types, src/events, state/reducer
state/storage.ts     --> src/types, src/events
state/storage-memory.ts --> src/types, src/events

bridge/index.ts      --> bridge/bridge
bridge/bridge.ts     --> src/types, src/scheduler, src/nodes, state/state-runtime, src/events

runtimes/copilot/    --> src/types (via copilot-adapter)
runtimes/mock/       --> src/types

ui/                  --> src/types, src/events (type-only imports)
```

## Event Flow

The flow framework is event-sourced. Every state mutation is recorded as an immutable event, and the projection (materialized view) is rebuilt by folding events through a pure reducer.

### Event lifecycle: from `run()` to UI

```
1. User calls bridge.launch(params)
   |
   v
2. Bridge creates AbortController, calls run(graph, options)
   |
   v
3. Scheduler walks the DAG, dispatches nodes in parallel batches.
   For each lifecycle moment, it calls:
   |
   |-- emitState(event: ExecutionEvent)  -- 15 types, persisted
   |     |
   |     v
   |   StateRuntime.handleEvent()
   |     |-- storage.appendEvent()      -- append to JSONL log
   |     |-- reduce(projection, event)  -- pure fold
   |     |-- storage.writeProjection()  -- atomic JSON write
   |     |-- cache.set(id, projection)  -- in-memory cache
   |     +-- onEvent callback           -- notify subscribers (SSE, etc.)
   |
   +-- emitOutput(event: OutputEvent)   -- 2 types, streamed only
         |
         v
       StateRuntime.handleOutput()
         +-- storage.appendOutput()     -- per-node log file
```

### The 15 execution events (persisted to JSONL)

```
Lifecycle events:          Node events:             Edge/artifact/cost:
  run:started                node:started             edge:traversed
  run:completed              node:completed           artifact:written
  run:resumed                node:failed              cost:recorded
                             node:killed              metadata
                             node:skipped
                             node:gated
                             gate:resolved
                             node:retrying
```

### The 2 output events (streamed, not persisted in event log)

```
  node:output    -- streaming text from agent session
  node:tool      -- tool start/complete notifications
```

### Projection as materialized view

The `ExecutionProjection` is the single read model served by the API and consumed by the UI. It contains:

```
ExecutionProjection
  +-- id, flowId, status, params
  +-- graph
  |     +-- nodes: ProjectionNode[]    (id, status, action, elapsed, error, attempt, etc.)
  |     +-- edges: ProjectionEdge[]    (source, target, action, state: default|taken|not_taken)
  |     +-- activeNodes: string[]      (currently running or gated)
  |     +-- completedPath: string[]    (ordered list of completed node IDs)
  +-- totalCost
  +-- startedAt, finishedAt
  +-- metadata: Record<string, unknown>
```

## Storage Layout (FileStorage)

```
{rootDir}/
  {executionId}/
    events.jsonl          -- append-only event log (source of truth)
    projection.json       -- materialized view (rebuilt from events on recovery)
    artifacts/
      {nodeId}/
        {filename}        -- node output artifacts (e.g., report.md)
    output/
      {nodeId}.log        -- streaming text output per node
```

## Node Types

The framework provides four node factory functions. Each returns a `NodeFn` -- the universal callable unit.

```
+-------------------+---------------------------------------------------+
| Factory           | Behavior                                          |
+-------------------+---------------------------------------------------+
| agent(config)     | Full LLM session lifecycle: setup -> prompt ->    |
|                   | session -> stream events -> read artifact ->      |
|                   | teardown. GT-3 crash recovery. Needs AgentRuntime.|
+-------------------+---------------------------------------------------+
| deterministic(    | Wraps a pure async function. No runtime needed.   |
|   name, fn)       | Receives NodeInput, returns NodeOutput.            |
+-------------------+---------------------------------------------------+
| gate(name?)       | Blocks until resolved externally via resolveGate().|
|                   | Used for human approvals, quality gates, etc.     |
|                   | Gate registry is globalThis-backed (ARCH-2).      |
+-------------------+---------------------------------------------------+
| verify(producer,  | Wraps a producer NodeFn with check loop.          |
|   config)         | Max N iterations. On failure, injects RetryContext |
|                   | with feedback. Returns { action: 'fail' } if all  |
|                   | iterations exhausted.                             |
+-------------------+---------------------------------------------------+
```

## Resume and Retry

The framework supports resuming crashed/stopped/failed executions and retrying individual nodes.

```
Resume flow:
  1. Bridge reads projection from StateRuntime
  2. Builds ResumeState (completed nodes, fired edges, statuses)
  3. Calls computeFrontier(graph, resumeState) to find restart nodes
  4. Calls run(graph, { ...options, resumeFrom }) -- scheduler skips completed nodes
  5. Scheduler emits run:resumed, then continues from frontier

Retry flow:
  1. Bridge reads projection, finds target node
  2. Resets target + all downstream nodes to 'pending' (BFS)
  3. Assembles RetryContext { priorOutput, feedback, override }
  4. Calls run(graph, { ...options, resumeFrom, retryContexts })
  5. Target node receives RetryContext in NodeInput.retryContext
```

## UI Visualization Layers

The UI provides three levels of visualization, each appropriate for different contexts:

```
Level 1: MiniPipeline (compact thumbnail — list views, cards, sidebars)
  |  Three rendering modes based on node count (ADR-004):
  |    graph (<=20):  SVG mini-DAG — 6px dots, thin edges, shows topology
  |    bar   (21-50): proportional status-colored segments
  |    summary (>50): text counts ("42 completed, 3 running, 1 failed")
  |  auto mode selects based on projection.graph.nodes.length
  |
Level 2: FlowGraph (full interactive DAG — main detail view)
  |  React Flow with layered layout (Kahn's algorithm)
  |  NodeCard: status icon, type badge, model, elapsed, attempts
  |  FlowEdge: taken/not_taken/default visual states
  |  Background grid, zoom controls, minimap
  |
Level 3: NodePanel.* (per-node detail — side panel)
     Compound components (ADR-003):
       NodePanel        — shell container (flex column, dark theme)
       NodePanel.Header — status dot, name, type, close
       NodePanel.Info   — model, duration, attempt, action
       NodePanel.Error  — error message (conditional)
       NodePanel.Gate   — data-driven buttons from allowedResolutions (ADR-002)
       NodePanel.Controls — Retry/Redo/Skip (hidden while running)
       NodePanel.Output — scrollable stream, configurable renderer

     NodeDetailPanel is a convenience composition of all building blocks.
     Custom layouts compose the pieces directly:
       <NodePanel>
         <NodePanel.Header ... />
         <MyCustomSection />
         <NodePanel.Output renderer="ansi" ... />
       </NodePanel>
```

### ANSI Rendering (ADR-001)

Output rendering defaults to **plain text**. ANSI conversion is opt-in:

- `NodePanel.Output` accepts `renderer?: OutputRenderer` where `OutputRenderer = 'plain' | 'ansi' | ((line, index) => ReactNode)`
- The `'ansi'` renderer uses a `hasAnsi()` fast-path per line to skip conversion for plain text
- ANSI utilities (`ansiToHtml`, `stripAnsi`, `hasAnsi`) are exported from `/ui` for custom renderers
- Investigation pipeline passes `renderer="ansi"` explicitly; other pipelines work with the default

### FlowCard (Deferred)

A `FlowCard` component (list-item card combining MiniPipeline + metadata) was designed but deferred. The current integration pattern is for consumers to compose `MiniPipeline` + their own card layout.

## Concurrency Model

- The scheduler dispatches all nodes in a batch simultaneously via `Promise.allSettled`.
- Each node runs in its own Promise with an independent timeout.
- Fan-in: a node with multiple incoming edges waits until all predecessor edges have fired.
- The bridge enforces a global concurrency limit of 10 simultaneous executions.
- Per-execution: `StateRuntime` uses a promise-chain mutex (SYS-1) to serialize events.
- Gate nodes block their Promise until `resolveGate()` is called externally.
- Abort propagation: `AbortSignal` is checked before each batch and passed to agent sessions.

## Fan-Out and Loop-Back (ADR-006)

The execution engine supports two extensions beyond basic DAG traversal:

### Fan-out edges

An edge target can be an array: `{ action: ['B', 'C'] }`. Both targets are dispatched in parallel. Fan-in semantics are unchanged — a downstream node waits for ALL fired sources.

### Bounded loop-back

When an edge fires and its target is already completed, the scheduler recognizes a loop-back:
1. Resets the target nodes and source node (targeted, non-cascading)
2. Emits `node:reset` events (crash-recovery safe)
3. Builds `RetryContext` with prior artifact content
4. Re-dispatches the targets
5. After `maxIterations` (per-loop via `loopFallback`), routes to a fallback target

See `docs/DESIGN-FAN-OUT-LOOP-BACK.md` for the full design document and `docs/adr/ADR-006-fan-out-loop-back.md` for the decision record.
