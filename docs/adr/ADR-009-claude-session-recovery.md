# ADR-009: Same-session recovery for the Claude Agent SDK runtime

**Status:** Accepted

## Context

ADR-008 defines same-session recovery for runtimes that advertise
`sessionRecovery: true`. The Copilot SDK can run a recovery turn that appends no
user message (`sendMessages({ messages: [] })`), so recovery there is invisible
to the transcript. The Claude Agent SDK, driven in string-prompt mode, has no
such primitive: every `query()` carries a prompt, and the only way to continue
a persisted session is `resume: sessionId`.

The Claude runtime therefore needs a recovery design that keeps ADR-008's
guarantees — bounded retries inside the same session, terminal exhaustion, no
cold prompt replay — while accepting that a continuation is a real user turn.

Relevant SDK behavior, verified against `@anthropic-ai/claude-agent-sdk` 0.3.316:

- A `result` frame decides the turn: `subtype: 'success'` may still carry
  `is_error: true` for an in-band API failure.
- `resume` first runs the SDK's own interrupted-turn rescue; frames then carry
  `resume_reason`, and the rescued work may already be complete.
- The SDK retries transient API failures natively and reports them as
  `system.api_retry` frames before giving up.
- `result.modelUsage` is cumulative across a resumed session.
- `forkSession(id, { upToMessageId })` copies a transcript through an
  **inclusive** message id and returns a new session id.

## Decision

The Claude runtime advertises `{ readOnlyPermissions: true,
requiredModeVerification: true, sessionRecovery: true }`. Recovery is on by
default and honors `sessionRecovery: false`.

### Eligibility

`classifyClaudeFailure` decides from the SDK's authoritative signals, in order:

1. Local fatal errors (configuration mismatch, fatal resume). Not recoverable.
2. `aborted` — condukt stopped the turn. Not recoverable.
3. `startup_failure_reason` — the CLI never started. Not recoverable.
4. `subtype` (`error_max_turns`, `error_max_budget_usd`,
   `error_max_structured_output_retries`). Not recoverable.
5. The assistant error enum. `rate_limit`, `overloaded`, `server_error`,
   `unknown` are recoverable; credentials, billing, request shape, model
   selection and `max_output_tokens` are not.
6. `api_error_status` on a success result: 408, 425, 429, 499, and ≥ 500 are
   recoverable.
7. `terminal_reason`: `model_error`, `api_error`, `aborted_streaming`,
   `aborted_tools` are recoverable; the non-recoverable set (prompt limits,
   turn limits, budget, hook stops, …) is not.
8. Text evidence in `errors[]`, the assistant error, or the thrown error.
9. A thrown stream error with no explicit signal is a transport failure and is
   recoverable. A result error with no evidence is not retried blindly.

### Sequence

1. The SDK's native retry gets a grace window first: if `api_retry` was seen,
   emit `recovery`/`native-retry` and wait `nativeRetryGraceMs`. This stops the
   two retry mechanisms racing.
2. Emit `scheduled` with the capped, jittered backoff and wait abort-aware.
3. Audit: `getSessionMessages(sessionId, { dir: cwd })` must return a non-empty
   transcript. Pending `tool_use` without a result is allowed — resume re-runs
   interrupted turns. An audit failure is retried within the same bounds and
   exhausts with stage `audit`.
4. Emit `resuming`, then `query({ prompt: CONTINUATION_PROMPT, options: {
   ...options, resume: sessionId } })`.
5. The first frame carrying `session_id` must equal the session that was asked
   for. A mismatch is fatal and exhausts with stage `resume` — the CLI is not
   where recovery thinks it is. Emit `continuation-sent` once.
6. A successful result emits `recovered` and `idle`. A recoverable failure
   reconnects and nudges again; a non-recoverable one fails the turn.

Every step is bounded by `maxContinuations` (capped at 23) and `budgetMs`.
Exhaustion emits `recovery`/`exhausted` with the stage that kept failing
(`resume`, `audit`, `continuation`, …) and throws
`SessionRecoveryExhaustedError`, which sets `suppressFreshSessionRetry`.

### The deviation: a textual continuation

ADR-008 injects no text because an empty turn is available. Here the fixed
`CONTINUATION_PROMPT` is a real user turn. It is deliberately task-free and
idempotent: "Continue from where you left off. Do not repeat work that is
already complete. If the task is finished, reply briefly with the final
result." Because `resume` may already have rescued the interrupted
turn, a full re-statement of the task would duplicate work; a brief nudge
cannot.

The prompt still enters the transcript, unlike Copilot recovery. History is
never truncated on exhaustion.

### History truncation uses a fork

`history.truncate(eventId)` locates the message by `uuid` and calls
`forkSession(sessionId, { dir: cwd, upToMessageId: messages[index - 1].uuid })`
— the previous message, because `upToMessageId` is inclusive. The returned
session id is adopted for later turns, and the usage ledger is replaced because
the fork restarts the cumulative billing baseline. Truncating the first message
cannot produce an empty transcript, so it returns 0 and leaves the session
unchanged; an unknown id throws. Truncation is serialized on the turn chain so
it cannot race a live turn.

## Consequences

- A transient 429/5xx or dropped stream no longer kills the node after a
  long tool-using turn; it reconnects to the same transcript.
- Recovery sends one visible, task-free user turn per attempt. A consumer that
  inspects transcripts sees these nudges.
- Resume's built-in rescue can make a continuation near-empty; that is accepted
  rather than fought, and live verification covers it.
- If the SDK ever answers a resume with a different session id, recovery stops
  immediately instead of silently continuing the wrong conversation.
- String-prompt mode also means `getContextUsage`, `interrupt`,
  `setPermissionMode`, and true empty-turn recovery remain unavailable. Moving
  the session to streaming-input mode is the recorded follow-up and would remove
  this ADR's deviation.
