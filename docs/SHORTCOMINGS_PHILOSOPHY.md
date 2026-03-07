# Shortcomings Fix: Philosophy & Soul

## Why These Fixes Matter

condukt was born from a real investigation dashboard — not a specification. Every abstraction was earned by building three production pipelines (availability, availability-dip, ICM). The 9 shortcomings documented here aren't theoretical gaps; they're friction points felt by the first consumer while building increasingly sophisticated pipelines.

The fix order is deliberate: we start with the safest additions (utilities and extractions from consumer workarounds), move to behavioral improvements (structured streaming, barrel splits), and finish with packaging polish. Every phase leaves the framework strictly better for consumers while maintaining full backward compatibility.

## Guiding Principles

These principles extend (never contradict) condukt's core architecture:

### 1. Extract, Don't Invent

Every new export in this plan exists today as a working workaround in taco-helper. We are extracting proven patterns, not designing speculative APIs.

- `createHmrSingleton()` — extracted from `flow-state.ts` (4 manual globalThis singletons)
- `setupOnce()` — extracted from `icm.ts` (`_initialized` Set pattern)
- `createExecutionSSEStream()` — extracted from two nearly-identical SSE routes
- `feedbackExtractor` — replaces `retryFeedbackBlock()` disk-reading workaround

The consumer code is the specification. The framework API should make the common case a one-liner.

### 2. Additive Over Breaking

Phase 1 (0.2.2) and Phase 3 (0.3.1) are purely additive — new exports, new optional fields. No consumer needs to change anything to upgrade. Phase 2 (0.3.0) is minor because `FileStorage` moves from `condukt/state` to `condukt/state/server`, which is a breaking import change for consumers using FileStorage on the client boundary (the typical Next.js pattern).

### 3. Framework Stays Generic

Every new API uses framework vocabulary, not investigation vocabulary:
- `createHmrSingleton(key, factory)` — not `createFlowStateSingleton()`
- `setupOnce(dir, key, fn)` — not `initializeRepo(dir)`
- `feedbackExtractor(sourceOutput, sourceMetadata)` — not `extractConvergenceReport()`

Zero domain types leak into condukt. The consumer provides domain logic via callbacks.

### 4. Consumer Migration Is Part of the Deliverable

A framework fix without consumer migration is incomplete. Each shortcoming fix includes:
- What the consumer currently does (the workaround)
- What the consumer does after (the framework call)
- Which files change in the consumer
- How to verify the migration worked

### 5. Event Sourcing Is Sacred

The `reasoning` event (#6) follows the established event pattern exactly:
- New `NodeReasoningEvent` type in the `OutputEvent` union (streamed, not persisted)
- Same shape as `NodeOutputEvent` — `executionId`, `nodeId`, `content`, `ts`
- Consumers that don't subscribe to `reasoning` events see zero behavioral change

The `feedbackExtractor` (#1) integrates with the existing `RetryContext` flow — it transforms what goes into `feedback`, it doesn't add a new context channel.

### 6. Packaging Honesty

Shortcomings #2 (CSS resolution), #3 (state barrel), #4 (ANSI import), #5 (Turbopack) are all packaging problems. They exist because condukt was developed against a `file:` link with webpack aliases masking resolution failures. The fixes are structural:
- Actual file at the expected path (not just an export map entry)
- Proper `import`/`require`/`default` conditions (not just `types` + `default`)
- Server-only modules in server-only barrels (not re-exported to client bundles)

## The Soul of Loop-Back

Shortcoming #1 (feedbackExtractor) deserves special treatment because it touches the heart of condukt's convergence model.

The loop-back system (ADR-006) was designed around a powerful insight: **accuracy through independent convergence**. When two AI agents from different families independently reach the same conclusion, confidence is high. When they diverge, the specific disagreements are the most valuable signal for re-investigation.

But the current implementation betrays this insight. When a convergence check decides "diverged" and loops back to the investigators, the retry context says only `"iteration 2"`. The convergence check's detailed analysis — which disagreements were found, what evidence conflicts, what specific areas need deeper investigation — is lost. The consumer (taco-helper) had to build `retryFeedbackBlock()` to read all three artifacts from disk and reconstruct the context.

The `feedbackExtractor` callback fixes this at the right abstraction level. The source node (convergenceCheck) has already analyzed the situation and written its findings to an artifact. The framework should pass that analysis to the loop-back targets, letting them incorporate the convergence reviewer's specific feedback into their re-investigation prompts.

This is not just a convenience — it's a correctness improvement. Without rich feedback, re-investigating agents repeat their analysis with no guidance on where to focus. With rich feedback, they target the specific disagreements identified by the convergence reviewer. The investigation converges faster and with higher quality.

## The Soul of Reasoning Visibility

Shortcoming #6 (thinking/reasoning tokens) is the second most impactful fix. Modern LLMs with extended thinking (Claude's `thinking` mode, GPT's reasoning tokens) do their deepest analysis in the thinking phase. The investigation phase — where the agent forms hypotheses, weighs evidence, and decides what tools to use — happens in reasoning tokens that are currently invisible.

For an investigation dashboard, this is a significant gap. The human operator watching a live investigation should see the agent's reasoning unfold, not just its final outputs and tool calls. The thinking tokens are often more informative than the response tokens for understanding whether an investigation is on track.

The fix is minimal and precise: switch the subprocess backend from raw text stdout to JSONL structured output, parse the event types, and emit reasoning tokens as a new `reasoning` event. The existing `text` event contract is preserved — consumers that don't care about reasoning tokens see identical behavior.

## What We Deliberately Did Not Do

Three candidates were evaluated and rejected:

1. **Worktree management** — Investigation-specific (git worktree per investigator). Belongs in the composition layer.
2. **JSON-from-markdown extraction** — Trivially reimplemented per consumer. A regex in domain code, not a framework utility.
3. **Quality gate framework** — Too domain-specific. condukt's `gate()` node is the right abstraction; the quality gate checks are investigation vocabulary.

These rejections protect condukt's generic soul. A framework that absorbs every consumer pattern becomes a monolith. The right line is: extract patterns used by 2+ consumers (or universally needed by the framework's deployment model, like HMR singletons for Next.js).
