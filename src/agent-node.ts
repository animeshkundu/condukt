import * as fs from 'node:fs';
import * as path from 'node:path';
import { agent } from './agent';
import type {
  AdvisorConfig,
  StandInConfig,
  CompactionMode,
  ContextTier,
  ExecutionContext,
  NodeEntry,
  NodeInput,
  NodeOutput,
  CustomAgentConfig,
  DefaultAgentConfig,
  MCPServersOption,
  RetryPolicy,
  SessionMode,
  ThinkingBudget,
  ToolRef,
  SubagentLimits,
  SubagentRosterOption,
} from './types';
import { DEFAULT_AGENT_TIMEOUT_SECS } from './types';

export type SchemaValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Minimal validation contract used by agentNode(). */
export interface SchemaValidator<T> {
  readonly validate: (
    value: unknown,
  ) => SchemaValidationResult<T> | Promise<SchemaValidationResult<T>>;
}

export type SchemaValidationFunction<T> = (value: unknown) => T | undefined;

interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: readonly unknown[];
}

type StandardSchemaResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] };

/** Structural subset of Standard Schema, kept local to avoid a runtime dependency. */
export interface StandardSchemaValidator<T> {
  readonly '~standard': {
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<T> | PromiseLike<StandardSchemaResult<T>>;
  };
}

export type AgentNodeSchema<T> =
  | SchemaValidator<T>
  | SchemaValidationFunction<T>
  | StandardSchemaValidator<T>;

export interface AgentNodeConfig<T> extends SubagentLimits {
  readonly prompt:
    | string
    | ((
      input: NodeInput,
      reads: Readonly<Record<string, unknown>>,
    ) => string);
  readonly model: string;
  readonly schema?: AgentNodeSchema<T>;
  readonly system?: string;
  readonly output?: string;
  readonly reads?: readonly string[];
  readonly displayName?: string;
  readonly thinkingBudget?: ThinkingBudget;
  readonly contextTier?: ContextTier;
  readonly compactionMode?: CompactionMode;
  readonly mode?: SessionMode;
  readonly advisor?: AdvisorConfig;
  readonly standIn?: StandInConfig;
  /** Replaces DEFAULT_MCP_SERVERS; spread the default to extend it, or use false to disable MCP. */
  readonly mcpServers?: MCPServersOption;
  /** Total wall-clock limit in seconds. Defaults to DEFAULT_AGENT_TIMEOUT_SECS. */
  readonly timeout?: number;
  readonly isolation?: boolean;
  readonly tools?: readonly ToolRef[] | readonly string[];
  readonly retry?: RetryPolicy;
  readonly customAgents?: readonly CustomAgentConfig[];
  readonly subagentRoster?: SubagentRosterOption;
  readonly defaultAgent?: DefaultAgentConfig;
  readonly excludedBuiltinAgents?: readonly string[];
  /** Runtime-only identifier used to distinguish concurrent quorum members. */
  readonly memberId?: string;
  readonly route?: (result: T) => string;
  readonly fallback?: (raw: string, error: Error) => T;
  readonly structuredRetry?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function standardIssueMessage(issue: StandardSchemaIssue, index: number): string {
  const pathPrefix = issue.path && issue.path.length > 0
    ? `${issue.path.map((part) => String(part)).join('.')}: `
    : '';
  return issue.message.length > 0
    ? `${pathPrefix}${issue.message}`
    : `Standard Schema issue ${index + 1}`;
}

/** Normalize condukt, function, and Standard Schema validators. */
export function toValidator<T>(schema: AgentNodeSchema<T>): SchemaValidator<T> {
  if (typeof schema === 'function') {
    return {
      validate: (value) => {
        try {
          const validated = schema(value);
          return validated === undefined
            ? { ok: false, issues: ['Validation function returned undefined'] }
            : { ok: true, value: validated };
        } catch (error) {
          return { ok: false, issues: [errorMessage(error)] };
        }
      },
    };
  }

  if ('~standard' in schema) {
    return {
      validate: async (value) => {
        try {
          const result = await schema['~standard'].validate(value);
          if ('issues' in result && result.issues !== undefined) {
            const issues = result.issues.map(standardIssueMessage);
            return {
              ok: false,
              issues: issues.length > 0 ? issues : ['Standard Schema validation failed'],
            };
          }
          return { ok: true, value: result.value };
        } catch (error) {
          return { ok: false, issues: [errorMessage(error)] };
        }
      },
    };
  }

  return schema;
}

/**
 * Yield every parseable JSON value in `text`, best first: the whole trimmed
 * string, then each balanced object/array span in start order (so a top-level
 * value is tried before a nested one). The caller validates candidates in order
 * and takes the first that satisfies the schema — so an example snippet that
 * precedes the real answer, or a span that parses but fails validation, does not
 * mask a later valid value.
 */
export function* extractJsonCandidates(text: string): Generator<unknown> {
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    try {
      // The whole response is a single JSON value — that IS the value; scanning
      // for embedded spans would only re-yield this same value.
      yield JSON.parse(trimmed) as unknown;
      return;
    } catch {
      // The complete response may contain prose or markdown around the JSON value.
    }
  }

