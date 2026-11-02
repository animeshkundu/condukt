/**
 * Session-recovery policy normalization and backoff, shared by every runtime
 * that implements ADR-008 recovery.
 */

import { DEFAULT_SESSION_RECOVERY_POLICY, type SessionRecoveryPolicy } from './types';

export const MAX_SESSION_RECOVERY_CONTINUATIONS = 23;

export interface EffectiveSessionRecoveryPolicy {
  readonly maxContinuations: number;
  readonly budgetMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly jitter: boolean;
  readonly nativeRetryGraceMs: number;
}

export function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

export function nonNegativeOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

export function effectiveSessionRecoveryPolicy(
  policy: SessionRecoveryPolicy | false | undefined,
): EffectiveSessionRecoveryPolicy | undefined {
  if (policy === false) return undefined;
  const configured = policy ?? {};
  return {
    maxContinuations: Math.min(
      MAX_SESSION_RECOVERY_CONTINUATIONS,
      positiveIntegerOr(
        configured.maxContinuations,
        DEFAULT_SESSION_RECOVERY_POLICY.maxContinuations,
      ),
    ),
    budgetMs: nonNegativeOr(configured.budgetMs, DEFAULT_SESSION_RECOVERY_POLICY.budgetMs),
    backoffBaseMs: positiveIntegerOr(
      configured.backoffBaseMs,
      DEFAULT_SESSION_RECOVERY_POLICY.backoffBaseMs,
    ),
    backoffMaxMs: positiveIntegerOr(
      configured.backoffMaxMs,
      DEFAULT_SESSION_RECOVERY_POLICY.backoffMaxMs,
    ),
    jitter: configured.jitter ?? DEFAULT_SESSION_RECOVERY_POLICY.jitter,
    nativeRetryGraceMs: nonNegativeOr(
      configured.nativeRetryGraceMs,
      DEFAULT_SESSION_RECOVERY_POLICY.nativeRetryGraceMs,
    ),
  };
}

export function recoveryDelayMs(
  policy: EffectiveSessionRecoveryPolicy,
  failedContinuation: number,
): number {
  const exponent = Math.min(52, Math.max(0, failedContinuation));
  const capped = Math.min(policy.backoffMaxMs, policy.backoffBaseMs * (2 ** exponent));
  const delayed = policy.jitter ? Math.random() * capped : capped;
  return Math.max(100, Number.isFinite(delayed) ? delayed : 100);
}
