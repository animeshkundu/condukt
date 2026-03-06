# ADR-006: Fan-Out Edges and Bounded Loop-Back

**Status**: Accepted
**Date**: 2026-03-05
**Deciders**: Architecture review (7-person adversarial team)

## Context

condukt's execution model is a DAG walker. Nodes are dispatched in topological order; edges route based on the action returned by each node. This works well for linear and branching pipelines, but it cannot express two patterns that real-world AI agent workflows need:

1. **Fan-out**: A single node's action dispatching multiple successor nodes in parallel. Today, one action maps to one target. Workaround: put all targets in `start[]`, which only works for the first batch.

2. **Convergence loops**: Two agents investigate independently, a reviewer checks convergence, and if they disagree, both re-investigate with the differences. This requires routing BACK to already-completed nodes — a bounded cycle. Today, completed nodes are permanently excluded from the frontier.

The motivating consumer is the availability dip pipeline: two frontier models from different families investigate independently, a convergence checker compares their findings, and on divergence, both re-run with the specific disagreements highlighted. The loop terminates when they converge or after N iterations.

## Decision

### Fan-out edges

Change the edge target type from `string` to `string | readonly string[]`. When a fan-out edge fires, the scheduler dispatches ALL targets, emitting one `edge:traversed` event per target. Existing single-target edges work identically (backward compatible).

### Bounded loop-back

When an edge fires and its target is already in the `completed` set, the scheduler recognizes a loop-back. It resets the target nodes and the source node (using a new targeted `resetLoopBody()` that does NOT cascade downstream), builds a `RetryContext` with the prior artifact content, and re-dispatches. After `maxIterations` (configurable per-loop via `loopFallback`), the scheduler routes to a fallback target instead.

A new `node:reset` event is emitted for each reset node, making loop-back fully observable in the event log and reconstructable on crash recovery.

### Loop configuration

Loop-back is configured via a new `loopFallback` field on `FlowGraph`:

```typescript
loopFallback: {
  'convergenceCheck:diverged': {
    source: 'convergenceCheck',
    action: 'diverged',
    fallbackTarget: 'deepDive',
    maxIterations: 3,
  },
}
```

This replaces an earlier proposal of using `${action}:exhausted` as a string convention, which was rejected during adversarial review because colons are valid in action names and the convention would collide silently.

## Alternatives Considered

### 1. Custom NodeFn loop (application-level)

A single node that internally manages multiple LLM sessions and checks convergence in a loop. Rejected because: the loop is invisible to the graph visualization, opaque to event sourcing, and untestable via graph-level tests.

### 2. Unrolled pipeline (no framework changes)

Explicitly define round 1 and round 2 nodes: `investigateA1`, `investigateA2`, etc. Rejected because: combinatorial explosion for N iterations, can't be parameterized at runtime, and violates DRY.

### 3. `:exhausted` action name convention

Encode the fallback as `'diverged:exhausted': 'deepDive'` in the edge map. Rejected during adversarial review: colons are valid in action strings, creating silent collision risk. The typed `loopFallback` field is explicit, validated, and IDE-discoverable.

### 4. Sub-flow nesting

Allow a node to contain an entire sub-graph. Rejected: fundamentally changes the execution model, adds a new abstraction layer, and the simple loop pattern doesn't warrant that complexity.

## Consequences

### Positive

- Convergence loop pattern is expressible as a first-class graph topology
- Fan-out enables parallel dispatch from any node, not just start
- All loop state is event-sourced: crash recovery, resume, and retry work correctly
- Backward compatible: existing single-target DAGs are unchanged
- Per-loop `maxIterations` allows different convergence thresholds in the same graph

### Negative

- UI layout must handle cycles (Kahn's algorithm assumes DAGs). Mitigated by excluding back-edges from topological sort and rendering them as arcs.
- `ProjectionNode` needs a new `iteration` field to distinguish loop iterations from retry attempts
- Scheduler complexity increases (loop detection, targeted reset, iteration tracking)
- Progress indication ("3/8 complete") becomes ambiguous with loops. Mitigated by showing "Running (iteration N)" instead.

### Risks

- Infinite loops if `validateGraph()` fails to detect unbounded cycles. Mitigated by: requiring `loopFallback` for every cycle-creating edge, hard cap of 100 total resets per execution.
- Fan-in corruption if loop reset clears firedEdges for unrelated paths. Mitigated by: `resetLoopBody()` only clears specific sources, not all sources to a target.

## New Types

```typescript
export type EdgeTarget = string | readonly string[];

export interface LoopFallbackEntry {
  readonly source: string;
  readonly action: string;
  readonly fallbackTarget: EdgeTarget;
  readonly maxIterations?: number;
}
```

## New Event

```typescript
export interface NodeResetEvent {
  readonly type: 'node:reset';
  readonly executionId: string;
  readonly nodeId: string;
  readonly reason: 'loop-back';
  readonly iteration: number;
  readonly sourceNodeId: string;
  readonly ts: number;
}
```
