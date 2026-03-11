# condukt — LLM Instructions

## What This Is

A generic, composable AI agent workflow framework. Three decoupled systems: stateless execution engine, event-sourced state manager, reactive UI. 100% generic — zero domain vocabulary.

## Structure (12 sub-path exports)

| Entry Point | Directory | Purpose |
|-------------|-----------|---------|
| `condukt` | `src/` | Core execution: scheduler, agent, deterministic, gate, verify |
| `condukt/state` | `state/` | Event-sourced persistence: reducer, state-runtime, storage |
| `condukt/state/server` | `state/` | Server-only: FileStorage (JSONL persistence) |
| `condukt/bridge` | `bridge/` | Orchestration API: launch, stop, resume, retry, skip, approve |
| `condukt/runtimes/copilot` | `runtimes/copilot/` | GitHub Copilot runtime: SubprocessBackend, SdkBackend, adapter |
| `condukt/runtimes/mock` | `runtimes/mock/` | Deterministic test runtime |
| `condukt/ui` | `ui/` | React Flow visualization (optional peer: react, @xyflow/react) |
| `condukt/ui/core` | `ui/core/` | Design-system primitives: Badge, Button, ExecutionCard, etc. |
| `condukt/ui/graph` | `ui/graph/` | FlowGraph + FlowEdge (React Flow wrappers) |
| `condukt/ui/tool-display` | `ui/tool-display/` | ResponsePartRenderer, SubagentSection, 50+ built-in formatters |
| `condukt/theme` | `theme/` | STATUS_COLORS, theme tokens |
| `condukt/utils` | `utils/` | Shared utilities |

## Key Files

| File | Purpose |
|------|---------|
| `src/types.ts` | All type definitions: NodeFn, FlowGraph, EdgeTarget, LoopFallbackEntry, ExecutionProjection, AgentRuntime |
| `src/events.ts` | 16 execution events + 2 output events (discriminated unions) |
| `src/scheduler.ts` | Graph walker: fan-in, fan-out, bounded loop-back, parallel dispatch, per-node timeout, abort, resume |
| `src/agent.ts` | LLM agent factory with GT-3 crash recovery, setup/teardown hooks |
| `src/nodes.ts` | deterministic() + gate() factories, resolveGate() |
| `src/verify.ts` | Iterative verification combinator |
| `state/reducer.ts` | Pure event->projection fold |
| `state/state-runtime.ts` | Cache, crash recovery, event routing, per-execution mutex |
| `state/storage.ts` | File-based JSONL storage with path traversal safety |
| `bridge/bridge.ts` | Orchestration API: launch, stop, resume, retry, skip, approve |
| `runtimes/copilot/subprocess-backend.ts` | CopilotBackend via child_process.spawn |
| `runtimes/copilot/sdk-backend.ts` | SdkBackend via @github/copilot-sdk (streaming, tool calls, sub-agents) |
| `runtimes/mock/mock-runtime.ts` | Deterministic test runtime |
| `ui/components/node-panel/` | Compound NodePanel: Header, Info, ErrorBar, Gate, Controls, Output (ADR-003) |
| `ui/components/MiniPipeline.tsx` | Three-mode pipeline thumbnail: graph/bar/summary (ADR-004) |
| `ui/tool-display/ResponsePartRenderer.tsx` | Renders response parts: tool calls, thinking, text, sub-agents |
| `ui/tool-display/SubagentSection.tsx` | Collapsible sub-agent grouping with nested tool display |
| `ui/tool-display/formatter.ts` | 50+ built-in tool formatters, `renderToolExpanded` callback for custom rendering |
| `ui/ansi.ts` | ANSI escape code utilities: ansiToHtml, stripAnsi, hasAnsi |

## Commands

```bash
npm test              # Run all tests (596 across 48 suites)
npm run typecheck     # tsc --noEmit
npm run build         # Build to dist/
npm run clean         # Remove dist/
```

## Rules

