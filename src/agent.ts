/**
 * Agent node factory — wraps an AgentRuntime session as a NodeFn.
 *
 * Lifecycle: setup → build prompt → delete stale artifact per attempt →
 * create session → wire events → send prompt → await idle/error → read artifact → teardown.
 *
 * Implements GT-3 dual-condition crash recovery: if a session errors out but
 * both a completion indicator was seen in output AND the artifact file exists
 * on disk with real content, treat the run as successful.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentConfig,
  AgentSession,
  ExecutionContext,
  NodeFn,
  NodeInput,
  NodeOutput,
  PromptOutput,
  RetryMeta,
  RetryPolicy,
  SessionConfig,
} from './types';
import {
  DEFAULT_AGENT_TIMEOUT_SECS,
  DEFAULT_CONTEXT_TIER,
  DEFAULT_MCP_SERVERS,
  DEFAULT_PRODUCER_MODEL,
  DEFAULT_THINKING_BUDGET,
  FlowAbortedError,
} from './types';
import type { ContentBlock } from '../runtimes/copilot/copilot-backend';
import type { ToolSpecificData, ImageToolData, ResourceToolData } from '../ui/tool-display/types';

// ---------------------------------------------------------------------------
// ContentBlock → ToolSpecificData bridge (SDK rich events → UI rendering)
// ---------------------------------------------------------------------------

/**
 * Convert SDK ContentBlock array to a ToolSpecificData value.
 * Picks the first block that maps to a known data shape (image or resource).
 * Returns undefined if no blocks match a renderable type.
 */
