# Handoff

Everything that doesn't fit in CLAUDE.md, API.md, or ARCHITECTURE.md. Read those first.

---

## Known Issues

### Barrel import pulls FlowGraph CSS

The `ui/index.ts` barrel re-exports `FlowGraph`, which imports `@xyflow/react` and its CSS. Any consumer importing from `condukt/ui` gets the CSS side-effect even if they only want `NodePanel` or `ansiToHtml`.

**Workaround**: Compositions that only need ANSI utilities or compound components should import them from the specific file path (`condukt/ui/ansi` or `condukt/ui/components/node-panel`) rather than the barrel. In practice this means the investigation composition imports ANSI utilities locally rather than through the barrel.

**Fix**: Split `/ui` into `/ui/graph` and `/ui/panel` sub-path exports. Deferred to avoid churn.

### CJS build output (not ESM)

`tsconfig.build.json` emits CommonJS (`"module": "CommonJS"`). This was a deliberate choice for Turbopack compatibility -- Next.js 16's Turbopack has edge cases with ESM-only packages resolved via `file:` links. The trade-off is slightly larger bundle size and no top-level await.

Revisit when Turbopack ESM resolution stabilizes.

### `file:` link copies on Windows (not symlink)

When the consuming application (e.g., `geneva-dashboard`) uses `"condukt": "file:../flow-framework"` in `package.json`, npm on Windows **copies** the package into `node_modules` rather than creating a symlink. This means:

- Changes to the framework source are NOT reflected until you re-run `npm install` in the consuming app
- The `dist/` directory must be rebuilt (`npm run build`) before reinstalling
- On macOS/Linux, npm does create a symlink, so the behavior differs across platforms

**Workflow**: After making changes to the framework, run `npm run build` in `flow-framework/`, then `npm install` in the consuming app.

---

## Integration Pattern

### Webpack aliases in next.config.ts

When consuming this package in a Next.js app, Turbopack/Webpack may fail to resolve sub-path exports from `file:`-linked packages. The consuming app's `next.config.ts` needs explicit aliases:

```typescript
// next.config.ts
const config = {
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      'condukt/state': path.resolve('../flow-framework/dist/state/index.js'),
      'condukt/bridge': path.resolve('../flow-framework/dist/bridge/index.js'),
      'condukt/runtimes/copilot': path.resolve('../flow-framework/dist/runtimes/copilot/index.js'),
      'condukt/runtimes/mock': path.resolve('../flow-framework/dist/runtimes/mock/index.js'),
      'condukt/ui': path.resolve('../flow-framework/dist/ui/index.js'),
    };
    return config;
  },
};
```

### HMR survival: globalThis-backed singletons

The gate registry (`src/nodes.ts`) uses a `globalThis`-backed `Map` keyed by a `Symbol`. This survives:

- **HMR**: Next.js dev server reloads modules but `globalThis` persists
- **Separate entry points**: Server-side and client-side entry points share the same `globalThis`
- **Bundler dedup failures**: Even if the module is loaded twice, the `Symbol` key is shared

The consuming app's `flow-state.ts` singleton (StateRuntime, Bridge, EventBus) should follow the same pattern:

```typescript
const FLOW_KEY = Symbol.for('condukt/state');
const g = globalThis as Record<symbol, unknown>;
if (!g[FLOW_KEY]) {
  g[FLOW_KEY] = createBridge(runtime, new StateRuntime(new FileStorage(dir)));
}
export const bridge = g[FLOW_KEY] as BridgeApi;
```

---

## Deferred Items

| Item | Rationale | Trigger |
|------|-----------|---------|
| **FlowCard** | List-item card combining MiniPipeline + metadata (status, duration, params). Designed in ADR-004 discussion but deferred -- consumers compose their own card layout for now. | When 2+ consuming apps need the same card layout. |
| **Graph folding for 100+ nodes** | MiniPipeline `summary` mode handles large graphs, but the full `FlowGraph` becomes unusable above ~100 nodes. Collapse parallel groups into expandable clusters. | When a real composition exceeds 50 nodes. |
| **`node:metric` event** | Structured numeric event for per-node metrics (tokens, cost, latency). Currently folded into `metadata` event. Separate event type enables dashboard aggregation. | When cost tracking is implemented. |
| **ShellRuntime** | `AgentRuntime` implementation that runs shell commands instead of LLM sessions. For deterministic nodes that need subprocess execution without the agent protocol. | When a composition needs subprocess nodes. |
| **ESM build** | Switch `tsconfig.build.json` from CJS to ESM. Blocked by Turbopack compat. | When Turbopack reliably resolves ESM sub-path exports from `file:` links. |
| **GraphRegistry (ADR-005)** | Server-side registry mapping `flowId` to `FlowGraph`. Designed and accepted, not yet implemented. Unblocks the retry API path for deployed environments. | Before first production deployment. |

---

## Review Findings Summary

### 7-Expert Review (Design Phase)

Seven domain experts reviewed the flow framework design documents. Key findings:

- **Scheduler**: Fan-in logic must track edges, not just predecessor node count (a node with 2 edges from the same source is not a fan-in of 2). Fixed in implementation.
- **Agent**: GT-3 crash recovery needs BOTH conditions (completion indicator seen AND artifact exists). Either alone produces false positives. Validated empirically.
- **State**: Per-execution mutex (SYS-1) is mandatory. Without it, concurrent event handling produces corrupted projections. Promise-chain mutex chosen over `AsyncMutex` for zero-dependency.
- **Bridge**: Concurrency limit (10) prevents resource exhaustion. Dedup check prevents double-launch from UI double-clicks.
- **Types**: `NodeFn` takes two args `(input, ctx)` -- deviation from initial single-arg design. Pragmatic: separates data (input) from services (context).
- **Storage**: Path traversal validation on every storage operation. `safePath()` rejects `..`, absolute paths, and null bytes.
- **Resume**: `computeFrontier()` must handle partially-completed fan-in (some predecessors completed, some not). Implemented via fired-edges tracking.

### 8-Expert Review (Implementation Phase)

Eight experts (including adversaries for investigation-bias and framework-level concerns) reviewed the implemented code. Key findings and resolutions:

- **Timer leaks**: Agent node `setTimeout` could leak if abort fired between setup and session creation. Fixed: clear timer in all exit paths.
- **Gate events**: `gate:resolved` event was emitted by bridge but not by scheduler. Both must emit for correct projection rebuild. Fixed: scheduler emits on gate unblock, bridge emits for persistence.
- **Resume lifecycle**: Resume after gate rejection left downstream nodes in `pending` instead of propagating the skip. Fixed: skip propagation in bridge resume path.
- **Path traversal**: Storage `safePath()` was only checking for `..` but not null bytes or absolute paths on Windows. Fixed: comprehensive validation.
- **Output renderer default**: ANSI was the default renderer, biasing toward CLI-based pipelines. Fixed: plain text default (ADR-001).
- **Gate buttons**: Hardcoded approve/reject buttons preclude custom gate resolutions. Fixed: data-driven buttons (ADR-002).
- **NodeDetailPanel extensibility**: Monolithic component with 6+ customization points. Fixed: compound components (ADR-003).
- **MiniPipeline threshold**: 12-node threshold was investigation-biased (9-node pipeline + headroom). Fixed: three modes with higher thresholds (ADR-004).

### Migration Trigger

The compound component pattern (ADR-003) was originally planned as "ship render slots, migrate to compounds when >2 slots needed." The 8-expert review identified 6+ customization points (output renderer, gate buttons, model display, line cap, auto-scroll, section ordering), triggering the migration before the first release rather than as a follow-up refactor.
