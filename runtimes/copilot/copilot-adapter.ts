/**
 * CopilotBackend → AgentRuntime adapter.
 *
 * The existing SubprocessBackend implements CopilotBackend. The flow
 * framework expects AgentRuntime. This thin adapter bridges the two
 * interfaces — they are structurally identical, this just maps the types.
 *
 * This adapter allows the flow framework to use the existing proven
 * SubprocessBackend (PATH hardening, NODE_OPTIONS stripping, heartbeat
 * timeout, process kill tree) without any modifications.
 */

import type { CopilotBackend, CopilotSession } from './copilot-backend';
import type {
  AgentRuntime,
  AgentSession,
  SessionConfig,
  SessionCreationOptions,
} from '../../src/types';

/**
 * Wraps a CopilotBackend as an AgentRuntime for the flow framework.
 *
 * Usage:
 * ```typescript
 * import { SubprocessBackend } from './subprocess-backend';
 * import { adaptCopilotBackend } from './copilot-adapter';
 *
 * const backend = new SubprocessBackend();
 * const runtime = adaptCopilotBackend(backend);
 * const bridge = createBridge(runtime, stateRuntime);
 * ```
 */
export function adaptCopilotBackend(backend: CopilotBackend): AgentRuntime {
  return {
    name: backend.name,
    ...(backend.capabilities !== undefined
      ? { capabilities: backend.capabilities }
      : {}),

    isAvailable(): Promise<boolean> {
      return backend.isAvailable();
    },

    async createSession(
      config: SessionConfig,
      options?: SessionCreationOptions,
    ): Promise<AgentSession> {
      // Map flow SessionConfig → CopilotBackend SessionConfig. Forward every
      // field SdkBackend consumes; systemMessage (role instructions + any
      // response schema), the tool filters, and the context tier must reach the
      // backend or the agent runs on the default persona with no system prompt.
      const copilotConfig: import('./copilot-backend').SessionConfig = {
        model: config.model,
        ...(config.thinkingBudget !== undefined
          ? { thinkingBudget: config.thinkingBudget }
          : {}),
        cwd: config.cwd,
        addDirs: config.addDirs,
        timeout: config.timeout,
        heartbeatTimeout: config.heartbeatTimeout,
        ...(config.contextTier !== undefined
          ? { contextTier: config.contextTier }
          : {}),
        ...(config.compactionMode !== undefined
          ? { compactionMode: config.compactionMode }
          : {}),
        ...(config.mode !== undefined
          ? { mode: config.mode }
          : {}),
        ...(config.permissionPolicy !== undefined
          ? { permissionPolicy: config.permissionPolicy }
          : {}),
        ...(config.requireMode !== undefined
          ? { requireMode: config.requireMode }
          : {}),
        ...(config.advisor !== undefined
          ? { advisor: config.advisor }
          : {}),
        ...(config.standIn !== undefined
          ? { standIn: config.standIn }
          : {}),
        ...(config.mcpServers !== undefined
          ? { mcpServers: config.mcpServers }
          : {}),
        ...(config.systemMessage !== undefined
          ? { systemMessage: config.systemMessage }
          : {}),
        ...(config.availableTools !== undefined
          ? { availableTools: config.availableTools }
          : {}),
        ...(config.excludedTools !== undefined
          ? { excludedTools: config.excludedTools }
          : {}),
        ...(config.customAgents !== undefined
          ? { customAgents: config.customAgents }
          : {}),
        ...(config.subagentRoster !== undefined
          ? { subagentRoster: config.subagentRoster }
          : {}),
        ...(config.subagentsEnabled !== undefined
          ? { subagentsEnabled: config.subagentsEnabled }
          : {}),
        ...(config.maxDepth !== undefined
          ? { maxDepth: config.maxDepth }
          : {}),
        ...(config.maxConcurrency !== undefined
          ? { maxConcurrency: config.maxConcurrency }
          : {}),
        ...(config.defaultAgent !== undefined
          ? { defaultAgent: config.defaultAgent }
          : {}),
        ...(config.excludedBuiltinAgents !== undefined
          ? { excludedBuiltinAgents: config.excludedBuiltinAgents }
          : {}),
        ...(config.mcpServerWorkingDirectory !== undefined
          ? { mcpServerWorkingDirectory: config.mcpServerWorkingDirectory }
          : {}),
      };

      const session: CopilotSession = await backend.createSession(copilotConfig, options);

      // CopilotSession and AgentSession are structurally identical —
      // same methods, same event signatures. Direct pass-through.
      return session;
    },
  };
}
