# API Reference

Complete reference for every exported function, class, and type across all six sub-path exports.

---

## Core (`@anthropic/flow-framework`)

The core module provides the execution engine: the scheduler, node factories, graph validation, and all type definitions.

### Functions

#### `run(graph: FlowGraph, options: RunOptions): Promise<RunResult>`

The main entry point. Walks a DAG, dispatches nodes in parallel batches, emits events via callbacks. Stateless -- all persistence is done by the callbacks.

- Validates the graph before execution
- Dispatches start nodes first, then follows edges based on node output actions
- Handles fan-in (waits for all predecessor edges before dispatching a target)
- Supports resume via `options.resumeFrom` and retry via `options.retryContexts`
- Throws `FlowAbortedError` when the AbortSignal fires

#### `agent(config: AgentConfig): NodeFn`

Creates a NodeFn that manages a full LLM agent session lifecycle. The returned function: deletes stale artifacts, runs setup hook, builds prompt, creates session, wires streaming events, sends prompt, awaits idle/error, reads artifact, runs teardown.

Implements GT-3 dual-condition crash recovery: if a session errors but a completion indicator was seen AND the artifact file exists with content, the run is treated as successful.

Parameters in `AgentConfig`:

| Field | Type | Description |
|-------|------|-------------|
| `objective` | `string` | Human-readable objective (documentation only) |
| `tools` | `readonly ToolRef[]` | Tools the agent can use |
| `output` | `string?` | Output artifact filename |
| `reads` | `readonly string[]?` | Artifact filenames this node reads |
| `model` | `string?` | Model name (default: `'claude-opus-4.6'`) |
| `isolation` | `boolean?` | If true, no extra dirs passed to session |
| `timeout` | `number?` | Hard timeout in seconds (default: 3600) |
| `heartbeatTimeout` | `number?` | No-output timeout in seconds (default: 120) |
| `cwdResolver` | `(input: NodeInput) => string?` | Override session cwd. Default: `input.dir`. Use for running in a repo dir while artifacts go to `input.dir`. |
| `setup` | `(input: NodeInput) => void \| Promise<void>?` | Pre-execution hook |
| `teardown` | `(input: NodeInput) => void \| Promise<void>?` | Post-execution hook (always runs) |
| `promptBuilder` | `(input: NodeInput) => PromptOutput` | **Required.** Builds the prompt |
| `actionParser` | `(artifactContent: string) => string?` | Parses action from artifact |
| `completionIndicators` | `readonly string[]?` | Strings that indicate completion (GT-3) |

#### `deterministic(name: string, fn: (input: NodeInput) => Promise<NodeOutput>): NodeFn`

Wraps a pure async function as a NodeFn. The ExecutionContext is available but typically unused. Deterministic nodes do not need an AgentRuntime.

#### `gate(name?: string): NodeFn`

Creates a NodeFn that blocks until externally resolved via `resolveGate()`. Used for human approvals, quality gates, and any point where the flow should pause for external input. The gate registers a Promise resolver in a globalThis-backed registry and blocks until resolution.

#### `resolveGate(executionId: string, nodeId: string, resolution: string, reason?: string): boolean`

Resolves a waiting gate node, unblocking the scheduler. Returns `true` if the gate was found and resolved, `false` if no pending gate exists for that execution/node pair.

#### `verify(producer: NodeFn, config: VerifyConfig): NodeFn`

Wraps a producer NodeFn with an iterative check loop. On each iteration: runs the producer, runs all checks, returns if all pass, otherwise injects RetryContext with feedback and retries. Returns `{ action: 'fail' }` after `maxIterations` (default: 3) failures.

`VerifyConfig`:

| Field | Type | Description |
|-------|------|-------------|
| `checks` | `readonly VerifyCheck[]` | Check functions to run after each iteration |
| `maxIterations` | `number?` | Max retry attempts (default: 3) |

#### `property(name: string, predicate: (content: string) => boolean, failureMessage: string): VerifyCheck`

Convenience factory for creating a `VerifyCheck` from a simple predicate. The predicate examines the artifact content string and returns true/false.

#### `validateGraph(graph: FlowGraph): void`

