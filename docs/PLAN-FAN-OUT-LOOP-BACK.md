# condukt: Fan-Out Edges + Loop-Back Support (v2 — Post-Adversarial Review)

## Context

The availability dip pipeline requires fan-out edges and loop-back edges in condukt. An adversarial review by 7 specialists surfaced 8 critical blockers in the v1 plan. This v2 plan addresses all of them.

## Critical Findings Addressed

| # | Finding | v1 Problem | v2 Solution |
|---|---------|-----------|-------------|
| 1 | No event for loop reset | Crash recovery can't reconstruct loop state | New `node:reset` event |
| 2 | `resetNodeAndDownstream` cascades too aggressively | Corrupts fan-in state for unrelated paths | New `resetLoopBody()` — targeted, non-cascading |
| 3 | `:exhausted` convention collides with user actions | Colons valid in action names | New `loopFallback` field on FlowGraph, not string convention |
| 4 | `attempt` conflates retries and iterations | UI can't distinguish | New `iteration` field on ProjectionNode |
| 5 | Frontier permanently skips completed nodes | Loop targets never re-dispatch | `node:reset` event + reducer resets status to `pending` |
| 6 | All fan-out targets fail → downstream hangs | Pending forever | Scheduler marks downstream as `skipped` when all predecessors failed |
| 7 | No per-loop timeout / infinite loop | Self-loops cause hang | `validateGraph()` rejects cycles without matching `loopFallback` entry |
| 8 | Per-graph `maxIterations` too coarse | Multi-loop graphs need different limits | Per-edge `maxIterations` via `LoopEdge` type |

---

## 1. Type Changes — `src/types.ts`

```typescript
// Fan-out: one action can dispatch multiple targets
export type EdgeTarget = string | readonly string[];

// FlowGraph — new fields
export interface FlowGraph {
  readonly nodes: Readonly<Record<string, NodeEntry>>;
  readonly edges: Readonly<Record<string, Readonly<Record<string, EdgeTarget>>>>;
  readonly start: readonly string[];
  readonly maxIterations?: number;       // global default (default 3)
  readonly loopFallback?: Readonly<Record<string, LoopFallbackEntry>>;  // per-loop config
}

// Loop fallback: replaces the `:exhausted` string convention
export interface LoopFallbackEntry {
  readonly source: string;        // node that fires the loop-back edge
  readonly action: string;        // action that triggers the loop
  readonly fallbackTarget: EdgeTarget;  // where to route when maxIterations exceeded
  readonly maxIterations?: number;      // per-loop override (defaults to graph.maxIterations ?? 3)
}
```

**Composer usage:**
```typescript
export const dipFlow: FlowGraph = {
  nodes: { ... },
  edges: {
    convergenceCheck: { converged: 'qualityGate', diverged: ['investigateA', 'investigateB'] },
  },
  start: ['investigateA', 'investigateB'],
  loopFallback: {
    'convergenceCheck:diverged': {
      source: 'convergenceCheck',
      action: 'diverged',
      fallbackTarget: 'deepDive',
      maxIterations: 3,
    },
  },
};
```

**Why this is better than `:exhausted`**: No action name collision. Explicit, typed, validated. Discoverable in IDE autocomplete.

---

## 2. New Event — `src/events.ts`

```typescript
export interface NodeResetEvent {
  readonly type: 'node:reset';
  readonly executionId: string;
  readonly nodeId: string;
  readonly reason: 'loop-back';
  readonly iteration: number;     // which iteration is starting
  readonly sourceNodeId: string;  // which node's completion triggered the reset
  readonly ts: number;
}
```

Add to `ExecutionEvent` union. This event is emitted BEFORE the loop targets are re-dispatched, ensuring crash recovery can reconstruct loop state.

---

## 3. Reducer — `state/reducer.ts`

### Handle `node:reset`
```typescript
case 'node:reset':
  return updateNode(state, event.nodeId, (n) => ({
    ...n,
    status: 'pending',
    iteration: event.iteration,
    // Keep attempt unchanged — iteration is separate from retry attempt
  }));
```

### New field on `ProjectionNode`
Add `iteration: number` (default 0). Incremented on `node:reset`, separate from `attempt` (which tracks retries).

### `completedPath` handling
On `node:reset`, do NOT remove from completedPath — it's an append-only historical log. But cap it at 200 entries to prevent unbounded growth.

---

## 4. Scheduler — `src/scheduler.ts`

### `normalizeTargets()` helper
```typescript
function normalizeTargets(target: EdgeTarget): string[] {
  return Array.isArray(target) ? [...target] : [target];
}
```

