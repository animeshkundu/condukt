import { forkSession, getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk';
import type {
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionMessagesOptions,
  Options,
  SDKMessage,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type {
  AgentSession,
  AgentSessionHistory,
  AgentSessionMetadata,
  AgentSessionUsage,
  ContextAttributionEntry,
  SessionConfig,
  SessionContextAttribution,
  SessionCreationOptions,
  SessionUsageMetrics,
  SessionUsageModelMetric,
  ToolUsageData,
} from '../../src/types';
import { SessionRecoveryExhaustedError } from '../../src/types';
import type { SessionRecoveryEvent } from '../../src/types';
import {
  effectiveSessionRecoveryPolicy,
  recoveryDelayMs,
} from '../../src/session-recovery-policy';
import type { EffectiveSessionRecoveryPolicy } from '../../src/session-recovery-policy';
import { createMapState, mapSdkMessage } from './message-mapper';
import type {
  ClaudeApiRetryInfo,
  ClaudeInitInfo,
  ClaudeResultOutcome,
  ClaudeSessionEmitter,
  MapOptions,
} from './message-mapper';
import { isSafeMode, mapConfig } from './config-mapper';
import {
  buildAdvisorStandInServer,
  CONDUKT_MCP_SERVER_NAME,
  INTERNAL_MCP_TOOL_NAMES,
  runOneShot,
} from './one-shot';
import { buildBridgeEnv, createBridge } from './protocol-bridge';
import type { BridgeHandle, BridgeRuntimeConfig } from './protocol-bridge';
import { ModelUsageLedger } from './usage-ledger';
import type { TokenCounts } from './usage-ledger';
import {
  ClaudeConfigurationError,
  ClaudeResumeAttemptError,
  ClaudeStreamEndedError,
  CONTINUATION_PROMPT,
  classifyClaudeFailure,
  failureFromOutcome,
  outcomeIsFailure,
  toResumeAttemptError,
} from './session-recovery';
import type {
  ClaudeFailureClassification,
  ClaudeRecoveryStage,
} from './session-recovery';

/**
 * Stored handlers. Each event has its own payload type (see the `on`
 * overloads below); `emit` is the only place that supplies runtime arguments,
 * so the erased shape is what the handler list can hold without an `any`.
 */
type Handler = (...args: never[]) => void;

/**
 * The slice of the SDK `Query` the session uses. Narrower than `Query` so
 * tests can supply a fake async iterable without reimplementing the control
 * protocol; the real handle satisfies it structurally.
 */
export interface ClaudeQueryHandle extends AsyncIterable<SDKMessage> {
  close?: () => void;
  getContextUsage?: (opts?: { readonly detail?: 'summary' | 'full' }) => Promise<{
    readonly totalTokens?: number;
    readonly categories?: ReadonlyArray<{
      readonly kind?: string;
      readonly id?: string;
      readonly name?: string;
      readonly tokens?: number;
    }>;
  }>;
}

/**
 * SDK boundaries the session calls. Overridable for tests (`@internal`); the
 * defaults are the SDK's own functions.
 */
export interface ClaudeSessionDeps {
  readonly queryFn?: (params: { readonly prompt: string; readonly options: Options }) => ClaudeQueryHandle;
  readonly getSessionMessagesFn?: (
    sessionId: string,
    options?: GetSessionMessagesOptions,
  ) => Promise<ReadonlyArray<Pick<SessionMessage, 'uuid' | 'type' | 'message'>>>;
  readonly forkSessionFn?: (
    sessionId: string,
    options?: ForkSessionOptions,
  ) => Promise<ForkSessionResult>;
  readonly sleepFn?: (ms: number) => Promise<void>;
}

interface AttemptResult {
  readonly outcome?: ClaudeResultOutcome;
  readonly error?: Error;
}

interface AttemptContext {
  readonly resume: boolean;
  readonly recovery: boolean;
  readonly expectedSessionId?: string;
  readonly requestedMode?: string;
  /** Built-in allow-list to compare against `init.tools` (read-only only). */
  readonly requestedTools?: readonly string[];
}

interface ActiveRecovery {
  readonly policy: EffectiveSessionRecoveryPolicy;
  readonly continuation: number;
  readonly startedAt: number;
}

const MCP_TOOL_PREFIX = 'mcp__';

export class ClaudeAgentSession implements AgentSession {
  readonly pid: number | null = null;
  private readonly config: SessionConfig;
  private readonly abortController: AbortController;
  private readonly bridgeOptions: BridgeRuntimeConfig | undefined;
  private bridgeHandle: BridgeHandle | null = null;
  private bridgeCreating: Promise<BridgeHandle> | null = null;
  private handlers: { event: string; handler: Handler }[] = [];
  private sessionId: string | null = null;
  private lastQuery: ClaudeQueryHandle | null = null;
  private aborted = false;
  private turnCount = 0;
  private sessionStartTime = Date.now();
  private lastCallContextTokens = 0;
  private lastCallInputTokens = 0;
  private lastCallOutputTokens = 0;
  private compactionCount = 0;
  private lastAssistantError: string | undefined;
  private lastApiRetry: ClaudeApiRetryInfo | undefined;
  private activeRecovery: ActiveRecovery | undefined;
  private readonly diagnostics = new Set<string>();
  private readonly includePartialMessages = true;
  private readonly queryFn: NonNullable<ClaudeSessionDeps['queryFn']>;
  private readonly getSessionMessagesFn: NonNullable<ClaudeSessionDeps['getSessionMessagesFn']>;
  private readonly forkSessionFn: NonNullable<ClaudeSessionDeps['forkSessionFn']>;
  private readonly sleepFn: (ms: number) => Promise<void>;
  /**
   * Usage is cumulative per session. A truncate forks the transcript, so the
   * running totals restart from the fork point and the old baseline would
   * suppress real usage until it caught up; the ledger is replaced instead.
   */
  private usageLedger: ModelUsageLedger;
  // Serialize turns: Claude SDK sessions are single-flight; concurrent turns would
  // interleave on the same abortController/sessionId.
  private turnChain: Promise<void> = Promise.resolve();

  constructor(
    config: SessionConfig,
    options?: SessionCreationOptions,
    bridgeOptions?: BridgeRuntimeConfig,
    deps?: ClaudeSessionDeps,
  ) {
    this.config = config;
    this.bridgeOptions = bridgeOptions;
    this.abortController = new AbortController();
    this.queryFn = deps?.queryFn ?? ((params) => query(params));
    this.getSessionMessagesFn = deps?.getSessionMessagesFn
      ?? ((sessionId, opts) => getSessionMessages(sessionId, opts));
    this.forkSessionFn = deps?.forkSessionFn
      ?? ((sessionId, opts) => forkSession(sessionId, opts));
    this.sleepFn = deps?.sleepFn ?? ((ms) => this.sleep(ms));
    this.usageLedger = new ModelUsageLedger({ fallbackModel: config.model });
    // Link to an externally provided abort signal (e.g. flow cancellation).
    if (options?.signal) {
      const sig = options.signal as AbortSignal;
      if (sig.aborted) {
        this.aborted = true;
        try { this.abortController.abort(); } catch { /* ignore */ }
      } else {
        sig.addEventListener('abort', () => {
          this.aborted = true;
          try { this.abortController.abort(); } catch { /* ignore */ }
        }, { once: true });
      }
    }
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers) {
      if (h.event === event) {
        // The erased rest type is never[]; this event's payload was checked by
        // the `on` overload at registration time.
        try { (h.handler as (...a: unknown[]) => void)(...args); } catch { /* ignore */ }
      }
    }
  }

  private diagnostic(message: string): void {
    if (this.diagnostics.has(message)) return;
    this.diagnostics.add(message);
    try {
      process.stderr.write(`[ClaudeAgentSession] ${message}\n`);
    } catch {
      /* closed stream */
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.aborted || this.abortController.signal.aborted) {
        resolve();
        return;
      }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.abortController.signal.removeEventListener('abort', finish);
        resolve();
      };
      timer = setTimeout(finish, ms);
      this.abortController.signal.addEventListener('abort', finish, { once: true });
    });
  }

  private buildEmitter(): ClaudeSessionEmitter {
    return {
      text: (text, parentToolCallId) => this.emit('text', text, parentToolCallId),
      reasoning: (text) => this.emit('reasoning', text),
      toolStart: (tool, input, args, callId, parentToolCallId) =>
        this.emit('tool_start', tool, input, args, callId, parentToolCallId),
      toolComplete: (tool, output, callId, parentToolCallId) =>
        this.emit('tool_complete', tool, output, callId, parentToolCallId),
      toolCompleteRich: (tool, contents, callId) =>
        this.emit('tool_complete_rich', tool, contents, callId),
      toolOutput: (tool, output, parentToolCallId) =>
        this.emit('tool_output', tool, output, parentToolCallId),
      idle: () => this.emit('idle'),
      error: (err) => this.emit('error', err),
      usage: (data) => {
        const outputTokens = data.outputTokens;
        if (typeof outputTokens === 'number') this.lastCallOutputTokens = outputTokens;
        this.emit('usage', data);
      },
      compaction: (phase, summary) => {
        // Exact compaction advances the bridge's session era so the
        // first post-compaction request already carries the fresh
        // identity (cache namespace + routing affinity).
        if (phase === 'complete') {
          try {
            this.bridgeHandle?.notifyCompaction();
          } catch {
            /* epoch identity must never fail a turn */
          }
        }
        this.emit('compaction', phase, summary);
      },
      subagentStart: (name, data) => this.emit('subagent_start', name, data),
      subagentEnd: (name, data) => this.emit('subagent_end', name, data),
      permission: (data) => this.emit('permission', data),
      toolUsage: (data: ToolUsageData) => this.emit('tool_usage', data),
    };
  }

  send(prompt: string): void {
    const run = async () => {
      // runTurn already emits 'error' on failure; do not re-emit here.
      try {
        await this.runTurn(prompt);
      } catch {
        /* already emitted by runTurn */
      }
    };
    // Fire-and-forget but serialized against other turns.
    this.turnChain = this.turnChain.then(run, run);
    void this.turnChain.catch(() => { /* already emitted */ });
  }

  async continueSession(prompt: string): Promise<void> {
    const run = () => this.runTurn(prompt, true);
    const next = this.turnChain.then(run, run);
    this.turnChain = next.catch(() => { /* keep chain alive */ });
    await next;
  }

  /**
   * Start (once) the in-process protocol bridge for this session.
   *
   * The bridge exposes an Anthropic-compatible surface and translates to
   * the configured upstream protocol (Anthropic pass-through / OpenAI
   * chat / OpenAI Responses). Returns null when no bridge is configured
   * (the CLI then talks to its default Anthropic endpoint).
   */
  async ensureBridge(): Promise<BridgeHandle | null> {
    if (!this.bridgeOptions) return null;
    if (this.aborted) return null;
    if (this.bridgeHandle) return this.bridgeHandle;
    if (!this.bridgeCreating) {
      // Session-level epoch config (SessionConfig.claude.epoch) wins over
      // the runtime-level bridge defaults.
      const epoch = this.config.claude?.epoch;
      const creating = createBridge({
        ...this.bridgeOptions,
        epochEnabled: epoch?.enabled ?? this.bridgeOptions.epochEnabled,
        epochRotateEnabled: epoch?.rotate ?? this.bridgeOptions.epochRotateEnabled,
        epochStateFile: epoch?.stateFile ?? this.bridgeOptions.epochStateFile,
        port: this.bridgeOptions.port ?? 0,
        sessionId: this.bridgeOptions.sessionId ?? `condukt-${randomUUID()}`,
      }).then(
        (handle) => {
          this.bridgeHandle = handle;
          return handle;
        },
        (error: unknown) => {
          // Do not cache a failed start: a later turn may recover (transient
          // port contention) and would otherwise be stuck on this rejection.
          if (this.bridgeCreating === creating) this.bridgeCreating = null;
          throw error;
        },
      );
      this.bridgeCreating = creating;
    }
    return this.bridgeCreating;
  }

  /**
   * Environment that points the Claude CLI at the bridge. Every query the
   * session issues — turns, recovery resumes, handoff summaries, and the
   * advisor/stand-in one-shots — must carry it, or the CLI falls back to
   * `api.anthropic.com` where no credential exists under the bridge.
   */
  private async bridgeEnv(): Promise<Record<string, string> | undefined> {
    if (!this.bridgeOptions) return undefined;
    const bridge = await this.ensureBridge();
    if (!bridge) return undefined;
    return buildBridgeEnv(bridge, { bridgeSecret: this.bridgeOptions.bridgeSecret });
  }

  private async runTurn(prompt: string, resume = false): Promise<void> {
    if (this.aborted) throw new Error('Session is aborted');
    this.turnCount += 1;

    let bridgeEnv: Record<string, string> | undefined;
    let mapped: ReturnType<typeof mapConfig>;
    try {
      bridgeEnv = await this.bridgeEnv();
      mapped = mapConfig(this.config, {
        ...(bridgeEnv !== undefined ? { env: bridgeEnv } : {}),
        onDiagnostic: (message) => this.diagnostic(message),
      });
    } catch (error) {
      const err = normalizeError(error);
      this.emit('error', err);
      throw err;
    }

    const mcpServer = buildAdvisorStandInServer({
      config: this.config,
      cwd: this.config.cwd,
      ...(bridgeEnv !== undefined ? { env: bridgeEnv } : {}),
      signal: this.abortController.signal,
      onToolUsage: (data) => this.emit('tool_usage', data),
    });
    const mcpServers = mcpServer
      ? { ...(mapped.options.mcpServers ?? {}), [CONDUKT_MCP_SERVER_NAME]: mcpServer }
      : mapped.options.mcpServers;
    // Under `dontAsk` a tool absent from `allowedTools` is denied. The
    // advisor/stand-in server is registered after `mapConfig`, so it is not
    // covered by the mapper's allow-list and must be added here.
    let allowedTools = mapped.options.allowedTools;
    if (mcpServer !== null && mapped.permissionMode === 'dontAsk') {
      const merged = new Set(allowedTools ?? []);
      for (const name of INTERNAL_MCP_TOOL_NAMES) merged.add(name);
      allowedTools = [...merged];
    }
    const baseOptions: Options = {
      ...mapped.options,
      mcpServers,
      allowedTools,
      abortController: this.abortController,
      includePartialMessages: this.includePartialMessages,
    } as Options;

    const requestedMode = mapped.permissionMode;
    const readOnly = this.config.permissionPolicy === 'read-only' || isSafeMode();
    const requestedTools = readOnly && Array.isArray(mapped.options.tools)
      ? mapped.options.tools
      : undefined;

    const initial = await this.attemptTurn(prompt, baseOptions, {
      resume,
      recovery: false,
      requestedMode,
      requestedTools,
    });
    if (this.aborted) return;
    if (initial.outcome !== undefined && !outcomeIsFailure(initial.outcome)) {
      this.emit('idle');
      return;
    }

    let failure: Error;
    if (initial.error !== undefined) {
      failure = initial.error;
    } else if (initial.outcome !== undefined) {
      failure = failureFromOutcome(initial.outcome);
    } else {
      return;
    }
    let lastClassification = this.classifyFailure(initial);
    const sessionId = this.sessionId;
    const policy = effectiveSessionRecoveryPolicy(this.config.sessionRecovery);

    if (policy === undefined || !lastClassification.recoverable || sessionId === null) {
      this.emit('error', failure);
      throw failure;
    }

    const recoveryStartedAt = Date.now();
    const deadlineMs = recoveryStartedAt + policy.budgetMs;
    let lastFailure = failure;
    let lastStage: ClaudeRecoveryStage = 'continuation';
    let continuation = 0;

    // The SDK retries transient API failures natively before it ever reports
    // one. Give that retry its grace window before resuming ourselves so the
    // two mechanisms do not race.
    if (this.lastApiRetry !== undefined) {
      this.emitRecovery('native-retry', policy, 0, sessionId, recoveryStartedAt, {
        ...(this.lastApiRetry.status !== null ? { statusCode: this.lastApiRetry.status } : {}),
        errorCode: this.lastApiRetry.error,
        reason: `native retry ${this.lastApiRetry.attempt}/${this.lastApiRetry.maxRetries} did not recover`,
      });
      if (policy.nativeRetryGraceMs > 0) {
        try {
          await this.waitWithinDeadline(deadlineMs, policy.nativeRetryGraceMs);
        } catch {
          this.exhaustRecovery(
            policy, sessionId, continuation, lastFailure, recoveryStartedAt,
            'recovery budget exhausted', 'continuation', lastClassification,
          );
        }
        if (this.aborted) return;
      }
    }

    for (;;) {
      if (continuation >= policy.maxContinuations) {
        this.exhaustRecovery(
          policy, sessionId, continuation, lastFailure, recoveryStartedAt,
          'continuation limit exhausted', lastStage, lastClassification,
        );
      }
      const delayMs = recoveryDelayMs(policy, continuation);
      this.emitRecovery('scheduled', policy, continuation + 1, sessionId, recoveryStartedAt, {
        delayMs,
        ...recoveryMetadata(lastClassification),
      });
      try {
        await this.waitWithinDeadline(deadlineMs, delayMs);
      } catch {
        this.exhaustRecovery(
          policy, sessionId, continuation, lastFailure, recoveryStartedAt,
          'recovery budget exhausted', lastStage, lastClassification,
        );
      }
      if (this.aborted) return;
      continuation += 1;

      // Audit before resuming: a missing transcript or session id cannot be
      // fixed by sending the continuation, but a fresh audit may succeed on a
      // later attempt, so it is retried within the same bounds.
      try {
        await this.auditRecoveryHistory(sessionId);
      } catch (error) {
        const auditError = normalizeError(error);
        lastFailure = auditError;
        lastStage = 'audit';
        lastClassification = {
          recoverable: true,
          reason: auditError.message,
          failureKind: 'audit',
        };
        if (continuation >= policy.maxContinuations || Date.now() >= deadlineMs) {
          this.exhaustRecovery(
            policy, sessionId, continuation, lastFailure, recoveryStartedAt,
            `audit: ${auditError.message}`, 'audit', lastClassification,
          );
        }
        continue;
      }

      this.emitRecovery('resuming', policy, continuation, sessionId, recoveryStartedAt, {
        ...recoveryMetadata(lastClassification),
      });
      this.activeRecovery = { policy, continuation, startedAt: recoveryStartedAt };
      let attempt: AttemptResult;
      try {
        attempt = await this.attemptTurn(CONTINUATION_PROMPT, baseOptions, {
          resume: true,
          recovery: true,
          expectedSessionId: sessionId,
          requestedMode,
          requestedTools,
        });
      } finally {
        this.activeRecovery = undefined;
      }
      if (this.aborted) return;

      if (attempt.outcome !== undefined && !outcomeIsFailure(attempt.outcome)) {
        this.emitRecovery('recovered', policy, continuation, sessionId, recoveryStartedAt);
        this.emit('idle');
        return;
      }

      const resumedFailure = attempt.error ?? (attempt.outcome !== undefined
        ? failureFromOutcome(attempt.outcome)
        : undefined);
      if (resumedFailure === undefined) {
        // Aborted between attempts; abort() is the terminal signal.
        return;
      }
      lastFailure = resumedFailure;
      lastClassification = this.classifyFailure(attempt);

      if (attempt.error instanceof ClaudeResumeAttemptError) {
        lastStage = attempt.error.stage;
        if (attempt.error.fatal) {
          this.exhaustRecovery(
            policy, sessionId, continuation, lastFailure, recoveryStartedAt,
            `${lastStage}: ${attempt.error.message}`, lastStage, lastClassification,
          );
        }
      }
      if (!lastClassification.recoverable) {
        this.emit('error', resumedFailure);
        throw resumedFailure;
      }
      // A resume that ran and failed again reconnects and nudges again; the
      // continuation count and the recovery budget are what bound the loop.
    }
  }

  /**
   * One query attempt. Returns the terminal outcome, or the error that ended
   * the stream, instead of throwing so the recovery loop can classify it.
   */
  private async attemptTurn(
    prompt: string,
    baseOptions: Options,
    context: AttemptContext,
  ): Promise<AttemptResult> {
    if (this.aborted) return {};
    this.lastAssistantError = undefined;
    this.lastApiRetry = undefined;

    const options: Options = context.resume && this.sessionId !== null
      ? { ...baseOptions, resume: this.sessionId }
      : baseOptions;
    let handle: ClaudeQueryHandle;
    try {
      handle = this.queryFn({ prompt, options });
    } catch (error) {
      const err = normalizeError(error);
      return { error: context.recovery ? toResumeAttemptError(err, 'resume') : err };
    }
    this.lastQuery = handle;

    const emitter = this.buildEmitter();
    const state = createMapState();
    const expectedSessionId = context.expectedSessionId
      ?? (context.resume ? this.sessionId ?? undefined : undefined);
    let outcome: ClaudeResultOutcome | undefined;
    let sawSessionId = false;
    let continuationSent = false;

    const sendContinuationEvent = () => {
      if (!context.recovery || continuationSent) return;
      continuationSent = true;
      const recovery = this.activeRecovery;
      if (recovery === undefined) return;
      this.emitRecovery(
        'continuation-sent',
        recovery.policy,
        recovery.continuation,
        expectedSessionId ?? this.sessionId ?? '',
        recovery.startedAt,
      );
    };

    const mapOptions: MapOptions = {
      includePartialMessages: this.includePartialMessages,
      ledger: this.usageLedger,
      resumed: context.resume && this.sessionId !== null,
      fallbackModel: this.config.model,
      onInit: (info) => {
        this.verifyRequiredMode(info, context);
      },
      onResult: (result) => { outcome = result; },
      onAssistantError: (error) => { this.lastAssistantError = error; },
      onApiRetry: (info) => { this.lastApiRetry = info; },
      onAssistantUsage: (contextTokens, outputTokens) => {
        this.lastCallContextTokens = contextTokens;
        this.lastCallInputTokens = contextTokens;
        if (outputTokens > 0) this.lastCallOutputTokens = outputTokens;
      },
      onCompaction: () => { this.compactionCount += 1; },
      onCompactionFailed: (error) => {
        if (error !== undefined) this.diagnostic(`Compaction failed: ${error}`);
      },
      isAborted: () => this.aborted,
    };

    try {
      for await (const msg of handle) {
        if (this.aborted) break;
        const frame = msg as SDKMessage & { session_id?: unknown };
        const frameSessionId = typeof frame.session_id === 'string' && frame.session_id.length > 0
          ? frame.session_id
          : undefined;
        if (frameSessionId !== undefined && !sawSessionId) {
          sawSessionId = true;
          if (expectedSessionId !== undefined && frameSessionId !== expectedSessionId) {
            throw context.recovery
              ? new ClaudeResumeAttemptError(
                'resume',
                `Claude resumed unexpected session '${frameSessionId}' instead of '${expectedSessionId}'`,
                true,
              )
              : new Error(
                `Claude returned session '${frameSessionId}' for a turn that resumed '${expectedSessionId}'`,
              );
          }
          sendContinuationEvent();
        }
        if (frameSessionId !== undefined && this.sessionId === null) {
          this.sessionId = frameSessionId;
        }
        mapSdkMessage(msg as SDKMessage, emitter, state, mapOptions);
      }
    } catch (error) {
      if (this.aborted) return {};
      const err = normalizeError(error);
      if (err instanceof ClaudeConfigurationError || err instanceof ClaudeResumeAttemptError) {
        return { error: err };
      }
      return {
        error: context.recovery
          ? toResumeAttemptError(err, sawSessionId ? 'continuation' : 'resume')
          : err,
      };
    }

    if (this.aborted) return {};
    if (outcome === undefined) {
      return {
        error: context.recovery
          ? new ClaudeResumeAttemptError('continuation', new ClaudeStreamEndedError().message, false)
          : new ClaudeStreamEndedError(),
      };
    }
    // A resumed turn whose frames carried no session id still completed;
    // report the dispatch before the terminal decision.
    if (!continuationSent) sendContinuationEvent();
    return { outcome };
  }

  private classifyFailure(attempt: AttemptResult): ClaudeFailureClassification {
    return classifyClaudeFailure({
      ...(attempt.outcome !== undefined ? { outcome: attempt.outcome } : {}),
      ...(this.lastAssistantError !== undefined
        ? { assistantError: this.lastAssistantError }
        : {}),
      ...(attempt.error !== undefined ? { error: attempt.error } : {}),
      aborted: this.aborted,
    });
  }

  /**
   * `requireMode` is a contract, not a hint: read the mode and the built-in
   * tool set back from `init` before the first prompt and fail the turn when
   * the CLI applied something else.
   */
  private verifyRequiredMode(info: ClaudeInitInfo, context: AttemptContext): void {
    if (this.config.requireMode !== true) return;
    if (context.requestedMode !== undefined && info.permissionMode !== context.requestedMode) {
      throw new ClaudeConfigurationError(
        `Claude reported permission mode '${info.permissionMode}', but '${context.requestedMode}' was required`,
      );
    }
    if (context.requestedTools !== undefined) {
      const allowed = new Set(context.requestedTools);
      const unexpected = info.tools
        .filter((tool) => !tool.startsWith(MCP_TOOL_PREFIX))
        .filter((tool) => !allowed.has(tool));
      if (unexpected.length > 0) {
        throw new ClaudeConfigurationError(
          `Claude enabled tools the required policy forbids: ${unexpected.join(', ')}`,
        );
      }
    }
  }

  /**
   * A resumed session must still have a transcript to resume from. Pending
   * `tool_use` blocks without results are fine: the CLI re-runs interrupted
   * turns on resume (`resume_reason` frames).
   */
  private async auditRecoveryHistory(sessionId: string): Promise<void> {
    const messages = await this.getSessionMessagesFn(sessionId, { dir: this.config.cwd });
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error(`No transcript found for session '${sessionId}'`);
    }
  }

  private async waitWithinDeadline(deadlineMs: number, delayMs: number): Promise<void> {
    if (Date.now() + delayMs >= deadlineMs) {
      throw new Error('Session recovery deadline exhausted');
    }
    await this.sleepFn(delayMs);
  }

  private emitRecovery(
    phase: SessionRecoveryEvent['phase'],
    policy: EffectiveSessionRecoveryPolicy,
    continuation: number,
    sessionId: string,
    startedAt: number | undefined,
    fields: Partial<SessionRecoveryEvent> = {},
  ): void {
    this.emit('recovery', {
      phase,
      continuation,
      maxContinuations: policy.maxContinuations,
      sessionId,
      ...(startedAt !== undefined ? { elapsedMs: Date.now() - startedAt } : {}),
      ...fields,
    });
  }

  /**
   * Ends recovery. `stage` names the reconnect step whose failure ended it;
   * the reason alone does not say which step produced it.
   */
  private exhaustRecovery(
    policy: EffectiveSessionRecoveryPolicy,
    sessionId: string,
    continuation: number,
    cause: Error,
    startedAt: number,
    reason: string,
    stage: ClaudeRecoveryStage,
    classification: ClaudeFailureClassification,
  ): never {
    this.activeRecovery = undefined;
    this.emitRecovery('exhausted', policy, continuation, sessionId, startedAt, {
      reason,
      stage,
      ...recoveryMetadata(classification),
    });
    const error = new SessionRecoveryExhaustedError(
      `Session recovery exhausted after ${continuation} continuation(s): ${reason}`,
      { cause },
    );
    this.emit('error', error);
    throw error;
  }

  get metadata(): AgentSessionMetadata {
    const self = this;
    return {
      async getContextAttribution(): Promise<SessionContextAttribution | null> {
        const compactions = { count: self.compactionCount };
        if (self.lastQuery?.getContextUsage) {
          try {
            const usage = await self.lastQuery.getContextUsage({ detail: 'summary' });
            const entries: ContextAttributionEntry[] = (usage.categories ?? []).map((category) => ({
              kind: category.kind ?? 'used',
              id: category.id ?? category.name ?? 'context',
              label: category.name ?? category.id ?? 'Context',
              tokens: nonNegative(category.tokens),
            }));
            if (entries.length > 0) {
              return { totalTokens: nonNegative(usage.totalTokens), entries, compactions };
            }
          } catch {
            // Control requests are only supported in streaming input mode;
            // this session uses string prompts, so failure is expected.
          }
        }
        if (self.lastCallContextTokens <= 0) return null;
        // Prompt size of the latest assistant frame: an estimate of the
        // current context window, not cumulative input across turns.
        return {
          totalTokens: self.lastCallContextTokens,
          entries: [{
            kind: 'used',
            id: 'context',
            label: 'Context',
            tokens: self.lastCallContextTokens,
          }],
          compactions,
        };
      },
      async getContextHeaviestMessages(): Promise<{ totalTokens: number; messages: [] }> {
        // The SDK exposes no per-message tokenization.
        return { totalTokens: self.lastCallContextTokens, messages: [] };
      },
      async recomputeContextTokens(): Promise<{
        totalTokens: number;
        messagesTokenCount: number;
        systemTokenCount: number;
      }> {
        return {
          totalTokens: self.lastCallContextTokens,
          messagesTokenCount: self.lastCallContextTokens,
          systemTokenCount: 0,
        };
      },
    };
  }

  get usage(): AgentSessionUsage {
    const self = this;
    return {
      async getMetrics(): Promise<SessionUsageMetrics> {
        const modelMetrics: Record<string, SessionUsageModelMetric> = {};
        const snapshot: ReadonlyMap<string, TokenCounts> = self.usageLedger.getSnapshot();
        const requestCounts = self.usageLedger.getRequestCounts();
        for (const [model, counts] of snapshot) {
          modelMetrics[model] = {
            // Per model: a turn that billed another model was not a request
            // this model served.
            requests: { count: requestCounts.get(model) ?? 0, cost: 0 },
            usage: {
              inputTokens: counts.inputTokens,
              outputTokens: counts.outputTokens,
              cacheReadTokens: counts.cacheReadTokens,
              cacheWriteTokens: counts.cacheWriteTokens,
            },
          };
        }
        if (Object.keys(modelMetrics).length === 0) {
          // No billed result yet: keep a zero-valued bucket for the
          // configured model so consumers never see an empty map. With no
          // usage the model split is unknown, so the session turn count is
          // the only defensible number.
          modelMetrics[self.config.model] = {
            requests: { count: self.turnCount, cost: 0 },
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        }
        return {
          totalPremiumRequestCost: 0,
          totalUserRequests: self.turnCount,
          // The SDK reports per-turn wall-clock duration, never API time;
          // modelUsage carries no USD cost.
          totalApiDurationMs: 0,
          sessionStartTime: new Date(self.sessionStartTime).toISOString(),
          codeChanges: { linesAdded: 0, linesRemoved: 0, filesModifiedCount: 0, filesModified: [] },
          modelMetrics,
          currentModel: self.config.model,
          lastCallInputTokens: self.lastCallInputTokens,
          lastCallOutputTokens: self.lastCallOutputTokens,
        };
      },
    };
  }

  get history(): AgentSessionHistory {
    const self = this;
    return {
      async summarizeForHandoff(): Promise<string> {
        const fallback = self.sessionId
          ? `Session ${self.sessionId}: ${self.lastCallInputTokens} input / ${self.lastCallOutputTokens} output tokens.`
          : 'Session (no id): no usage recorded.';
        if (!self.sessionId) return fallback;
        try {
          const messages = await self.getSessionMessagesFn(self.sessionId, { dir: self.config.cwd });
          const transcript = transcriptText(messages).slice(0, 8000);
          if (transcript.trim().length === 0) return fallback;
          const bridgeEnv = await self.bridgeEnv();
          const result = await runOneShot({
            model: self.config.model,
            prompt: 'Summarize this conversation for handoff. Capture the objective, what was '
              + `completed, what remains, and any constraints that must survive a restart.\n\n${transcript}`,
            cwd: self.config.cwd,
            ...(bridgeEnv !== undefined ? { env: bridgeEnv } : {}),
            signal: self.abortController.signal,
          });
          return result.text || fallback;
        } catch {
          return fallback;
        }
      },
      async truncate(eventId: string): Promise<number> {
        // Serialized with turns: forking mid-turn would race the transcript.
        const run = () => self.truncateNow(eventId);
        const next = self.turnChain.then(run, run);
        self.turnChain = next.then(() => undefined, () => undefined);
        return next;
      },
    };
  }

  private async truncateNow(eventId: string): Promise<number> {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      throw new Error('Cannot truncate a Claude session that has not produced a session id');
    }
    if (this.aborted) throw new Error('Session is aborted');
    const messages = await this.getSessionMessagesFn(sessionId, { dir: this.config.cwd });
    const index = messages.findIndex((message) => message.uuid === eventId);
    if (index < 0) {
      throw new Error(`Unknown history event '${eventId}'`);
    }
    if (index === 0) {
      // `upToMessageId` is inclusive, so there is no way to fork to an empty
      // transcript. Keep the session and report that nothing was removed.
      this.diagnostic(`truncate('${eventId}') targets the first message; session unchanged`);
      return 0;
    }
    const upToMessageId = messages[index - 1]?.uuid;
    const forked = await this.forkSessionFn(sessionId, {
      dir: this.config.cwd,
      ...(upToMessageId !== undefined ? { upToMessageId } : {}),
    });
    this.sessionId = forked.sessionId;
    this.lastQuery = null;
    // The fork restarts the cumulative usage total from its transcript; a
    // fresh ledger seeds its baseline on the next resumed result instead of
    // re-billing (or suppressing) the retained turns.
    this.usageLedger = new ModelUsageLedger({ fallbackModel: this.config.model });
    return messages.length - index;
  }

  on(event: 'text', handler: (text: string, parentToolCallId?: string) => void): void;
  on(event: 'reasoning', handler: (text: string) => void): void;
  on(event: 'tool_start', handler: (
    tool: string,
    input: string,
    args: Record<string, unknown>,
    callId?: string,
    parentToolCallId?: string,
  ) => void): void;
  on(event: 'tool_complete', handler: (
    tool: string,
    output: string,
    callId?: string,
    parentToolCallId?: string,
  ) => void): void;
  on(event: 'tool_complete_rich', handler: (
    tool: string,
    contents: ReadonlyArray<Record<string, unknown>>,
    callId?: string,
  ) => void): void;
  on(event: 'tool_output', handler: (tool: string, output: string, parentToolCallId?: string) => void): void;
  on(event: 'idle', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'usage', handler: (data: Record<string, unknown>) => void): void;
  on(event: 'tool_usage', handler: (data: ToolUsageData) => void): void;
  on(event: 'compaction', handler: (phase: 'start' | 'complete', summary?: string) => void): void;
  on(event: 'subagent_start', handler: (name: string, data: Record<string, unknown>) => void): void;
  on(event: 'subagent_end', handler: (name: string, data: Record<string, unknown>) => void): void;
  on(event: 'permission', handler: (data: Record<string, unknown>) => void): void;
  on(event: 'recovery', handler: (event: SessionRecoveryEvent) => void): void;
  on(event: 'intent', handler: (intent: string) => void): void;
  /**
   * Dynamic wiring for callers that forward an event name from configuration
   * or a test table. Payloads are not checked on this arm; prefer the literal
   * overloads.
   */
  on(event: string, handler: Handler): void;
  on(event: string, handler: Handler): void {
    this.handlers.push({ event, handler });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.activeRecovery = undefined;
    try { this.abortController.abort(); } catch { /* ignore */ }
    try { this.lastQuery?.close?.(); } catch { /* ignore */ }
    try {
      await this.bridgeCreating;
    } catch { /* bridge never started */ }
    try { await this.bridgeHandle?.close(); } catch { /* ignore */ }
    // Both references go: a session that has been aborted must not answer a
    // later ensureBridge() with a closed handle.
    this.bridgeCreating = null;
    this.bridgeHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function recoveryMetadata(
  classification: ClaudeFailureClassification,
): Partial<SessionRecoveryEvent> {
  return {
    ...(classification.statusCode !== undefined ? { statusCode: classification.statusCode } : {}),
    ...(classification.errorCode !== undefined ? { errorCode: classification.errorCode } : {}),
    ...(classification.failureKind !== undefined ? { failureKind: classification.failureKind } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Extracts readable text from `SessionMessage.message` content blocks. */
function transcriptText(
  messages: ReadonlyArray<Pick<SessionMessage, 'uuid' | 'type' | 'message'>>,
): string {
  const lines: string[] = [];
  for (const entry of messages) {
    const message = asRecord(entry.message);
    const role = typeof message?.role === 'string' ? message.role : entry.type;
    const content = message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((block) => {
          const record = asRecord(block);
          return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
        })
        .filter((part) => part.length > 0)
        .join('\n');
    }
    if (text.trim().length > 0) lines.push(`${role}: ${text}`);
  }
  return lines.join('\n');
}