Validates a FlowGraph structure. Checks that start nodes exist, edge sources/targets reference valid nodes (or `'end'`), and no duplicate output filenames exist. Throws `FlowValidationError` with a list of issues on failure.

#### `computeFrontier(graph: FlowGraph, state: ResumeState): string[]`

Computes the next set of executable nodes given the current resume state. Used internally by the bridge for resume and retry operations. Returns node IDs that are ready to run (all predecessors completed).

#### `getParams<T>(projection: ExecutionProjection): T`

Type-safe params accessor. Casts `projection.params` to the specified type `T`. Zero runtime cost.

#### `wasCompletedBeforeCrash(dir: string, outputFile: string, outputLines: readonly string[], indicators?: readonly string[]): boolean`

GT-3 dual-condition crash recovery check. Returns true only if both conditions hold: (1) at least one completion indicator appears in the output lines, AND (2) the artifact file exists on disk with non-trivial content (> 10 chars).

### Error Classes

#### `FlowAbortedError`

Thrown when a flow is aborted via AbortSignal. Extends `Error` with `name: 'FlowAbortedError'`.

```typescript
new FlowAbortedError(reason?: string)
```

#### `FlowValidationError`

Thrown by `validateGraph()` when the graph has structural issues. Extends `Error` with `name: 'FlowValidationError'`.

```typescript
new FlowValidationError(issues: readonly string[])
// .issues: readonly string[] — list of validation problems
```

### Types

#### `NodeFn`

```typescript
type NodeFn = (input: NodeInput, ctx: ExecutionContext) => Promise<NodeOutput>;
```

The fundamental callable unit. Every node in the graph is a `NodeFn`.

#### `NodeInput`

```typescript
interface NodeInput {
  readonly dir: string;                                 // Working directory
  readonly params: Readonly<Record<string, unknown>>;   // Composition-defined parameters
  readonly artifactPaths: Readonly<Record<string, string>>;  // Filename -> absolute path for readable artifacts
  readonly retryContext?: RetryContext;                  // Populated on retry
}
```

#### `NodeOutput`

```typescript
interface NodeOutput {
  readonly action: string;                    // Routing action (determines which edge to follow)
  readonly artifact?: string;                 // Artifact content to write
  readonly metadata?: Record<string, unknown>; // Metadata to emit as events
}
```

#### `RetryContext`

```typescript
interface RetryContext {
  readonly priorOutput: string | null;  // Previous artifact content
  readonly feedback: string;            // Why the prior attempt failed
  readonly override?: string;           // User-provided override instruction
}
```

#### `ExecutionContext`

```typescript
interface ExecutionContext {
  readonly executionId: string;
  readonly nodeId: string;
  readonly runtime: AgentRuntime;
  readonly emitOutput: (event: OutputEvent) => void;
  readonly signal: AbortSignal;
}
```

Runtime services injected by the scheduler. Not shared mutable state.

#### `FlowGraph`

```typescript
interface FlowGraph {
  readonly nodes: Readonly<Record<string, NodeEntry>>;
  readonly edges: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly start: readonly string[];
}
```

A complete flow definition. `nodes` maps node IDs to entries. `edges` maps source node IDs to `{ action: targetNodeId }` routing tables (use `'end'` to terminate a path). `start` lists root node IDs.

#### `NodeEntry`

```typescript
interface NodeEntry {
  readonly fn: NodeFn;
  readonly displayName: string;
  readonly nodeType: 'agent' | 'deterministic' | 'gate' | 'verify';
  readonly output?: string;           // Artifact filename this node produces
  readonly reads?: readonly string[]; // Artifact filenames this node reads
  readonly model?: string;            // Model name (for display)
  readonly timeout?: number;          // Per-node timeout in seconds (default: 3600)
}
```

#### `RunOptions`

```typescript
interface RunOptions {
  readonly executionId: string;
  readonly dir: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly runtime: AgentRuntime;
  readonly emitState: (event: ExecutionEvent) => Promise<void>;
  readonly emitOutput: (event: OutputEvent) => void;
  readonly signal: AbortSignal;
  readonly resumeFrom?: ResumeState;
  readonly retryContexts?: Readonly<Record<string, RetryContext>>;
}
```

