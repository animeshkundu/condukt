# Reasoning Visibility & Artifact Tab: Plan

## Overview

Two framework gaps fixed in condukt 0.3.2 + consumer migration in taco-helper:
- **Reasoning tokens invisible** → Fixed: `onOutput` callback + reasoning persistence + UI rendering
- **Artifact visibility depends on consumer workarounds** → Fixed: `NodePanel.Artifact` framework component

## Documentation Suite

| Document | Purpose |
|----------|---------|
| `REASONING_ARTIFACT_PHILOSOPHY.md` | Why it matters, guiding principles, the soul of reasoning visibility |
| `REASONING_ARTIFACT_ARCHITECTURE.md` | Layer placement, dependency analysis, event flow diagrams |
| `REASONING_ARTIFACT_DESIGN.md` | Detailed design per component: interfaces, edge cases, rejected alternatives |
| `REASONING_ARTIFACT_PLAN.md` | This file — workstream overview, validation workflow, team structure |
| `REASONING_ARTIFACT_IMPLEMENTATION.md` | Exact file/line/code specs for implementation teams |

## Branch

- **condukt**: `feat/reasoning-artifact-0.3.2` (from current HEAD)
- **taco-helper**: `feat/icm-agent` (existing branch)

## Validation Workflow

1. Implement in condukt (3 parallel workstreams)
2. `npm run build` + `npm test` in condukt — 458+ existing + ~26 new tests
3. Barrel exports + version bump to 0.3.2
4. `npm pack` → tarball
5. In taco-helper: `npm install ../condukt/condukt-0.3.2.tgz`
6. Implement consumer migration (2 parallel workstreams)
7. `npm run typecheck` + `npm test` in taco-helper — 368+ pass
8. Manual verification: launch ICM investigation, verify reasoning streams live, artifact tab works

---

## Workstreams

### Phase 1: condukt Framework (3 parallel agents)

#### WS-1: Core Transport Fix
**Owner**: Agent A (core-transport)
**Files**: `state/state-runtime.ts`, `bridge/sse.ts`
**Scope**: Add `onOutput` callback, persist reasoning with prefix, reconstruct on replay
**Status**: DONE

#### WS-2: UI Components
**Owner**: Agent B (ui-components)
**Files**: `ui/hooks/useNodeOutput.ts`, `ui/hooks/useNodeArtifact.ts` (NEW), `ui/components/MarkdownContent.tsx` (NEW), `ui/components/node-panel/Artifact.tsx` (NEW), `ui/components/node-panel/index.tsx`
**Scope**: Reasoning in hook, artifact fetch hook, markdown renderer, compound component
**Status**: DONE

#### WS-3: Tests + MockRuntime
**Owner**: Agent C (tests)
**Files**: `runtimes/mock/mock-runtime.ts`, `__tests__/state-runtime.test.ts`, 3 new test files
**Scope**: MockNodeConfig reasoning field, onOutput callback tests, ANSI dim tests, XSS tests
**Status**: DONE — 26 new tests passing

### Phase 2: condukt Integration (Lead)

#### WS-4: Barrel Exports + Build
**Owner**: Lead
**Files**: `ui/core/index.ts`, `ui/index.ts`, `package.json`
**Scope**: Export new hooks/components, bump to 0.3.2, build, pack, install in taco-helper

### Phase 3: taco-helper Consumer Migration (2 parallel agents)

#### WS-5: Backend Wiring
**Owner**: Agent D (backend)
**Files**: `src/app/api/_shared/flow-state.ts`, `src/app/api/executions/[id]/nodes/[nodeId]/artifact/route.ts` (NEW)
**Scope**: Wire onOutput to FlowEventBus, widen bus type, create artifact REST endpoint

#### WS-6: Frontend Integration
**Owner**: Agent E (frontend)
**Files**: `src/app/flow/[id]/page.tsx`, `src/components/rca-display.tsx` (DELETE)
**Scope**: Reasoning SSE handling, artifact tab with smart auto-switch, delete IcmRcaPanel/rca-display.tsx

### Phase 4: Verification (Lead)

#### WS-7: Final Checks
**Owner**: Lead
**Scope**: `npm run typecheck` + `npm test` on both repos, verify test counts

---

## Adversarial Review Findings (Pre-implementation)

A 5-expert adversarial review was conducted. Findings integrated into the design:

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| C1 | Critical | No transport path for output events | Fixed: `onOutput` callback on StateRuntime |
| C2 | Critical | Historical data breaks (IcmRcaPanel removal) | User decision: no backward compat needed |
| C3 | Critical | Reasoning type lost on replay | Fixed: `\x00reasoning\x00` prefix encoding |
| I1 | Important | Auto-tab-switch disrupts reading | Fixed: smart auto-switch (badge when scrolled up) |
| I2 | Important | Hardcoded markdown styling | Fixed: `className` + `style` props on MarkdownContent |

## Files Summary

| File | Repo | Change | Workstream |
|------|------|--------|------------|
| `state/state-runtime.ts` | condukt | Add `onOutput`, persist reasoning | WS-1 |
| `bridge/sse.ts` | condukt | Replay reasoning prefix | WS-1 |
| `ui/hooks/useNodeOutput.ts` | condukt | Handle `node:reasoning` | WS-2 |
| `ui/hooks/useNodeArtifact.ts` | condukt | NEW — artifact fetch hook | WS-2 |
| `ui/components/MarkdownContent.tsx` | condukt | NEW — markdown renderer | WS-2 |
| `ui/components/node-panel/Artifact.tsx` | condukt | NEW — compound component | WS-2 |
| `ui/components/node-panel/index.tsx` | condukt | Wire Artifact | WS-2 |
| `runtimes/mock/mock-runtime.ts` | condukt | Add reasoning config | WS-3 |
| `__tests__/` (5 files) | condukt | ~26 new tests | WS-3 |
| `ui/core/index.ts` | condukt | Export new APIs | WS-4 |
| `ui/index.ts` | condukt | Barrel re-export | WS-4 |
| `package.json` | condukt | Bump 0.3.2 | WS-4 |
| `src/app/api/_shared/flow-state.ts` | taco-helper | Wire `onOutput`, widen bus | WS-5 |
| `src/app/api/.../artifact/route.ts` | taco-helper | NEW — artifact REST endpoint | WS-5 |
| `src/app/flow/[id]/page.tsx` | taco-helper | Reasoning + artifact tab + remove IcmRcaPanel | WS-6 |
| `src/components/rca-display.tsx` | taco-helper | DELETE | WS-6 |
