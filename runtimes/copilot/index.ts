export type {
  CopilotBackend,
  CopilotSession,
  CopilotSessionHistory,
  CopilotSessionMetadata,
  CopilotSessionUsage,
  CompactionMode,
  SessionMode,
  PermissionPolicy,
  SessionConfig as CopilotSessionConfig,
  UsageData,
  RichToolResult,
  ContentBlock,
  PermissionInfo,
  ContextAttributionEntry,
  SessionContextAttribution,
  ContextHeaviestMessage,
  ContextHeaviestMessages,
  RecomputedContextTokens,
  SessionUsageTokenDetail,
  SessionUsageCodeChanges,
  SessionUsageModelMetric,
  SessionUsageMetrics,
} from './copilot-backend';
export { SubprocessBackend } from './subprocess-backend';
export { SdkBackend } from './sdk-backend';
export type { SdkBackendOptions, TerminalLogLevel } from './sdk-backend';
export {
  DEFAULT_COMPLEMENTARY_MODEL_POLICY,
  DEFAULT_COMPLEMENTARY_MODEL_PREFERENCE,
  DEFAULT_SUBAGENT_ROSTER,
  MODEL_TIER_CATALOG,
  MODEL_TIERS,
  mergeSubagentRosters,
  resolveComplementaryModel,
  resolveSubagentRosterModels,
  resolveTieredCustomAgents,
} from './subagents';
export type {
  ComplementaryModelPolicy,
  ComplementaryModelResolution,
  ModelLab,
  ModelTier,
  ModelTierDefinition,
  ResolvedSubagentRoster,
  ResolvedTieredCustomAgents,
  SubagentComplementaryResolution,
  TieredCustomAgentDefinition,
  SubagentLimits,
  SubagentRoster,
  SubagentRosterEntry,
  SubagentRosterOption,
  SubagentRosterValue,
} from './subagents';
export { adaptCopilotBackend } from './copilot-adapter';
export { isProcessAlive, killProcessTree } from './process-killer';
