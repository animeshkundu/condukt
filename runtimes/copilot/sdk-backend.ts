/**
 * SdkBackend — CopilotBackend implementation using @github/copilot-sdk.
 *
 * Drop-in replacement for SubprocessBackend. Uses the SDK's CopilotClient
 * (one CLI process per session via JSON-RPC over stdio) instead of spawning
 * the copilot CLI directly.
 *
 * Event mapping matches SubprocessBackend exactly: the 7 core events
 * (text, tool_start, tool_complete, tool_output, idle, error, reasoning)
 * plus optional rich events (intent, usage, tool_complete_rich,
 * subagent_start, subagent_end, permission).
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { CopilotBackend, CopilotSession, SessionConfig, UsageData, ContentBlock, PermissionInfo } from './copilot-backend';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SdkBackendOptions {
  /** Path to .copilot/mcp.json for MCP server configuration. */
  mcpConfigPath?: string;
  /** Extra directories to add to PATH (e.g. .tools/bin). */
  extraPathDirs?: readonly string[];
  /** Additional tool names to resolve and add to PATH (e.g. ['az', 'dotnet']). */
  pathTools?: readonly string[];
}

/** Shape of the dynamically imported @github/copilot-sdk module. */
interface CopilotSdkModule {
  CopilotClient: new (opts: {
    useStdio: boolean;
    autoRestart: boolean;
    env: Record<string, string | undefined>;
    logLevel: string;
  }) => SdkClient;
  approveAll: (req: unknown) => unknown;
}

interface SdkClient {
  createSession(config: Record<string, unknown>): Promise<SdkSessionHandle>;
  stop(): Promise<void>;
  forceStop(): Promise<void>;
}

interface SdkSessionHandle {
  send(msg: { prompt: string }): Promise<void>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  on(event: string, handler: (e: SdkEvent) => void): void;
  on(handler: (e: SdkEvent) => void): void;
}

interface SdkEvent {
  type?: string;
  data?: Record<string, unknown>;
}

interface SdkToolRequest {
  name?: string;
  toolCallId?: string;
}

interface SdkToolResult {
  content?: string;
  detailedContent?: string;
  contents?: ReadonlyArray<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// PATH hardening: shared logic with SubprocessBackend
// ---------------------------------------------------------------------------

/**
 * Generic tools every agent subprocess needs for basic operation.
 * Domain-specific tools (az, dotnet, etc.) are passed via pathTools option.
 */
const GENERIC_PATH_TOOLS = ['cmd', 'pwsh', 'powershell', 'git', 'node', 'npm'];

/** Known SDK event types handled by typed handlers or silently consumed. */
const KNOWN_EVENT_TYPES = new Set([
  'assistant.message', 'assistant.message_delta',
  'assistant.reasoning', 'assistant.reasoning_delta',
  'assistant.intent', 'assistant.usage',
  'tool.execution_start', 'tool.execution_complete',
  'tool.execution_partial_result',
  'session.idle', 'session.error',
  'subagent.started', 'subagent.completed', 'subagent.failed',
  'permission.requested', 'permission.completed',
  // Lifecycle events silently consumed (matching SubprocessBackend)
  'session.start', 'session.resume', 'session.shutdown', 'session.task_complete',
  'session.info', 'session.warning', 'session.title_changed',
  'session.context_changed', 'session.usage_info', 'session.model_change',
  'session.compaction_start', 'session.compaction_complete',
  'session.mode_changed', 'session.plan_changed',
  'session.truncation', 'session.snapshot_rewind',
  'session.workspace_file_changed', 'session.handoff',
  'user.message', 'pending_messages.modified', 'system.message',
  'assistant.turn_start', 'assistant.turn_end', 'assistant.streaming_delta',
  'abort', 'skill.invoked',
  'subagent.selected', 'subagent.deselected',
  'user_input.requested', 'user_input.completed',
  'elicitation.requested', 'elicitation.completed',
  'external_tool.requested', 'external_tool.completed',
  'command.queued', 'command.completed',
  'exit_plan_mode.requested', 'exit_plan_mode.completed',
  'tool.user_requested', 'tool.execution_progress',
]);

/** Cache for resolved tool directories. */
let _cachedToolDirs = new Map<string, string[]>();

/**
 * Dynamically resolve directories for tools that agents need on PATH.
 * Uses `where` (Windows) or `which` to find each tool, then extracts
 * the directory. Cached after first call.
 */
function resolveToolDirs(tools: readonly string[]): string[] {
  const key = tools.join(',');
  if (_cachedToolDirs.has(key)) return _cachedToolDirs.get(key)!;

  const locate = process.platform === 'win32' ? 'where' : 'which';
  const dirs = new Set<string>();

  for (const tool of tools) {
    try {
      const result = cp.spawnSync(locate, [tool], { stdio: 'pipe', encoding: 'utf-8', timeout: 3000 });
      if (result.status === 0 && result.stdout) {
        const toolPath = result.stdout.trim().split(/\r?\n/)[0];
        if (toolPath) dirs.add(path.dirname(toolPath));
      }
    } catch {
      // Tool not installed — skip
    }
  }

  const resolved = [...dirs];
  _cachedToolDirs.set(key, resolved);
  return resolved;
}

/**
 * Extract human-readable summary from tool arguments object.
 */
function extractArgSummary(args: Record<string, unknown>): string {
  for (const key of ['description', 'intent', 'summary', 'command', 'query',
                      'path', 'pattern', 'glob', 'url', 'file_text']) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) return val;
  }
  const firstStr = Object.values(args).find(v => typeof v === 'string' && (v as string).length > 0);
  if (typeof firstStr === 'string') return firstStr;
  return '';
}

