/**
 * Pure mapping from condukt SessionConfig to Claude Agent SDK Options.
 *
 * The Copilot session config and the Claude session config express the same
 * intents with different primitives. The important asymmetries, all verified
 * against the installed SDK typings:
 *
 * - Copilot's `availableTools` is a source-qualified availability allow-list
 *   (`builtin:*`, `builtin:<name>`, `mcp:*`, `mcp:<name>`, `custom:<name>`,
 *   bare names). On the Claude SDK, `Options.tools` restricts built-in tools
 *   only, while `allowedTools` merely auto-allows names under `dontAsk`. MCP
 *   availability can only be restricted by pruning whole servers; per-tool
 *   control on a kept server is a permission policy, not availability.
 * - `systemMessage` appends to Claude Code's default prompt (`preset` +
 *   `append`), it does not replace it.
 * - `additionalDirectories` requires absolute paths.
 *
 * Everything here is pure; diagnostics are delivered through an injected
 * callback so the mapper stays testable.
 */

import { isAbsolute, resolve } from 'node:path';
import {
  BUILTIN_TOOL_NAMES,
  LEGACY_TOOL_NAME_ALIASES,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentDefinition,
  AgentMcpServerSpec,
  McpServerConfig,
  McpServerToolPolicy,
  Options,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  CustomAgentConfig,
  MCPServerConfig,
  PermissionPolicy,
  SessionConfig,
  SessionMode,
} from '../../src/types';
import { resolveMcpEnvironmentRecord, resolveMcpHeaders } from '../mcp-env';

