export type {
  CopilotBackend,
  CopilotSession,
  CopilotSessionHistory,
  CopilotSessionMetadata,
  CopilotSessionUsage,
  CompactionMode,
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
export type { SdkBackendOptions } from './sdk-backend';
export { DEFAULT_SUBAGENT_ROSTER, mergeSubagentRosters } from './subagents';
export type {
  SubagentLimits,
  SubagentRoster,
  SubagentRosterEntry,
  SubagentRosterOption,
  SubagentRosterValue,
} from './subagents';
export { adaptCopilotBackend } from './copilot-adapter';
export { isProcessAlive, killProcessTree } from './process-killer';
