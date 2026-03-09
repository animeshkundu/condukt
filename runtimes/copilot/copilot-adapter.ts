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
import type { AgentRuntime, AgentSession, SessionConfig } from '../../src/types';

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

    isAvailable(): Promise<boolean> {
      return backend.isAvailable();
    },

    async createSession(config: SessionConfig): Promise<AgentSession> {
      // Map flow SessionConfig → CopilotBackend SessionConfig
      const copilotConfig = {
        model: config.model,
        thinkingBudget: config.thinkingBudget,
        cwd: config.cwd,
        addDirs: config.addDirs,
        timeout: config.timeout,
        heartbeatTimeout: config.heartbeatTimeout,
      };

      const session: CopilotSession = await backend.createSession(copilotConfig);

      // CopilotSession and AgentSession are structurally identical —
      // same methods, same event signatures. Direct pass-through.
      return session;
    },
  };
}