export function isSafeMode(): boolean {
  const v = (process.env.CONDUKT_SAFE_MODE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export interface ClaudeConfigMapping {
  readonly options: Partial<Options>;
  readonly permissionMode: string;
  readonly requiresDangerousSkip: boolean;
}

export interface ClaudeConfigMapOptions {
  /**
   * Extra environment variables for the CLI subprocess (e.g. the
   * in-process bridge's ANTHROPIC_BASE_URL + fake credentials). The SDK
   * REPLACES the child env with options.env when set, so callers merge
   * with process.env here.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * One-shot isolation (advisor / stand-in / handoff): disable built-in
   * tools, MCP servers, and host settings discovery, and never inherit the
   * caller's permission policy. `systemMessage` is then a complete custom
   * prompt rather than an append to Claude Code's own prompt.
   */
  readonly oneShot?: boolean;
  /** Receives warnings the SDK options cannot express (deduped per message). */
  readonly onDiagnostic?: (message: string) => void;
}

/** Built-ins that only read. `LSP` is deliberately separate: it may start servers. */
const READ_ONLY_BUILTINS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LSP']);
const READ_ONLY_DEFAULT: readonly string[] = ['Read', 'Grep', 'Glob'];

const BUILTIN_NAMES: ReadonlySet<string> = new Set(BUILTIN_TOOL_NAMES);
const BUILTIN_NAMES_LOWERCASE: ReadonlyMap<string, string> = new Map(
  BUILTIN_TOOL_NAMES.map((name) => [name.toLowerCase(), name]),
);
const LEGACY_ALIASES_LOWERCASE: ReadonlyMap<string, string> = new Map(
  Object.entries(LEGACY_TOOL_NAME_ALIASES).map(([legacy, current]) => [legacy.toLowerCase(), current]),
);

const MCP_TOOL_PREFIX = 'mcp__';

/** process.env as a plain string record (drops undefined values). */
function processEnvRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Resolves a tool name written in any casing to its canonical built-in name. */
function canonicalBuiltinName(name: string): string | undefined {
  if (BUILTIN_NAMES.has(name)) return name;
  const lower = name.toLowerCase();
  return BUILTIN_NAMES_LOWERCASE.get(lower) ?? LEGACY_ALIASES_LOWERCASE.get(lower);
}

/**
 * Tool names in a deny-list may be written in Copilot's lowercase vocabulary
 * (`task`, `bash`). The SDK matches exactly, so normalize what we can and
 * leave anything unrecognized untouched (MCP names are case-sensitive).
 */
function canonicalToolName(name: string): string {
  return canonicalBuiltinName(name) ?? name;
}

interface QualifiedTool {
  readonly source?: 'builtin' | 'mcp' | 'custom';
  readonly name: string;
}

function splitQualified(entry: string): QualifiedTool {
  const index = entry.indexOf(':');
  if (index < 0) return { name: entry };
  const prefix = entry.slice(0, index).toLowerCase();
  if (prefix === 'builtin' || prefix === 'mcp' || prefix === 'custom') {
    return { source: prefix, name: entry.slice(index + 1) };
  }
  return { name: entry };
}

interface AvailableToolsPlan {
  readonly allBuiltins: boolean;
  readonly builtinNames: string[];
  readonly allMcp: boolean;
  readonly mcpToolNames: string[];
  readonly extraAllowed: string[];
}

function planAvailableTools(
  entries: readonly string[],
  onDiagnostic?: (message: string) => void,
): AvailableToolsPlan {
  const plan: {
    allBuiltins: boolean;
    builtinNames: string[];
    allMcp: boolean;
    mcpToolNames: string[];
    extraAllowed: string[];
  } = {
    allBuiltins: false,
    builtinNames: [],
    allMcp: false,
    mcpToolNames: [],
    extraAllowed: [],
  };
  const seenCustom = new Set<string>();

  for (const entry of entries) {
    const { source, name } = splitQualified(entry);
    if (source === 'custom') {
      // condukt registers no host custom tools on the Claude side; only the
      // internal advisor/stand-in server exists and it is not expressible in
      // Copilot's custom:* vocabulary either.
      if (!seenCustom.has(entry)) {
        seenCustom.add(entry);
        onDiagnostic?.(
          `availableTools entry '${entry}' has no Claude equivalent (no host custom tools); ignored`,
        );
      }
      continue;
    }
    if (source === 'mcp') {
      if (name === '*') plan.allMcp = true;
      else if (!plan.mcpToolNames.includes(name)) plan.mcpToolNames.push(name);
      continue;
    }
    if (source === 'builtin') {
      if (name === '*') {
        plan.allBuiltins = true;
        continue;
      }
      const builtin = canonicalBuiltinName(name);
      if (builtin === undefined) {
        // Unknown builtin:<x> is still a tool name the model may call.
        if (!plan.extraAllowed.includes(name)) plan.extraAllowed.push(name);
      } else if (!plan.builtinNames.includes(builtin)) {
        plan.builtinNames.push(builtin);
      }
      continue;
    }
    // Bare names: a built-in name restricts availability; anything else is a
    // name to auto-allow (MCP tools included, as on Copilot where a bare name
    // matches across sources).
    const builtin = canonicalBuiltinName(name);
    if (builtin !== undefined) {
      if (!plan.builtinNames.includes(builtin)) plan.builtinNames.push(builtin);
    } else if (!plan.extraAllowed.includes(name)) {
      plan.extraAllowed.push(name);
    }
  }

  return plan;
}

export function mapPermissionMode(
  mode: SessionMode | undefined,
  policy: PermissionPolicy | undefined,
): { mode: string; requiresDangerousSkip: boolean } {
  if (isSafeMode() && mode !== 'plan') {
    return { mode: 'dontAsk', requiresDangerousSkip: false };
  }
  if (mode === 'plan') {
    return { mode: 'plan', requiresDangerousSkip: false };
  }
  if (policy === 'read-only') {
    // dontAsk: deny anything not pre-approved; combined with allowedTools below.
    return { mode: 'dontAsk', requiresDangerousSkip: false };
  }
  // Autonomous default.
  return { mode: 'bypassPermissions', requiresDangerousSkip: true };
}

function resolveAdditionalDirectories(
  addDirs: readonly string[] | undefined,
  cwd: string,
): string[] | undefined {
  if (addDirs === undefined || addDirs.length === 0) return undefined;
  const base = cwd.length > 0 ? cwd : process.cwd();
  const resolved: string[] = [];
  for (const dir of addDirs) {
    if (dir.length === 0) continue;
    const absolute = isAbsolute(dir) ? dir : resolve(base, dir);
    if (!resolved.includes(absolute)) resolved.push(absolute);
  }
  return resolved.length > 0 ? resolved : undefined;
}

export interface ClaudeMcpConversion {
  readonly servers: Record<string, McpServerConfig> | undefined;
  /** Exact `mcp__server__tool` names requested through a per-tool list. */
  readonly allowedTools: string[];
}

function asStringArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function toToolPolicies(
  tools: readonly unknown[],
): { policies: McpServerToolPolicy[]; names: string[] } | null {
  if (tools.length === 0) return null; // [] removes the server entirely
  if (tools.length === 1 && tools[0] === '*') return { policies: [], names: [] };
  const policies: McpServerToolPolicy[] = [];
  const names: string[] = [];
  for (const entry of tools) {
    if (typeof entry === 'string') {
      if (entry === '*') continue;
      policies.push({ name: entry, permission_policy: 'always_allow' });
      names.push(entry);
      continue;
    }
    if (entry !== null && typeof entry === 'object') {
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.name !== 'string') continue;
      const policy: McpServerToolPolicy = { name: candidate.name };
      const permission = candidate.permission_policy;
      if (permission === 'always_allow' || permission === 'always_ask' || permission === 'always_deny') {
        policies.push({ ...policy, permission_policy: permission });
      } else {
        policies.push(policy);
      }
      names.push(candidate.name);
    }
  }
  return { policies, names };
}

/**
 * Converts condukt MCP server configs to SDK configs.
 *
 * Differences the SDK cannot express are reported instead of silently
 * dropped: a stdio server has no per-server working directory, and a kept
 * server cannot hide individual tools (only per-tool permission policies).
 */
export function toClaudeMcpServers(
  servers: Readonly<Record<string, MCPServerConfig>> | undefined,
  options?: {
    readonly onDiagnostic?: (message: string) => void;
    readonly workingDirectory?: string;
  },
): ClaudeMcpConversion {
  if (servers === undefined) return { servers: undefined, allowedTools: [] };
  const onDiagnostic = options?.onDiagnostic;
  const converted: Record<string, McpServerConfig> = {};
  const allowedTools: string[] = [];
  let warnedWorkingDirectory = false;

  for (const [serverName, server] of Object.entries(servers)) {
    if (server === null || typeof server !== 'object') continue;

    const declaredTools = asStringArray(server.tools);
    let policies: McpServerToolPolicy[] | undefined;
    if (declaredTools !== undefined) {
      const planned = toToolPolicies(declaredTools);
      if (planned === null) continue; // tools: [] -> server is switched off
      policies = planned.policies;
      for (const toolName of planned.names) {
        const qualified = `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
        if (!allowedTools.includes(qualified)) allowedTools.push(qualified);
      }
    }

    const workingDirectory =
      typeof server.workingDirectory === 'string'
        ? server.workingDirectory
        : options?.workingDirectory;
    if (workingDirectory !== undefined && !warnedWorkingDirectory) {
      warnedWorkingDirectory = true;
      onDiagnostic?.(
        'MCP server working directories are not supported by the Claude SDK; '
        + `'${workingDirectory}' is ignored (servers inherit the session cwd)`,
      );
    }

    const timeout = typeof server.timeout === 'number' ? server.timeout : undefined;

    const url = typeof server.url === 'string' ? server.url : undefined;
    if (url !== undefined) {
      const headers = resolveMcpHeaders(
        server.headers as Record<string, string> | undefined,
        ({ header, names }) => {
          onDiagnostic?.(
            `MCP header ${header} dropped: none of ${names.join(', ')} is set`,
          );
        },
      );
      const shared = {
        url,
        ...(headers !== undefined ? { headers } : {}),
        ...(policies !== undefined && policies.length > 0 ? { tools: policies } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      };
      converted[serverName] = server.type === 'sse'
        ? { type: 'sse', ...shared }
        : { type: 'http', ...shared };
      continue;
    }

    const command = typeof server.command === 'string' ? server.command : undefined;
    if (command === undefined) {
      onDiagnostic?.(`MCP server '${serverName}' has neither a command nor a url; skipped`);
      continue;
    }
    const args = asStringArray(server.args)?.filter((a): a is string => typeof a === 'string');
    const env = resolveMcpEnvironmentRecord(server.env as Record<string, string> | undefined);
    converted[serverName] = {
      type: 'stdio',
      command,
      ...(args !== undefined && args.length > 0 ? { args: [...args] } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(policies !== undefined && policies.length > 0 ? { tools: policies } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  return {
    servers: Object.keys(converted).length > 0 ? converted : undefined,
    allowedTools,
  };
}

function toAgentMcpServers(
  servers: Readonly<Record<string, MCPServerConfig>> | undefined,
  onDiagnostic?: (message: string) => void,
): AgentMcpServerSpec[] | undefined {
  const conversion = toClaudeMcpServers(servers, { onDiagnostic });
  if (conversion.servers === undefined) return undefined;
  // Agent specs describe process-transport servers only; every server produced
  // by the converter is stdio/http/sse, never an in-process SDK instance.
  return [conversion.servers as unknown as Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfigForProcessTransport>];
}

function toAgentDefinition(
  agent: CustomAgentConfig,
  onDiagnostic?: (message: string) => void,
): AgentDefinition {
  if (agent.displayName !== undefined || agent.infer !== undefined) {
    onDiagnostic?.(
      `custom agent '${agent.name}': displayName/infer have no Claude equivalent; ignored`,
    );
  }
  const tools = agent.tools === null || agent.tools === undefined
    ? undefined
    : agent.tools.map((tool) => canonicalToolName(tool));
  const mcpServers = toAgentMcpServers(agent.mcpServers, onDiagnostic);
  return {
    description: agent.description ?? agent.name,
    prompt: agent.prompt,
    ...(tools !== undefined ? { tools } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(agent.skills !== undefined ? { skills: [...agent.skills] } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
  };
}

export function mapConfig(config: SessionConfig, extra?: ClaudeConfigMapOptions): ClaudeConfigMapping {
  const onDiagnostic = extra?.onDiagnostic;
  const oneShot = extra?.oneShot === true;
  const permission = oneShot
    ? { mode: 'dontAsk', requiresDangerousSkip: false }
    : mapPermissionMode(config.mode, config.permissionPolicy);
  const { mode: permissionMode, requiresDangerousSkip } = permission;

  // ── Tool availability ───────────────────────────────────────────────
  const readOnly = config.permissionPolicy === 'read-only' || isSafeMode();
  const requested = config.availableTools;
  const plan = requested !== undefined ? planAvailableTools(requested, onDiagnostic) : undefined;

  // Built-in availability (`Options.tools`); undefined means "full preset".
  let builtinTools: string[] | { type: 'preset'; preset: 'claude_code' } | undefined;
  if (oneShot) {
    builtinTools = [];
  } else if (readOnly) {
    builtinTools = plan === undefined
      ? [...READ_ONLY_DEFAULT]
      : plan.allBuiltins
        ? [...READ_ONLY_DEFAULT]
        : plan.builtinNames.filter((name) => READ_ONLY_BUILTINS.has(name));
  } else if (plan === undefined) {
    builtinTools = undefined;
  } else if (plan.allBuiltins) {
    builtinTools = { type: 'preset', preset: 'claude_code' };
  } else {
    builtinTools = plan.builtinNames;
  }

  // MCP availability: an allow-list without an MCP entry prunes every server,
  // because a kept server's tools cannot be hidden individually.
  const mcpKept = !oneShot
    && config.mcpServers !== false
    && (plan === undefined || plan.allMcp || plan.mcpToolNames.length > 0);
  // Suppressing condukt's servers is not the same as disabling MCP: the SDK
  // still discovers `.mcp.json`, user settings, and plugin servers unless
  // `strictMcpConfig` is set, so the two always travel together.
  const mcpSuppressed = oneShot || !mcpKept;
  const mcpConversion = mcpSuppressed
    ? { servers: undefined, allowedTools: [] as string[] }
    : toClaudeMcpServers(config.mcpServers, {
      onDiagnostic,
      workingDirectory: config.mcpServerWorkingDirectory,
    });

  const mcpAllowed: string[] = [];
  if (!oneShot && mcpKept) {
    // Explicit per-server tool lists are opt-ins under dontAsk.
    for (const name of mcpConversion.allowedTools) mcpAllowed.push(name);
    if (plan !== undefined && !plan.allMcp) {
      for (const toolName of plan.mcpToolNames) {
        for (const serverName of Object.keys(mcpConversion.servers ?? {})) {
          const qualified = `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
          if (!mcpAllowed.includes(qualified)) mcpAllowed.push(qualified);
        }
      }
    }
  }

  const allowedTools = new Set<string>();
  if (!oneShot) {
    if (readOnly && Array.isArray(builtinTools)) {
      for (const name of builtinTools) allowedTools.add(name);
    }
    if (plan !== undefined) {
      for (const name of plan.extraAllowed) allowedTools.add(name);
    }
    if (readOnly || plan !== undefined) {
      for (const name of mcpAllowed) allowedTools.add(name);
    }
  }

  // ── Deny-list ───────────────────────────────────────────────────────
  const disallowed = new Set<string>();
  for (const name of config.excludedTools ?? []) disallowed.add(canonicalToolName(name));
  for (const name of config.defaultAgent?.excludedTools ?? []) disallowed.add(canonicalToolName(name));
  if (config.subagentsEnabled === false || oneShot) {
    // Agent is the current subagent tool; Task is its legacy alias.
    disallowed.add('Agent');
    disallowed.add('Task');
  }

  // excludedBuiltinAgents has no Claude equivalent: the Claude SDK has no
  // built-in named agents to exclude (they arrive through plugins/settings).
  if (config.excludedBuiltinAgents !== undefined && config.excludedBuiltinAgents.length > 0) {
    onDiagnostic?.(
      'excludedBuiltinAgents has no Claude equivalent (no built-in agent registry); ignored',
    );
  }

  // ── Custom agents ───────────────────────────────────────────────────
  const agents: Record<string, AgentDefinition> = {};
  for (const agent of config.customAgents ?? []) {
    agents[agent.name] = toAgentDefinition(agent, onDiagnostic);
  }

  const additionalDirectories = oneShot
    ? undefined
    : resolveAdditionalDirectories(config.addDirs, config.cwd);

  const systemPrompt: Options['systemPrompt'] = oneShot
    ? config.systemMessage
    : config.systemMessage !== undefined
      ? { type: 'preset', preset: 'claude_code', append: config.systemMessage }
      : undefined;

  const options: Partial<Options> = {
    model: config.model,
    cwd: config.cwd,
    systemPrompt,
    tools: builtinTools,
    allowedTools: allowedTools.size > 0 ? [...allowedTools] : undefined,
    disallowedTools: disallowed.size > 0 ? [...disallowed] : undefined,
    permissionMode: permissionMode as Options['permissionMode'],
    allowDangerouslySkipPermissions: requiresDangerousSkip,
    agents: Object.keys(agents).length > 0 ? agents : undefined,
    mcpServers: mcpSuppressed ? {} : mcpConversion.servers,
    // Strict only when condukt deliberately supplies no servers. A main
    // session that keeps host MCP discovery (no config, no allow-list) stays
    // as Claude Code is, and a kept server set must not silently drop the
    // host's own.
    ...(mcpSuppressed ? { strictMcpConfig: true } : {}),
    additionalDirectories,
    ...(oneShot ? { settingSources: [] as Options['settingSources'] } : {}),
  };

  // Thinking budget → effort level (1:1 from condukt's vocabulary). The
  // bridge consumes body.effort/output_config.effort and maps it onto the
  // upstream family (responses effort table, DeepSeek/GLM demotions).
  if (!oneShot && config.thinkingBudget) {
    options.effort = config.thinkingBudget;
  }

  // ── Claude-runtime session config (SessionConfig.claude) ───────────
  // Tier models: the CLI resolves its opus/sonnet/haiku tiers through
  // these env vars (no model defaults are shipped by condukt).
  const claudeEnv: Record<string, string> = {};
  const tier = config.claude?.tierModels;
  if (tier?.opus) claudeEnv['ANTHROPIC_DEFAULT_OPUS_MODEL'] = tier.opus;
  if (tier?.sonnet) claudeEnv['ANTHROPIC_DEFAULT_SONNET_MODEL'] = tier.sonnet;
  if (tier?.haiku) claudeEnv['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = tier.haiku;

  const autoCompact = config.claude?.autoCompact;
  if (autoCompact?.pctOverride !== undefined) {
    claudeEnv['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'] = String(autoCompact.pctOverride);
  }
  if (autoCompact?.maxContextTokens !== undefined) {
    claudeEnv['CLAUDE_CODE_MAX_CONTEXT_TOKENS'] = String(autoCompact.maxContextTokens);
  }
  if (autoCompact?.window !== undefined) {
    options.settings = { autoCompactWindow: autoCompact.window };
  }

  const mergedEnv = { ...claudeEnv, ...(extra?.env ?? {}) };
  if (Object.keys(mergedEnv).length > 0) {
    // The SDK replaces the child environment when options.env is set.
    options.env = { ...processEnvRecord(), ...mergedEnv };
  }

  return { options, permissionMode, requiresDangerousSkip };
}

export default mapConfig;
