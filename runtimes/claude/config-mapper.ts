/**
 * Pure mapping from condukt SessionConfig to Claude Agent SDK Options.
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { SessionConfig, PermissionPolicy, SessionMode } from '../../src/types';

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
}

/** process.env as a plain string record (drops undefined values). */
function processEnvRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export function mapPermissionMode(
  mode: SessionMode | undefined,
  policy: PermissionPolicy | undefined,
): { mode: string; requiresDangerousSkip: boolean } {
  const raw = (process.env.CONDUKT_SAFE_MODE ?? '').trim().toLowerCase();
  const safeMode = raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  if (safeMode && mode !== 'plan') {
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

export function mapConfig(config: SessionConfig, extra?: ClaudeConfigMapOptions): ClaudeConfigMapping {
  const { mode: permissionMode, requiresDangerousSkip } = mapPermissionMode(
    config.mode,
    config.permissionPolicy,
  );

  const agents: Record<string, { description: string; prompt: string; tools?: string[]; model?: string; effort?: string; disallowedTools?: string[] }> = {};
  for (const a of config.customAgents ?? []) {
    agents[a.name] = {
      description: a.description ?? a.name,
      prompt: a.prompt,
      tools: a.tools === null ? undefined : (a.tools as string[] | undefined),
      model: a.model,
      effort: a.effort,
    };
  }

  const mcpServers = config.mcpServers === false ? undefined : (config.mcpServers as Record<string, unknown> | undefined);

  const safeMode = isSafeMode();
  const allowedTools = config.availableTools ? [...config.availableTools] : (safeMode ? ['Read','Grep','Glob'] : undefined);
  const disallowedTools = config.excludedTools ? [...config.excludedTools] : undefined;

  // Read-only policy: honor the caller's tool allow-list when provided so we do
  // not silently drop requested tools; only fall back to a safe subset otherwise.
  const DANGEROUS_TOOLS = new Set(['Bash','Write','Edit','NotebookEdit','MultiEdit','WebFetch','WebSearch','Task']);
  const safeOrReadOnly = isSafeMode() || config.permissionPolicy === 'read-only';
  const WRITE_TOOLS = DANGEROUS_TOOLS;
  const baseAllowed = allowedTools;
  const readOnlyAllowed = safeOrReadOnly
    ? (baseAllowed && baseAllowed.length > 0
        ? baseAllowed.filter((t) => !WRITE_TOOLS.has(t))
        : ['Read', 'Grep', 'Glob'])
    : allowedTools;

  const options: Partial<Options> = {
    model: config.model,
    cwd: config.cwd,
    systemPrompt: config.systemMessage,
    allowedTools: safeOrReadOnly ? readOnlyAllowed : allowedTools,
    disallowedTools: safeOrReadOnly
      ? [...(disallowedTools ?? []), ...DANGEROUS_TOOLS]
      : disallowedTools,
    permissionMode: permissionMode as Options['permissionMode'],
    allowDangerouslySkipPermissions: requiresDangerousSkip,
    agents: Object.keys(agents).length > 0 ? (agents as Options['agents']) : undefined,
    mcpServers: mcpServers as Options['mcpServers'],
    maxTurns: undefined,
  };

  // Thinking budget → effort level (1:1 from condukt's vocabulary). The
  // bridge consumes body.effort/output_config.effort and maps it onto the
  // upstream family (responses effort table, DeepSeek/GLM demotions).
  if (config.thinkingBudget) {
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

  if (config.excludedBuiltinAgents && config.excludedBuiltinAgents.length > 0) {
    // Claude has no direct "excluded builtin agents"; map to disallowedTools entries.
    const cur = (options.disallowedTools ?? []) as string[];
    options.disallowedTools = [...cur, ...config.excludedBuiltinAgents];
  }

  return { options, permissionMode, requiresDangerousSkip };
}

export default mapConfig;
