# Condukt Shortcomings Fix Plan

## Overview

9 framework shortcomings documented during taco-helper ICM pipeline development. Fixes organized into 3 releases:
- **0.2.2** (patch): Safe additions — #9, #8, #7, #1
- **0.3.0** (minor): Behavioral changes — #6, #3, #4
- **0.3.1** (patch): Packaging polish — #2, #5

## Documentation Suite

| Document | Purpose |
|----------|---------|
| `SHORTCOMINGS_PHILOSOPHY.md` | Why these fixes matter, design principles, what we chose not to do |
| `SHORTCOMINGS_ARCHITECTURE.md` | How new features fit the dependency graph, event model, export map |
| `SHORTCOMINGS_DESIGN.md` | Detailed design per fix: interfaces, edge cases, rejected alternatives |
| `SHORTCOMINGS_IMPLEMENTATION.md` | Exact file/line/code specs for implementation teams |
| `SHORTCOMINGS_FIX_PLAN.md` | This file — overview, validation workflow, per-shortcoming summary |

## Branch

`feat/shortcomings-0.2.2-0.3.1` (from master at `4a2ae72`)

## Validation Workflow (per phase)

1. Implement in condukt
2. `npm run build` + `npm test` in condukt
3. `npm pack` → tarball
4. In taco-helper: `npm install ../condukt/condukt-x.x.x.tgz`
5. Migrate taco-helper from workarounds to framework APIs
6. `npm run typecheck` + `npm test` in taco-helper
7. Manual: launch ICM investigation, verify end-to-end
8. `npm publish` from condukt
9. In taco-helper: `npm install condukt@x.x.x`
10. Final regression check

---

## Phase 1: Safe Additions → 0.2.2

### #9 — HMR-Safe Singleton Factory