/**
 * Parse .copilot/mcp.json format and convert to SDK-compatible MCPServerConfig.
 * Adds `tools: ["*"]` to each entry to enable all tools.
 */
function parseMcpConfig(configPath: string): Record<string, Record<string, unknown>> | null {
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const servers = (raw.mcpServers ?? raw.servers ?? raw) as Record<string, unknown>;
    if (!servers || typeof servers !== 'object') return null;

    const result: Record<string, Record<string, unknown>> = {};
    for (const [name, config] of Object.entries(servers)) {
      if (!config || typeof config !== 'object') continue;
      const entry = config as Record<string, unknown>;
      result[name] = {
        ...entry,
        type: entry.type === 'stdio' ? 'local' : (entry.type ?? 'local'),
        tools: ['*'],
      };
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    process.stderr.write(`[SdkBackend] Failed to parse MCP config at ${configPath}: ${err}\n`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event handler storage
// ---------------------------------------------------------------------------

interface SdkEventHandler {
  event: string;
  handler: (...args: never[]) => void;
}

// ---------------------------------------------------------------------------
// SdkBackend
// ---------------------------------------------------------------------------

/**
 * CopilotBackend implementation using @github/copilot-sdk.
 *
 * Drop-in replacement for SubprocessBackend. Uses the SDK's CopilotClient
 * (one CLI process per session via JSON-RPC over stdio) instead of spawning
 * the copilot CLI directly.
 */
export class SdkBackend implements CopilotBackend {
  readonly name = 'sdk';
  private readonly mcpConfigPath: string | undefined;
  private readonly extraPathDirs: readonly string[];
  private readonly pathTools: readonly string[];

  constructor(options: SdkBackendOptions = {}) {
    this.mcpConfigPath = options.mcpConfigPath;
    this.extraPathDirs = options.extraPathDirs ?? [];
    this.pathTools = options.pathTools ?? [];
  }

  async isAvailable(): Promise<boolean> {
    try {
      const sdkModuleName = '@github/copilot-sdk';
      await import(sdkModuleName);
      return true;
    } catch {
      return false;
    }
  }

  async createSession(config: SessionConfig): Promise<CopilotSession> {
    return new SdkSession(config, this.mcpConfigPath, this.extraPathDirs, this.pathTools);
  }
}

// ---------------------------------------------------------------------------
// SdkSession
// ---------------------------------------------------------------------------

/**
 * CopilotSession implementation backed by @github/copilot-sdk CopilotClient.
 *
 * Lifecycle:
 *   1. Constructor stores config (no I/O)
 *   2. send() imports the SDK, creates a CopilotClient, creates an SDK session,
 *      wires all event handlers, then sends the prompt
 *   3. session.idle -> emit('idle'), cleanup
 *   4. abort() -> emit('error') -> set aborted -> SDK abort -> client.stop()
 */
class SdkSession implements CopilotSession {
  private _client: SdkClient | null = null;
  private _sdkSession: SdkSessionHandle | null = null;
  private handlers: SdkEventHandler[] = [];
  private readonly config: SessionConfig;
  private readonly mcpConfigPath: string | undefined;
  private readonly extraPathDirs: readonly string[];
  private readonly pathTools: readonly string[];
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private aborted = false;

  /**
   * Maps toolCallId -> toolName for attributing tool_complete events.
   * Populated from assistant.message toolRequests and tool.execution_start.
   */
  private _toolCallNames = new Map<string, string>();

  /**
   * Buffers partial results that arrive before their tool.execution_start.
   */
  private _pendingPartials = new Map<string, string[]>();

  get pid(): number | null {
    // SDK manages the CLI process internally; no direct PID access
    return null;
  }

  constructor(
    config: SessionConfig,
    mcpConfigPath: string | undefined,
    extraPathDirs: readonly string[],
    pathTools: readonly string[],
  ) {
    this.config = config;
    this.mcpConfigPath = mcpConfigPath;
    this.extraPathDirs = extraPathDirs;
    this.pathTools = pathTools;
  }

  /**
   * Send a prompt to the agent. Creates the SDK client and session on first call.
   * Matches SubprocessBackend.send() contract: fire-and-forget, events stream via on().
   */
  send(prompt: string): void {
    this._run(prompt).catch((err: unknown) => {
      if (!this.aborted) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Internal async entrypoint that creates the client, session, wires events,
   * sends the prompt, and handles lifecycle.
   */
  private async _run(prompt: string): Promise<void> {
    // Dynamic import: @github/copilot-sdk is ESM-only.
    // Use string indirection to avoid TS2307 when the SDK is not installed
    // (it's an optional peer dependency).
    const sdkModuleName = '@github/copilot-sdk';
    const { CopilotClient, approveAll } = await (import(sdkModuleName) as Promise<CopilotSdkModule>);

    // ---------------------------------------------------------------
    // Build hardened environment (strip NODE_OPTIONS, extend PATH)
    // ---------------------------------------------------------------
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.NODE_OPTIONS;

    const pathSep = process.platform === 'win32' ? ';' : ':';
    const extraPaths = [...this.extraPathDirs];
    for (const dir of resolveToolDirs([...GENERIC_PATH_TOOLS, ...this.pathTools])) {
      if (!env.PATH?.includes(dir)) extraPaths.push(dir);
    }
    env.PATH = `${env.PATH ?? ''}${pathSep}${extraPaths.join(pathSep)}`;

    // ---------------------------------------------------------------
    // Parse MCP config
    // ---------------------------------------------------------------
    const mcpServers = this.mcpConfigPath
      ? parseMcpConfig(this.mcpConfigPath)
      : null;

    // ---------------------------------------------------------------
    // Create CopilotClient (process-per-session: new client each time)
    // autoRestart: false — if CLI dies, emit error immediately
    // ---------------------------------------------------------------
    const client = new CopilotClient({
      useStdio: true,
      autoRestart: false,
      env,
      logLevel: 'warning',
    });
    this._client = client;

    // ---------------------------------------------------------------
    // Create SDK session
    // ---------------------------------------------------------------
    const sessionConfig: Record<string, unknown> = {
      model: this.config.model,
      streaming: true,
      onPermissionRequest: approveAll,
      workingDirectory: this.config.cwd,
      reasoningEffort: this.config.thinkingBudget,
    };

    if (mcpServers) {
      sessionConfig.mcpServers = mcpServers;
    }

    const sdkSession = await client.createSession(sessionConfig);
    this._sdkSession = sdkSession;

    // ---------------------------------------------------------------
    // Set up hard timeout
    // ---------------------------------------------------------------
    this.timeoutTimer = setTimeout(() => {
      this.emitError(new Error(`Session timed out after ${this.config.timeout}s`));
      this.abort();
    }, this.config.timeout * 1000);

    // Set up heartbeat timeout
    this.resetHeartbeat();

    // ---------------------------------------------------------------
    // Wire SDK events -> CopilotSession events
    // ---------------------------------------------------------------
    this._wireEvents(sdkSession);

    // ---------------------------------------------------------------
    // Send the prompt (fire-and-forget; events stream via handlers)
    // ---------------------------------------------------------------
    await sdkSession.send({ prompt });
  }

  /**
   * Wire all SDK session events to CopilotSession event emissions.
   */
  private _wireEvents(sdkSession: SdkSessionHandle): void {
    // --- Assistant text response ---
    sdkSession.on('assistant.message', (e: SdkEvent) => {
      if (this.aborted) return;
      this.resetHeartbeat();

      const data = e.data;
      const content = typeof data?.content === 'string' ? data.content : '';
      if (content) this.emit('text', content);

      // Pre-seed _toolCallNames from tool requests so tool.execution_complete
      // can resolve names even if tool.execution_start lacks a toolCallId.
      const toolRequests = Array.isArray(data?.toolRequests) ? data.toolRequests as SdkToolRequest[] : [];
      for (const req of toolRequests) {
        const name = String(req.name ?? '');
        const callId = String(req.toolCallId ?? '');
        if (callId && name) this._toolCallNames.set(callId, name);
      }
    });

    // --- Assistant text delta (streaming) ---
    sdkSession.on('assistant.message_delta', (e: SdkEvent) => {
      if (this.aborted) return;
      this.resetHeartbeat();
      const delta = typeof e.data?.deltaContent === 'string' ? e.data.deltaContent : '';
      if (delta) this.emit('text', delta);
    });

    // --- Reasoning ---
    sdkSession.on('assistant.reasoning', (e: SdkEvent) => {
      if (this.aborted) return;
      this.resetHeartbeat();
      const content = typeof e.data?.content === 'string' ? e.data.content : '';
      if (content) this.emit('reasoning', content);
    });

    sdkSession.on('assistant.reasoning_delta', (e: SdkEvent) => {
      if (this.aborted) return;
      this.resetHeartbeat();
      const delta = typeof e.data?.deltaContent === 'string' ? e.data.deltaContent : '';
      if (delta) this.emit('reasoning', delta);
    });

    // --- Tool execution start ---
    sdkSession.on('tool.execution_start', (e: SdkEvent) => {
      if (this.aborted) return;
      this.resetHeartbeat();

      const data = e.data;
      const toolName = String(data?.toolName ?? '');
      const args = data?.arguments as Record<string, unknown> | undefined;
      const summary = args ? extractArgSummary(args) : '';

      const callId = String(data?.toolCallId ?? '');
      if (callId && toolName) {
        this._toolCallNames.set(callId, toolName);
        // Flush any partials that arrived before this start event
        const buffered = this._pendingPartials.get(callId);
        if (buffered) {
          for (const p of buffered) this.emit('tool_output', toolName, p);
          this._pendingPartials.delete(callId);
        }
      }

      if (toolName) this.emit('tool_start', toolName, summary, args ?? {}, callId);
    });

    // --- Tool execution complete ---
    sdkSession.on('tool.execution_complete', (e: SdkEvent) => {
      if (this.aborted) return;
      this.resetHeartbeat();

      const data = e.data;
      const callId = String(data?.toolCallId ?? '');
      let toolName = '';

      if (typeof data?.toolName === 'string' && data.toolName)
        toolName = data.toolName;
      if (!toolName && callId)
        toolName = this._toolCallNames.get(callId) ?? '';
      this._toolCallNames.delete(callId);

      const result = data?.result as SdkToolResult | undefined;
      const output = typeof result?.content === 'string'
        ? result.content
        : typeof result?.detailedContent === 'string'
          ? result.detailedContent : '';

      this.emit('tool_complete', toolName, output, callId);

      // Rich event: structured content blocks for consumers that want them
      if (result?.contents && Array.isArray(result.contents)) {
        this.emit('tool_complete_rich', toolName, result.contents, callId);
      }
    });

    // --- Tool execution partial result ---
    sdkSession.on('tool.execution_partial_result', (e: SdkEvent) => {
      if (this.aborted) return;
      this.resetHeartbeat();

      const data = e.data;
      const partial = typeof data?.partialOutput === 'string' ? data.partialOutput : '';
      if (!partial) return;

      const callId = String(data?.toolCallId ?? '');
      const toolName = (callId && this._toolCallNames.get(callId)) || '';

      if (toolName) {
        this.emit('tool_output', toolName, partial);
      } else if (callId) {
        const buf = this._pendingPartials.get(callId) ?? [];
        buf.push(partial);
        this._pendingPartials.set(callId, buf);
      } else {
        this.emit('text', partial);
      }
    });

    // --- Session idle (agent finished all work) ---
    sdkSession.on('session.idle', () => {
      if (this.aborted) return;
      this.clearTimers();
      this.emit('idle');
      this._cleanup();
    });

    // --- Session error ---
    sdkSession.on('session.error', (e: SdkEvent) => {
      if (this.aborted) return;
      this.clearTimers();
      const msg = typeof e.data?.message === 'string' ? e.data.message : 'Unknown session error';
      this.emitError(new Error(msg));
    });

    // --- Subagent lifecycle (mapped to tool events for SubprocessBackend parity) ---
    sdkSession.on('subagent.started', (e: SdkEvent) => {
      if (this.aborted) return;
      this.resetHeartbeat();
      const data = e.data;
      const name = String(data?.agentDisplayName ?? data?.agentName ?? 'agent');
      this.emit('tool_start', `subagent:${name}`, '', {});
      this.emit('subagent_start', name, data ?? {});
    });

    sdkSession.on('subagent.completed', (e: SdkEvent) => {
      if (this.aborted) return;
      this.resetHeartbeat();
      const data = e.data;
      const name = String(data?.agentDisplayName ?? data?.agentName ?? 'agent');
      this.emit('tool_complete', `subagent:${name}`, '');
      this.emit('subagent_end', name, data ?? {});
    });

    sdkSession.on('subagent.failed', (e: SdkEvent) => {
      if (this.aborted) return;
      this.resetHeartbeat();
      const data = e.data;
      const name = String(data?.agentDisplayName ?? data?.agentName ?? 'agent');
      const error = typeof data?.error === 'string' ? data.error : '';
      this.emit('tool_complete', `subagent:${name}`, error);
      this.emit('subagent_end', name, data ?? {});
    });

    // --- Rich events (optional; consumers can subscribe or ignore) ---

    sdkSession.on('assistant.intent', (e: SdkEvent) => {
      if (this.aborted) return;
      this.resetHeartbeat();
      const intent = typeof e.data?.intent === 'string' ? e.data.intent : '';
      if (intent) this.emit('intent', intent);
    });

    sdkSession.on('assistant.usage', (e: SdkEvent) => {
      if (this.aborted) return;
      this.resetHeartbeat();
      this.emit('usage', e.data ?? {});
    });

    sdkSession.on('permission.requested', (e: SdkEvent) => {
      if (this.aborted) return;
      this.resetHeartbeat();
      this.emit('permission', e.data ?? {});
    });

    // --- Catch-all for unhandled events ---
    sdkSession.on((e: SdkEvent) => {
      if (this.aborted) return;
      if (e && typeof e.type === 'string' && !KNOWN_EVENT_TYPES.has(e.type)) {
        process.stderr.write(`[SdkBackend] Unhandled event: ${e.type}\n`);
      }
    });
  }

  // ── CopilotSession event subscription ────────────────────────────────────
  // Overloads match CopilotSession interface exactly.

  on(event: 'text', handler: (text: string) => void): void;
  on(event: 'tool_start', handler: (tool: string, input: string, args: Record<string, unknown>, callId?: string) => void): void;
  on(event: 'tool_complete', handler: (tool: string, output: string, callId?: string) => void): void;
  on(event: 'tool_output', handler: (tool: string, output: string) => void): void;
  on(event: 'idle', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'reasoning', handler: (text: string) => void): void;
  on(event: 'intent', handler: (intent: string) => void): void;
  on(event: 'usage', handler: (data: UsageData) => void): void;
  on(event: 'tool_complete_rich', handler: (tool: string, contents: ReadonlyArray<ContentBlock>, callId?: string) => void): void;
  on(event: 'subagent_start', handler: (name: string, data: Record<string, unknown>) => void): void;
  on(event: 'subagent_end', handler: (name: string, data: Record<string, unknown>) => void): void;
  on(event: 'permission', handler: (data: PermissionInfo) => void): void;
  on(event: string, handler: (...args: never[]) => void): void {
    this.handlers.push({ event, handler });
  }

  /**
   * Abort the session.
   * Sequence matches SubprocessBackend exactly:
   *   1. emit error (resolves step-executor Promise)
   *   2. set aborted = true (close handler skips)
   *   3. SDK abort + client stop
   */
  async abort(): Promise<void> {
    if (this.aborted) return;
    this.clearTimers();
    this.emitError(new Error('Session aborted'));
    this.aborted = true;
    await this._cleanup();
  }

  /**
   * Clean up SDK resources (session disconnect + client stop).
   * Safe to call multiple times.
   */
  private async _cleanup(): Promise<void> {
    const sdkSession = this._sdkSession;
    const client = this._client;
    this._sdkSession = null;
    this._client = null;

    if (sdkSession) {
      try { await sdkSession.abort(); } catch { /* Session may already be disconnected */ }
      try { await sdkSession.disconnect(); } catch { /* Ignore */ }
    }

    if (client) {
      try {
        const stopPromise = client.stop();
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
        await Promise.race([stopPromise, timeout]);
      } catch { /* Graceful stop failed */ }
      try { await client.forceStop(); } catch { /* May already be dead */ }
    }
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers) {
      if (h.event === event) {
        (h.handler as (...a: unknown[]) => void)(...args);
      }
    }
  }

  private emitError(err: Error): void {
    this.emit('error', err);
  }

  private resetHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }
    this.heartbeatTimer = setTimeout(() => {
      this.emitError(new Error(`No output for ${this.config.heartbeatTimeout}s (heartbeat timeout)`));
      this.abort();
    }, this.config.heartbeatTimeout * 1000);
  }

  private clearTimers(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
