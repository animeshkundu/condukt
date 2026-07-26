import type { AgentNodeConfig, AgentNodeSchema } from './agent-node';
import {
  extractJsonCandidates,
  loadReads,
  produce,
  rawCandidates,
  removeInvalidOutput,
  repairPrompt,
  retryCount,
  serialize,
  toValidator,
  validateCandidate,
  validationError,
  writeOutput,
} from './agent-node';
import type {
  CustomAgentConfig,
  DefaultAgentConfig,
  ExecutionContext,
  NodeEntry,
  NodeInput,
  NodeOutput,
  RetryPolicy,
} from './types';

export interface PanelMember {
  readonly model: string;
  readonly system?: string;
  readonly id?: string;
}

export interface PanelMemberMeta {
  readonly member: PanelMember;
  readonly ok: boolean;
}

export interface PanelConfig<T, V = unknown> {
  readonly prompt:
    | string
    | ((
      input: NodeInput,
      reads: Readonly<Record<string, unknown>>,
    ) => string);
  readonly members: readonly PanelMember[];
  readonly memberSchema?: AgentNodeSchema<V>;
  readonly reconcile: (
    verdicts: readonly V[],
    meta: readonly PanelMemberMeta[],
  ) => T;
  readonly output?: string;
  readonly reads?: readonly string[];
  readonly displayName?: string;
  readonly route?: (result: T) => string;
  readonly fallback?: (error: Error) => T;
  readonly timeout?: number;
  readonly isolation?: boolean;
  readonly retry?: RetryPolicy;
  readonly customAgents?: readonly CustomAgentConfig[];
  readonly defaultAgent?: DefaultAgentConfig;
  readonly excludedBuiltinAgents?: readonly string[];
  readonly structuredRetry?: number;
}

type MemberResult<V> =
  | { readonly ok: true; readonly value: V }
  | { readonly ok: false; readonly error: Error };

async function runMember<T, V>(
  config: PanelConfig<T, V>,
  member: PanelMember,
  prompt: string,
  input: NodeInput,
  ctx: ExecutionContext,
): Promise<MemberResult<V>> {
  const memberOutput = config.output
    ?? `.condukt/${ctx.executionId}-${ctx.nodeId}-panel-member.json`;
  const memberConfig: AgentNodeConfig<V> = {
    prompt,
    model: member.model,
    system: member.system,
    output: memberOutput,
    timeout: config.timeout,
    isolation: config.isolation,
    retry: config.retry,
    customAgents: config.customAgents,
    defaultAgent: config.defaultAgent,
    excludedBuiltinAgents: config.excludedBuiltinAgents,
  };

  if (!config.memberSchema) {
    try {
      removeInvalidOutput(input, memberOutput);
      const result = await produce(memberConfig, prompt, input, ctx);
      if (!config.output) removeInvalidOutput(input, memberOutput);
      return { ok: true, value: (result.artifact ?? result.text) as V };
    } catch (error) {
      if (!config.output) removeInvalidOutput(input, memberOutput);
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  const validator = toValidator(config.memberSchema);
  let raw = '';
  let lastError = new Error('Structured output was not produced');
  const attempts = retryCount(config.structuredRetry) + 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const currentPrompt = attempt === 0
      ? `${prompt}\n\nReturn exactly one valid JSON value with no prose or markdown fences.`
      : repairPrompt(prompt, raw, lastError);
    try {
      removeInvalidOutput(input, memberOutput);
      const result = await produce(memberConfig, currentPrompt, input, ctx);
      const issues: string[] = [];
      for (const source of rawCandidates(result)) {
        raw = source.raw;
        let sawCandidate = false;
        for (const candidate of extractJsonCandidates(source.raw)) {
          sawCandidate = true;
          const validated = await validateCandidate(validator, candidate);
          if (validated.ok) {
            if (!config.output) removeInvalidOutput(input, memberOutput);
            return { ok: true, value: validated.value };
          }
          issues.push(...validated.issues.map((issue) => `${source.label}: ${issue}`));
        }
        if (!sawCandidate) {
          issues.push(`${source.label}: no valid JSON value was found`);
        }
      }
      lastError = validationError(issues);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (!config.output) removeInvalidOutput(input, memberOutput);
  return { ok: false, error: lastError };
}

function successOutput<T, V>(
  config: PanelConfig<T, V>,
  input: NodeInput,
  result: T,
  meta: readonly PanelMemberMeta[],
): NodeOutput {
  const artifact = serialize(result);
  writeOutput(input, config.output, artifact);
  return {
    action: config.route?.(result) ?? 'default',
    artifact,
    metadata: { value: result, panel: meta },
  };
}

/**
 * Create a sequential multi-agent panel whose successful member verdicts are
 * combined by a caller-supplied reconciliation policy.
 *
 * @experimental Experimental — API may change before it stabilizes into condukt core.
 */
export function panelNode<T, V = unknown>(config: PanelConfig<T, V>): NodeEntry {
  if (config.members.length < 1) {
    throw new Error('panelNode requires at least one member');
  }

  const fn = async (input: NodeInput, ctx: ExecutionContext): Promise<NodeOutput> => {
    let retryAttempt = 1;
    const panelContext: ExecutionContext = ctx.nextRetryAttempt
      ? ctx
      : {
          ...ctx,
          nextRetryAttempt: () => {
            retryAttempt += 1;
            return retryAttempt;
          },
        };
    const retryBudgetMs = config.retry?.budgetMs;
    const retryDeadlineMs = panelContext.retryDeadlineMs
      ?? (retryBudgetMs === undefined
        ? undefined
        : Date.now() + (
            Number.isFinite(retryBudgetMs)
              ? Math.max(0, retryBudgetMs)
              : 0
          ));
    const memberContext = retryDeadlineMs === undefined
      ? panelContext
      : { ...panelContext, retryDeadlineMs };
    const reads = loadReads(input, config.reads);
    const prompt = typeof config.prompt === 'string'
      ? config.prompt
      : config.prompt(input, reads);
    const verdicts: V[] = [];
    const meta: PanelMemberMeta[] = [];
    let lastError = new Error('No panel members produced a verdict');

    for (const member of config.members) {
      let memberResult: MemberResult<V>;
      try {
        memberResult = await runMember(config, member, prompt, input, memberContext);
      } catch (error) {
        memberResult = {
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
      meta.push({ member, ok: memberResult.ok });
      if (memberResult.ok) {
        verdicts.push(memberResult.value);
      } else {
        lastError = memberResult.error;
      }
    }

    try {
      if (verdicts.length === 0) {
        if (!config.fallback) {
          removeInvalidOutput(input, config.output);
          return { action: 'fail' };
        }
        return successOutput(config, input, config.fallback(lastError), meta);
      }

      return successOutput(config, input, config.reconcile(verdicts, meta), meta);
    } catch (error) {
      // reconcile/fallback/write threw — don't leak a member artifact at the
      // node output path.
      removeInvalidOutput(input, config.output);
      throw error instanceof Error ? error : new Error(String(error));
    }
  };

  return {
    fn,
    displayName: config.displayName ?? '(panel)',
    nodeType: 'agent',
    output: config.output,
    reads: config.reads,
    model: config.members[0]?.model ?? 'panel',
    timeout: config.timeout,
  };
}