**Current behavior**: Consumers manually cast `globalThis` and manage symbol keys (taco-helper's `flow-state.ts` has 4 manual singletons).

**Target behavior**: `createHmrSingleton<T>(key, factory)` returns cached-or-created instance using `Symbol.for()`.

**Files to change**:
- NEW: `src/hmr-singleton.ts`
- MODIFY: `src/index.ts` — add export

**Consumer migration (taco-helper)**:
- Replace manual `globalThis` pattern in `src/app/api/_shared/flow-state.ts` with `createHmrSingleton()`
- Each of the 4 singletons becomes a one-liner

**Acceptance criteria**:
- First call creates instance via factory
- Second call returns cached instance (same reference)
- Different keys return different instances
- Type-safe (generic parameter)
- 4 test cases

---

### #8 — Per-Execution Setup Cache

**Current behavior**: Consumers maintain manual `_initialized: Set<string>` to avoid re-running setup per execution directory (taco-helper's `icm.ts` uses this pattern).

**Target behavior**: `setupOnce(dir, key, fn)` deduplicates concurrent/repeated setup calls. Failed promises evicted for retry.

**Files to change**:
- NEW: `src/setup-once.ts`
- MODIFY: `src/index.ts` — add exports

**Consumer migration (taco-helper)**:
- Replace `_initialized` Set pattern in `src/compositions/investigation/icm.ts` with `setupOnce()`
- Delete manual dedup logic

**Acceptance criteria**:
- First call executes fn, second call returns same Promise (dedup)
- Different dir+key combos execute independently
- Failed Promise evicted — next call retries
- `clearSetupCache()` clears all or per-dir
- 5 test cases

---

### #7 — SSE Streaming Route Export

**Current behavior**: Consumers reimplement replay-subscribe-heartbeat-cleanup SSE pattern per route. Taco-helper has two nearly identical SSE routes.

**Target behavior**: `createExecutionSSEStream()` and `createNodeSSEStream()` return framework-agnostic `ReadableStream` with replay, live subscription, heartbeat, and cleanup.

**Files to change**:
- NEW: `bridge/sse.ts`
- MODIFY: `bridge/index.ts` — add exports

**Consumer migration (taco-helper)**:
- Replace `src/app/api/executions/[id]/stream/route.ts` body with `createExecutionSSEStream()`
- Replace `src/app/api/executions/[id]/nodes/[nodeId]/stream/route.ts` body with `createNodeSSEStream()`

**Acceptance criteria**:
- Replays stored outputs/projection before live events
- Filters live events by executionId (and nodeId for node stream)
- 30s heartbeat keepalive
- Cleanup on cancel (unsubscribe + clear interval)
- 6 test cases

---

### #1 — Retry Context feedbackExtractor (Critical)

**Current behavior**: Loop-back retry context feedback is hardcoded to `"iteration N"` (scheduler.ts line 701). Consumers must read artifacts from disk themselves to get meaningful feedback.

**Target behavior**: Optional `feedbackExtractor` callback on `LoopFallbackEntry` allows source node output to be transformed into rich feedback.

**Files to change**:
- MODIFY: `src/types.ts` — add `feedbackExtractor` to `LoopFallbackEntry`
- MODIFY: `src/scheduler.ts` — use feedbackExtractor at lines 699-702

**Consumer migration (taco-helper)**:
- Add `feedbackExtractor` to convergenceCheck's loopFallback entries in `icm.ts`
- Remove `retryFeedbackBlock()` workaround from `icm-prompts.ts` (reads artifacts from disk)

**Acceptance criteria**:
- Optional field — existing graphs without it get `"iteration N"` (backwards compatible)
- feedbackExtractor receives source output artifact + metadata
- Custom feedback string flows through to `input.retryContext.feedback`
- Test case verifying custom feedback

---

## Phase 2: Behavioral Changes → 0.3.0

### #6 — Thinking/Reasoning Token Streaming (High)

**Current behavior**: SubprocessBackend emits all stdout as `text` events. Thinking/reasoning tokens are invisible.

**Target behavior**: `--output-format json` enables JSONL parsing. Reasoning deltas emit as `reasoning` events. Message deltas as `text`.

**Files to change**:
- MODIFY: `runtimes/copilot/subprocess-backend.ts` — add `--output-format json`, JSONL parser
- MODIFY: `runtimes/copilot/copilot-backend.ts` — add `reasoning` to CopilotSession
- MODIFY: `src/types.ts` — add `on('reasoning')` to AgentSession
- MODIFY: `src/events.ts` — add `NodeReasoningEvent`
- MODIFY: `src/agent.ts` — wire reasoning event

**Consumer migration (taco-helper)**:
- Dashboard UI can display thinking tokens in a collapsible section
- No breaking changes — `reasoning` event is additive

**Acceptance criteria**:
- JSONL `assistant.reasoning_delta` → `reasoning` event
- JSONL `assistant.message_delta` → `text` event
- Non-JSON lines fallback to `text` (robustness)
- 8 test cases

---

### #3 — State Barrel Split

**Current behavior**: `condukt/state` exports FileStorage (requires `fs`), breaking client-side imports.

**Target behavior**: `condukt/state` exports only client-safe code. `condukt/state/server` exports FileStorage.

**Files to change**:
- NEW: `state/server.ts`
- MODIFY: `state/index.ts` — remove FileStorage
- MODIFY: `package.json` — add `./state/server` export

**Consumer migration (taco-helper)**:
- Change `import { FileStorage } from 'condukt/state'` to `import { FileStorage } from 'condukt/state/server'`
- Remove `fs: false` fallback from `next.config.ts`

**Acceptance criteria**:
- `condukt/state` importable without `fs`
- `condukt/state/server` exports FileStorage
- Test verifying no `fs` in state barrel

---

### #4 — ANSI Utilities Separate Export

**Current behavior**: Importing ANSI utils from `condukt/ui` pulls in FlowGraph CSS. Consumers maintain local copies.

**Target behavior**: `condukt/utils` exports ansi utilities without UI dependencies.

**Files to change**:
- NEW: `utils/index.ts`
- MODIFY: `package.json` — add `./utils` export
- MODIFY: `tsconfig.json` — include `utils/`

**Consumer migration (taco-helper)**:
- Replace `src/lib/ansi.ts` with `import { ansiToHtml, stripAnsi, hasAnsi } from 'condukt/utils'`
- Delete local copy

**Acceptance criteria**:
- `condukt/utils` importable without React/CSS deps
- Exports ansiToHtml, stripAnsi, hasAnsi

---

## Phase 3: Packaging Polish → 0.3.1

### #2 — postcss-import CSS Resolution

**Current behavior**: postcss-import cannot resolve `condukt/ui/style.css` sub-path export.

**Target behavior**: Physical `ui/style.css` file redirects to `dist/ui/style.css` via `@import`.

**Files to change**:
- NEW: `ui/style.css`
- MODIFY: `package.json` — add to `files` array

**Consumer migration (taco-helper)**:
- Remove CSS copy workaround from `dev.ps1`
- Import directly: `@import 'condukt/ui/style.css'`

---

### #5 — Turbopack Compatibility

**Current behavior**: Sub-path exports missing condition fields. Turbopack fails to resolve.

**Target behavior**: Each export entry has `import`, `require`, `default` conditions alongside `types`.

**Files to change**:
- MODIFY: `package.json` — expand export conditions

**Consumer migration (taco-helper)**:
- Remove webpack aliases from `next.config.ts`
- Run `npx next dev` (turbopack) to verify

---

## Files Summary

| File | Changes | Shortcomings |
|------|---------|-------------|
| `src/hmr-singleton.ts` | NEW | #9 |
| `src/setup-once.ts` | NEW | #8 |
| `bridge/sse.ts` | NEW | #7 |
| `utils/index.ts` | NEW | #4 |
| `state/server.ts` | NEW | #3 |
| `ui/style.css` | NEW (redirect) | #2 |
| `src/types.ts` | feedbackExtractor + on('reasoning') | #1, #6 |
| `src/scheduler.ts` | Use feedbackExtractor | #1 |
| `src/agent.ts` | Wire reasoning event | #6 |
| `src/events.ts` | NodeReasoningEvent | #6 |
| `src/index.ts` | Add exports #8, #9 | #8, #9 |
| `bridge/index.ts` | SSE exports | #7 |
| `state/index.ts` | Remove FileStorage | #3 |
| `runtimes/copilot/subprocess-backend.ts` | JSONL refactor | #6 |
| `runtimes/copilot/copilot-backend.ts` | reasoning event | #6 |
| `package.json` | exports, files | #2, #3, #4, #5 |
