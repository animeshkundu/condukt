# Fan-Out and Loop-Back: Design Document

## Philosophy

condukt's original model is simple: a DAG of nodes connected by action-routed edges. This simplicity is a strength — it's predictable, resumable, and easy to visualize. We are extending it, not replacing it.

The extension serves one core insight from AI agent pipeline design: **accuracy through independent convergence**. When two agents from different model families independently reach the same conclusion, that conclusion is almost certainly correct. When they disagree, the specific disagreements are the most valuable signal for further investigation. This pattern — parallel investigation, convergence check, conditional re-investigation — is a bounded cycle in the graph.

### Guiding Principles

1. **DAGs are the common case.** Fan-out and loop-back are opt-in. A graph with no array targets and no `loopFallback` behaves exactly as before. Zero overhead for DAGs.

2. **Loops are bounded, never unbounded.** Every cycle in the graph must have a corresponding `loopFallback` entry with a `maxIterations` limit and a fallback target. `validateGraph()` enforces this. There is no way to create an infinite loop through the graph API.

3. **Event sourcing is the source of truth.** Every state mutation — including loop-back resets — is recorded as an immutable event. The projection is always reconstructable from the event log. Crash mid-loop, restart, same result.

4. **Targeted reset, not cascading.** When a loop fires back, only the loop body (targets + source) is reset. Downstream nodes that haven't run yet are untouched. Fan-in sources from unrelated paths are preserved. This is the hardest invariant to get right and the most critical.

5. **Iteration is not retry.** A node that loops 3 times is on iteration 3, not attempt 3. Retry (triggered by the user after a failure) is a separate concept tracked by `attempt`. The UI must distinguish these.

## Execution Model

### Fan-out

```
A returns { action: 'default' }
Edge: A: { default: ['B', 'C'] }

Scheduler:
  1. Resolve target: ['B', 'C']
  2. Fire edge A→B, emit edge:traversed
  3. Fire edge A→C, emit edge:traversed
  4. Both B and C enter frontier (if all their other prerequisites met)
  5. Dispatch B and C in parallel
```

Fan-out is pure sugar. It's equivalent to having two separate actions that route to different targets, except both fire from the same action. The fan-in semantics are unchanged: a downstream node waits for ALL fired sources.

### Loop-back

```
A + B → C (fan-in)
C returns { action: 'diverged' }
Edge: C: { diverged: ['A', 'B'], converged: 'D' }
loopFallback: { 'C:diverged': { source: 'C', action: 'diverged', fallbackTarget: 'E', maxIterations: 3 } }

Scheduler (iteration 1):
  1. C completes with action 'diverged'
  2. Resolve target: ['A', 'B']
  3. Detect loop-back: A and B are already in completed set
  4. loopIterations['C:diverged'] = 1, which is <= 3 (max)
  5. RESET:
     a. Emit node:reset for A (iteration: 1)
     b. Emit node:reset for B (iteration: 1)
     c. Clear A from completed, firedEdges
     d. Clear B from completed, firedEdges
     e. Emit node:reset for C (iteration: 1)
     f. Clear C from completed
     g. Clear ONLY A and B from C's firedEdges sources (preserve other sources)
  6. Build RetryContext for A and B (prior artifact + iteration count)
  7. Fire edges C→A and C→B
  8. A and B enter frontier, dispatch in parallel
  9. When both complete, they fire edges to C
  10. C enters frontier (fan-in: both A and B completed)
  11. C runs again, checks convergence...

Scheduler (after max iterations):
  1. C completes with action 'diverged'
  2. loopIterations['C:diverged'] = 4, which is > 3 (max)
  3. Look up fallback: 'E'
  4. Fire edge C→E instead
  5. Normal execution continues
```

### The Reset Contract

`resetLoopBody(targets, source)` is the most safety-critical function. Its contract:

**MUST reset:**
- Each target node: clear from `completed`, `nodeStatuses`, `firedEdges[target]`
- The source node: clear from `completed`, `nodeStatuses`
- Only the target→source entries in `firedEdges[source]` (not other fan-in sources)