#### `RunResult`

```typescript
interface RunResult {
  readonly completed: boolean;
  readonly durationMs: number;
}
```

#### `ResumeState`

```typescript
interface ResumeState {
  readonly completedNodes: Map<string, { action: string; finishedAt: number }>;
  readonly firedEdges: Map<string, Set<string>>;   // target -> sources that routed there
  readonly nodeStatuses: Map<string, string>;
}
```

#### `AgentRuntime`

```typescript
interface AgentRuntime {
  createSession(config: SessionConfig): Promise<AgentSession>;
  isAvailable(): Promise<boolean>;
  readonly name: string;
}
```

The runtime contract. Implemented by `SubprocessBackend` (via adapter), `MockRuntime`, or any custom runtime.

#### `AgentSession`

```typescript
interface AgentSession {
  readonly pid: number | null;
  send(prompt: string): void;
  on(event: 'text', handler: (text: string) => void): void;
  on(event: 'tool_start', handler: (tool: string, input: string) => void): void;
  on(event: 'tool_complete', handler: (tool: string, output: string) => void): void;
  on(event: 'idle', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  abort(): Promise<void>;
}
```

#### `SessionConfig`

```typescript
interface SessionConfig {
  readonly model: string;
  readonly cwd: string;
  readonly addDirs: readonly string[];
  readonly timeout: number;          // seconds
  readonly heartbeatTimeout: number; // seconds
}
```

#### `ExecutionProjection`

```typescript
interface ExecutionProjection {
  readonly id: string;
  readonly flowId: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'crashed';
  readonly params: Record<string, unknown>;
  readonly graph: {
    readonly nodes: ReadonlyArray<ProjectionNode>;
    readonly edges: ReadonlyArray<ProjectionEdge>;
    readonly activeNodes: readonly string[];
    readonly completedPath: readonly string[];
  };
  readonly totalCost: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly metadata: Record<string, unknown>;
}
```

The materialized view of an execution. Served directly by the API, consumed by the UI.

#### `ProjectionNode`

```typescript
interface ProjectionNode {
  readonly id: string;
  readonly displayName: string;
  readonly nodeType: string;
  readonly model?: string;
  readonly status: string;           // pending | running | completed | failed | killed | skipped | gated | retrying
  readonly action?: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly elapsedMs?: number;
  readonly attempt: number;
  readonly error?: string;
  readonly output?: string;
  readonly gateData?: Record<string, unknown>;
}
```

#### `ProjectionEdge`

```typescript
interface ProjectionEdge {
  readonly source: string;
  readonly action: string;
  readonly target: string;
  readonly state: 'default' | 'taken' | 'not_taken';
}
```

#### `ExecutionId`

```typescript
type ExecutionId = Brand<string, 'ExecutionId'>;
```

Branded string type for execution identifiers. Create via `'my-id' as ExecutionId`.

#### `StorageEngine`

```typescript
interface StorageEngine {
  appendEvent(execId: string, event: ExecutionEvent): void;
  readEvents(execId: string): ExecutionEvent[];
  writeProjection(execId: string, projection: ExecutionProjection): void;
  readProjection(execId: string): ExecutionProjection | null;
  writeArtifact(execId: string, nodeId: string, name: string, content: string): void;
  readArtifact(execId: string, nodeId: string, name: string): string | null;
  appendOutput(execId: string, nodeId: string, line: string): void;
  readOutput(execId: string, nodeId: string, offset?: number, limit?: number): OutputPage;
  closeOutput(execId: string, nodeId: string): void;
  delete(execId: string): boolean;
  listExecutionIds(): string[];
}
```

#### `OutputPage`

```typescript
interface OutputPage {
  readonly lines: readonly string[];
  readonly offset: number;
  readonly total: number;
  readonly hasMore: boolean;
}
```

#### `PromptOutput`

```typescript
type PromptOutput = string | { system: string; user: string };
```

Return type for `AgentConfig.promptBuilder`. Can be a plain string or a structured system/user prompt pair.

#### `ToolRef`

```typescript
interface ToolRef {
  readonly id: string;
  readonly displayName: string;
}
```

#### Event Types

All 15 execution events and 2 output events are exported as individual interfaces. They form two discriminated unions:

```typescript
type ExecutionEvent =
  | RunStartedEvent | RunCompletedEvent | RunResumedEvent
  | NodeStartedEvent | NodeCompletedEvent | NodeFailedEvent
  | NodeKilledEvent | NodeSkippedEvent | NodeGatedEvent
  | GateResolvedEvent | NodeRetryingEvent | EdgeTraversedEvent
  | ArtifactWrittenEvent | CostRecordedEvent | MetadataEvent;

type OutputEvent = NodeOutputEvent | NodeToolEvent;
```

Every event carries `executionId: string` and `ts: number`. Node events also carry `nodeId: string`.

---

## State (`@anthropic/flow-framework/state`)

Event-sourced persistence layer. Receives events from the execution engine, reduces them into projections, and persists both.

### `StateRuntime`

```typescript
class StateRuntime {
  constructor(storage: StorageEngine, onEvent?: (event: ExecutionEvent) => void);
}
```

Coordinates event flow, projection caching, and storage. Uses a per-execution async mutex to serialize events.

| Method | Signature | Description |
|--------|-----------|-------------|
| `handleEvent` | `(event: ExecutionEvent) => Promise<void>` | Append event to log, reduce, cache, persist, notify |
| `handleOutput` | `(event: OutputEvent) => void` | Route `node:output` events to per-node log files |
| `writeArtifact` | `(execId, nodeId, name, content) => void` | Write an artifact to storage |
| `getProjection` | `(id: string) => ExecutionProjection \| null` | Read from cache, fall back to storage |
| `listExecutions` | `() => ExecutionProjection[]` | Return all cached projections |
| `getNodeOutput` | `(execId, nodeId, offset?, limit?) => OutputPage` | Read paginated node output |
| `getArtifact` | `(execId, nodeId, name) => string \| null` | Read an artifact from storage |
| `rebuildProjection` | `(execId: string) => ExecutionProjection` | Replay events from log, rewrite projection |
| `recoverOnStartup` | `() => void` | Hydrate cache from storage; mark running executions as crashed |
| `delete` | `(execId: string) => boolean` | Delete execution from cache and storage |
| `shutdown` | `() => void` | Close output streams for all cached executions |

### `FileStorage`

```typescript
class FileStorage implements StorageEngine {
  constructor(rootDir: string);
}
```

File-based StorageEngine. Uses JSONL for event logs, atomic rename for projection writes, flat files for artifacts, append-only files for output. All paths are validated against traversal attacks via `safePath()`.

### `MemoryStorage`

```typescript
class MemoryStorage implements StorageEngine {
  constructor();
}
```

In-memory StorageEngine for tests. Zero I/O. Same interface as `FileStorage`.

### `reduce(state: ExecutionProjection, event: ExecutionEvent): ExecutionProjection`

Pure reducer function. Folds a single event into the current projection. Exhaustive switch with `never` default ensures all event types are handled. Immutable -- returns a new projection object.

### `createEmptyProjection(id: string, flowId?: string): ExecutionProjection`

Creates a blank projection with the given ID. All fields set to defaults (status: `'pending'`, empty graph, zero cost).

### `replayEvents(id: string, events: readonly ExecutionEvent[]): ExecutionProjection`

Replays an event sequence from scratch to rebuild a projection. Equivalent to `events.reduce(reduce, createEmptyProjection(id))`.

---

## Bridge (`@anthropic/flow-framework/bridge`)

Orchestration layer that connects the execution engine, state layer, and external consumers (API routes, CLI).

### `createBridge(runtime: AgentRuntime, stateRuntime: StateRuntime): BridgeApi`

Factory function. Creates a bridge instance with per-bridge tracking of running executions.

### `BridgeApi`

