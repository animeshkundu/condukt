# Reasoning Visibility & Artifact Tab: Philosophy & Soul

## Why This Feature Matters

condukt was built to orchestrate AI agent pipelines with full observability. But today, two categories of agent work are invisible to operators:

1. **Reasoning tokens** — The deepest analysis happens in extended thinking (Claude's `thinking` mode, GPT's reasoning tokens). An operator watching a live ICM investigation sees tool calls and text output, but the critical phase where the agent forms hypotheses, weighs evidence, and decides which tools to use is a black box.

2. **Artifacts** — The final output of each node (RCA reports, investigation summaries, quality gate results) is a first-class concept in the domain but a second-class citizen in the UI. The consumer (taco-helper) was forced to build `IcmRcaPanel` and `rca-display.tsx` — 300+ lines of domain-specific workaround code — just to display what the agent produced.

Both problems share a root cause: **the framework streams events but doesn't close the loop to the UI**.

## Guiding Principles

### 1. Complete the Transport, Don't Reinvent It

The `node:reasoning` event type already exists (`src/events.ts:210-216`). The `agent()` factory already emits it (`src/agent.ts:163-171`). The `MockRuntime` already supports a `reasoning` session event. The event system is complete — the transport isn't.

`StateRuntime.handleOutput()` stores `node:output` but silently drops `node:reasoning` and `node:tool`. It has no callback mechanism to notify subscribers. The event is born, stored (sometimes), and dies without reaching the SSE stream.

The fix is surgical: add an `onOutput` callback (matching the existing `onEvent` pattern) and persist reasoning with a distinguishing prefix. No new event types. No new storage APIs. No new protocols.

### 2. Persist and Reconstruct, Don't Lose Type Identity

A reasoning event stored as plain text loses its identity on replay. When a user opens a historical investigation, all lines replay as `node:output` — reasoning becomes indistinguishable from regular output.

The `\x00reasoning\x00` prefix pattern is deliberate:
- **Null bytes cannot appear in agent text output** (they're stripped by terminal emulators, JSON serializers, and LLM tokenizers)
- **The prefix is invisible to consumers who don't know to look** — backward compatible
- **Reconstruction is O(1) per line** — a `startsWith` check, not a regex
- **No schema migration** — existing stored output is unaffected (no null bytes = all lines are `node:output`)

This preserves the event sourcing principle: the stored representation is lossless.

### 3. Framework Provides Primitives, Consumer Provides Domain

The artifact tab in condukt provides:
- `useNodeArtifact` hook — fetches content via REST
- `MarkdownContent` component — renders markdown safely
- `NodePanel.Artifact` compound component — loading/empty/content states

The consumer decides:
- When to show the artifact tab (node has output? node is completed?)
- When to auto-switch (user at bottom? node just completed?)
- What domain-specific chrome to add (verdict badges, ICM links, validation checks)

This separation means `NodePanel.Artifact` works for availability investigations, ICM RCA reports, and any future pipeline — without framework changes.

### 4. Delete Consumer Workarounds, Don't Preserve Them

`IcmRcaPanel` and `rca-display.tsx` were good code that solved a real problem. But they're workarounds for a framework gap. Once `NodePanel.Artifact` exists:

- `rca-display.tsx` (272 lines) is deleted entirely — its rendering logic lives in `MarkdownContent`
- `IcmRcaPanel` (27 lines in `page.tsx`) is deleted — its fetch logic lives in `useNodeArtifact`
- The `graphName === 'icm'` special case in the routing logic is deleted — all pipelines use the same artifact tab

No backward compatibility shims. No "deprecated but still works." Clean deletion.

### 5. Don't Disrupt the Reader

The adversarial review identified a critical UX concern: auto-switching to the artifact tab when a node completes disrupts users who are reading the output stream. The solution:

- **User at bottom (autoScroll=true)**: Auto-switch to artifact tab. The user has been following live output and wants to see the result.
- **User scrolled up (reading)**: Show a badge on the artifact tab. The user is reading something — don't yank it away.

This "smart auto-switch" pattern is per-node and resets when the user selects a different node.

## The Soul of Reasoning Visibility

An investigation dashboard exists to answer one question: **"What is the agent doing right now, and is it on the right track?"**

Tool calls answer the "doing" part. But the "right track" part requires seeing the agent's reasoning — the hypotheses it's forming, the evidence it's weighing, the decision tree it's navigating.

Without reasoning visibility, an operator watching a 20-minute ICM investigation sees:
- Tool call: `read_file(src/components/auth.tsx)` — okay, it's reading code
- Tool call: `search_code("error handling")` — fine, searching
- Tool call: `read_file(src/lib/api.ts)` — more reading

With reasoning visibility, the same operator sees:
- `[thinking] The auth component catches errors but doesn't propagate them to the caller...`
- `[thinking] Hypothesis: the silent error in auth.tsx masks the real failure in api.ts...`
- `[thinking] I should check if the error boundary in the parent catches this...`

The dimmed `[thinking]` prefix provides visual hierarchy — reasoning is context, not content. The operator can scan it for trajectory assessment without confusing it with actual output.

## What We Deliberately Did Not Do

1. **Separate reasoning panel** — Considered and rejected. A split view (output left, reasoning right) doubles the visual complexity for marginal benefit. Inline reasoning with dim styling achieves the same purpose with less cognitive load.

2. **Reasoning-only tab** — Considered and rejected. Would require filtering stored output by prefix on every tab switch. The output stream already shows everything chronologically — reasoning interleaved with output is the natural reading order.

3. **Structured artifact renderer** — The `MarkdownContent` component deliberately does NOT use a markdown library (marked, remark, rehype). The rendering needs are simple (headings, code blocks, blockquotes, tables, paragraphs) and the XSS surface of full markdown libraries is non-trivial. Regex-based parsing with HTML escaping is safer and sufficient.

4. **Artifact editing** — Artifacts are read-only in the dashboard. The agent writes them; the operator reads them. Editing belongs in ADO work items or ICM incidents, not the investigation dashboard.
