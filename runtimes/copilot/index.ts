export type { CopilotBackend, CopilotSession, SessionConfig as CopilotSessionConfig } from './copilot-backend';
export { SubprocessBackend } from './subprocess-backend';
export { adaptCopilotBackend } from './copilot-adapter';
export { isProcessAlive, killProcessTree } from './process-killer';
