# ADR-008: Same-session recovery for transient model-call failures

**Status:** Accepted

## Context

A long-running model turn can finish many tool calls and then emit a transient root `model.call_failure`. Replaying the original prompt in a fresh session loses the persisted conversation and repeats completed work. Copilot SDK 1.0.11 exposes stable session IDs, `resumeSession`, complete event history, and the experimental `session.rpc.sendMessages({ messages: [] })` operation, which runs a turn over existing history without appending a user message.

Two local OpenAI-compatible probes establish the required sequence:

- After a bodyless HTTP 400, an empty turn on the failed live handle was a no-op. Disconnecting without aborting, creating a fresh client, resuming the identical session with `continuePendingWork: false`, and then sending an empty turn succeeded without adding another `user.message`.
- After a streaming response emitted partial deltas and then held its socket open, disconnecting the session and stopping the old client closed the upstream socket before resume. The resumed empty turn made exactly one provider request, with maximum concurrency one and no late output from the abandoned call. Aborting first also closed the socket, but persisted `abort` and `assistant.turn_end`, incorrectly making the abandoned task appear complete to the recovery audit.

The SDK does not expose a way to restart an in-flight provider stream at a byte or token boundary.

## Decision

Condukt enables same-session recovery by default on runtimes that advertise `sessionRecovery: true`. A node may opt out with `sessionRecovery: false`. An explicit policy on an unsupported runtime fails before session creation; an unset policy preserves that runtime's existing behavior.

For an eligible transient root model-call failure, or a local session-progress timeout whose history contains exactly one unmatched root turn, the SDK backend:

1. Allows a brief SDK-native retry grace period for reported model-call failures. A local progress timeout skips this grace because no SDK retry event was reported.
2. Audits persisted history and rejects ambiguous turns, pending tools, or pending external work.
3. Disconnects the failed handle without aborting.
4. Creates a fresh client and resumes the exact same session ID with the complete original configuration and `continuePendingWork: false`.
5. Reapplies mode and subagent settings, audits history again, and rebaselines context/compaction accounting. If the turn completed during handoff, it settles without a continuation.
6. Calls `sendMessages({ messages: [], wait: false })` only while the turn remains unmatched.

The progress heartbeat is based on a closed set of meaningful events. Informational, unknown, empty, duplicate, and non-increasing streaming events do not extend it. Active tools and headless external requests remain bounded by that progress deadline: novel progress refreshes it, but silence fails closed without a model continuation because replay safety is ambiguous. A progress timeout remains distinct from an authoritative provider failure in diagnostics, while safe root-turn recovery shares the same continuation count, recovery budget, and original hard deadline.

Recovery is bounded by an absolute time budget, the original session timeout, capped backoff, and a maximum continuation count capped at 23. Exhaustion is terminal and cannot trigger whole-session prompt replay. History is never truncated, and no textual continuation prompt is injected.

Mutation-capable nodes must opt out unless their external effects are idempotent and their history can be reconciled safely. Pending permissions, external tools, sampling, user input, or elicitation fail closed.

## Consequences

- Completed tool results and conversation history survive transient transport failures.
- The original user prompt is persisted once.
- Recovery cannot claim to resume the failed provider stream itself.
- `SubprocessBackend` and test runtimes retain existing behavior when recovery is not explicitly requested.
- Recovery control state is in-process. A condukt host-process crash does not resume the same live turn.
- The SDK peer floor is 1.0.11 because empty-turn and resume behavior is validated against that release.