| Method | Signature | Description |
|--------|-----------|-------------|
| `launch` | `(params: LaunchParams) => Promise<string>` | Start a new execution. Returns execution ID. Enforces concurrency limit (10) and dedup. Creates working directory. Runs in background. |
| `stop` | `(executionId: string) => Promise<void>` | Abort a running execution. Signals the scheduler, waits for it to stop. |
| `resume` | `(executionId, graph) => Promise<{resumingFrom: string[]} \| null>` | Resume a crashed/failed/stopped execution. Computes frontier, starts from there. Returns null if no frontier found. |
| `retryNode` | `(executionId, nodeId, graph, override?) => Promise<void>` | Retry a specific node. Resets it and all downstream nodes. Passes RetryContext with prior output and optional override. |
| `skipNode` | `(executionId, nodeId) => Promise<void>` | Skip a pending, gated, or failed node. Emits `node:skipped` event. |
| `approveGate` | `(executionId, nodeId, resolution, reason?) => Promise<void>` | Resolve a pending gate. Calls `resolveGate()` to unblock the scheduler, then emits `gate:resolved` event. |
| `getExecution` | `(executionId: string) => ExecutionProjection \| null` | Get the current projection for an execution. |
| `listExecutions` | `() => ExecutionProjection[]` | List all cached executions. |
| `isRunning` | `(executionId: string) => boolean` | Check if an execution is currently running. |

### `LaunchParams`

```typescript
interface LaunchParams {
  readonly executionId: string;
  readonly graph: FlowGraph;
  readonly dir: string;
  readonly params: Record<string, unknown>;
}
```

---

## Runtimes: Copilot (`@anthropic/flow-framework/runtimes/copilot`)

Runtime adapter for the GitHub Copilot CLI.

### Types

#### `CopilotBackend`

```typescript
interface CopilotBackend {
  createSession(config: CopilotSessionConfig): Promise<CopilotSession>;
  isAvailable(): Promise<boolean>;
  readonly name: string;
}
```

#### `CopilotSession`

```typescript
interface CopilotSession {
  readonly pid: number | null;
  send(prompt: string): void;
  on(event: 'text' | 'tool_start' | 'tool_complete' | 'idle' | 'error', handler: Function): void;
  abort(): Promise<void>;
}
```

#### `CopilotSessionConfig`

```typescript
interface CopilotSessionConfig {
  readonly model: string;
  readonly cwd: string;
  readonly addDirs: readonly string[];
  readonly timeout: number;
  readonly heartbeatTimeout: number;
}
```

### `SubprocessBackend`

```typescript
class SubprocessBackend implements CopilotBackend {
  constructor(options?: SubprocessBackendOptions);
  readonly name: 'subprocess';
}
```

Spawns the copilot CLI as a child process. Features: PATH hardening (resolves tool directories dynamically), NODE_OPTIONS stripping, readline-based stdout parsing, hard timeout + heartbeat timeout, platform-specific process tree kill.

`SubprocessBackendOptions`:

| Field | Type | Description |
|-------|------|-------------|
| `commandFactory` | `(config) => [string, string[]]?` | Custom command builder |
| `extraPathDirs` | `readonly string[]?` | Extra directories to add to PATH |
| `mcpConfigPath` | `string?` | Path to MCP config file |

### `adaptCopilotBackend(backend: CopilotBackend): AgentRuntime`

Thin adapter that wraps a `CopilotBackend` as an `AgentRuntime`. The two interfaces are structurally identical; this maps the types.

### `isProcessAlive(pid: number): boolean`

Check if a process with the given PID is alive. Uses `process.kill(pid, 0)` (signal 0 = probe existence).

### `killProcessTree(pid: number): Promise<void>`

Kill a process and its entire tree. On Windows: `taskkill /T /F /PID`. On other platforms: `kill -9`. Does not throw if the process does not exist.

---

## Runtimes: Mock (`@anthropic/flow-framework/runtimes/mock`)

Deterministic test runtime that replays configured events per node.

### `MockRuntime`

```typescript
class MockRuntime implements AgentRuntime {
  constructor(
    configs: Record<string, MockNodeConfig>,
    options?: { nodeResolver?: (config: SessionConfig) => string },
  );
  readonly name: 'mock';
}
```

The node is identified by the `cwd` basename of the SessionConfig by default, or via a custom `nodeResolver`.

### `MockNodeConfig`

```typescript
interface MockNodeConfig {
  text?: string[];                                       // Text lines to emit
  tools?: Array<{ name: string; input: string; output: string }>;  // Tool call sequence
  artifact?: string;                                     // Artifact content to write
  error?: Error;                                         // Emit error instead of idle
  delay?: number;                                        // Delay in ms before events
}
```

