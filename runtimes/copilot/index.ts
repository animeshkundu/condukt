export type { CopilotBackend, CopilotSession, SessionConfig as CopilotSessionConfig, UsageData, RichToolResult, ContentBlock, PermissionInfo } from './copilot-backend';
export { SubprocessBackend } from './subprocess-backend';
export { SdkBackend } from './sdk-backend';
export type { SdkBackendOptions } from './sdk-backend';
export { adaptCopilotBackend } from './copilot-adapter';
export { isProcessAlive, killProcessTree } from './process-killer';