### `validateGraph()` — enhanced
1. Handle array targets in existence checks
2. **Cycle detection**: For every edge, check if any target can reach the source (DFS). If so, require a matching entry in `graph.loopFallback` keyed by `${source}:${action}`. Reject graphs with unbounded cycles.
3. **Self-loop detection**: Reject `A: { default: 'A' }` unless it has a loopFallback entry.

### `extractSkeleton()` — fan-out expansion
Expand array targets into multiple `GraphEdgeSkeleton` entries. Add `isLoopBack: boolean` flag for UI rendering.

### Edge firing (lines 476-505) — the core change

```typescript
// Phase 1b: Fire edges
for (const { nodeId, output } of newlyCompleted) {
  const edgeMap = graph.edges[nodeId];
  if (!edgeMap) continue;

  let rawTarget = edgeMap[output.action] ?? edgeMap['default'];
  if (!rawTarget) continue;

  let targets = normalizeTargets(rawTarget);

  // Loop-back detection: any target already completed?
  const isLoopBack = targets.some(t => t !== 'end' && completed.has(t));

  if (isLoopBack) {
    const key = `${nodeId}:${output.action}`;
    const count = (loopIterations.get(key) ?? 0) + 1;
    loopIterations.set(key, count);

    // Check per-loop or global max
    const fallbackEntry = graph.loopFallback?.[key];
    const max = fallbackEntry?.maxIterations ?? graph.maxIterations ?? 3;

    if (count > max) {
      // Exhausted — route to fallback
      if (fallbackEntry?.fallbackTarget) {
        targets = normalizeTargets(fallbackEntry.fallbackTarget);
      } else {
        continue; // no fallback = terminal
      }
    } else {
      // Reset loop body (targeted, not cascading)
      await resetLoopBody(targets, nodeId, completed, nodeStatuses, firedEdges,
                          graph, dir, emitState, executionId, count);
    }
  }

  // Fire edges to all targets
  for (const t of targets) {
    if (t === 'end') continue;
    let sources = firedEdges.get(t);
    if (!sources) { sources = new Set(); firedEdges.set(t, sources); }
    sources.add(nodeId);
    await emitState({ type: 'edge:traversed', executionId, source: nodeId, target: t, action: output.action, ts: Date.now() });
  }
}
```

### `resetLoopBody()` — NEW targeted reset (replaces BFS cascade)

Only resets the EXACT nodes in the loop body. Does NOT cascade downstream.

```typescript
async function resetLoopBody(
  targets: string[],
  sourceNodeId: string,
  completed: Map<string, {...}>,
  nodeStatuses: Map<string, string>,
  firedEdges: Map<string, Set<string>>,
  graph: FlowGraph,
  dir: string,
  emitState: (e: ExecutionEvent) => Promise<void>,
  executionId: string,
  iteration: number,
): Promise<void> {
  // 1. Reset each target node
  for (const t of targets) {
    completed.delete(t);
    nodeStatuses.set(t, 'pending');
    firedEdges.delete(t);  // clear fan-in tracking for this target
    await emitState({ type: 'node:reset', executionId, nodeId: t, reason: 'loop-back',
                      iteration, sourceNodeId, ts: Date.now() });
  }

  // 2. Reset the source node (it needs to re-run after targets complete)
  completed.delete(sourceNodeId);
  nodeStatuses.set(sourceNodeId, 'pending');
  // Clear ONLY the firedEdges TO the source from the loop targets
  // NOT from other unrelated sources
  const sourceFiredEdges = firedEdges.get(sourceNodeId);
  if (sourceFiredEdges) {
    for (const t of targets) sourceFiredEdges.delete(t);
    // If no sources remain, delete the entry
    if (sourceFiredEdges.size === 0) firedEdges.delete(sourceNodeId);
  }
  await emitState({ type: 'node:reset', executionId, nodeId: sourceNodeId, reason: 'loop-back',
                    iteration, sourceNodeId, ts: Date.now() });
}
```

**Key difference from v1**: Does NOT BFS cascade. Only touches the exact loop body nodes (targets + source). Preserves firedEdges for unrelated fan-in paths.

### All-fail fan-out handling (Phase 2 addition)

After computing nextPending, check if any fan-out target set has ALL members in `failedNodes`. If so, downstream nodes waiting on that fan-out will never fire — mark them as `skipped`.

### Resume reconstruction

When `resumeFrom` is provided, reconstruct `loopIterations` by scanning `edge:traversed` events in the projection. Count how many times each `source:action` pair appears where the target was already completed at traversal time. Practically: count `node:reset` events grouped by `sourceNodeId:action`.

---

## 5. Bridge — `bridge/bridge.ts`

### `resetNodeAndDownstream()` — handle array targets
BFS: use `normalizeTargets()` when iterating edge targets. This is for the existing `retryNode` mechanism (user-triggered retry), not for loop-back (which uses `resetLoopBody`).