**MUST NOT reset:**
- Any node downstream of the source (they haven't run in this iteration)
- Any fan-in source to the loop body nodes from outside the loop
- The `loopIterations` counter (it accumulates across iterations)

**MUST emit:**
- `node:reset` event for every reset node, BEFORE re-dispatch

### All-Fail Fan-Out

If all targets in a fan-out FAIL (throw errors), no edge fires from them to their downstream. The downstream node will wait forever. The scheduler must detect this: after processing a batch, if any node in `firedEdges` has ALL its sources in `failedNodes`, mark the target as `skipped`.

## State Model

### ProjectionNode additions

```typescript
interface ProjectionNode {
  // ... existing fields ...
  iteration: number;  // NEW: 0 for first run, incremented on each node:reset
  // `attempt` remains for retries (user-triggered)
}
```

### ResumeState additions

```typescript
interface ResumeState {
  // ... existing fields ...
  loopIterations: Map<string, number>;  // source:action → iteration count
}
```

Reconstructed from event log by counting `node:reset` events grouped by `sourceNodeId`.

## UI Model

### Layout

Back-edges (edges from later layers to earlier layers) are excluded from Kahn's topological sort. They are detected in a pre-pass and rendered as curved arcs above the graph. This preserves the existing DAG layout quality for the forward edges while showing the loop structure clearly.

### Progress

Graphs with loops cannot show "N/M nodes complete" because M is variable. Instead:
- DAGs (no loopFallback): show "N/M nodes complete" (unchanged)
- Graphs with loops: show "Running (iteration N)" where N comes from the highest `ProjectionNode.iteration` value

### Node Display

A node in iteration 2 shows a small badge: "iter 2". This is separate from the retry badge ("attempt 2"). Both can be present simultaneously.

## Lifecycle Interactions

### Stop

AbortSignal propagates to all running nodes. Mid-loop state is preserved in the event log. No special handling needed.

### Resume

`buildResumeState()` reconstructs `loopIterations` from `node:reset` events. `computeFrontier()` finds the incomplete nodes in the current iteration. Resume dispatches them.

### Retry

User-triggered `retryNode()` uses the existing `resetNodeAndDownstream()` (updated to handle array targets). Loop iteration count is NOT reset by retry — it's part of the execution history. The node's `attempt` counter increments; `iteration` stays the same.

### Skip

Skipping a fan-out target: the target is marked `skipped` (treated as completed). Fan-in downstream sees all sources as settled. Loop-back: if the skipped target is part of a loop, the convergence check still runs (with one fewer input). If ALL loop targets are skipped, the loop effectively passes through.

## Validation

`validateGraph()` gains three new checks:

1. **Array target existence**: Every element in an `EdgeTarget` array must exist in `graph.nodes` or be `'end'`.
2. **Cycle detection**: DFS from every node. If a cycle is found, require a matching `loopFallback` entry keyed by `${source}:${action}`.
3. **Fallback target existence**: Every `loopFallback.fallbackTarget` must exist in `graph.nodes` or be `'end'`.

Graphs without cycles pass validation with zero overhead (the cycle detection DFS finds nothing).

## File Change Summary

| File | Nature of Change |
|------|-----------------|
| `src/types.ts` | `EdgeTarget` type, `LoopFallbackEntry` interface, `FlowGraph.loopFallback`, `FlowGraph.maxIterations`, `ResumeState.loopIterations` |
| `src/events.ts` | `NodeResetEvent` added to `ExecutionEvent` union |
| `src/scheduler.ts` | `normalizeTargets()`, `validateGraph()` cycle detection, `extractSkeleton()` fan-out expansion, edge firing with loop-back, `resetLoopBody()`, all-fail fan-out detection |
| `state/reducer.ts` | Handle `node:reset` event, `ProjectionNode.iteration` field, completedPath cap at 200 |
| `bridge/bridge.ts` | `resetNodeAndDownstream()` handles array targets, `buildResumeState()` reconstructs `loopIterations` |
| `ui/components/FlowGraph.tsx` | Back-edge detection pre-pass, exclude from Kahn's sort |
| `ui/components/FlowEdge.tsx` | Back-edge arc rendering |
| `ui/components/MiniPipeline.tsx` | Cycle-aware layout, back-edge arcs in graph mode |