  for (let start = 0; start < text.length; start += 1) {
    const opening = text[start];
    if (opening !== '{' && opening !== '[') continue;

    const expectedClosings: string[] = [opening === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        expectedClosings.push('}');
      } else if (character === '[') {
        expectedClosings.push(']');
      } else if (character === '}' || character === ']') {
        if (expectedClosings.at(-1) !== character) break;
        expectedClosings.pop();
        if (expectedClosings.length === 0) {
          try {
            yield JSON.parse(text.slice(start, index + 1)) as unknown;
          } catch {
            // Not valid JSON from this start; continue scanning later positions.
          }
          break;
        }
      }
    }
  }
}

function parseRead(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function loadReads(
  input: NodeInput,
  names: readonly string[] | undefined,
): Readonly<Record<string, unknown>> {
  const reads: Record<string, unknown> = {};
  for (const name of names ?? []) {
    const artifactPath = input.artifactPaths[name] ?? path.join(input.dir, name);
    try {
      reads[name] = parseRead(fs.readFileSync(artifactPath, 'utf-8'));
    } catch {
      // A missing optional read remains absent from the record.
    }
  }
  return reads;
}

function toolIds(
  tools: readonly ToolRef[] | readonly string[] | undefined,
): readonly string[] | undefined {
  return tools?.map((tool) => typeof tool === 'string' ? tool : tool.id);
}

interface Diagnostic {
  readonly issue: string;
  readonly count: number;
  readonly order: number;
}

export interface RepairCandidate {
  readonly source: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly issues: readonly string[];
}

function diagnostics(issues: readonly string[]): readonly Diagnostic[] {
  const details = issues.length > 0 ? issues : ['Schema validation failed'];
  const byIssue = new Map<string, { count: number; order: number }>();
  for (const issue of details) {
    const existing = byIssue.get(issue);
    if (existing) existing.count += 1;
    else byIssue.set(issue, { count: 1, order: byIssue.size });
  }
  return [...byIssue].map(([issue, detail]) => ({ issue, ...detail }));
}

function diagnosticLine(diagnostic: Diagnostic): string {
  const count = diagnostic.count === 1
    ? ''
    : ` (${diagnostic.count} occurrences)`;
  return `- ${diagnostic.issue}${count}`;
}

function omittedLine(count: number): string {
  return `- ${count} distinct validation ${count === 1 ? 'issue was' : 'issues were'} omitted`;
}

function renderDiagnostics(entries: readonly Diagnostic[]): string {
  return entries.map(diagnosticLine).join('\n');
}

function boundedDiagnostics(issues: readonly string[], budget: number): string {
  const entries = diagnostics(issues);
  const complete = renderDiagnostics(entries);
  if (complete.length <= budget) return complete;

  const ranked = [...entries].sort((left, right) => (
    right.count - left.count || left.order - right.order
  ));
  const selected: Diagnostic[] = [];
  for (const entry of ranked) {
    const next = [...selected, entry];
    const omitted = entries.length - next.length;
    const lines = [
      renderDiagnostics([...next].sort((left, right) => left.order - right.order)),
      ...(omitted > 0 ? [omittedLine(omitted)] : []),
    ].filter((line) => line.length > 0).join('\n');
    if (lines.length > budget) continue;
    selected.push(entry);
  }

  const omitted = entries.length - selected.length;
  const omission = omittedLine(omitted);
  if (selected.length === 0) {
    // A budget too small for "issue plus omission count" still has room for the issue,
    // and one concrete diagnostic is worth more than a bare count of what was dropped.
    const only = ranked[0] === undefined ? '' : diagnosticLine(ranked[0]);
    if (only.length > 0 && only.length <= budget) return only;
    return omission.length <= budget ? omission : '';
  }
  return [
    renderDiagnostics([...selected].sort((left, right) => left.order - right.order)),
    ...(omitted > 0 ? [omission] : []),
  ].filter((line) => line.length > 0).join('\n');
}

export function preferRepairCandidate(
  current: RepairCandidate | undefined,
  source: string,
  value: unknown,
  issues: readonly string[],
): RepairCandidate | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return current;
  const candidate: RepairCandidate = {
    source,
    value: value as Readonly<Record<string, unknown>>,
    issues,
  };
  return current === undefined
    || Object.keys(candidate.value).length >= Object.keys(current.value).length
    ? candidate
    : current;
}