### `buildResumeState()` — reconstruct loop iterations
Add `loopIterations` to `ResumeState`:
```typescript
export interface ResumeState {
  readonly completedNodes: Map<string, { action: string; finishedAt: number }>;
  readonly firedEdges: Map<string, Set<string>>;
  readonly nodeStatuses: Map<string, string>;
  readonly loopIterations: Map<string, number>;  // NEW: source:action → count
}
```

Reconstruct from projection: count `node:reset` events per `sourceNodeId`.

---

## 6. UI/UX Changes

### Layout: Simplified cycle handling (not full Sugiyama)

Instead of implementing full Sugiyama (complex, error-prone), use a simpler approach:
1. **Detect back-edges** in `computeLayout()`: any edge where target's layer < source's layer
2. **Exclude back-edges from Kahn's sort** — run Kahn's on the DAG subset, assign layers normally
3. **Render back-edges as arcs** — separate pass, styled distinctly (dashed, loop arrow icon)

This is simpler, correct, and preserves existing DAG layout quality.

### FlowEdge.tsx — back-edge rendering
- Normal edges: left-to-right bezier (unchanged)
- Back-edges: curved arc above the graph with a loop icon and iteration badge ("×2")

### MiniPipeline.tsx — same simplified cycle detection
- Exclude back-edges from layer computation
- Render them as thin arcs in graph mode

### Progress indication
- Graphs with loops: show "Running (iteration N)" instead of "N/M nodes complete"
- `ProjectionNode.iteration` drives the display

### Node status display
- When a node is reset, it shows "pending (iteration 2)" instead of raw "pending"
- The `iteration` field is visible in the node detail panel

---

## 7. Testing Plan (~55 new tests)

### Fan-out (8 tests)
| # | Test |
|---|------|
| 1 | A → [B, C]: both dispatch in parallel |
| 2 | A → [B, C] → D: D waits for both (diamond) |
| 3 | Conditional fan-out: pass → [B, C], fail → D |
| 4 | Fan-out with 'end': [B, 'end'] → only B dispatches |
| 5 | Fan-out edge events: one `edge:traversed` per target |
| 6 | All fan-out targets fail → downstream skipped |
| 7 | Partial fan-out failure → downstream waits for all settled |
| 8 | Multi-level fan-out: A → [B, C], B → [D, E] |

### Loop-back (15 tests)
| # | Test |
|---|------|
| 9 | Simple loop: A → B → A (converges on iteration 2) |
| 10 | Loop with fan-out: [A, B] → C → [A, B] (dip pattern) |
| 11 | Max iterations exhausted → routes to loopFallback |
| 12 | Custom per-edge maxIterations |
| 13 | RetryContext on loop (prior output + iteration count) |
| 14 | Loop resets source node (convergenceCheck re-runs) |
| 15 | Loop does NOT cascade downstream (qualityGate untouched) |
| 16 | Fan-in preserved: unrelated sources not cleared on loop reset |
| 17 | `node:reset` event emitted for each reset node |
| 18 | `iteration` field incremented on ProjectionNode |
| 19 | Loop + abort: stops cleanly mid-loop |
| 20 | Loop + gate node as convergence check |
| 21 | Self-loop: A → A (with loopFallback) |
| 22 | Nested loops: A → B → A AND B → C → B |
| 23 | Artifact lifecycle: overwritten per iteration, prior content in RetryContext |

### Validation (5 tests)
| # | Test |
|---|------|
| 24 | Cycle without loopFallback → FlowValidationError |
| 25 | Array target with missing node → FlowValidationError |
| 26 | Self-loop without loopFallback → FlowValidationError |
| 27 | loopFallback referencing non-existent node → FlowValidationError |
| 28 | Backward compat: single string targets unchanged |

### Lifecycle (10 tests)
| # | Test |
|---|------|
| 29 | Stop mid-fan-out: running nodes killed |
| 30 | Resume after stop mid-fan-out: incomplete target re-dispatches |
| 31 | Stop mid-loop: all active nodes killed, loop state preserved |
| 32 | Resume after stop mid-loop: iteration count reconstructed correctly |
| 33 | Retry node within loop: downstream resets, iteration count preserved |
| 34 | Retry loop source: resets loop body, re-runs |
| 35 | Skip one fan-out target: downstream fan-in still proceeds |
| 36 | Skip within loop: loop proceeds with remaining targets |
| 37 | Resume mid-loop with one target crashed: only crashed target re-dispatches |
| 38 | retryNode + loop iteration counter interaction |

### Integration (7 tests)
| # | Test |
|---|------|
| 39 | Full convergence loop: converge on round 1 (happy path) |
| 40 | Full convergence loop: diverge then converge on round 2 |
| 41 | Full convergence loop: exhausted after maxIterations → fallback |
| 42 | Full dip pipeline mock: investigate → converge → QG → workitem |
| 43 | Resume from crashed mid-loop: full pipeline completes |
| 44 | Event log: verify event count for N-iteration loop |
| 45 | completedPath capped at 200 entries |