1. **Zero domain vocabulary** — the framework must never import investigation-specific concepts
2. **Zero `any` types** — use generic types, branded types, or explicit `unknown`
3. **Readonly by default** — all interface fields are `readonly`
4. **Discriminated unions for events** — every event has a `type` field
5. **Tests must pass** — 596 tests across 48 suites, all must pass before commit
6. **Plain text default** — output renderer defaults to plain text, ANSI is opt-in (ADR-001)
7. **Data-driven gates** — gate buttons from `allowedResolutions`, not hardcoded (ADR-002)
8. **Compound components** — NodePanel is decomposed, NodeDetailPanel is convenience default (ADR-003)
9. **Follow `DESIGN_LANGUAGE.md`** — all visual tokens, spacing, typography, and component patterns are codified there

## Test Suites

| Suite | File | Tests |
|-------|------|-------|
| Scheduler | `__tests__/scheduler.test.ts` | 12 |
| Scheduler (comprehensive) | `__tests__/scheduler-comprehensive.test.ts` | 22 |
| Fan-out | `__tests__/fan-out.test.ts` | 12 |
| Loop-back | `__tests__/loop-back.test.ts` | 17 |
| Agent | `__tests__/agent.test.ts` | 17 |
| Nodes | `__tests__/nodes.test.ts` | 10 |
| Verify | `__tests__/verify.test.ts` | 9 |
| Reducer | `__tests__/reducer.test.ts` | 20 |
| Storage | `__tests__/storage.test.ts` | 11 |
| State Runtime | `__tests__/state-runtime.test.ts` | 15 |
| State Barrel Import | `__tests__/state-barrel-import.test.ts` | 2 |
| Bridge | `__tests__/bridge.test.ts` | 9 |
| Bridge (comprehensive) | `__tests__/bridge-comprehensive.test.ts` | 29 |
| Integration | `__tests__/integration.test.ts` | 7 |
| Integration (comprehensive) | `__tests__/integration-comprehensive.test.ts` | 10 |
| Integration (loops) | `__tests__/integration-loop.test.ts` | 7 |
| Branch Coverage | `__tests__/branch-coverage.test.ts` | 35 |
| Copilot Adapter | `__tests__/copilot-adapter.test.ts` | 5 |
| SDK Backend Events | `__tests__/runtimes/sdk-backend-events.test.ts` | 6 |
| Subprocess JSONL | `__tests__/subprocess-jsonl.test.ts` | 24 |
| SSE | `__tests__/sse.test.ts` | 8 |
| Setup Once | `__tests__/setup-once.test.ts` | 5 |
| HMR Singleton | `__tests__/hmr-singleton.test.ts` | 4 |
| Mock Runtime Reasoning | `__tests__/mock-runtime-reasoning.test.ts` | 3 |
| Reasoning E2E | `__tests__/reasoning-e2e.test.ts` | 4 |
| E2E Dip Pipeline | `__tests__/e2e-dip-pipeline.test.ts` | 2 |
| NodePanel | `__tests__/node-panel.test.ts` | 24 |
| MiniPipeline | `__tests__/mini-pipeline.test.ts` | 11 |
| Primitives | `__tests__/primitives.test.tsx` | 21 |
| Tool Display | `__tests__/tool-display.test.ts` | 72 |
| Subagent Grouping | `__tests__/ui/subagent-grouping.test.ts` | 10 |
| Cycle-aware UI | `__tests__/ui/cycle-aware-ui.test.tsx` | 7 |
| Controls | `__tests__/ui/controls.test.tsx` | 10 |
| ErrorBar | `__tests__/ui/error-bar.test.tsx` | 5 |
| ExecutionCard | `__tests__/ui/execution-card.test.tsx` | 7 |
| FlowStatusBar | `__tests__/ui/flow-status-bar.test.tsx` | 9 |
| Format Utils | `__tests__/ui/format-utils.test.ts` | 10 |
| Gate | `__tests__/ui/gate.test.tsx` | 10 |
| Header | `__tests__/ui/header.test.tsx` | 9 |
| Info | `__tests__/ui/info.test.tsx` | 10 |
| Markdown Content | `__tests__/ui/markdown-content.test.tsx` | 15 |
| NodeListItem | `__tests__/ui/node-list-item.test.tsx` | 12 |
| Output | `__tests__/ui/output.test.tsx` | 18 |
| PageHeader | `__tests__/ui/page-header.test.tsx` | 7 |
| Stat | `__tests__/ui/stat.test.tsx` | 3 |
| ANSI Dim | `__tests__/ui/ansi-dim.test.ts` | 4 |
| useAutoSelectNode | `__tests__/ui/use-auto-select-node.test.ts` | 8 |
| useNodeNavigation | `__tests__/ui/use-node-navigation.test.ts` | 9 |
| **Total** | **48 suites** | **596** |