export function repairCandidateIssues(
  issues: readonly string[],
  candidate: RepairCandidate | undefined,
): readonly string[] {
  return candidate === undefined
    ? issues
    : candidate.issues.map((issue) => `${candidate.source}: ${issue}`);
}

export function repairPrompt(
  prompt: string,
  issues: readonly string[],
  candidate?: RepairCandidate,
): string {
  // Evidence about a failed attempt must never exceed the instructions it diagnoses.
  const evidenceBudget = prompt.length;
  // The candidate claims the budget first: it is what lets a near-miss be corrected
  // without redoing the work, whereas diagnostics only describe the miss.
  const serialized = candidate === undefined ? undefined : JSON.stringify(candidate.value, null, 2);
  const serializedCandidate = serialized !== undefined && serialized.length <= evidenceBudget
    ? serialized
    : undefined;
  const issueBlock = boundedDiagnostics(issues, evidenceBudget - (serializedCandidate?.length ?? 0));

  const evidence = serializedCandidate === undefined
    ? candidate === undefined
      ? ['', 'No credible JSON object was found in the previous response.']
      : ['', 'The previous JSON object exceeded the repair evidence budget.']
    : ['', `Previous JSON candidate from ${candidate?.source}:`, serializedCandidate];
  return [
    prompt,
    '',
    'Your previous response was not valid structured output.',
    'Return exactly one valid JSON value matching the requested contract with no prose or markdown fences.',
    ...(issueBlock.length === 0 ? [] : ['Validation issues:', issueBlock]),
    ...evidence,
  ].join('\n');
}

export function validationError(issues: readonly string[]): Error {
  return new Error(renderDiagnostics(diagnostics(issues)));
}

export async function validateCandidate<T>(
  validator: SchemaValidator<T>,
  value: unknown,
): Promise<SchemaValidationResult<T>> {
  try {
    return await validator.validate(value);
  } catch (error) {
    return { ok: false, issues: [errorMessage(error)] };
  }
}

export function serialize(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) {
    throw new Error('Structured result is not JSON-serializable');
  }
  return json;
}

export function writeOutput(input: NodeInput, output: string | undefined, content: string): void {
  if (!output) return;
  const outputPath = path.join(input.dir, output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, 'utf-8');
}

export function removeInvalidOutput(input: NodeInput, output: string | undefined): void {
  if (!output) return;
  try {
    fs.unlinkSync(path.join(input.dir, output));
  } catch {
    // The producer may have returned text without writing an artifact.
  }
}

export function retryCount(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.trunc(value));
}

export interface ProducerResult {
  readonly artifact?: string;
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
}

interface RawCandidate {
  readonly label: string;
  readonly raw: string;
}

export function rawCandidates(result: ProducerResult): readonly RawCandidate[] {
  const candidates: RawCandidate[] = [];
  if (result.artifact !== undefined) {
    candidates.push({ label: 'Artifact', raw: result.artifact });
  }
  if (result.text.length > 0 && result.text !== result.artifact) {
    candidates.push({ label: 'Model text', raw: result.text });
  }
  return candidates.length > 0
    ? candidates
    : [{ label: 'Response', raw: '' }];
}

export async function produce<T>(
  config: AgentNodeConfig<T>,
  prompt: string,
  input: NodeInput,
  ctx: ExecutionContext,
): Promise<ProducerResult> {
  const text: string[] = [];
  const producer = agent({
    output: config.output,
    model: config.model,
    thinkingBudget: config.thinkingBudget,
    contextTier: config.contextTier,
    compactionMode: config.compactionMode,
    mode: config.mode,
    advisor: config.advisor,
    standIn: config.standIn,
    mcpServers: config.mcpServers,
    isolation: config.isolation,
    timeout: config.timeout ?? DEFAULT_AGENT_TIMEOUT_SECS,
    systemMessage: config.system,
    availableTools: toolIds(config.tools),
    retry: config.retry,
    customAgents: config.customAgents,
    subagentRoster: config.subagentRoster,
    subagentsEnabled: config.subagentsEnabled,
    maxDepth: config.maxDepth,
    maxConcurrency: config.maxConcurrency,
    defaultAgent: config.defaultAgent,
    excludedBuiltinAgents: config.excludedBuiltinAgents,
    memberId: config.memberId,
    promptBuilder: () => prompt,
  });
  const result = await producer(input, {
    ...ctx,
    emitOutput: (event) => {
      if (event.type === 'node:output') text.push(event.content);
      ctx.emitOutput(event);
    },
  });
  return {
    artifact: result.artifact,
    text: text.join(''),
    metadata: result.metadata,
  };
}

