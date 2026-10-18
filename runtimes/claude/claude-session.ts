import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { AgentSession, SessionConfig, SessionCreationOptions, ToolUsageData, AgentSessionMetadata, AgentSessionUsage, AgentSessionHistory, SessionContextAttribution, SessionUsageMetrics, ContextAttributionEntry, SessionUsageModelMetric } from '../../src/types';
import { mapSdkMessage, createMapState } from './message-mapper';
import { mapConfig } from './config-mapper';
import { buildAdvisorStandInServer } from './one-shot';
import { buildBridgeEnv, createBridge } from './protocol-bridge';
import type { BridgeHandle, BridgeRuntimeConfig } from './protocol-bridge';

type Handler = (...args: any[]) => void;

export class ClaudeAgentSession implements AgentSession {
  readonly pid: number | null = null;
  private readonly config: SessionConfig;
  private readonly abortController: AbortController;
  private readonly bridgeOptions: BridgeRuntimeConfig | undefined;
  private bridgeHandle: BridgeHandle | null = null;
  private bridgeCreating: Promise<BridgeHandle> | null = null;
  private handlers: { event: string; handler: Handler }[] = [];
  private sessionId: string | null = null;
  private lastQuery: Query | null = null;
  private aborted = false;
  private lastUsage: Record<string, unknown> | null = null;
  private accumulatedInput = 0;
  private accumulatedOutput = 0;
  private accumulatedCacheRead = 0;
  private accumulatedCacheWrite = 0;
  private turnCount = 0;
  private sessionStartTime = Date.now();
  private turnHadAssistantUsage = false;
  private lastCallInputTokens = 0;
  private lastCallOutputTokens = 0;
  private readonly includePartialMessages = true;
  // Serialize turns: Claude SDK sessions are single-flight; concurrent turns would
  // interleave on the same abortController/sessionId.
  private turnChain: Promise<void> = Promise.resolve();