### Reducer (5 tests)
| # | Test |
|---|------|
| 46 | `node:reset` resets status to pending, sets iteration |
| 47 | `node:started` after `node:reset` increments attempt |
| 48 | completedPath doesn't shrink on reset |
| 49 | Multiple resets: iteration correctly incremented |
| 50 | Projection serialization/deserialization with loop state |

### UI (5 tests)
| # | Test |
|---|------|
| 51 | FlowGraph layout: back-edges excluded from Kahn's, rendered as arcs |
| 52 | MiniPipeline handles cycle without infinite layout loop |
| 53 | Fan-out edges render correctly (multiple from one source) |
| 54 | Node iteration badge shows in node detail |
| 55 | Progress shows "Running (iteration N)" for looped graphs |

---

## 8. Documentation Updates

### `CLAUDE.md`
- Update "DAG walker" → "graph walker with bounded cycle support"
- Add `EdgeTarget`, `LoopFallbackEntry` to key types
- Update test count

### `docs/ARCHITECTURE.md`
- Update execution system: fan-out + bounded loops
- New section: Loop-back edge execution model

### `docs/COMPOSITION_GUIDE.md`
- New section: "Fan-Out Routing" with examples
- New section: "Convergence Loops" with `loopFallback` pattern
- Show `maxIterations` and `RetryContext.iteration` usage

### `docs/API.md`
- Updated FlowGraph, LoopFallbackEntry, EdgeTarget types
- Updated validateGraph behavior

### NEW: `docs/adr/ADR-006-fan-out-loop-back.md`
- Decision, context, alternatives (custom NodeFn, unrolled pipeline, `:exhausted` convention)
- Rejected `:exhausted` due to action name collision risk (adversarial finding #3)
- Adopted `loopFallback` field + `node:reset` event for crash-safe loops

---

## 9. Implementation Order

| Phase | Files | Tests | What |
|-------|-------|-------|------|
| 1 | `src/types.ts`, `src/events.ts` | 0 | `EdgeTarget`, `LoopFallbackEntry`, `FlowGraph.loopFallback`, `NodeResetEvent`, `ResumeState.loopIterations` |
| 2 | `src/scheduler.ts` | 8 | `normalizeTargets()`, `validateGraph()` cycle detection, `extractSkeleton()` — fan-out only |
| 3 | `state/reducer.ts` | 5 | Handle `node:reset`, `iteration` field, completedPath cap |
| 4 | `src/scheduler.ts` | 15 | `resetLoopBody()`, loop-back detection, iteration tracking, RetryContext, fallback routing, all-fail fan-out |
| 5 | `bridge/bridge.ts` | 10 | `resetNodeAndDownstream()` array handling, `buildResumeState()` loop reconstruction, lifecycle tests |
| 6 | `ui/components/` | 5 | Back-edge detection, arc rendering, iteration badge, progress |
| 7 | Integration + full pipeline | 7 | End-to-end convergence loop, resume, event log |
| 8 | `docs/*`, `CLAUDE.md` | 0 | Architecture, Composition Guide, API, ADR-006 |

---

## 10. Verification

### Per-phase gates
- After each phase: `npm run typecheck && npm test && npm run build`
- Existing 233 tests must pass at every phase

### Final gate
```bash
npm run typecheck  # clean
npm test           # 233 + 55 = 288 pass
npm run build      # clean dist
```

### Manual lifecycle verification
1. **Stop mid-loop** → execution stops, `node:killed` emitted, loop state in event log
2. **Resume mid-loop** → iteration count reconstructed, continues from checkpoint
3. **Retry within loop** → downstream resets, iteration counter preserved
4. **Full convergence loop** → diverge × 2, then converge, qualityGate runs once

---

## 11. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Infinite loop | `validateGraph()` rejects cycles without `loopFallback`. Hard cap: 100 total resets per execution. |
| Fan-out corrupts fan-in | `resetLoopBody()` only clears specific sources from firedEdges, not all sources. |
| Crash mid-loop loses state | `node:reset` event persisted before re-dispatch. Reducer reconstructs loop state on replay. |
| Action name collision | `loopFallback` is a separate typed field, not encoded in action strings. |
| UI layout hangs on cycles | Back-edges excluded from Kahn's sort. Cycle detection is a pre-pass, not embedded in layout. |
| Event log bloat | Cap completedPath at 200. Document: loops >10 iterations not recommended for perf. |
| Memory from RetryContext | RetryContext reads artifact once (prior iteration). Artifact is overwritten each iteration. Max memory = 1 artifact per looped node. |