function successOutput<T>(
  config: AgentNodeConfig<T>,
  input: NodeInput,
  value: T,
  metadata: Record<string, unknown> | undefined,
): NodeOutput {
  const artifact = serialize(value);
  writeOutput(input, config.output, artifact);
  return {
    action: config.route?.(value) ?? 'default',
    artifact,
    metadata: { ...metadata, value },
  };
}

/**
 * Create a batteries-included agent NodeEntry with optional validated structured output.
 *
 * @experimental Experimental — API may change before it stabilizes into condukt core.
 */
export function agentNode<T = string>(config: AgentNodeConfig<T>): NodeEntry {
  const fn = async (input: NodeInput, ctx: ExecutionContext): Promise<NodeOutput> => {
    let retryAttempt = 1;
    const nodeContext: ExecutionContext = ctx.nextRetryAttempt
      ? ctx
      : {
          ...ctx,
          nextRetryAttempt: () => {
            retryAttempt += 1;
            return retryAttempt;
          },
        };
    const reads = loadReads(input, config.reads);
    const prompt = typeof config.prompt === 'string'
      ? config.prompt
      : config.prompt(input, reads);

    if (!config.schema) {
      const result = await produce(config, prompt, input, nodeContext);
      const raw = result.artifact ?? result.text;
      return {
        action: config.route?.(raw as unknown as T) ?? 'default',
        artifact: raw,
        metadata: result.metadata,
      };
    }

    const validator = toValidator(config.schema);
    const retryBudgetMs = config.retry?.budgetMs;
    const retryWindowMs = retryBudgetMs === undefined
      ? config.retry === undefined
        ? undefined
        : (config.timeout ?? DEFAULT_AGENT_TIMEOUT_SECS) * 1000
      : Number.isFinite(retryBudgetMs)
        ? Math.max(0, retryBudgetMs)
        : 0;
    const retryDeadlineMs = nodeContext.retryDeadlineMs
      ?? (retryWindowMs === undefined ? undefined : Date.now() + retryWindowMs);
    const producerContext = retryDeadlineMs === undefined
      ? nodeContext
      : { ...nodeContext, retryDeadlineMs };
    let raw = '';
    let lastIssues = ['Structured output was not produced'];
    let lastCandidate: RepairCandidate | undefined;
    let lastError = validationError(lastIssues);
    let metadata: Record<string, unknown> | undefined;
    const attempts = retryCount(config.structuredRetry) + 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const currentPrompt = attempt === 0
        ? `${prompt}\n\nReturn exactly one valid JSON value with no prose or markdown fences.`
        : repairPrompt(prompt, lastIssues, lastCandidate);
      const result = await produce(config, currentPrompt, input, producerContext);
      metadata = result.metadata;
      const issues: string[] = [];
      let repairCandidate: RepairCandidate | undefined;
      for (const source of rawCandidates(result)) {
        raw = source.raw;
        let sawCandidate = false;
        for (const candidate of extractJsonCandidates(source.raw)) {
          sawCandidate = true;
          const validated = await validateCandidate(validator, candidate);
          if (validated.ok) {
            return successOutput(config, input, validated.value, metadata);
          }
          const candidateIssues = validated.issues;
          issues.push(...candidateIssues.map((issue) => `${source.label}: ${issue}`));
          repairCandidate = preferRepairCandidate(
            repairCandidate,
            source.label,
            candidate,
            candidateIssues,
          );
        }
        if (!sawCandidate) {
          issues.push(`${source.label}: no valid JSON value was found`);
        }
      }
      lastIssues = [...repairCandidateIssues(issues, repairCandidate)];
      lastCandidate = repairCandidate;
      lastError = validationError(issues);
    }

    if (config.fallback) {
      return successOutput(config, input, config.fallback(raw, lastError), metadata);
    }

    removeInvalidOutput(input, config.output);
    return { action: 'fail' };
  };

  return {
    fn,
    displayName: config.displayName ?? '(agent)',
    nodeType: 'agent',
    output: config.output,
    reads: config.reads,
    model: config.model,
    timeout: config.timeout ?? DEFAULT_AGENT_TIMEOUT_SECS,
  };
}
