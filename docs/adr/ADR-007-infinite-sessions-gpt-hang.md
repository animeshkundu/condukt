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

### 1. Enable `infiniteSessions` in SdkBackend session config

The `@github/copilot-sdk` supports `InfiniteSessionConfig` which enables automatic context compaction:

```typescript
sessionConfig.infiniteSessions = {
  enabled: true,
  backgroundCompactionThreshold: 0.80,
  bufferExhaustionThreshold: 0.95,
};
```

- Background compaction starts at 80% context utilization
- The live settings RPC rejects over-limit dispatches at 95% until compaction completes
- These documented stock values are the default. Callers can opt into the legacy aggressive 60%/75% thresholds or the exact-diagnostics adaptive pre-dispatch controller through `compactionMode`.
- This allows sessions with unlimited tool calls

The runtime assigns an explicit `sessionId` and can reconnect an interrupted model turn through the same persisted conversation. See [ADR-008](./ADR-008-sdk-session-recovery.md). This is separate from compaction: recovery cannot replay an in-flight provider stream, and instead resumes the same ID and runs an empty turn over audited history.

### Validation

A production `SdkBackend` accumulation probe retained 300 tool results totaling 2,400,900 payload bytes in each mode. Both runs completed with `COMPACTION_COMPARISON_COMPLETE` after exact-verified compaction:

| Mode | Peak `usage_info` tokens | Peak exact recomputation | Exact compaction reductions | Result |
|------|--------------------------|--------------------------|-----------------------------|--------|
| Stock 80%/95% | 748,587 | 742,094 | 742,094 → 13,575 (count 0 → 1) | 300/300 calls completed |
| Aggressive 60%/75% | 667,602 | 661,709 | 580,355 → 13,636 and 661,709 → 13,093 (count 0 → 1 → 2) | 300/300 calls completed |

Each run captured token trajectories, attribution, heaviest messages, exact recomputation, usage metrics, and the successful-compaction count. Stock compacted before the historical 944,213-token failure point, so this controlled workload could not safely reproduce a context above that point. The result demonstrates compaction plus continued execution, not that a 944,213-token request was dispatched successfully.

Request telemetry records only the serialized body byte count and SHA-256 visible at the SDK handler seam. Serialized bytes are not token counts and may differ from the provider's final transformed request.

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