## Architecture

```
Composition Layer (user code)
  |  defines: FlowGraph { nodes, edges, start }
  |  uses: agent(), deterministic(), gate(), verify()
  |
  v
Execution Layer (src/)
  |  run(graph, options) — graph walker (DAG + bounded cycles)
  |  fan-out edges, loop-back with maxIterations + loopFallback (ADR-006)
  |  emits: ExecutionEvent stream (16 types incl. node:reset)
  |
  v
State Layer (state/)
  |  StateRuntime: event->projection fold + persistence
  |  StorageEngine: JSONL event log + atomic projection writes
  |
  v
Bridge Layer (bridge/)
  |  createBridge(runtime, stateRuntime) -> BridgeApi
  |  launch, stop, resume, retry, skip, approve
  |
  v
Runtime Layer (runtimes/)
  |  AgentRuntime interface -> SubprocessBackend, SdkBackend, MockRuntime
  |
  v
UI Layer (ui/)
     Visualization:
       FlowGraph         — full interactive React Flow DAG
       MiniPipeline      — compact thumbnail (3 modes: graph/bar/summary)
     Detail:
       NodeDetailPanel   — convenience default (zero-config)
       NodePanel.*       — compound components (Header, Info, Error, Gate, Controls, Output)
     Hooks:
       useFlowExecution  — SSE + REST for single execution
       useNodeOutput     — SSE streaming per-node output
     Tool Display (ui/tool-display/):
       ResponsePartRenderer — renders tool calls, thinking, text, sub-agents
       SubagentSection      — collapsible sub-agent grouping with nested tools
       formatter            — 50+ built-in tool formatters, renderToolExpanded callback
     Utilities:
       ansiToHtml        — ANSI escape -> HTML spans (opt-in, ADR-001)
       STATUS_COLORS     — status -> { dot, text, bg } color map
```

## Publishing

```bash
# 1. Bump version in package.json
# 2. Build and publish
npm run build && npm publish
# 3. In taco-helper, update to new version
cd Q:\Software\investigation\taco-helper && npm update condukt
```

For local iteration without publishing: `npm run build && npm pack` in condukt, then `npm install ../condukt/condukt-0.x.0.tgz` in taco-helper. Or use `npm link` for fastest feedback.

## Gotchas

| Issue | Symptom | Fix |
|-------|---------|-----|
| Dynamic `import()` in CJS output | TypeScript transforms `import()` to `require()`, breaking ESM-only deps | Use `new Function('specifier', 'return import(specifier)')` escape hatch (see `sdk-backend.ts`) |
| Optional peer deps | `@github/copilot-sdk`, `react`, `@xyflow/react` are optional peers | All three have `"optional": true` in `peerDependenciesMeta` — consumers only install what they use |
| Build output structure | Sub-path exports must map to `dist/` paths exactly | `tsconfig.build.json` mirrors source layout; verify `exports` in `package.json` after adding new entry points |
| Consumer webpack compat | condukt sub-path exports don't resolve in Turbopack | Consumers must use webpack mode + `transpilePackages: ['condukt']` |
| Reasoning delta `\n` joiner | Thinking text shows spaces between tokens ("ic m" instead of "icm") | `onReasoning` must concatenate deltas directly — no `\n` or ` ` separator. Markdown collapses single newlines to spaces. |
| `wordBreak: 'break-word'` | Unpredictable mid-word breaks near `_` and `-` | Use `overflowWrap: 'break-word'` (CSS standard). Never use `wordBreak: 'break-word'` (non-standard). |
