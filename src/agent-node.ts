import * as fs from 'node:fs';
import * as path from 'node:path';
import { agent } from './agent';
import type {
  ExecutionContext,
  NodeEntry,
  NodeInput,
  NodeOutput,
  CustomAgentConfig,
  DefaultAgentConfig,
  RetryPolicy,
  ThinkingBudget,
  ToolRef,
} from './types';

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

export interface AgentNodeConfig<T> {
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
  readonly timeout?: number;
  readonly isolation?: boolean;
  readonly tools?: readonly ToolRef[] | readonly string[];
  readonly retry?: RetryPolicy;
  readonly customAgents?: readonly CustomAgentConfig[];
  readonly defaultAgent?: DefaultAgentConfig;
  readonly excludedBuiltinAgents?: readonly string[];
  /** Runtime-only identifier used to distinguish concurrent panel members. */
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

export function repairPrompt(prompt: string, raw: string, error: Error): string {
  return [
    prompt,
    '',
    'Your previous response was not valid structured output. Return only corrected JSON.',
    'Validation issues:',
    error.message,
    '',
    'Previous response:',
    raw,
  ].join('\n');
}

export function validationError(issues: readonly string[]): Error {
  const details = issues.length > 0 ? issues : ['Schema validation failed'];
  return new Error(details.map((issue) => `- ${issue}`).join('\n'));
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
    isolation: config.isolation,
    timeout: config.timeout,
    systemMessage: config.system,
    availableTools: toolIds(config.tools),
    retry: config.retry,
    customAgents: config.customAgents,
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
    const retryDeadlineMs = nodeContext.retryDeadlineMs
      ?? (retryBudgetMs === undefined
        ? undefined
        : Date.now() + (
            Number.isFinite(retryBudgetMs)
              ? Math.max(0, retryBudgetMs)
              : 0
          ));
    const producerContext = retryDeadlineMs === undefined
      ? nodeContext
      : { ...nodeContext, retryDeadlineMs };
    let raw = '';
    let lastError = new Error('Structured output was not produced');
    let metadata: Record<string, unknown> | undefined;
    const attempts = retryCount(config.structuredRetry) + 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const currentPrompt = attempt === 0
        ? `${prompt}\n\nReturn exactly one valid JSON value with no prose or markdown fences.`
        : repairPrompt(prompt, raw, lastError);
      const result = await produce(config, currentPrompt, input, producerContext);
      metadata = result.metadata;
      const issues: string[] = [];
      for (const source of rawCandidates(result)) {
        raw = source.raw;
        let sawCandidate = false;
        for (const candidate of extractJsonCandidates(source.raw)) {
          sawCandidate = true;
          const validated = await validateCandidate(validator, candidate);
          if (validated.ok) {
            return successOutput(config, input, validated.value, metadata);
          }
          issues.push(...validated.issues.map((issue) => `${source.label}: ${issue}`));
        }
        if (!sawCandidate) {
          issues.push(`${source.label}: no valid JSON value was found`);
        }
      }
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
    timeout: config.timeout,
  };
}
