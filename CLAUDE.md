# condukt — LLM Instructions

## What This Is

A generic, composable AI agent workflow framework. Three decoupled systems: stateless execution engine, event-sourced state manager, reactive UI. 100% generic — zero domain vocabulary.

## Structure (6 sub-path exports)

| Entry Point | Directory | Purpose |
|-------------|-----------|---------|
| `condukt` | `src/` | Core execution: scheduler, agent, deterministic, gate, verify |
| `condukt/state` | `state/` | Event-sourced persistence: reducer, state-runtime, storage |
| `condukt/bridge` | `bridge/` | Orchestration API: launch, stop, resume, retry, skip, approve |
| `condukt/runtimes/copilot` | `runtimes/copilot/` | GitHub Copilot CLI runtime adapter |
| `condukt/runtimes/mock` | `runtimes/mock/` | Deterministic test runtime |
| `condukt/ui` | `ui/` | React Flow visualization (optional peer: react, @xyflow/react) |

## Key Files

| File | Purpose |
|------|---------|
| `src/types.ts` | All type definitions: NodeFn, FlowGraph, ExecutionProjection, AgentRuntime |
| `src/events.ts` | 15 execution events + 2 output events (discriminated unions) |
| `src/scheduler.ts` | DAG walker: fan-in, parallel dispatch, per-node timeout, abort, resume |
| `src/agent.ts` | LLM agent factory with GT-3 crash recovery, setup/teardown hooks |
| `src/nodes.ts` | deterministic() + gate() factories, resolveGate() |
| `src/verify.ts` | Iterative verification combinator |
| `state/reducer.ts` | Pure event->projection fold |
| `state/state-runtime.ts` | Cache, crash recovery, event routing, per-execution mutex |
| `state/storage.ts` | File-based JSONL storage with path traversal safety |
| `bridge/bridge.ts` | Orchestration API: launch, stop, resume, retry, skip, approve |
| `runtimes/copilot/subprocess-backend.ts` | CopilotBackend via child_process.spawn |
| `runtimes/mock/mock-runtime.ts` | Deterministic test runtime |
| `ui/components/node-panel/` | Compound NodePanel: Header, Info, ErrorBar, Gate, Controls, Output (ADR-003) |
| `ui/components/MiniPipeline.tsx` | Three-mode pipeline thumbnail: graph/bar/summary (ADR-004) |
| `ui/ansi.ts` | ANSI escape code utilities: ansiToHtml, stripAnsi, hasAnsi |

## Commands

```bash
npm test              # Run all tests (223 across 16 suites)
npm run typecheck     # tsc --noEmit
npm run build         # Build to dist/
npm run clean         # Remove dist/
```

## Rules

1. **Zero domain vocabulary** — the framework must never import investigation-specific concepts
2. **Zero `any` types** — use generic types, branded types, or explicit `unknown`
3. **Readonly by default** — all interface fields are `readonly`
4. **Discriminated unions for events** — every event has a `type` field
5. **Tests must pass** — 233 tests across 17 suites, all must pass before commit
6. **Plain text default** — output renderer defaults to plain text, ANSI is opt-in (ADR-001)
7. **Data-driven gates** — gate buttons from `allowedResolutions`, not hardcoded (ADR-002)
8. **Compound components** — NodePanel is decomposed, NodeDetailPanel is convenience default (ADR-003)
9. **Follow `DESIGN_LANGUAGE.md`** — all visual tokens, spacing, typography, and component patterns are codified there

## Test Suites

| Suite | File | Tests |
|-------|------|-------|
| Scheduler | `__tests__/scheduler.test.ts` | 12 |
| Scheduler (comprehensive) | `__tests__/scheduler-comprehensive.test.ts` | 22 |
| Agent | `__tests__/agent.test.ts` | 16 |
| Nodes | `__tests__/nodes.test.ts` | 10 |
| Verify | `__tests__/verify.test.ts` | 9 |
| Reducer | `__tests__/reducer.test.ts` | 15 |
| Storage | `__tests__/storage.test.ts` | 11 |
| State Runtime | `__tests__/state-runtime.test.ts` | 8 |
| Bridge | `__tests__/bridge.test.ts` | 9 |
| Bridge (comprehensive) | `__tests__/bridge-comprehensive.test.ts` | 19 |
| Integration | `__tests__/integration.test.ts` | 7 |
| Integration (comprehensive) | `__tests__/integration-comprehensive.test.ts` | 10 |
| Branch Coverage | `__tests__/branch-coverage.test.ts` | 35 |
| Copilot Adapter | `__tests__/copilot-adapter.test.ts` | 5 |
| NodePanel | `__tests__/node-panel.test.ts` | 24 |
| MiniPipeline | `__tests__/mini-pipeline.test.ts` | 11 |
| **Total** | **17 suites** | **233** |

## Architecture

```
Composition Layer (user code)
  |  defines: FlowGraph { nodes, edges, start }
  |  uses: agent(), deterministic(), gate(), verify()
  |
  v
Execution Layer (src/)
  |  run(graph, options) — stateless DAG walker
  |  emits: ExecutionEvent stream
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
  |  AgentRuntime interface -> SubprocessBackend, MockRuntime, etc.
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
     Utilities:
       ansiToHtml        — ANSI escape -> HTML spans (opt-in, ADR-001)
       STATUS_COLORS     — status -> { dot, text, bg } color map
```
