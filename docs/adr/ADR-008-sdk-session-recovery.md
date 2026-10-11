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
5. Reapplies mode and subagent settings and audits history again. Native context and compaction policy remain owned by the resumed Copilot runtime. If the turn completed during handoff, it settles without a continuation.
6. Calls `sendMessages({ messages: [], wait: false })` only while the turn remains unmatched.
7. Repeats steps 3 to 6 when any of them fails, until the continuation count or the recovery budget runs out. The two failures that cannot change their answer do not repeat: a missing client factory, and a resumed session whose id is not the one that was asked for.

### What counts as an eligible failure

Eligibility is decided from the event payload, and that payload arrives in one of two shapes:

- **The SDK's typed shape** (`model.call_failure`): flat and camelCase, with `source` always present (`top_level`, `subagent`, or `mcp_sampling`) alongside `failureKind`, `transport`, `statusCode`, `errorMessage`, and `badRequestKind`.
- **The CLI's envelope** (`model.model_call_failure`): `kind: 'model_call_failure'`, `turn`, `modelCallDurationMs`, and the details **nested** under `modelCall` in snake_case (`failure_kind`, `api_endpoint`, `error`, `request_id`). It carries no `source`.

The CLI envelope reaches the same handler through the type-substring branch in `dispatchClassEvent`. The backend unwraps it onto the flat shape before deciding eligibility, because a predicate written for the flat shape rejected every transport failure that arrived in the envelope and the run restarted the node from a cold session instead of resuming it. An absent `source` on the envelope means the root session: an agent-scoped failure returns on `logAgentScopedFailure` before classification is reached.

The progress heartbeat is based on a closed set of meaningful events. Informational, unknown, empty, duplicate, and non-increasing streaming events do not extend it. Novel progress refreshes the deadline; silence trips it. A node that opted into recovery then resumes even with a tool or headless external request outstanding, because the resume does not replay that call: it is abandoned and the model re-issues it, which for the idempotent reads recovery is opted into is the better trade against failing the node. A node that did not opt in still fails closed, and reports `session.progress_timeout.pending_work` when work was in flight. A progress timeout remains distinct from an authoritative provider failure in diagnostics, while safe root-turn recovery shares the same continuation count, recovery budget, and original hard deadline.

Recovery is bounded by an absolute time budget, the original session timeout, capped backoff, and a maximum continuation count capped at 23. Exhaustion is terminal and cannot trigger whole-session prompt replay. History is never truncated, and recovery injects no textual continuation prompt: every recovery turn is empty and runs over existing history. The declared-output guard is the one place a continuation carries text, and it is not recovery — see below.

Mutation-capable nodes must opt out unless their external effects are idempotent and their history can be reconciled safely. Pending permissions, external tools, sampling, user input, or elicitation fail closed.

### The declared-output guard, and why its continuation carries text

A node may declare `output`, and `requireOutput` fails it when that file is missing or
blank. condukt does not write that file for the model: after the session it reads
`path.join(input.dir, config.output)` and hands the file to the next node, and the model
writes it with a tool. A miss therefore used to be measurable only after the attempt had
already returned and torn itself down, which is too late to do anything but fail.

The guard runs *inside* the attempt, on the handle the turn just settled on:

- **The handle outlives a clean turn.** `settleIdle` no longer calls `void this._cleanup()`
  on the same line it emits `idle`; `abort()` still tears the handle down. This is the
  whole seam: `recoverSameSession` rebuilds the client, re-verifies the session id and
  audits history for a single unmatched root turn, all of which exist because the old
  handle is gone. Here it is not gone.
- **The continuation is a real user turn.** A recovery continuation is empty by design,
  because replay safety is ambiguous; an artifact that was never written has no such
  ambiguity, so the guard sends a textual instruction naming the missing path. Default
  policy is two nudges with jittered, capped backoff, and a consumer may supply
  `outputNudge.prompt`. The prompt receives `outputPath` (as configured) and
  `artifactPath` (absolute), because the consumer knows which tool performs the write and
  a tool needs the absolute path; the framework default leaves the choice of tool open.
- **Exhaustion is still terminal.** `MissingRequiredOutputError` sets
  `suppressFreshSessionRetry`, so a node whose artifact never lands fails without replaying
  the original prompt in a fresh session. Nudges stay inside the single attempt, so the
  node deadline and the session timeout bound the whole guard.
- **The seam is optional.** `AgentSession.continueSession` is optional and
  `AgentConfig.outputNudge` is additive. A runtime that does not implement it makes the
  guard report the miss it could not repair rather than pass silently.

A dead session is not this case: when the attempt itself rejected, there is nothing to
continue, and the failure stands.

### Retrying a resume that fails

A resume handshake can fail on its own: the reconnect lands on a socket that is already
disposed, a fresh client refuses to start, or the nudge is rejected. The handshake used to
exhaust recovery on any such failure, on the argument that resume failures are unsafe to
replay. That argument does not hold for this operation.

The invariant it turns on is that the handshake writes nothing. The resume passes
`continuePendingWork: false` and the continuation is `sendMessages({ messages: [], wait:
false })`, so no transcript entry, no tool call, and no turn boundary is appended. The
session is left at the exact point of interruption, and a handshake that fails part way
through leaves it at that same point. Running the handshake again resumes that same state,
so a second, fifth or twenty-third attempt is exactly as safe as the first: nothing
compounds, because nothing was written.

The operation that is genuinely unsafe to replay is a cold node restart, which re-sends the
prompt and replays the whole turn, duplicating work and re-issuing whatever tool calls it
made. That remains a single attempt.

Two costs are real and belong to every attempt, including the first, so neither argues
against retrying: each attempt builds and starts a fresh client, which is what `budgetMs`
bounds, and the attempt that eventually succeeds abandons any tool call that was genuinely
in flight at the time.

Each failed attempt tears down what it built before it throws, which is a precondition of
the argument rather than a detail. A resumed handle or client left standing could make the
SDK refuse the next resume as already active, and the retry would exhaust on a stage name
that says so. The teardown therefore takes down the handle that is live at the time, which
after a resume that succeeded and then failed on the nudge is the resumed handle, not the
one the attempt started from.

An `exhausted` event carries the step that kept failing as `stage` (`fence`, `client`,
`resume`, `configuration`, `audit`, `continuation`). The reason alone, typically
`Connection is disposed.`, does not say which RPC produced it.

## Consequences

- Completed tool results and conversation history survive transient transport failures.
- The original user prompt is persisted once. Recovery adds no turns at all; the
  declared-output guard adds only its bounded nudge turns, and only when the artifact
  is missing.
- A node's declared output is enforced, and a miss is repaired in the same session
  before it fails the node.
- A cleanly completed turn keeps its session handle until the attempt ends; `abort()`
  still disposes it.
- Recovery cannot claim to resume the failed provider stream itself.
- A failed reconnect no longer ends the turn. The same continuation count and recovery
  budget bound it, so a flake costs wall-clock rather than the node's work.
- `SubprocessBackend` and test runtimes retain existing behavior when recovery is not explicitly requested.
- Recovery control state is in-process. A condukt host-process crash does not resume the same live turn.
- The SDK peer floor is 1.0.11 because empty-turn and resume behavior is validated against that release.
