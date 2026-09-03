# ADR-007: Infinite Sessions for GPT Context Exhaustion

**Status**: Accepted
**Date**: 2026-03-12

## Context

GPT-5.4 models silently stop responding after ~137-140 tool calls in long-running SDK sessions. The Copilot SDK's context window fills up, and without automatic compaction the model API stops generating responses. No `session.idle`, `session.error`, or any event is emitted — the session goes completely silent.

The Copilot CLI has an internal idle session cleanup (~30 min) that kills the session without notifying the SDK (`client.js:1003-1004` has an empty `onError` handler). Condukt's heartbeat timeout (45 min) fires later and gets "Session not found."

Claude models are unaffected because they complete their investigations within the context limit (~72 tool calls observed). GPT-5.4 with `reasoningEffort: 'xhigh'` produces more verbose reasoning and tool calls, exhausting the context window first.

### Evidence

| Run | @github/copilot | Tool Calls | infiniteSessions | Result |
|-----|----------------|------------|------------------|--------|
| inv-2bae3527 | 1.0.2 | ~140 | off | Hung |
| inv-10b551ee | 1.0.4 | 140 | off | Heartbeat timeout |
| inv-7d918bbe | 1.0.0 | 137 | off | Hung |
| inv-93994bdb | 1.0.2 | **160+** | **on** | **Completed** |

Reproduced on copilot 1.0.0, 1.0.2, and 1.0.4 — not a version regression.

### CLI Log Evidence

```
04:08:48 [WARNING] Session d46f82d0... has been idle for 1804s, cleaning up
04:53:53 [ERROR]   Session not found or not currently active: d46f82d0...
```

## Decision

### 1. Delegate infinite-session policy to the Copilot runtime

The original implementation supplied explicit stock/aggressive thresholds and later added an adaptive pre-dispatch controller through the experimental SDK request-handler seam. That made Condukt responsible for provider request forwarding, context admission, proactive compaction, and post-compaction verification.

The revised decision is to use the SDK's stock behavior:

- `CopilotClient` is constructed without `requestHandler`, so the native runtime owns provider HTTP/SSE/WebSocket behavior.
- `infiniteSessions` is omitted from the session config. The pinned-runtime probe demonstrates that omission enables automatic compaction with runtime-selected thresholds in SDK 1.0.11 on runtimes 1.0.81 and 1.0.82.
- `CompactionMode`, custom thresholds, proactive `history.compact()`, exact-token admission, and post-compaction verification are removed.
- Native `session.compaction_start` / `session.compaction_complete` events remain observable. Condukt suspends its semantic heartbeat while compaction is active, trusts native success, and fails immediately on native `success: false`.
- A missing completion is bounded only by the existing node hard timeout. This deliberately accepts slower detection rather than adding a second compaction controller.

The runtime assigns an explicit `sessionId` and can reconnect an interrupted model turn through the same persisted conversation. See [ADR-008](./ADR-008-sdk-session-recovery.md). Recovery remains separate from compaction and cannot replay an in-flight provider stream.

### Historical validation and replacement contract

The earlier accumulation probe retained 300 tool results totaling 2,400,900 payload bytes. Explicit stock 80%/95% and aggressive 60%/75% runs both compacted and completed. Those results remain historical evidence that native compaction supports long sessions, but no longer define Condukt-owned policy.

Before removing the custom path, a native no-handler synthetic loopback probe exercised runtime 1.0.81 and current stable 1.0.82 with a 16,384-token test limit and all tools disabled. In each runtime, omitted, enabled-only, and explicit-stock variants:

- emitted one automatic compaction start and completion;
- removed about 43,000 synthetic tokens;
- accepted an ordinary parent send submitted while the held compaction response was unresolved;
- accepted a queued parent send during the original short hold, and safely overlapped provider requests during the strengthened two-second hold (maximum concurrency two);
- persisted one parent message and produced one terminal assistant message;
- completed without context failure or duplicate terminal state.

This validates automatic compaction and an ordinary queued parent send for the pinned runtimes. It does not validate tool-call/result pairing across compaction, a tool-pending interleaving, or production reliability. Omission remains the production configuration contract, and future SDK/runtime upgrades must rerun the probe.

### 2. Include failed nodes in loop-back re-dispatch

`scheduler.ts:648` only re-dispatched completed nodes on loop-back. Failed parallel nodes (e.g., investigateB that timed out) were permanently abandoned, causing one-sided loops:

```typescript
// Before:
const loopBackTargets = targets.filter(t => completed.has(t));

// After:
const loopBackTargets = targets.filter(t => completed.has(t) || failedNodes.has(t));
```

`resetLoopBody` already clears `failedNodes` (line 293), so no other changes needed.

## Consequences

- GPT models can now run investigations with 140+ tool calls without hanging
- Sessions automatically manage their context window via compaction
- Failed parallel nodes get retried on loop-back instead of being permanently abandoned
- Compaction events (`session.compaction_start`, `session.compaction_complete`) are already in `LIFECYCLE_EVENT_TYPES` and silently consumed

## Alternatives Considered

- **Shorter heartbeat timeout**: Would detect the hang faster but not prevent it. Still wastes 20+ minutes per failure.
- **Switching GPT nodes to SubprocessBackend**: SubprocessBackend doesn't support `infiniteSessions`. Would lose rich streaming events.
- **Reducing GPT `reasoningEffort`**: Would reduce context usage but degrade investigation quality.
