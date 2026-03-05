/**
 * Verify combinator — wraps a producer NodeFn with a check loop.
 *
 * On each iteration:
 * 1. Call the producer to generate output
 * 2. Run all checks against the output
 * 3. If all pass → return the producer's output
 * 4. If any fail → build feedback, inject RetryContext, retry
 * 5. If max iterations reached → return { action: 'fail' }
 *
 * The verify combinator is itself a NodeFn. From the scheduler's perspective,
 * it's one node that may take multiple internal iterations.
 */

import type {
  NodeFn,
  NodeInput,
  NodeOutput,
  ExecutionContext,
} from './types';

// ---------------------------------------------------------------------------
// Check types
// ---------------------------------------------------------------------------

export interface VerifyCheck {
  readonly name: string;
  readonly fn: (dir: string, artifactContent: string | undefined) => Promise<CheckResult>;
}

export interface CheckResult {
  readonly passed: boolean;
  readonly feedback: string;
}

export interface VerifyConfig {
  readonly checks: readonly VerifyCheck[];
  readonly maxIterations?: number; // default: 3
}

// ---------------------------------------------------------------------------
// property() — convenience factory for common check patterns
// ---------------------------------------------------------------------------

/**
 * Creates a VerifyCheck from a predicate function.
 *
 * @param name - Display name for the check
 * @param predicate - Function that examines artifact content and returns true/false
 * @param failureMessage - Message to include in feedback when check fails
 */
export function property(
  name: string,
  predicate: (content: string) => boolean,
  failureMessage: string,
): VerifyCheck {
  return {
    name,
    fn: async (_dir: string, artifactContent: string | undefined): Promise<CheckResult> => {
      if (artifactContent == null || artifactContent.trim() === '') {
        return { passed: false, feedback: `${name}: No artifact content to verify` };
      }
      const passed = predicate(artifactContent);
      return {
        passed,
        feedback: passed ? `${name}: passed` : `${name}: ${failureMessage}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// verify() — the combinator
// ---------------------------------------------------------------------------

/**
 * Wraps a producer NodeFn with iterative verification.
 *
 * The returned NodeFn:
 * 1. Calls the producer (which may be an agent, deterministic, etc.)
 * 2. Runs all checks against the producer's output
 * 3. If all checks pass → returns the producer's NodeOutput
 * 4. If any check fails → injects RetryContext with feedback, calls producer again
 * 5. After maxIterations failures → returns { action: 'fail' }
 *
 * Each iteration emits metadata events with check results for observability.
 *
 * @param producer - The NodeFn to wrap (e.g., an agent node)
 * @param config - Checks to run and max iterations
 */
export function verify(
  producer: NodeFn,
  config: VerifyConfig,
): NodeFn {
  const maxIterations = config.maxIterations ?? 3;

  return async (input: NodeInput, ctx: ExecutionContext): Promise<NodeOutput> => {
    let currentInput = input;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      // Run the producer
      const output = await producer(currentInput, ctx);

      // Run all checks
      const checkResults = await Promise.all(
        config.checks.map(async (check) => {
          try {
            return await check.fn(input.dir, output.artifact);
          } catch (err) {
            return {
              passed: false,
              feedback: `${check.name}: check error — ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }),
      );

      const allPassed = checkResults.every((r) => r.passed);

      // Emit check results as metadata for observability
      const metadataOutput: NodeOutput = {
        action: output.action,
        artifact: output.artifact,
        metadata: {
          ...(output.metadata ?? {}),
          _verifyIteration: iteration,
          _verifyMaxIterations: maxIterations,
          _verifyChecks: checkResults.map((r, i) => ({
            name: config.checks[i].name,
            passed: r.passed,
            feedback: r.feedback,
          })),
        },
      };

      if (allPassed) {
        return metadataOutput;
      }

      // Last iteration — fail
      if (iteration === maxIterations) {
        return {
          action: 'fail',
          artifact: output.artifact,
          metadata: metadataOutput.metadata,
        };
      }

      // Build feedback for retry
      const failedChecks = checkResults
        .filter((r) => !r.passed)
        .map((r) => r.feedback);

      const feedbackStr = `Verification failed (attempt ${iteration}/${maxIterations}):\n${failedChecks.map((f) => `  - ${f}`).join('\n')}`;

      // Retry with RetryContext
      currentInput = {
        ...input,
        retryContext: {
          priorOutput: output.artifact ?? null,
          feedback: feedbackStr,
          override: currentInput.retryContext?.override,
        },
      };
    }

    // Should not reach here, but TypeScript needs it
    return { action: 'fail' };
  };
}