  constructor(config: SessionConfig, options?: SessionCreationOptions, bridgeOptions?: BridgeRuntimeConfig) {
    this.config = config;
    this.bridgeOptions = bridgeOptions;
    this.abortController = new AbortController();
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
        try { h.handler(...args); } catch { /* ignore */ }
      }
    }
  }

  private buildEmitter() {
    return {
      text: (t: string) => this.emit('text', t),
      reasoning: (t: string) => this.emit('reasoning', t),
      toolStart: (tool: string, input: string, args: Record<string, unknown>, callId?: string) =>
        this.emit('tool_start', tool, input, args, callId),
      toolComplete: (tool: string, output: string, callId?: string) =>
        this.emit('tool_complete', tool, output, callId),
      toolOutput: (tool: string, output: string) => this.emit('tool_output', tool, output),
      idle: () => this.emit('idle'),
      error: (err: Error) => this.emit('error', err),
      usage: (data: Record<string, unknown>) => {
        const source = String(data.source ?? '');
        const isResult = source === 'result';
        const accumulate = !isResult || !this.turnHadAssistantUsage;
        if (accumulate) {
          this.accumulatedInput += Number(data.input_tokens ?? data.inputTokens ?? 0);
          this.accumulatedOutput += Number(data.output_tokens ?? data.outputTokens ?? 0);
          this.accumulatedCacheRead += Number(data.cache_read_input_tokens ?? data.cacheReadTokens ?? 0);
          this.accumulatedCacheWrite += Number(data.cache_creation_input_tokens ?? data.cacheWriteTokens ?? 0);
        }
        if (!isResult) this.turnHadAssistantUsage = true;
        const inTok = data.input_tokens ?? data.inputTokens;
        if (inTok !== undefined) this.lastCallInputTokens = Number(inTok);
        const outTok = data.output_tokens ?? data.outputTokens;
        if (outTok !== undefined) this.lastCallOutputTokens = Number(outTok);
        this.lastUsage = data;
        this.emit('usage', data);
      },
      compaction: (phase: 'start' | 'complete', summary?: string) => {
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
      subagentStart: (name: string, data: Record<string, unknown>) => this.emit('subagent_start', name, data),
      subagentEnd: (name: string, data: Record<string, unknown>) => this.emit('subagent_end', name, data),
      permission: (data: Record<string, unknown>) => this.emit('permission', data),
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
    if (this.bridgeHandle) return this.bridgeHandle;
    if (!this.bridgeCreating) {
      // Session-level epoch config (SessionConfig.claude.epoch) wins over
      // the runtime-level bridge defaults.
      const epoch = this.config.claude?.epoch;
      this.bridgeCreating = createBridge({
        ...this.bridgeOptions,
        epochEnabled: epoch?.enabled ?? this.bridgeOptions.epochEnabled,
        epochRotateEnabled: epoch?.rotate ?? this.bridgeOptions.epochRotateEnabled,
        epochStateFile: epoch?.stateFile ?? this.bridgeOptions.epochStateFile,
        port: this.bridgeOptions.port ?? 0,
        sessionId: this.bridgeOptions.sessionId ?? `condukt-${randomUUID()}`,
      }).then((handle) => {
        this.bridgeHandle = handle;
        return handle;
      });
    }
    return this.bridgeCreating;
  }

  private async runTurn(prompt: string, resume = false): Promise<void> {
    if (this.aborted) throw new Error('Session is aborted');
    this.turnCount += 1;
    this.turnHadAssistantUsage = false;
    let bridge: BridgeHandle | null = null;
    if (this.bridgeOptions) {
      try {
        bridge = await this.ensureBridge();
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        this.emit('error', err);
        throw err;
      }
    }
    const bridgeEnv =
      bridge && this.bridgeOptions
        ? buildBridgeEnv(bridge, { bridgeSecret: this.bridgeOptions.bridgeSecret })
        : undefined;
    const mapped = mapConfig(this.config, bridgeEnv ? { env: bridgeEnv } : undefined);
    const mcpServer = buildAdvisorStandInServer({
      config: this.config,
      cwd: this.config.cwd,
      onToolUsage: (data) => this.emit('tool_usage', data),
    });
    const mcpServers = mcpServer
      ? { ...(mapped.options.mcpServers ?? {}), condukt: mcpServer }
      : mapped.options.mcpServers;
    const opts: Options = {
      ...mapped.options,
      mcpServers,
      abortController: this.abortController,
      includePartialMessages: this.includePartialMessages,
      ...(resume && this.sessionId ? { resume: this.sessionId } : {}),
    } as Options;

    const q = query({ prompt, options: opts });
    this.lastQuery = q;
    const emitter = this.buildEmitter();
    const mapState = createMapState();

    try {
      for await (const msg of q) {
        if (this.aborted) break;
        const m = msg as SDKMessage & { session_id?: string };
        if (m.session_id && !this.sessionId) this.sessionId = m.session_id;
        mapSdkMessage(m as SDKMessage, emitter, mapState, { includePartialMessages: this.includePartialMessages });
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (!this.aborted) {
        this.emit('error', err);
      }
      throw err;
    }
  }

  get metadata(): AgentSessionMetadata {
    const self = this;
    return {
      async getContextAttribution() {
        if (!self.lastQuery) return null;
        try {
          const r: any = await self.lastQuery.getContextUsage({ detail: 'summary' });
          const entries: ContextAttributionEntry[] = (r.categories ?? []).map((c: any) => ({
            kind: c.kind ?? 'used',
            id: c.name,
            label: c.name,
            tokens: c.tokens ?? 0,
          }));
          return { totalTokens: r.totalTokens ?? 0, entries, compactions: { count: 0 } };
        } catch {
          return null;
        }
      },
      async getContextHeaviestMessages(limit?: number) {
        return { totalTokens: self.accumulatedInput, messages: [] };
      },
      async recomputeContextTokens(modelId?: string) {
        return { totalTokens: self.accumulatedInput, messagesTokenCount: self.accumulatedInput, systemTokenCount: 0 };
      },
    };
  }

  get usage(): AgentSessionUsage {
    const self = this;
    return {
      async getMetrics() {
        const modelMetrics: Record<string, SessionUsageModelMetric> = {};
        modelMetrics['claude'] = {
          requests: { count: self.turnCount, cost: 0 },
          usage: {
            inputTokens: self.accumulatedInput,
            outputTokens: self.accumulatedOutput,
            cacheReadTokens: self.accumulatedCacheRead,
            cacheWriteTokens: self.accumulatedCacheWrite,
          },
          cacheExpiresAt: undefined,
        };
        return {
          totalPremiumRequestCost: 0,
          totalUserRequests: self.turnCount,
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
      async summarizeForHandoff() {
        if (!self.sessionId) {
          return `Session (no id): ${self.accumulatedInput} input / ${self.accumulatedOutput} output tokens.`;
        }
        try {
          const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
          const msgs = await getSessionMessages(self.sessionId, { dir: self.config.cwd });
          const transcript = msgs.map((m: any) => `${m.role ?? m.type}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')}`).join('\n').slice(0, 8000);
          const { runOneShot } = await import('./one-shot');
          const res = await runOneShot({ model: self.config.model, prompt: `Summarize this conversation for handoff:\n\n${transcript}`, cwd: self.config.cwd });
          return res.text || `Session ${self.sessionId}: ${self.accumulatedInput} input / ${self.accumulatedOutput} output tokens.`;
        } catch {
          return `Session ${self.sessionId}: ${self.accumulatedInput} input / ${self.accumulatedOutput} output tokens.`;
        }
      },
      async truncate(eventId: string) {
        throw new Error(`truncate is not supported on the Claude runtime (event '${eventId}')`);
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: any, handler: any): void {
    this.handlers.push({ event, handler });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    try { this.abortController.abort(); } catch { /* ignore */ }
    try { this.lastQuery?.close(); } catch { /* ignore */ }
    try {
      await this.bridgeCreating;
    } catch { /* bridge never started */ }
    try { await this.bridgeHandle?.close(); } catch { /* ignore */ }
    this.bridgeHandle = null;
  }
}
