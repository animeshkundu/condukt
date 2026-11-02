/**
 * Same-session recovery for the Claude runtime (ADR-009, ADR-008 parity).
 *
 * The Claude SDK has no empty-turn primitive in string-prompt mode, so
 * recovery here resumes the failed session and sends one fixed,
 * task-free continuation. Everything in this module is pure so it can be
 * unit-tested without a CLI: the session owns the loop and the events.
 */

import type { ClaudeResultOutcome } from './message-mapper';

/**
 * The idempotent nudge sent after a resume. It must not repeat the original
 * task: `resume` may already have re-run an interrupted turn on its own
 * (`resume_reason` frames), and a second full task would duplicate work.
 */
export const CONTINUATION_PROMPT =
  'Continue from where you left off. Do not repeat work that is already complete. '
  + 'If the task is finished, reply briefly with the final result.';

/**
 * The reconnect step that produced an error. Mirrors the `stage` values on a
 * `SessionRecoveryEvent` so an `exhausted` event can name what failed.
 */
export type ClaudeRecoveryStage =
  | 'fence'
  | 'client'
  | 'resume'
  | 'configuration'
  | 'audit'
  | 'continuation';

/**
 * A failed recovery step.
 *
 * `fatal` marks steps whose failure cannot change its answer on a retry: the
 * resumed session reported a different id than the one asked for, or the CLI
 * refused the required permission mode. Every other step is retried until
 * the continuation count or the recovery budget runs out.
 */
export class ClaudeResumeAttemptError extends Error {
  constructor(
    readonly stage: ClaudeRecoveryStage,
    message: string,
    readonly fatal: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ClaudeResumeAttemptError';
  }
}

export function toResumeAttemptError(
  value: unknown,
  stage: ClaudeRecoveryStage,
): ClaudeResumeAttemptError {
  if (value instanceof ClaudeResumeAttemptError) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new ClaudeResumeAttemptError(stage, message, false, {
    cause: value instanceof Error ? value : undefined,
  });
}

/** The CLI accepted the prompt but the query stream ended with no result. */
export class ClaudeStreamEndedError extends Error {
  constructor(message = 'Claude query ended without a result message') {
    super(message);
    this.name = 'ClaudeStreamEndedError';
  }
}

/** A requested configuration invariant was not applied by the CLI. */
export class ClaudeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeConfigurationError';
  }
}

export interface ClaudeFailureSignals {
  /** The terminal message, when the stream produced one. */
  readonly outcome?: ClaudeResultOutcome;
  /** Last `assistant.error` value seen during the failed turn. */
  readonly assistantError?: string;
  /** A thrown stream/transport error, when the turn never produced a result. */
  readonly error?: Error;
  /** condukt aborted the turn; nothing is recoverable. */
  readonly aborted: boolean;
}

export interface ClaudeFailureClassification {
  readonly recoverable: boolean;
  /** Human-readable evidence, also used in the `exhausted` reason. */
  readonly reason: string;
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly failureKind?: string;
}

/**
 * Assistant-frame errors that a resumed turn cannot fix. Credentials, request
 * shape, and model selection are configuration facts, not transient faults;
 * `max_output_tokens` is a per-turn limit that a continuation could mask but
 * not raise.
 */
const NON_RECOVERABLE_ASSISTANT_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'max_output_tokens',
  'cloud_credential_error',
]);

const RECOVERABLE_ASSISTANT_ERRORS: ReadonlySet<string> = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
  'unknown',
]);

/** Terminal reasons where the model call itself was interrupted. */
const RECOVERABLE_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'model_error',
  'api_error',
  'aborted_streaming',
  'aborted_tools',
]);

const NON_RECOVERABLE_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'prompt_too_long',
  'blocking_limit',
  'rapid_refill_breaker',
  'max_turns',
  'budget_exhausted',
  'structured_output_retry_exhausted',
  'turn_setup_failed',
  'image_error',
  'malformed_tool_use_exhausted',
  'stop_hook_prevented',
  'hook_stopped',
  'tool_deferred',
  'tool_deferred_unavailable',
  'background_requested',
]);

const NON_RECOVERABLE_SUBTYPES: ReadonlySet<string> = new Set([
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]);

const TRANSIENT_TEXT = /terminated|connection|socket|timeout|timed out|econn|network|fetch failed|temporar|unavailable|overloaded|rate.?limit|too many requests|bad gateway|service unavailable|gateway timeout|internal server error/i;

const NON_RECOVERABLE_TEXT = /authentication|unauthorized|forbidden|invalid api key|invalid_request|permission denied|model not found|prompt is too long|context length|maximum context|max_tokens|exceeds the context window/i;

/** `result.subtype !== 'success'` or a transient API failure flagged in-band. */
export function outcomeIsFailure(outcome: ClaudeResultOutcome): boolean {
  return outcome.subtype !== 'success' || outcome.isError;
}