---

## UI (`@anthropic/flow-framework/ui`)

React components and hooks for flow visualization. Optional peer dependencies: `react >= 18`, `@xyflow/react >= 12`.

### Components

#### `FlowGraph`

```typescript
function FlowGraph(props: {
  projection: ExecutionProjection;
  selectedNodeId: string | null;
  onNodeSelect: (nodeId: string) => void;
}): JSX.Element;
```

Full flow visualization using React Flow. Computes a layered layout from the projection (topological sort via Kahn's algorithm). Includes background grid, zoom controls, and minimap with status-colored nodes.

#### `NodeCard`

```typescript
const NodeCard: React.MemoExoticComponent<(props: NodeProps) => JSX.Element>;
```

Individual node renderer inside the flow graph. Displays: status icon (with pulse animation for running/gated), display name, type badge (Agent/Check/Gate/Verify), model, elapsed time, attempt count, error indicator. Status-dependent border and background colors.

#### `FlowEdge`

```typescript
const FlowEdge: React.MemoExoticComponent<(props: EdgeProps) => JSX.Element>;
```

Custom edge renderer. Visual states: default (gray), taken (green, thicker), not_taken (gray, dashed). Shows action label for non-default actions.

#### `NodeDetailPanel`

```typescript
function NodeDetailPanel(props: {
  projection: ExecutionProjection;
  nodeId: string;
  onClose: () => void;
  onAction: (action: 'retry' | 'skip' | 'approve' | 'reject', nodeId: string) => void;
}): JSX.Element | null;
```

Side panel showing node details: status, model, duration, error. For gated nodes: approve/reject buttons with gate data display. For failed/completed/killed nodes: retry and skip buttons. Includes a scrollable output stream with live updates via `useNodeOutput`.

#### `FlowStatusBar`

```typescript
function FlowStatusBar(props: {
  projection: ExecutionProjection;
}): JSX.Element;
```

Bottom status bar showing: node status counts (completed, running, pending, failed, gated, skipped, killed), overall execution status, elapsed time, total cost.

#### `MiniPipeline`

```typescript
function MiniPipeline(props: MiniPipelineProps): JSX.Element | null;

interface MiniPipelineProps {
  projection: ExecutionProjection;
  /** Rendering mode. auto: graph <=20, bar <=50, summary >50. */
  mode?: 'graph' | 'bar' | 'summary' | 'auto';
  /** Height in px. Default: 32 for graph, 8 for bar, 20 for summary. */
  height?: number;
}
```

Compact pipeline thumbnail for list views, cards, and sidebars (ADR-004). Three rendering modes based on node count:

- **`graph`** (<=20 nodes): Compact SVG mini-DAG with 6px status-colored dots and thin edges. Preserves topology (parallel branches, fan-in).
- **`bar`** (21-50 nodes): Proportional horizontal bar with status-colored segments.
- **`summary`** (>50 nodes): Text counts per status (e.g., "42 completed, 3 running, 1 failed").
- **`auto`** (default): Selects mode based on `projection.graph.nodes.length`.

#### `NodePanel` (Compound Component)

```typescript
const NodePanel: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> & {
  Header: React.FC<{ node: ProjectionNode; onClose: () => void }>;
  Info: React.FC<{ node: ProjectionNode }>;
  Error: React.FC<{ node: ProjectionNode }>;
  Gate: React.FC<{ node: ProjectionNode; onResolve: (resolution: string) => void }>;
  Controls: React.FC<{ node: ProjectionNode; onRetry: () => void; onSkip: () => void; executionRunning?: boolean }>;
  Output: React.FC<{
    lines: string[];
    total: number;
    loading?: boolean;
    renderer?: OutputRenderer;
    maxLines?: number;
    autoScroll?: boolean;
    isRunning?: boolean;
  }>;
};
```

Decomposed node detail panel (ADR-003). Each sub-component handles one concern and is independently composable. The dot-notation pattern (`NodePanel.Header`, `NodePanel.Gate`, etc.) allows arbitrary composition:

```tsx
<NodePanel>
  <NodePanel.Header node={node} onClose={close} />
  <NodePanel.Info node={node} />
  {node.status === 'gated' && <MyCustomGateUI />}
  <NodePanel.Controls node={node} onRetry={retry} onSkip={skip} />
  <NodePanel.Output lines={lines} total={total} renderer="ansi" />
</NodePanel>
```

Sub-components:

| Component | Purpose |
|-----------|---------|
| `NodePanel` | Shell container (flex column layout, dark theme) |
| `NodePanel.Header` | Status dot, display name, node type, close button |
| `NodePanel.Info` | Model, duration, attempt count, action taken |
| `NodePanel.Error` | Error message display (renders only when `node.error` is set) |
| `NodePanel.Gate` | Data-driven gate buttons from `gateData.allowedResolutions` (ADR-002) |
| `NodePanel.Controls` | Retry/Redo/Skip buttons (hidden while execution is running) |
| `NodePanel.Output` | Scrollable output stream with configurable renderer, copy, auto-scroll |

#### `OutputRenderer` type

```typescript
type OutputRenderer = 'plain' | 'ansi' | ((line: string, index: number) => React.ReactNode);
```

Configures how `NodePanel.Output` renders lines:

- `'plain'` (default): Lines rendered as text nodes. No `dangerouslySetInnerHTML`.
- `'ansi'`: ANSI escape codes converted to colored HTML spans. Uses `hasAnsi()` fast-path to skip conversion for plain lines.
- `function`: Custom renderer receives `(line, index)` and returns a ReactNode.

### Constants

#### `STATUS_COLORS`

```typescript
const STATUS_COLORS: Record<string, { dot: string; text: string; bg: string }>;
```

Maps node status strings to inline style colors. Used by `NodeCard`, `MiniPipeline`, `FlowStatusBar`, and available for custom components. Entries: `pending`, `running`, `completed`, `failed`, `killed`, `skipped`, `gated`, `retrying`.

### Hooks

#### `useFlowExecution`

```typescript
function useFlowExecution(options: {
  executionId: string | null;
  baseUrl?: string;
  pollInterval?: number;
}): {
  projection: ExecutionProjection | null;
  loading: boolean;
  error: string | null;
  sseStatus: FlowSSEStatus;
  refetch: () => Promise<void>;
};
```

Hook for a single execution. Fetches the initial projection via REST, then subscribes to an SSE stream for real-time updates. Falls back to polling when SSE disconnects.

`FlowSSEStatus`: `'connecting' | 'open' | 'closed' | 'error'`

#### `useFlowExecutions`

```typescript
function useFlowExecutions(baseUrl?: string): {
  executions: ExecutionProjection[];
  loading: boolean;
  refetch: () => Promise<void>;
};
```

Hook for the execution list. Fetches all executions on mount.

#### `useNodeOutput`

```typescript
function useNodeOutput(options: {
  executionId: string | null;
  nodeId: string | null;
  baseUrl?: string;
  autoScroll?: boolean;
}): {
  lines: string[];
  total: number;
  loading: boolean;
  scrollRef: React.RefObject<HTMLElement | null>;
  refetch: () => Promise<void>;
};
```

Hook for per-node output streaming. Fetches initial output, then subscribes to SSE for live updates. Returns a `scrollRef` for auto-scroll behavior.

### Utilities

#### `ansiToHtml(text: string): string`

Converts ANSI SGR escape sequences to HTML `<span>` elements with inline styles. Handles: 16 foreground colors (30-37, 90-97), bold (1), dim (2), reset (0, 22, 39). HTML-escapes the text content. Non-SGR sequences (cursor movement, OSC) are stripped.

#### `stripAnsi(text: string): string`

Removes all ANSI escape sequences from a string. Strips SGR, OSC, and single-character escapes. Used by the copy-to-clipboard feature in `NodePanel.Output`.

#### `hasAnsi(text: string): boolean`

Fast check for whether a string contains any ANSI escape sequences. Used as a fast-path in the ANSI renderer to skip `ansiToHtml()` for plain text lines.

#### `cn(...inputs: ClassValue[]): string`

Class name merging utility. Combines `clsx` and `tailwind-merge` for conflict-free Tailwind CSS class composition.