function contentBlocksToToolData(
  contents: ReadonlyArray<ContentBlock>,
): ToolSpecificData | undefined {
  for (const block of contents) {
    if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      const imageData: ImageToolData = {
        data: block.data,
        mimeType: block.mimeType,
        alt: typeof block.alt === 'string' ? block.alt : undefined,
      };
      return imageData;
    }
    if (block.type === 'resource' && typeof block.uri === 'string' && typeof block.name === 'string') {
      const resourceData: ResourceToolData = {
        uri: block.uri,
        name: block.name,
        title: typeof block.title === 'string' ? block.title : undefined,
        mimeType: typeof block.mimeType === 'string' ? block.mimeType : undefined,
        text: typeof block.text === 'string' ? block.text : undefined,
      };
      return resourceData;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// GT-3 dual-condition crash recovery helper
// ---------------------------------------------------------------------------

const DEFAULT_COMPLETION_INDICATORS: readonly string[] = [
  'Done.',
  'completed',
  'CONFIRMED',
  'finished',
];

/**
 * Checks both conditions required to treat a crashed session as successful:
 * 1. At least one completion indicator string appears in the output lines
 * 2. The artifact file exists on disk with non-trivial content (> 10 chars)
 *
 * Both conditions must hold. Either alone produces false positives (GT-3).
 */
export function wasCompletedBeforeCrash(
  dir: string,
  outputFile: string,
  outputLines: readonly string[],
  indicators?: readonly string[],
): boolean {
  const indicatorList = indicators ?? DEFAULT_COMPLETION_INDICATORS;

  // Condition 1: any indicator found in any output line
  const hasIndicator = outputLines.some((line) =>
    indicatorList.some((ind) => line.includes(ind)),
  );

  // Condition 2: artifact exists with real content
  let hasArtifact = false;
  try {
    const artifactPath = path.join(dir, outputFile);
    if (fs.existsSync(artifactPath)) {
      const content = fs.readFileSync(artifactPath, 'utf-8');
      hasArtifact = content.trim().length > 10;
    }
  } catch {
    // File doesn't exist or can't be read
    hasArtifact = false;
  }

  return hasIndicator && hasArtifact;
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

function formatPrompt(promptOutput: PromptOutput): string {
  if (typeof promptOutput === 'string') {
    return promptOutput;
  }
  // Structured prompt: combine system + user with clear delimiters
  return `${promptOutput.system}\n\n${promptOutput.user}`;
}

// ---------------------------------------------------------------------------
// Model-call retry
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_BACKOFF_MAX_MS = 120_000;
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EHOSTUNREACH',
  'ENETDOWN', 'ENETRESET', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

interface ErrorWithRetryMetadata extends Error {
  readonly statusCode?: number | string;
  readonly status?: number | string;
  readonly errorCode?: string;
  readonly code?: string;
  readonly cause?: unknown;
}

interface AttemptUsage {
  readonly usage?: Record<string, unknown>;
  readonly subagentUsage: readonly Record<string, unknown>[];
}

interface ErrorWithAttemptUsage extends Error {
  readonly attemptUsage?: AttemptUsage;
}

interface NodeUsageMetadata {
  readonly attemptUsage: readonly Record<string, unknown>[];
  readonly subagentUsage: readonly Record<string, unknown>[];
}

interface ErrorWithNodeUsage extends Error {
  readonly nodeUsage?: NodeUsageMetadata;
}

function numericStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readRetryMetadata(error: Error): Omit<RetryMeta, 'attempt'> {
  let current: unknown = error;
  let statusCode: number | undefined;
  let errorCode: string | undefined;
  const seen = new Set<unknown>();

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const candidate = current as ErrorWithRetryMetadata;
    statusCode ??= numericStatus(candidate.statusCode ?? candidate.status);
    errorCode ??= candidate.errorCode ?? candidate.code;
    current = candidate.cause;
  }

  return {
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

function errorChain(error: Error): readonly Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = (current as ErrorWithRetryMetadata).cause;
  }
  return chain;
}

function hasPermanentMarker(message: string): boolean {
  return /\b(?:auth(?:entication|orization)?|unauthori[sz]ed|forbidden|permission denied|invalid request|unprocessable)\b/.test(message);
}

function hasTransientTimeoutMarker(message: string): boolean {
  return /heartbeat(?: timeout)?|idle(?: stall| timeout)|no output for \d+(?:\.\d+)?s|session timed out|request timed out|connect(?:ion)? timeout|socket timeout|etimedout/.test(message);
}

export function isRetriableModelError(error: Error, meta: RetryMeta): boolean {
  if (error instanceof FlowAbortedError) return false;

  const statusCode = meta.statusCode;
  if (statusCode !== undefined) {
    if (statusCode < 400) return false;
    return !(statusCode === 400 || statusCode === 401 || statusCode === 403
      || statusCode === 404 || statusCode === 405 || statusCode === 410
      || statusCode === 413 || statusCode === 414 || statusCode === 415
      || statusCode === 422);
  }

  const code = meta.errorCode?.toUpperCase();
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true;

  const messages = errorChain(error)
    .map((entry) => `${entry.name} ${entry.message}`.toLowerCase());
  if (messages.some(hasPermanentMarker)) return false;
  if (messages.some(hasTransientTimeoutMarker)) return true;
  // Unknown model failures retry because attempt and deadline limits bound false positives.
  return true;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function nonNegativeFinite(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

export function retryDelayMs(policy: RetryPolicy, failedAttempt: number): number {
  const configuredBase = policy.backoffBaseMs;
  const base = configuredBase !== undefined
    && Number.isFinite(configuredBase)
    && configuredBase > 0
    ? configuredBase
    : DEFAULT_BACKOFF_BASE_MS;
  const configuredMax = policy.backoffMaxMs;
  const max = configuredMax !== undefined
    && Number.isFinite(configuredMax)
    && configuredMax > 0
    ? configuredMax
    : DEFAULT_BACKOFF_MAX_MS;
  const exponent = Math.min(52, Math.max(0, failedAttempt - 1));
  const exponential = Math.min(max, base * (2 ** exponent));
  const jittered = policy.jitter === false ? exponential : Math.random() * exponential;
  return Math.max(100, Number.isFinite(jittered) ? jittered : 100);
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new FlowAbortedError('Aborted before retry');
  if (delayMs <= 0) return;

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new FlowAbortedError('Aborted during retry backoff'));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sessionConfig(config: AgentConfig, input: NodeInput, ctx: ExecutionContext): SessionConfig {
  const sessionCwd = config.cwdResolver ? config.cwdResolver(input) : input.dir;
  const mcpServers = config.mcpServers ?? DEFAULT_MCP_SERVERS;
  return {
    model: config.model ?? DEFAULT_PRODUCER_MODEL,
    thinkingBudget: config.thinkingBudget ?? DEFAULT_THINKING_BUDGET,
    // ?? rather than a presence check: an explicit 'default' must survive, so a consumer
    // can opt out of long context and not merely into it.
    contextTier: config.contextTier ?? DEFAULT_CONTEXT_TIER,
    compactionMode: config.compactionMode,
    mode: config.mode ?? 'autopilot',
    advisor: config.advisor,
    panel: config.panel,
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    cwd: sessionCwd,
    addDirs: config.isolation ? [] : [input.dir],
    timeout: config.timeout ?? DEFAULT_AGENT_TIMEOUT_SECS,
    heartbeatTimeout: config.heartbeatTimeout ?? 900,
    systemMessage: config.systemMessage,
    availableTools: config.availableTools ?? (
      config.tools && config.tools.length > 0
        ? config.tools.map((tool) => tool.id)
        : undefined
    ),
    excludedTools: config.excludedTools,
    customAgents: config.customAgents,
    subagentRoster: config.subagentRoster,
    subagentsEnabled: config.subagentsEnabled,
    maxDepth: config.maxDepth,
    maxConcurrency: config.maxConcurrency,
    defaultAgent: config.defaultAgent,
    excludedBuiltinAgents: config.excludedBuiltinAgents,
    nodeId: ctx.nodeId,
    memberId: config.memberId,
    artifactFilename: config.output,
  };
}

interface SessionAttemptResult extends AttemptUsage {
  readonly outputLines: readonly string[];
}

function attemptUsage(
  usage: Record<string, unknown> | undefined,
  subagentUsage: readonly Record<string, unknown>[],
): AttemptUsage {
  return { usage, subagentUsage: [...subagentUsage] };
}

function withAttemptUsage(error: unknown, usage: AttemptUsage): ErrorWithAttemptUsage {
  const normalized = error instanceof Error ? error : new Error(String(error));
  Object.assign(normalized, { attemptUsage: usage });
  return normalized as ErrorWithAttemptUsage;
}

function withNodeUsage(
  error: Error,
  attemptUsage: readonly Record<string, unknown>[],
  subagentUsage: readonly Record<string, unknown>[],
): ErrorWithNodeUsage {
  if (attemptUsage.length === 0 && subagentUsage.length === 0) return error;
  Object.assign(error, {
    nodeUsage: {
      attemptUsage: [...attemptUsage],
      subagentUsage: [...subagentUsage],
    },
  });
  return error as ErrorWithNodeUsage;
}

async function runSessionAttempt(
  config: AgentConfig,
  input: NodeInput,
  ctx: ExecutionContext,
  prompt: string,
): Promise<SessionAttemptResult> {
  let session: AgentSession | null = null;
  const outputLines: string[] = [];
  let lastUsage: Record<string, unknown> | undefined;
  const subagentUsage: Record<string, unknown>[] = [];

  try {
    const creation = ctx.runtime.createSession(
      sessionConfig(config, input, ctx),
      { signal: ctx.signal },
    );
    const createdSession = await new Promise<AgentSession>((resolve, reject) => {
      const onAbort = () => reject(new FlowAbortedError('Aborted during session creation'));
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      creation.then(
        (created) => {
          ctx.signal.removeEventListener('abort', onAbort);
          if (ctx.signal.aborted) {
            void created.abort();
            reject(new FlowAbortedError('Aborted during session creation'));
            return;
          }
          resolve(created);
        },
        (error: unknown) => {
          ctx.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
    session = createdSession;

    session.on('text', (text: string, parentToolCallId?: string) => {
      outputLines.push(text);
      ctx.emitOutput({
        type: 'node:output', executionId: ctx.executionId, nodeId: ctx.nodeId,
        content: text, parentToolCallId, ts: Date.now(),
      });
    });
    session.on('reasoning', (text: string) => {
      ctx.emitOutput({
        type: 'node:reasoning', executionId: ctx.executionId, nodeId: ctx.nodeId,
        content: text, ts: Date.now(),
      });
    });
    session.on('tool_start', (tool: string, toolInput: string, args: Record<string, unknown>, callId?: string, parentToolCallId?: string) => {
      ctx.emitOutput({
        type: 'node:tool', executionId: ctx.executionId, nodeId: ctx.nodeId,
        tool, phase: 'start', summary: toolInput, args, toolCallId: callId,
        parentToolCallId, ts: Date.now(),
      });
    });
    session.on('tool_complete', (tool: string, output: string, callId?: string, parentToolCallId?: string) => {
      ctx.emitOutput({
        type: 'node:tool', executionId: ctx.executionId, nodeId: ctx.nodeId,
        tool, phase: 'complete', summary: output, toolCallId: callId,
        parentToolCallId, ts: Date.now(),
      });
    });
    session.on('tool_output', (tool: string, output: string, parentToolCallId?: string) => {
      outputLines.push(output);
      ctx.emitOutput({
        type: 'node:output', executionId: ctx.executionId, nodeId: ctx.nodeId,
        content: output, tool, parentToolCallId, ts: Date.now(),
      });
    });
    session.on('intent', (intent: string) => {
      ctx.emitOutput({
        type: 'node:intent', executionId: ctx.executionId, nodeId: ctx.nodeId,
        intent, ts: Date.now(),
      });
    });
    session.on('usage', (data: Record<string, unknown>) => {
      lastUsage = data;
      ctx.emitOutput({
        type: 'node:usage', executionId: ctx.executionId, nodeId: ctx.nodeId,
        inputTokens: typeof data.inputTokens === 'number' ? data.inputTokens : undefined,
        outputTokens: typeof data.outputTokens === 'number' ? data.outputTokens : undefined,
        totalTokens: typeof data.totalTokens === 'number' ? data.totalTokens : undefined,
        model: typeof data.model === 'string' ? data.model : undefined,
        ts: Date.now(),
      });
    });
    session.on('tool_complete_rich', (tool: string, contents: ReadonlyArray<Record<string, unknown>>, callId?: string) => {
      const toolData = contentBlocksToToolData(contents as ReadonlyArray<ContentBlock>);
      if (toolData) {
        ctx.emitOutput({
          type: 'node:tool', executionId: ctx.executionId, nodeId: ctx.nodeId,
          tool, phase: 'complete', summary: '', toolCallId: callId,
          toolSpecificData: toolData, ts: Date.now(),
        });
      }
    });
    session.on('subagent_start', (name: string, data: Record<string, unknown>) => {
      ctx.emitOutput({
        type: 'node:subagent', executionId: ctx.executionId, nodeId: ctx.nodeId,
        agentName: name, phase: 'start',
        toolCallId: typeof data.toolCallId === 'string' ? data.toolCallId : undefined,
        info: data, ts: Date.now(),
      });
    });
    session.on('subagent_end', (name: string, data: Record<string, unknown>) => {
      const totalTokens = typeof data.totalTokens === 'number' ? data.totalTokens : undefined;
      const model = typeof data.model === 'string' ? data.model : undefined;
      if (totalTokens !== undefined) {
        subagentUsage.push({ totalTokens, ...(model !== undefined ? { model } : {}) });
      }
      ctx.emitOutput({
        type: 'node:subagent', executionId: ctx.executionId, nodeId: ctx.nodeId,
        agentName: name, phase: 'end',
        toolCallId: typeof data.toolCallId === 'string' ? data.toolCallId : undefined,
        info: data,
        error: typeof data.error === 'string' ? data.error : undefined,
        ts: Date.now(),
      });
    });
    session.on('permission', (data: Record<string, unknown>) => {
      ctx.emitOutput({
        type: 'node:permission', executionId: ctx.executionId, nodeId: ctx.nodeId,
        kind: typeof data.kind === 'string' ? data.kind : undefined,
        detail: typeof data.detail === 'string' ? data.detail : undefined,
        approved: typeof data.approved === 'boolean' ? data.approved : undefined,
        ts: Date.now(),
      });
    });
    session.on('compaction', (phase: string, summary?: string) => {
      const message = phase === 'start'
        ? '\n--- Context compaction started ---\n'
        : `\n--- Context compaction complete${summary ? `: ${summary}` : ''} ---\n`;
      outputLines.push(message);
      ctx.emitOutput({
        type: 'node:output', executionId: ctx.executionId, nodeId: ctx.nodeId,
        content: message, ts: Date.now(),
      });
    });

    const activeSession = session;
    ctx.emitOutput({
      type: 'node:prompt', executionId: ctx.executionId, nodeId: ctx.nodeId,
      role: config.memberId ?? ctx.nodeDisplayName ?? 'agent',
      model: config.model ?? ctx.nodeModel ?? 'claude-opus-4.6',
      content: prompt, ts: Date.now(),
    });
    activeSession.send(prompt);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        activeSession.abort().then(
          () => reject(new FlowAbortedError('Aborted during session execution')),
          () => reject(new FlowAbortedError('Aborted during session execution')),
        );
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      activeSession.on('idle', () => {
        ctx.signal.removeEventListener('abort', onAbort);
        resolve();
      });
      activeSession.on('error', (error: Error) => {
        ctx.signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });

    return { outputLines, usage: lastUsage, subagentUsage };
  } catch (error) {
    if (!ctx.signal.aborted && config.output && wasCompletedBeforeCrash(
      input.dir, config.output, outputLines, config.completionIndicators,
    )) {
      return { outputLines, usage: lastUsage, subagentUsage };
    }
    throw withAttemptUsage(error, attemptUsage(lastUsage, subagentUsage));
  } finally {
    if (session) {
      try {
        await session.abort();
      } catch {
        // Session may already be closed.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Agent factory
// ---------------------------------------------------------------------------

/**
 * Creates a NodeFn that manages a full agent session lifecycle.
 *
 * The returned function:
 * 1. Calls config.setup(input) if provided (R5, R10)
 * 2. Builds the prompt via config.promptBuilder(input)
 * 3. Deletes any stale artifact before each session attempt
 * 4. Creates a session via ctx.runtime.createSession()
 * 5. Wires session events to ctx.emitOutput for streaming
 * 6. Sends the prompt and awaits completion (idle) or error
 * 7. On error: attempts GT-3 crash recovery
 * 8. On success: reads artifact, parses action
 * 9. Calls config.teardown(input) in finally block
 */
export function agent(config: AgentConfig): NodeFn {
  return async (input: NodeInput, ctx: ExecutionContext): Promise<NodeOutput> => {
    if (ctx.signal.aborted) {
      throw new FlowAbortedError('Aborted before agent start');
    }

    if (config.setup) await config.setup(input);

    try {
      const prompt = formatPrompt(config.promptBuilder(input));
      const policy = config.retry ?? {};
      const maxAttempts = positiveInteger(policy.maxAttempts, DEFAULT_MAX_ATTEMPTS);
      const budgetMs = policy.budgetMs === undefined
        ? config.retry === undefined
          ? undefined
          : (config.timeout ?? DEFAULT_AGENT_TIMEOUT_SECS) * 1000
        : nonNegativeFinite(policy.budgetMs, 0);
      const retryDeadlineMs = ctx.retryDeadlineMs
        ?? (budgetMs === undefined ? undefined : Date.now() + budgetMs);
      const sharedContext: ExecutionContext = retryDeadlineMs === undefined
        ? ctx
        : { ...ctx, retryDeadlineMs };
      let attempt = 1;
      let result: SessionAttemptResult | undefined;
      let lastFailure: Error | undefined;
      const failedUsage: Record<string, unknown>[] = [];
      const failedSubagentUsage: Record<string, unknown>[] = [];

      while (attempt <= maxAttempts) {
        if (ctx.signal.aborted) {
          throw withNodeUsage(
            new FlowAbortedError('Aborted before session attempt'),
            failedUsage,
            failedSubagentUsage,
          );
        }
        const remainingMs = retryDeadlineMs === undefined
          ? undefined
          : retryDeadlineMs - Date.now();
        if (remainingMs !== undefined && remainingMs <= 0) {
          throw withNodeUsage(
            lastFailure ?? new Error('Retry deadline exhausted'),
            failedUsage,
            failedSubagentUsage,
          );
        }

        const budgetController = new AbortController();
        const budgetTimer = remainingMs === undefined
          ? undefined
          : setTimeout(
            () => budgetController.abort(),
            Math.min(remainingMs, 2_147_483_647),
          );
        const attemptContext: ExecutionContext = remainingMs === undefined
          ? sharedContext
          : {
              ...sharedContext,
              signal: AbortSignal.any([ctx.signal, budgetController.signal]),
            };

        try {
          if (config.output) {
            // Per-attempt cleanup prevents a failed attempt's artifact surviving into a later one.
            const artifactPath = path.join(input.dir, config.output);
            try {
              fs.unlinkSync(artifactPath);
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
            }
          }
          result = await runSessionAttempt(config, input, attemptContext, prompt);
          break;
        } catch (error) {
          const currentError = error instanceof Error ? error : new Error(String(error));
          const consumed = (currentError as ErrorWithAttemptUsage).attemptUsage;
          if (consumed?.usage) failedUsage.push(consumed.usage);
          if (consumed) failedSubagentUsage.push(...consumed.subagentUsage);
          if (ctx.signal.aborted) {
            throw withNodeUsage(
              new FlowAbortedError('Aborted during session attempt'),
              failedUsage,
              failedSubagentUsage,
            );
          }
          if (budgetController.signal.aborted) {
            throw withNodeUsage(
              lastFailure ?? (
                currentError instanceof FlowAbortedError
                  ? new Error('Retry deadline exhausted')
                  : currentError
              ),
              failedUsage,
              failedSubagentUsage,
            );
          }
          if (currentError instanceof FlowAbortedError) {
            throw withNodeUsage(currentError, failedUsage, failedSubagentUsage);
          }
          lastFailure = currentError;

          const retryMetadata = readRetryMetadata(currentError);
          const meta: RetryMeta = { attempt, ...retryMetadata };
          const retriable = (policy.isRetriable ?? isRetriableModelError)(currentError, meta);
          if (!retriable || attempt >= maxAttempts) {
            throw withNodeUsage(currentError, failedUsage, failedSubagentUsage);
          }

          const delayMs = retryDelayMs(policy, attempt);
          if (retryDeadlineMs !== undefined && Date.now() + delayMs >= retryDeadlineMs) {
            throw withNodeUsage(currentError, failedUsage, failedSubagentUsage);
          }

          attempt += 1;
          try {
            await waitForRetry(delayMs, ctx.signal);
            if (ctx.emitState) {
              await ctx.emitState({
                type: 'node:retrying',
                executionId: ctx.executionId,
                nodeId: ctx.nodeId,
                attempt: ctx.nextRetryAttempt?.() ?? attempt,
                ts: Date.now(),
              });
            }
          } catch (retryError) {
            const normalizedRetryError = retryError instanceof Error
              ? retryError
              : new Error(String(retryError));
            throw withNodeUsage(
              normalizedRetryError,
              failedUsage,
              failedSubagentUsage,
            );
          }
        } finally {
          if (budgetTimer !== undefined) clearTimeout(budgetTimer);
        }
      }

      if (!result) throw new Error('Agent session exhausted without a result');

      let content: string | undefined;
      if (config.output) {
        try {
          content = fs.readFileSync(path.join(input.dir, config.output), 'utf-8');
        } catch {
          content = undefined;
        }
      }

      const action = config.actionParser && content
        ? config.actionParser(content)
        : 'default';
      const metadata: Record<string, unknown> = {};
      const usage = [...failedUsage, ...(result.usage ? [result.usage] : [])];
      const subagentUsage = [...failedSubagentUsage, ...result.subagentUsage];
      if (usage.length > 0) metadata.usage = usage.at(-1);
      if (usage.length > 1) metadata.attemptUsage = usage;
      if (subagentUsage.length > 0) metadata.subagentUsage = subagentUsage;

      return {
        action,
        artifact: content,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    } finally {
      if (config.teardown) {
        try {
          await config.teardown(input);
        } catch {
          // Teardown errors must not mask the primary result.
        }
      }
    }
  };
}