/** The error a terminal result should fail the turn with. */
export function failureFromOutcome(outcome: ClaudeResultOutcome): Error {
  const message = outcome.errors[0]
    ?? (outcome.apiErrorStatus !== undefined && outcome.apiErrorStatus !== null
      ? `Claude API error (status ${outcome.apiErrorStatus})`
      : outcome.terminalReason !== undefined
        ? `Claude session failed (${outcome.subtype}: ${outcome.terminalReason})`
        : `Claude session failed (${outcome.subtype})`);
  const error = new Error(message);
  error.name = outcome.subtype === 'success' ? 'ClaudeApiError' : 'ClaudeResultError';
  return error;
}

/**
 * Decides whether resuming the same session can plausibly fix a failed turn.
 *
 * Evidence is checked in the order the SDK makes it authoritative:
 * `startup_failure_reason` and fatal local errors first, then the assistant
 * error enum, then the HTTP status, then `terminal_reason`, then message
 * text. A thrown stream error with no explicit signal is treated as a
 * transport failure and is recoverable; a result error with no evidence is
 * not retried blindly.
 */
export function classifyClaudeFailure(
  signals: ClaudeFailureSignals,
): ClaudeFailureClassification {
  if (signals.error instanceof ClaudeConfigurationError) {
    return {
      recoverable: false,
      reason: signals.error.message,
      failureKind: 'configuration',
    };
  }
  if (signals.error instanceof ClaudeResumeAttemptError && signals.error.fatal) {
    return {
      recoverable: false,
      reason: signals.error.message,
      failureKind: signals.error.stage,
    };
  }
  if (signals.aborted) {
    return { recoverable: false, reason: 'turn was aborted', failureKind: 'aborted' };
  }

  const outcome = signals.outcome;
  if (outcome?.startupFailureReason !== undefined) {
    return {
      recoverable: false,
      reason: `Claude startup failed: ${outcome.startupFailureReason}`,
      errorCode: outcome.startupFailureReason,
      failureKind: 'startup',
    };
  }
  if (outcome !== undefined && NON_RECOVERABLE_SUBTYPES.has(outcome.subtype)) {
    return {
      recoverable: false,
      reason: `Claude result '${outcome.subtype}' is not recoverable`,
      errorCode: outcome.subtype,
      failureKind: outcome.subtype,
    };
  }

  const assistantError = signals.assistantError;
  if (assistantError !== undefined) {
    if (NON_RECOVERABLE_ASSISTANT_ERRORS.has(assistantError)) {
      return {
        recoverable: false,
        reason: `Claude reported '${assistantError}'`,
        errorCode: assistantError,
        failureKind: 'assistant-error',
      };
    }
    if (RECOVERABLE_ASSISTANT_ERRORS.has(assistantError)) {
      return {
        recoverable: true,
        reason: `Claude reported '${assistantError}'`,
        errorCode: assistantError,
        failureKind: 'assistant-error',
      };
    }
  }

  const status = outcome?.apiErrorStatus ?? undefined;
  if (typeof status === 'number' && Number.isFinite(status)) {
    const recoverable = status === 408 || status === 425 || status === 429 || status === 499 || status >= 500;
    return {
      recoverable,
      reason: `Claude API status ${status}`,
      statusCode: status,
      ...(assistantError !== undefined ? { errorCode: assistantError } : {}),
      failureKind: 'api-error',
    };
  }

  const terminalReason = outcome?.terminalReason;
  if (terminalReason !== undefined) {
    const recoverable = RECOVERABLE_TERMINAL_REASONS.has(terminalReason);
    return {
      recoverable,
      reason: NON_RECOVERABLE_TERMINAL_REASONS.has(terminalReason)
        ? `Claude terminal reason '${terminalReason}' is not recoverable`
        : `Claude terminal reason '${terminalReason}'`,
      errorCode: terminalReason,
      failureKind: 'terminal',
    };
  }

  const evidence = [
    ...(outcome?.errors ?? []),
    ...(assistantError !== undefined ? [assistantError] : []),
    ...(signals.error !== undefined ? [signals.error.message] : []),
  ].join('\n');
  if (evidence.length > 0) {
    if (NON_RECOVERABLE_TEXT.test(evidence)) {
      return {
        recoverable: false,
        reason: 'failure text describes a non-transient condition',
        failureKind: 'text',
      };
    }
    if (TRANSIENT_TEXT.test(evidence)) {
      return {
        recoverable: true,
        reason: 'failure text describes a transient fault',
        failureKind: 'text',
      };
    }
  }

  if (signals.error !== undefined) {
    return {
      recoverable: true,
      reason: signals.error.message,
      failureKind: 'stream',
    };
  }
  return {
    recoverable: false,
    reason: outcome !== undefined
      ? `Claude result '${outcome.subtype}' carried no recoverable evidence`
      : 'no failure evidence',
    ...(outcome !== undefined ? { errorCode: outcome.subtype } : {}),
    failureKind: 'unknown',
  };
}
