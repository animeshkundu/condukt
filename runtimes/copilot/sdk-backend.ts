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
import type {
  CopilotClient as CopilotSdkClient,
  CopilotSession as CopilotSdkSession,
  CustomAgentConfig as CopilotSdkCustomAgentConfig,
  MCPServerConfig as CopilotMcpServerConfig,
  ModelCapabilitiesOverride as CopilotSdkModelCapabilitiesOverride,
  ModelInfo as CopilotSdkModelInfo,
  SessionConfig as CopilotSdkSessionConfig,
  approveAll as approveAllPermissions,
  RuntimeConnection as CopilotRuntimeConnection,
} from '@github/copilot-sdk';
import type { Logger } from '../../src/types';
import { NO_OP_LOGGER } from '../../src/types';
import type {
  CopilotBackend,
  CopilotSession,
  SessionConfig,
  SessionCreationOptions,
  UsageData,
  ContentBlock,
  PermissionInfo,
} from './copilot-backend';
import { classifySdkEvent } from './lifecycle-events';
import { DEFAULT_SUBAGENT_ROSTER, mergeSubagentRosters } from './subagents';
import type { SubagentRoster } from './subagents';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SdkBackendOptions {
  /** .copilot/mcp.json servers merged beneath session servers unless MCP is disabled. */
  readonly mcpConfigPath?: string;
  /** Extra directories to add to PATH (e.g. .tools/bin). */
  readonly extraPathDirs?: readonly string[];
  /** Additional tool names to resolve and add to PATH (e.g. ['az', 'dotnet']). */
  readonly pathTools?: readonly string[];
  /** Existing Copilot home/config directory passed through to the SDK untouched. */
  readonly configDir?: string;
  /** Opt-in per-agent overrides merged over the stable default roster; omit or pass false for no roster. */
  readonly subagentRoster?: SubagentRoster | false;
  /** Receives non-fatal backend diagnostics. */
  readonly logger?: Logger;
}

/** Shape of the dynamically imported @github/copilot-sdk module. */
interface CopilotSdkModule {
  readonly CopilotClient: typeof CopilotSdkClient;
  readonly RuntimeConnection: typeof CopilotRuntimeConnection;
  readonly approveAll: typeof approveAllPermissions;
}

type SdkClient = CopilotSdkClient;
type SdkSessionHandle = CopilotSdkSession;

type ModelLimitSource = 'max_prompt_tokens' | 'max_context_window_tokens';

interface ModelCapabilityResolution {
  readonly modelCapabilities?: CopilotSdkModelCapabilitiesOverride;
}

interface SdkEvent {
  readonly type?: string;
  readonly agentId?: string;
  readonly data?: Record<string, unknown>;
}

