# ADR-008: Same-session recovery for transient model-call failures

**Status:** Accepted

## Context

A long-running model turn can finish many tool calls and then emit a transient root `model.call_failure`. Replaying the original prompt in a fresh session loses the persisted conversation and repeats completed work. Copilot SDK 1.0.11 exposes stable session IDs, `resumeSession`, complete event history, and the experimental `session.rpc.sendMessages({ messages: [] })` operation, which runs a turn over existing history without appending a user message.

A local OpenAI-compatible fault probe established the required sequence. After a bodyless HTTP 400, an empty turn on the failed live handle was a no-op. Disconnecting without aborting, creating a fresh client, resuming the identical session with `continuePendingWork: false`, and then sending an empty turn succeeded without adding another `user.message`.

The SDK does not expose a way to restart an in-flight provider stream at a byte or token boundary.

## Decision

Condukt enables same-session recovery by default on runtimes that advertise `sessionRecovery: true`. A node may opt out with `sessionRecovery: false`. An explicit policy on an unsupported runtime fails before session creation; an unset policy preserves that runtime's existing behavior.

For an eligible transient root model-call failure, the SDK backend:

1. Allows a brief SDK-native retry grace period.
2. Audits persisted history and rejects ambiguous pending work.
3. Disconnects the failed handle without aborting.
4. Creates a fresh client and resumes the exact same session ID with the complete original configuration and `continuePendingWork: false`.
5. Reapplies mode and subagent settings, rebaselines context/compaction accounting, and audits history again.
6. Calls `sendMessages({ messages: [], wait: false })`.

Recovery is bounded by an absolute time budget, the original session timeout, capped backoff, and a maximum continuation count. Exhaustion is terminal and cannot trigger whole-session prompt replay. History is never truncated, and no textual continuation prompt is injected.

Mutation-capable nodes must opt out unless their external effects are idempotent and their history can be reconciled safely. Pending permissions, external tools, sampling, user input, or elicitation fail closed.

## Consequences

- Completed tool results and conversation history survive transient transport failures.
- The original user prompt is persisted once.
- Recovery cannot claim to resume the failed provider stream itself.
- `SubprocessBackend` and test runtimes retain existing behavior when recovery is not explicitly requested.
- Recovery control state is in-process. A condukt host-process crash does not resume the same live turn.
- The SDK peer floor is 1.0.11 because empty-turn and resume behavior is validated against that release.