function normalizeSdkEvent(event: unknown): SdkEvent {
  if (typeof event !== 'object' || event === null) return {};
  const candidate = event as {
    readonly type?: unknown;
    readonly agentId?: unknown;
    readonly data?: unknown;
  };
  return {
    ...(typeof candidate.type === 'string' ? { type: candidate.type } : {}),
    ...(typeof candidate.agentId === 'string' ? { agentId: candidate.agentId } : {}),
    ...(typeof candidate.data === 'object' && candidate.data !== null
      ? { data: candidate.data as Record<string, unknown> }
      : {}),
  };
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

const NAMED_SDK_EVENTS = new Set([
  'assistant.message', 'assistant.message_delta',
  'assistant.reasoning', 'assistant.reasoning_delta',
  'assistant.intent', 'assistant.usage',
  'tool.execution_start', 'tool.execution_complete',
  'tool.execution_partial_result',
  'session.idle', 'session.task_complete', 'session.error',
  'model.call_failure', 'abort',
  'session.compaction_start', 'session.compaction_complete',
  'subagent.started', 'subagent.completed', 'subagent.failed',
  'permission.requested',
]);

// ---------------------------------------------------------------------------
// PATH hardening: shared logic with SubprocessBackend
// ---------------------------------------------------------------------------

/**
 * Generic tools every agent subprocess needs for basic operation.
 * Domain-specific tools (az, dotnet, etc.) are passed via pathTools option.
 */
const GENERIC_PATH_TOOLS = ['cmd', 'pwsh', 'powershell', 'git', 'node', 'npm'];


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
function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')
    ? Object.fromEntries(entries)
    : undefined;
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseMcpServer(
  value: unknown,
  forceAllTools = false,
): CopilotMcpServerConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const configuredTools = stringArray(entry.tools);
  const tools = forceAllTools ? ['*'] : configuredTools;
  const timeout = nonNegativeFiniteNumber(entry.timeout);

  if (entry.type === 'http' || entry.type === 'sse') {
    if (typeof entry.url !== 'string') return undefined;
    const headers = stringRecord(entry.headers);
    return {
      type: entry.type,
      url: entry.url,
      ...(headers !== undefined ? { headers } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  if (typeof entry.command !== 'string') return undefined;
  const args = stringArray(entry.args);
  const env = stringRecord(entry.env);
  return {
    type: entry.type === 'stdio' ? 'stdio' : 'local',
    command: entry.command,
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(typeof entry.workingDirectory === 'string'
      ? { workingDirectory: entry.workingDirectory }
      : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

function parseMcpConfig(configPath: string): Record<string, CopilotMcpServerConfig> | null {
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const root = raw as Record<string, unknown>;
    const servers = root.mcpServers ?? root.servers ?? root;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null;

    const result: Record<string, CopilotMcpServerConfig> = {};
    for (const [name, config] of Object.entries(servers)) {
      const parsed = parseMcpServer(config, true);
      if (parsed) result[name] = parsed;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    process.stderr.write(`[SdkBackend] Failed to parse MCP config at ${configPath}: ${err}\n`);
    return null;
  }
}

const ENV_REFERENCE = /^\$\{([A-Z_][A-Z0-9_]*(?:\|[A-Z_][A-Z0-9_]*)*)\}$/;

/**
 * Resolves ${NAME} and ${NAME|FALLBACK|...}, taking the first variable that is set.
 *
 * The fallback chain exists because there is no single conventional name for a GitHub
 * token: the Copilot CLI itself reads COPILOT_GITHUB_TOKEN, then GH_TOKEN, then
 * GITHUB_TOKEN. A default that insisted on one spelling would silently ship an
 * unauthenticated server in any environment that chose a different one.
 */
function resolveMcpEnvironmentValue(value: string): string | undefined {
  const match = ENV_REFERENCE.exec(value);
  if (!match) return value;
  for (const name of match[1]!.split('|')) {
    const resolved = process.env[name];
    if (resolved !== undefined && resolved !== '') return resolved;
  }
  return undefined;
}

function resolveMcpEnvironmentRecord(
  values: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (values === undefined) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const environmentValue = resolveMcpEnvironmentValue(value);
    if (environmentValue !== undefined) resolved[key] = environmentValue;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

// Embedded references, so `Bearer ${A|B}` resolves rather than only a bare `${A|B}`. The
// fallback alternatives must be part of the pattern: a reference matcher without them finds
// nothing in `${A|B}`, leaves the value untouched, and emits the placeholder as a literal
// header — an unauthenticated server that reports no error and simply returns no tools.
const HEADER_ENV_REFERENCE = /\$\{([A-Z_][A-Z0-9_]*(?:\|[A-Z_][A-Z0-9_]*)*)\}/g;

function resolveMcpHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const references = [...value.matchAll(HEADER_ENV_REFERENCE)];
    let resolvedValue = value;
    let complete = true;
    for (const reference of references) {
      const names = reference[1]!.split('|');
      const environmentValue = names
        .map((name) => process.env[name])
        .find((candidate) => candidate !== undefined && candidate !== '');
      if (environmentValue === undefined) {
        // Dropping the header is deliberate — a missing credential must not abort a run — but
        // it is invisible at the server, which just answers with nothing.
        try {
          process.stderr.write(`[SdkBackend] MCP header ${key} dropped: none of ${names.join(', ')} is set\n`);
        } catch { /* diagnostics must not break configuration */ }
        complete = false;
        break;
      }
      resolvedValue = resolvedValue.replace(reference[0], environmentValue);
    }
    if (complete) resolved[key] = resolvedValue;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function toSdkMcpServers(
  servers: false,
): false;
function toSdkMcpServers(
  servers: Readonly<Record<string, import('./copilot-backend').MCPServerConfig>> | undefined,
): Record<string, CopilotMcpServerConfig> | undefined;
function toSdkMcpServers(
  servers: Readonly<Record<string, import('./copilot-backend').MCPServerConfig>> | false | undefined,
): Record<string, CopilotMcpServerConfig> | false | undefined;
function toSdkMcpServers(
  servers: Readonly<Record<string, import('./copilot-backend').MCPServerConfig>> | false | undefined,
): Record<string, CopilotMcpServerConfig> | false | undefined {
  if (servers === undefined || servers === false) return servers;
  const converted: Record<string, CopilotMcpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    const parsed = parseMcpServer(server);
    if (!parsed) continue;
    if ('url' in parsed) {
      const headers = resolveMcpHeaders(parsed.headers);
      converted[name] = {
        ...parsed,
        ...(headers !== undefined ? { headers } : { headers: undefined }),
      };
    } else {
      const env = resolveMcpEnvironmentRecord(parsed.env);
      converted[name] = {
        ...parsed,
        ...(env !== undefined ? { env } : { env: undefined }),
      };
    }
  }
  return converted;
}

function toSdkCustomAgent(
  agent: import('./copilot-backend').CustomAgentConfig,
): CopilotSdkCustomAgentConfig {
  return {
    name: agent.name,
    prompt: agent.prompt,
    ...(agent.displayName !== undefined ? { displayName: agent.displayName } : {}),
    ...(agent.description !== undefined ? { description: agent.description } : {}),
    ...(agent.tools !== undefined
      ? { tools: agent.tools === null ? null : [...agent.tools] }
      : {}),
    ...(agent.mcpServers !== undefined
      ? { mcpServers: toSdkMcpServers(agent.mcpServers) }
      : {}),
    ...(agent.infer !== undefined ? { infer: agent.infer } : {}),
    ...(agent.skills !== undefined ? { skills: [...agent.skills] } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
  };
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
  private readonly configDirectory: string | undefined;
  private readonly subagentRoster: SubagentRoster | false | undefined;
  private readonly extraPathDirs: readonly string[];
  private readonly pathTools: readonly string[];
  private readonly logger: Logger;
  private modelListPromise: Promise<readonly CopilotSdkModelInfo[] | undefined> | undefined;
  private readonly modelCapabilityResolutions = new Map<
    string,
    Promise<ModelCapabilityResolution>
  >();

  constructor(options: SdkBackendOptions = {}) {
    this.mcpConfigPath = options.mcpConfigPath;
    this.configDirectory = options.configDir;
    this.subagentRoster = options.subagentRoster;
    this.extraPathDirs = options.extraPathDirs ?? [];
    this.pathTools = options.pathTools ?? [];
    this.logger = options.logger ?? NO_OP_LOGGER;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const sdkModuleName = '@github/copilot-sdk';
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>;
      await dynamicImport(sdkModuleName);
      return true;
    } catch {
      return false;
    }
  }

  private resolveModelCapabilities(
    client: SdkClient,
    model: string,
  ): Promise<ModelCapabilityResolution> {
    const cached = this.modelCapabilityResolutions.get(model);
    if (cached) return cached;

    const resolution = this.resolveModelCapabilitiesUncached(client, model).catch((err: unknown) => {
      this.logger.warn('Copilot model capability resolution failed; using proportional compaction thresholds only', {
        model,
        reason: 'capability_resolution_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    });
    this.modelCapabilityResolutions.set(model, resolution);
    return resolution;
  }

  private async resolveModelCapabilitiesUncached(
    client: SdkClient,
    model: string,
  ): Promise<ModelCapabilityResolution> {
    const models = await this.listModels(client);
    if (!models) return {};

    const selected = models.find(candidate => candidate.id === model);
    if (!selected) {
      this.logger.warn('Copilot model capability lookup failed; using proportional compaction thresholds only', {
        model,
        reason: 'model_not_found',
      });
      return {};
    }

    const limits = selected.capabilities?.limits;
    const promptLimit = limits?.max_prompt_tokens;
    const contextWindowLimit = limits?.max_context_window_tokens;
    const source: ModelLimitSource | undefined = isPositiveFiniteNumber(promptLimit)
      ? 'max_prompt_tokens'
      : promptLimit === undefined && isPositiveFiniteNumber(contextWindowLimit)
        ? 'max_context_window_tokens'
        : undefined;
    const discoveredLimit = source === 'max_prompt_tokens'
      ? promptLimit
      : source === 'max_context_window_tokens'
        ? contextWindowLimit
        : undefined;

    if (source === undefined || discoveredLimit === undefined) {
      this.logger.warn('Copilot model capability lookup returned no usable token limit; using proportional compaction thresholds only', {
        model,
        reason: 'invalid_limit',
        maxPromptTokens: promptLimit,
        maxContextWindowTokens: contextWindowLimit,
      });
      return {};
    }

    const promptTokenCeiling = Math.floor(discoveredLimit * 0.80);
    if (!isPositiveFiniteNumber(promptTokenCeiling)) {
      this.logger.warn('Copilot model capability lookup produced no usable prompt-token ceiling; using proportional compaction thresholds only', {
        model,
        reason: 'invalid_computed_ceiling',
        discoveredLimit,
        limitSource: source,
      });
      return {};
    }

    this.logger.info('Resolved Copilot model prompt-token ceiling', {
      model,
      discoveredLimit,
      limitSource: source,
      promptTokenCeiling,
    });
    return {
      modelCapabilities: {
        limits: {
          max_prompt_tokens: promptTokenCeiling,
        },
      },
    };
  }

  private listModels(client: SdkClient): Promise<readonly CopilotSdkModelInfo[] | undefined> {
    if (this.modelListPromise) return this.modelListPromise;

    this.modelListPromise = (async () => {
      try {
        await client.start();
        return await client.listModels();
      } catch (err) {
        this.logger.warn('Copilot model capability discovery failed; using proportional compaction thresholds only', {
          reason: 'list_models_failed',
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    })();
    return this.modelListPromise;
  }

  async createSession(
    config: SessionConfig,
    options?: SessionCreationOptions,
  ): Promise<CopilotSession> {
    if (options?.signal?.aborted) {
      throw new Error('Session creation aborted');
    }
    return new SdkSession(
      config,
      this.mcpConfigPath,
      this.configDirectory,
      this.subagentRoster,
      this.extraPathDirs,
      this.pathTools,
      this.logger,
      (client, model) => this.resolveModelCapabilities(client, model),
    );
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
  private readonly configDirectory: string | undefined;
  private readonly backendRoster: SubagentRoster | false | undefined;
  private readonly extraPathDirs: readonly string[];
  private readonly pathTools: readonly string[];
  private readonly logger: Logger;
  private readonly resolveModelCapabilities: (
    client: SdkClient,
    model: string,
  ) => Promise<ModelCapabilityResolution>;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private compactionTimer: ReturnType<typeof setTimeout> | null = null;
  private abortGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private compactionInProgress = false;
  private turnSettled = false;
  private compactionRecoveryInProgress = false;
  private aborted = false;
  private _turnText = new Map<string, string>();
  private intentionalAborts = new WeakSet<SdkSessionHandle>();

  /**
   * Maps toolCallId -> toolName for attributing tool_complete events.
   * Populated from assistant.message toolRequests and tool.execution_start.
   */
  private _toolCallNames = new Map<string, string>();

  /**
   * Maps toolCallId -> parentToolCallId for attributing child events to
   * their parent sub-agent. Populated from tool.execution_start events
   * that carry a parentToolCallId. Used to look up the parent for
   * tool.execution_partial_result (which lacks parentToolCallId).
   */
  private _callIdToParent = new Map<string, string>();

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
    configDirectory: string | undefined,
    backendRoster: SubagentRoster | false | undefined,
    extraPathDirs: readonly string[],
    pathTools: readonly string[],
    logger: Logger,
    resolveModelCapabilities: (
      client: SdkClient,
      model: string,
    ) => Promise<ModelCapabilityResolution>,
  ) {
    this.config = config;
    this.mcpConfigPath = mcpConfigPath;
    this.configDirectory = configDirectory;
    this.backendRoster = backendRoster;
    this.extraPathDirs = extraPathDirs;
    this.pathTools = pathTools;
    this.logger = logger;
    this.resolveModelCapabilities = resolveModelCapabilities;
  }

  /**
   * Send a prompt to the agent. Creates the SDK client and session on first call.
   * Matches SubprocessBackend.send() contract: fire-and-forget, events stream via on().
   */
  send(prompt: string): void {
    if (this.aborted) {
      this.emitError(new Error('Session is aborted'));
      return;
    }
    // Detach the preceding SDK handle synchronously before resetting shared turn
    // state. Any late events from it then fail the per-handler isActive() guard.
    this.clearTimers();
    void this._cleanup();
    this._turnText.clear();
    this._toolCallNames.clear();
    this._callIdToParent.clear();
    this._pendingPartials.clear();
    this.turnSettled = false;
    this._run(prompt).catch((err: unknown) => {
      this.fail(err instanceof Error ? err : new Error(String(err)), 'session.run');
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
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<CopilotSdkModule>;
    const { CopilotClient, RuntimeConnection, approveAll } = await dynamicImport(sdkModuleName);

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
    const configuredMcpServers = toSdkMcpServers(this.config.mcpServers);
    const fileMcpServers = this.mcpConfigPath
      ? parseMcpConfig(this.mcpConfigPath)
      : null;
    // Backend-level file servers remain available when authoring-layer defaults
    // are present. A session entry with the same name is the more specific value;
    // false is the explicit kill switch for both layers.
    const mcpServers = configuredMcpServers === false
      ? undefined
      : configuredMcpServers !== undefined || fileMcpServers !== null
        ? { ...(fileMcpServers ?? {}), ...(configuredMcpServers ?? {}) }
        : undefined;

    // ---------------------------------------------------------------
    // Create CopilotClient (process-per-session: new client each time)
    // ---------------------------------------------------------------
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio(),
      env,
      logLevel: 'warning',
    });
    this._client = client;

    // ---------------------------------------------------------------
    // Create SDK session
    // ---------------------------------------------------------------
    const sessionRoster = this.config.subagentRoster;
    let roster: SubagentRoster | false | undefined;
    if (sessionRoster === false || (sessionRoster === undefined && this.backendRoster === false)) {
      roster = false;
    } else if (
      sessionRoster !== undefined
      && this.backendRoster !== undefined
      && this.backendRoster !== false
    ) {
      roster = mergeSubagentRosters(
        DEFAULT_SUBAGENT_ROSTER,
        mergeSubagentRosters(this.backendRoster, sessionRoster),
      );
    } else if (sessionRoster !== undefined) {
      roster = mergeSubagentRosters(DEFAULT_SUBAGENT_ROSTER, sessionRoster);
    } else if (this.backendRoster !== undefined && this.backendRoster !== false) {
      roster = mergeSubagentRosters(DEFAULT_SUBAGENT_ROSTER, this.backendRoster);
    } else {
      roster = this.backendRoster;
    }

    const { modelCapabilities } = await this.resolveModelCapabilities(client, this.config.model);

    const sessionConfig: CopilotSdkSessionConfig = {
      model: this.config.model,
      streaming: true,
      // This applies only to the parent session. The installed SDK's subagent
      // settings surface cannot carry a capability override to child sessions.
      ...(modelCapabilities !== undefined ? { modelCapabilities } : {}),
      onPermissionRequest: approveAll,
      workingDirectory: this.config.cwd,
      reasoningEffort: this.config.thinkingBudget,
      ...(this.config.contextTier !== undefined
        ? { contextTier: this.config.contextTier }
        : {}),
      ...(this.configDirectory !== undefined
        ? { configDirectory: this.configDirectory }
        : {}),
      ...(this.config.systemMessage !== undefined
        ? { systemMessage: { mode: 'append', content: this.config.systemMessage } }
        : {}),
      ...(this.config.availableTools !== undefined
        ? { availableTools: [...this.config.availableTools] }
        : {}),
      ...(this.config.excludedTools !== undefined
        ? { excludedTools: [...this.config.excludedTools] }
        : {}),
      ...(this.config.customAgents !== undefined
        ? { customAgents: this.config.customAgents.map(toSdkCustomAgent) }
        : {}),
      ...(this.config.defaultAgent !== undefined
        ? {
            defaultAgent: {
              ...(this.config.defaultAgent.excludedTools !== undefined
                ? { excludedTools: [...this.config.defaultAgent.excludedTools] }
                : {}),
            },
          }
        : {}),
      ...(this.config.excludedBuiltinAgents !== undefined
        ? { excludedBuiltinAgents: [...this.config.excludedBuiltinAgents] }
        : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      // The SDK defaults this on, so every commit an agent composes carries a
      // Co-authored-by trailer. Output should read as the repository owner's work.
      coauthorEnabled: false,
      // Layer proportional compaction over the discovered absolute pre-send ceiling.
      // For gpt-5.6-sol, the SDK's 1,050,000-token denominator starts background
      // compaction at 630,000 (60%), while 80% of the provider's 922,000 prompt
      // limit caps pre-send prompts at 737,600 before the 787,500 blocking fraction.
      infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: 0.60,
        bufferExhaustionThreshold: 0.75,
      },
      // Registered before createSession issues its RPC, closing the early-event
      // gap for session.start and *_loaded events.
      onEvent: (event) => this.handleEarlyEvent(normalizeSdkEvent(event)),
    };

    const sdkSession = await client.createSession(sessionConfig);
    if (this.aborted) {
      try { await sdkSession.disconnect(); } catch { /* Ignore inert early-abort handle */ }
      return;
    }
    this._sdkSession = sdkSession;

    // Apply the live override before any prompt can dispatch a subagent.
    // This experimental RPC degrades safely if the installed CLI rejects it.
    if (roster !== undefined && roster !== false) {
      try {
        await sdkSession.rpc.tools.updateSubagentSettings({
          subagents: { agents: roster },
        });
      } catch (err) {
        this.logger.warn('Failed to apply Copilot subagent roster; using default settings', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Set autopilot mode explicitly (matches SubprocessBackend's --autopilot flag)
    try {
      await sdkSession.rpc.mode.set({ mode: 'autopilot' });
    } catch {
      // SDK may not support mode.set — continue without it
    }

    // ---------------------------------------------------------------
    // Wire SDK events -> CopilotSession events
    // ---------------------------------------------------------------
    this._wireEvents(sdkSession);

    // ---------------------------------------------------------------
    // Set up turn timers only while this handle is still active
    // ---------------------------------------------------------------
    if (this.aborted || this._sdkSession !== sdkSession) return;
    this.timeoutTimer = setTimeout(() => {
      if (this.aborted || this._sdkSession !== sdkSession) return;
      this.fail(new Error(`Session timed out after ${this.config.timeout}s`), 'timeout');
    }, this.config.timeout * 1000);
    this.resetHeartbeat();

    // ---------------------------------------------------------------
    // Send the prompt (fire-and-forget; events stream via handlers)
    // ---------------------------------------------------------------
    await sdkSession.send({ prompt });
  }

  /**
   * Wire all SDK session events to CopilotSession event emissions.
   */
  private _wireEvents(sdkSession: SdkSessionHandle): void {
    const isActive = (): boolean => this._sdkSession === sdkSession && !this.aborted;

    // --- Assistant text response ---
    sdkSession.on('assistant.message', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();

      const data = e.data;
      const content = typeof data?.content === 'string' ? data.content : '';
      const parentToolCallId = typeof data?.parentToolCallId === 'string' ? data.parentToolCallId : undefined;
      const streamKey = parentToolCallId ?? '__root__';
      if (content) {
        const streamed = this._turnText.get(streamKey) ?? '';
        const remainder = content === streamed
          ? ''
          : content.startsWith(streamed) ? content.slice(streamed.length) : content;
        if (remainder) this.emit('text', remainder, parentToolCallId);
      }
      this._turnText.delete(streamKey);

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
      if (!isActive()) return;
      this.resetHeartbeat();
      const data = e.data;
      const delta = typeof data?.deltaContent === 'string' ? data.deltaContent : '';
      const parentToolCallId = typeof data?.parentToolCallId === 'string' ? data.parentToolCallId : undefined;
      if (delta) {
        const streamKey = parentToolCallId ?? '__root__';
        this._turnText.set(streamKey, (this._turnText.get(streamKey) ?? '') + delta);
        this.emit('text', delta, parentToolCallId);
      }
    });

    // --- Reasoning ---
    sdkSession.on('assistant.reasoning', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();
      const content = typeof e.data?.content === 'string' ? e.data.content : '';
      if (content) this.emit('reasoning', content);
    });

    sdkSession.on('assistant.reasoning_delta', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();
      const delta = typeof e.data?.deltaContent === 'string' ? e.data.deltaContent : '';
      if (delta) this.emit('reasoning', delta);
    });

    // --- Tool execution start ---
    sdkSession.on('tool.execution_start', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();

      const data = e.data;
      const toolName = String(data?.toolName ?? '');
      const args = data?.arguments as Record<string, unknown> | undefined;
      const summary = args ? extractArgSummary(args) : '';
      const parentToolCallId = typeof data?.parentToolCallId === 'string' ? data.parentToolCallId : undefined;

      const callId = String(data?.toolCallId ?? '');
      if (callId && toolName) {
        this._toolCallNames.set(callId, toolName);
        // Record parent mapping for partial_result lookups
        if (parentToolCallId) {
          this._callIdToParent.set(callId, parentToolCallId);
        }
        // Flush any partials that arrived before this start event
        const buffered = this._pendingPartials.get(callId);
        if (buffered) {
          const resolvedParent = parentToolCallId ?? this._callIdToParent.get(callId);
          for (const p of buffered) this.emit('tool_output', toolName, p, resolvedParent);
          this._pendingPartials.delete(callId);
        }
      }

      if (toolName) this.emit('tool_start', toolName, summary, args ?? {}, callId, parentToolCallId);
    });

    // --- Tool execution complete ---
    sdkSession.on('tool.execution_complete', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();

      const data = e.data;
      const callId = String(data?.toolCallId ?? '');
      const parentToolCallId = typeof data?.parentToolCallId === 'string'
        ? data.parentToolCallId
        : this._callIdToParent.get(callId);
      let toolName = '';

      if (typeof data?.toolName === 'string' && data.toolName)
        toolName = data.toolName;
      if (!toolName && callId)
        toolName = this._toolCallNames.get(callId) ?? '';
      this._toolCallNames.delete(callId);
      this._callIdToParent.delete(callId);

      const result = data?.result as SdkToolResult | undefined;
      const output = typeof result?.content === 'string'
        ? result.content
        : typeof result?.detailedContent === 'string'
          ? result.detailedContent : '';

      this.emit('tool_complete', toolName, output, callId, parentToolCallId);

      // Rich event: structured content blocks for consumers that want them
      if (result?.contents && Array.isArray(result.contents)) {
        this.emit('tool_complete_rich', toolName, result.contents, callId);
      }
    });

    // --- Tool execution partial result ---
    // Note: tool.execution_partial_result does NOT carry parentToolCallId in
    // the SDK. We look it up from the _callIdToParent map populated by
    // tool.execution_start.
    sdkSession.on('tool.execution_partial_result', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();

      const data = e.data;
      const partial = typeof data?.partialOutput === 'string' ? data.partialOutput : '';
      if (!partial) return;

      const callId = String(data?.toolCallId ?? '');
      const toolName = (callId && this._toolCallNames.get(callId)) || '';
      const parentToolCallId = callId ? this._callIdToParent.get(callId) : undefined;

      if (toolName) {
        this.emit('tool_output', toolName, partial, parentToolCallId);
      } else if (callId) {
        const buf = this._pendingPartials.get(callId) ?? [];
        buf.push(partial);
        this._pendingPartials.set(callId, buf);
      } else {
        this.emit('text', partial);
      }
    });

    // --- Session idle (agent finished all work) ---
    sdkSession.on('session.idle', (e: SdkEvent) => {
      if (!isActive() || this.compactionRecoveryInProgress) return;
      this.resetHeartbeat();
      if (!e.agentId) this.settleIdle();
    });

    // --- task_complete → idle (some models fire this instead of session.idle) ---
    sdkSession.on('session.task_complete', (e: SdkEvent) => {
      if (!isActive() || this.compactionRecoveryInProgress) return;
      this.resetHeartbeat();
      if (e.agentId) return;
      if (e.data?.success === false) {
        const fields = {
          eventType: e.type ?? 'session.task_complete',
          ...(typeof e.data.summary === 'string' ? { summary: e.data.summary } : {}),
        };
        this.logger.warn('Copilot task completion failed; session remains active', fields);
        try {
          process.stderr.write('[SdkBackend] TASK COMPLETION FAILED; session remains active\n');
        } catch { /* closed stream */ }
        return;
      }
      this.settleIdle();
    });

    // The CLI normally follows an abort event with session.idle. If that
    // terminal event is lost, fail quickly rather than waiting for heartbeat.
    sdkSession.on('abort', (e: SdkEvent) => {
      if (!isActive() || this.compactionRecoveryInProgress) return;
      this.resetHeartbeat();
      if (this.logAgentScopedFailure(e)) return;
      if (this.intentionalAborts.delete(sdkSession)) return;
      if (this.abortGraceTimer) clearTimeout(this.abortGraceTimer);
      this.abortGraceTimer = setTimeout(() => {
        this.abortGraceTimer = null;
        if (!isActive()) return;
        const reason = typeof e.data?.reason === 'string' ? `: ${e.data.reason}` : '';
        this.fail(new Error(`SDK turn aborted${reason}`), 'abort', e.data);
      }, 1000);
    });

    // --- Session/model errors ---
    sdkSession.on('session.error', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();
      if (this.logAgentScopedFailure(e)) return;
      // A rate-limit error eligible for automatic model switching is followed by
      // auto_mode_switch.requested. Let the headless policy resolve that request
      // instead of tearing down the session before it can recover.
      if (e.data?.eligibleForAutoSwitch === true) return;
      const msg = typeof e.data?.message === 'string' ? e.data.message : 'Unknown session error';
      this.fail(new Error(msg), 'session.error', e.data);
    });

    // model.call_failure is telemetry for a failed LLM request, but the SDK has
    // no API to resume/retry that in-flight turn. A second send() would append a
    // duplicate user message rather than replaying the failed call, so fail the
    // condukt session immediately instead of waiting for its heartbeat timeout.
    sdkSession.on('model.call_failure', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();
      if (this.logAgentScopedFailure(e)) return;
      const data = e.data;
      const detail = typeof data?.errorMessage === 'string'
        ? data.errorMessage
        : typeof data?.errorCode === 'string'
          ? data.errorCode
          : 'Unknown model call failure';
      const rawStatusCode = data?.statusCode;
      const statusCode = typeof rawStatusCode === 'number' || typeof rawStatusCode === 'string'
        ? rawStatusCode
        : undefined;
      const errorCode = typeof data?.errorCode === 'string' ? data.errorCode : undefined;
      const status = statusCode !== undefined ? ` (HTTP ${statusCode})` : '';
      const error = new Error(`Model call failed${status}: ${detail}`);
      if (statusCode !== undefined) Object.assign(error, { statusCode });
      if (errorCode !== undefined) Object.assign(error, { errorCode });
      this.fail(error, 'model.call_failure', data);
    });

    // --- Context compaction (infinite sessions) ---
    // During compaction the model goes silent. SUSPEND the heartbeat entirely
    // (not reset) to prevent killing the session. Hard timeout remains as safety net.
    sdkSession.on('session.compaction_start', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();
      if (e.agentId) return;
      this.compactionInProgress = true;
      // SUSPEND heartbeat — compaction silence is expected
      if (this.heartbeatTimer) {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      // Clear any existing stuck timer (handles double compaction_start)
      if (this.compactionTimer) {
        clearTimeout(this.compactionTimer);
        this.compactionTimer = null;
      }
      this.emit('compaction', 'start');

      // Recovery: if compaction doesn't complete within 3 min, escalate.
      // Capture session to local to avoid TOCTOU null dereference after await.
      const session = this._sdkSession;
      if (!session || !isActive()) return;
      this.compactionTimer = setTimeout(async () => {
        if (!this.compactionInProgress || !isActive() || !session) return;
        try {
          try { process.stderr.write('[SdkBackend] Compaction stuck 3min — forcing compact\n'); } catch { /* */ }
          await session.rpc.history.compact();
          // Re-check guards after await — session may have been torn down
          if (!this.compactionInProgress || !isActive()) return;
          // If force-compact works, compaction_complete will fire naturally
        } catch {
          // Re-check guards after await
          if (!isActive()) return;
          try { process.stderr.write('[SdkBackend] Force compact failed — aborting + re-sending\n'); } catch { /* */ }
          // Escalate: abort current message, then re-send to nudge model.
          // Uses RAW SDK abort (session stays alive), NOT this.abort() (which tears down).
          // SDK docs: "The session remains valid and can continue to be used for new messages."
          // Wait for idle after abort before sending, to avoid racing with in-flight processing.
          this.compactionInProgress = false;
          this.compactionRecoveryInProgress = true;
          this._turnText.clear();
          try {
            this.intentionalAborts.add(session);
            await session.abort();
            // Some SDK versions emit abort synchronously, others just after the
            // request resolves. Keep the marker through the settling window.
            if (this.abortGraceTimer) {
              clearTimeout(this.abortGraceTimer);
              this.abortGraceTimer = null;
            }
            // WeakSet entries are removed when the delayed intentional abort event
            // arrives. The handle itself becomes collectible after session cleanup.
            // Wait briefly for the abort to settle before re-sending.
            // The SDK resolves abort() on acknowledgement, not on idle.
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (!isActive()) return;
            await session.send({ prompt: 'Continue from where you left off.' });
            this.compactionRecoveryInProgress = false;
            this.resetHeartbeat();
          } catch {
            this.compactionRecoveryInProgress = false;
            try { process.stderr.write('[SdkBackend] Recovery failed — restarting heartbeat as safety net\n'); } catch { /* */ }
            this.resetHeartbeat(); // Detect if model is truly dead instead of waiting for hours-long hard timeout
          }
        }
      }, 3 * 60 * 1000);
    });

    sdkSession.on('session.compaction_complete', (e: SdkEvent) => {
      if (!isActive()) return;
      if (e.agentId) {
        this.resetHeartbeat();
        return;
      }
      this.compactionInProgress = false;
      if (this.compactionTimer) { clearTimeout(this.compactionTimer); this.compactionTimer = null; }
      // Restart heartbeat — model should resume producing output
      this.resetHeartbeat();
      const data = e.data as Record<string, unknown> | undefined;
      // Check if compaction actually succeeded
      if (data?.success === false) {
        const errMsg = typeof data.error === 'string' ? data.error : 'unknown reason';
        try { process.stderr.write(`[SdkBackend] Compaction failed: ${errMsg}\n`); } catch { /* */ }
      }
      const pre = data?.preCompactionTokens;
      const post = data?.postCompactionTokens;
      const removed = data?.tokensRemoved;
      const summary = pre && post
        ? `${pre} → ${post} tokens${removed != null ? ` (saved ${removed})` : ''}`
        : '';
      this.emit('compaction', 'complete', summary);
    });

    // --- Subagent lifecycle ---
    // Sub-agents use their own event path (subagent_start/subagent_end).
    // The synthetic tool_start/tool_complete dual-emit is removed — sub-agent
    // grouping is handled by SubagentSectionPart in the UI layer.
    sdkSession.on('subagent.started', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();
      const data = e.data;
      const name = String(data?.agentDisplayName ?? data?.agentName ?? 'agent');
      const toolCallId = typeof data?.toolCallId === 'string' ? data.toolCallId : '';
      this.emit('subagent_start', name, { ...data, toolCallId });
    });

    sdkSession.on('subagent.completed', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();
      const data = e.data;
      const name = String(data?.agentDisplayName ?? data?.agentName ?? 'agent');
      const toolCallId = typeof data?.toolCallId === 'string' ? data.toolCallId : '';
      this.emit('subagent_end', name, { ...data, toolCallId });
    });

    sdkSession.on('subagent.failed', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();
      const data = e.data;
      const name = String(data?.agentDisplayName ?? data?.agentName ?? 'agent');
      const toolCallId = typeof data?.toolCallId === 'string' ? data.toolCallId : '';
      const error = typeof data?.error === 'string' ? data.error : '';
      this.emit('subagent_end', name, { ...data, toolCallId, error });
    });

    // --- Rich events (optional; consumers can subscribe or ignore) ---

    sdkSession.on('assistant.intent', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();
      const intent = typeof e.data?.intent === 'string' ? e.data.intent : '';
      if (intent) this.emit('intent', intent);
    });

    sdkSession.on('assistant.usage', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();
      this.emit('usage', e.data ?? {});
    });

    sdkSession.on('permission.requested', (e: SdkEvent) => {
      if (!isActive()) return;
      this.resetHeartbeat();
      this.emit('permission', e.data ?? {});
    });

    // Class-level handling for the full SDK event surface. Named handlers above
    // retain payload-specific mapping; this dispatcher supplies liveness,
    // terminal fallbacks, pending-request policies, and future-event safety.
    sdkSession.on((e: SdkEvent) => {
      if (!isActive()) return;
      this.dispatchClassEvent(sdkSession, e);
    });
  }

  // ── CopilotSession event subscription ────────────────────────────────────
  // Overloads match CopilotSession interface exactly.

  on(event: 'text', handler: (text: string, parentToolCallId?: string) => void): void;
  on(event: 'tool_start', handler: (tool: string, input: string, args: Record<string, unknown>, callId?: string, parentToolCallId?: string) => void): void;
  on(event: 'tool_complete', handler: (tool: string, output: string, callId?: string, parentToolCallId?: string) => void): void;
  on(event: 'tool_output', handler: (tool: string, output: string, parentToolCallId?: string) => void): void;
  on(event: 'idle', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'reasoning', handler: (text: string) => void): void;
  on(event: 'intent', handler: (intent: string) => void): void;
  on(event: 'usage', handler: (data: UsageData) => void): void;
  on(event: 'tool_complete_rich', handler: (tool: string, contents: ReadonlyArray<ContentBlock>, callId?: string) => void): void;
  on(event: 'subagent_start', handler: (name: string, data: Record<string, unknown>) => void): void;
  on(event: 'subagent_end', handler: (name: string, data: Record<string, unknown>) => void): void;
  on(event: 'permission', handler: (data: PermissionInfo) => void): void;
  on(event: 'compaction', handler: (phase: 'start' | 'complete', summary?: string) => void): void;
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
    try { process.stderr.write(`[SdkBackend] ${err.message}\n`); } catch { /* closed stream */ }
    this.emit('error', err);
  }

  private settleIdle(): void {
    if (this.aborted || this.turnSettled) return;
    this.turnSettled = true;
    this._turnText.clear();
    this.clearTimers();
    this.emit('idle');
    void this._cleanup();
  }

  private fail(err: Error, eventType: string, data?: Record<string, unknown>): void {
    if (this.aborted || this.turnSettled) return;
    this.turnSettled = true;
    this.clearTimers();
    try {
      process.stderr.write(`[SdkBackend] ${eventType}: ${this.serializeEventDataCompact(eventType, data)}\n`);
    } catch { /* closed stream */ }
    this.emitError(err);
    this.aborted = true;
    void this._cleanup();
  }

  private logAgentScopedFailure(e: SdkEvent): boolean {
    // Scope is carried by agentId; matching error text or type would miss future child failures.
    if (!e.agentId) return false;
    const reason = typeof e.data?.message === 'string'
      ? e.data.message
      : typeof e.data?.errorMessage === 'string'
        ? e.data.errorMessage
        : typeof e.data?.error === 'string'
          ? e.data.error
          : typeof e.data?.reason === 'string'
            ? e.data.reason
            : 'Unknown agent failure';
    const eventType = e.type ?? 'unknown';
    const fields = {
      agentId: e.agentId,
      eventType,
      reason,
      ...(typeof e.data?.errorType === 'string' ? { errorType: e.data.errorType } : {}),
      ...(typeof e.data?.errorCode === 'string' ? { errorCode: e.data.errorCode } : {}),
    };
    this.logger.error('Copilot sub-agent failed; parent session remains active', fields);
    try {
      process.stderr.write(
        `[SdkBackend] AGENT-SCOPED FAILURE agentId=${e.agentId} event=${eventType} reason=${reason}\n`,
      );
    } catch { /* closed stream */ }
    return true;
  }

  private handleEarlyEvent(e: SdkEvent): void {
    if (this.aborted || !e || typeof e.type !== 'string') return;
    // Once the active handle exists, the session catch-all is authoritative.
    // Only the pre-handle creation window is handled here.
    if (this._sdkSession) return;
    const eventClass = classifySdkEvent(e.type);
    if (eventClass === 'informational') return;
    if (this.isFailureShapedEvent(e)) {
      if (this.logAgentScopedFailure(e)) return;
      const payload = this.serializeEventDataCompact(e.type, e.data);
      try { process.stderr.write(`[SdkBackend] Early failure event: ${e.type} data=${payload}\n`); } catch { /* */ }
      this.fail(new Error(`Early SDK failure event: ${e.type}`), e.type, e.data);
    }
  }

  private dispatchClassEvent(sdkSession: SdkSessionHandle, e: SdkEvent): void {
    if (!e || typeof e.type !== 'string') return;
    this.resetHeartbeat();
    if (NAMED_SDK_EVENTS.has(e.type)) return;
    const eventClass = classifySdkEvent(e.type);
    if (e.type === 'session.shutdown' && e.data?.shutdownType === 'error') {
      if (this.logAgentScopedFailure(e)) return;
      const reason = typeof e.data.errorReason === 'string'
        ? e.data.errorReason
        : 'SDK session shut down abnormally';
      this.fail(new Error(reason), 'session.shutdown', e.data);
      return;
    }
    if (eventClass === 'terminal-success') {
      if (!e.agentId) this.settleIdle();
      return;
    }
    if (eventClass === 'terminal-failure') {
      if (this.logAgentScopedFailure(e)) return;
      this.fail(new Error(`SDK terminal failure: ${e.type}`), e.type, e.data);
      return;
    }
    if (eventClass === 'streaming-liveness') return;
    if (eventClass === 'pending-request') {
      void this.resolvePendingRequest(sdkSession, e);
      return;
    }
    if (eventClass === 'informational') return;

    const payload = this.serializeEventDataCompact(e.type, e.data);
    try { process.stderr.write(`[SdkBackend] Unknown event: ${e.type} data=${payload}\n`); } catch { /* */ }
    if (this.isFailureShapedEvent(e)) {
      if (this.logAgentScopedFailure(e)) return;
      this.fail(new Error(`Unknown SDK failure event: ${e.type}`), e.type, e.data);
    }
  }

  private serializeEventData(data?: Record<string, unknown>): string {
    try {
      return JSON.stringify(data ?? {});
    } catch {
      return '(unstringifiable payload)';
    }
  }

  private serializeEventDataCompact(type: string, data?: Record<string, unknown>): string {
    if (type === 'session.binary_asset') return '(binary payload omitted)';
    const serialized = this.serializeEventData(data);
    return serialized.length > 2000 ? `${serialized.slice(0, 2000)}…` : serialized;
  }

  private isFailureShapedEvent(e: SdkEvent): boolean {
    const type = e.type ?? '';
    if (/(?:^|[._-])(error|failure|fatal)(?:$|[._-])/i.test(type)) return true;
    const data = e.data;
    if (!data) return false;
    return data.failed === true
      || typeof data.error === 'string'
      || (data.error != null && typeof data.error === 'object');
  }

  private async resolvePendingRequest(sdkSession: SdkSessionHandle, e: SdkEvent): Promise<void> {
    if (this.aborted || this._sdkSession !== sdkSession) return;
    const requestId = typeof e.data?.requestId === 'string' ? e.data.requestId : '';
    if (!requestId) {
      this.fail(new Error(`Pending SDK request missing requestId: ${e.type}`), e.type ?? 'pending-request', e.data);
      return;
    }
    try {
      switch (e.type) {
        case 'sampling.requested':
          await sdkSession.rpc.mcp.cancelSamplingExecution({ requestId });
          break;
        case 'auto_mode_switch.requested':
          // Approve this turn only. Do not persist a user preference from a
          // headless execution engine.
          await sdkSession.rpc.ui.handlePendingAutoModeSwitch({ requestId, response: 'yes' });
          break;
        case 'session_limits_exhausted.requested':
          await sdkSession.rpc.ui.handlePendingSessionLimitsExhausted({
            requestId,
            response: { action: 'cancel' },
          });
          break;
        case 'mcp.headers_refresh_required':
          // The runtime has its own timeout fallback; registering no response
          // avoids inventing credentials in a headless process.
          break;
      }
    } catch (err) {
      if (this.aborted || this._sdkSession !== sdkSession) return;
      this.fail(
        err instanceof Error ? err : new Error(String(err)),
        `${e.type}.policy`,
        e.data,
      );
    }
  }

  private resetHeartbeat(): void {
    if (this.aborted || this.turnSettled || this.compactionInProgress || !this._sdkSession) return;
    const sdkSession = this._sdkSession;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }
    this.heartbeatTimer = setTimeout(() => {
      if (this.aborted || this.turnSettled || this._sdkSession !== sdkSession) return;
      this.fail(
        new Error(`No output for ${this.config.heartbeatTimeout}s (heartbeat timeout)`),
        'heartbeat',
      );
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
    if (this.compactionTimer) {
      clearTimeout(this.compactionTimer);
      this.compactionTimer = null;
    }
    if (this.abortGraceTimer) {
      clearTimeout(this.abortGraceTimer);
      this.abortGraceTimer = null;
    }
    this.compactionInProgress = false;
    this.compactionRecoveryInProgress = false;
  }
}
