import type { AgentRuntime, AgentSession, SessionConfig, SessionCreationOptions, RuntimeCapabilities } from '../../src/types';
import { ClaudeAgentRuntime } from './claude-runtime';
import type { ClaudeRuntimeOptions } from './claude-runtime';

export class FallbackRuntime implements AgentRuntime {
  readonly name = 'fallback';
  private copilot: AgentRuntime | null;
  private claude: AgentRuntime;
  private active: AgentRuntime | null = null;

  constructor(copilot: AgentRuntime | null, claudeOptions: ClaudeRuntimeOptions = {}) {
    this.copilot = copilot;
    this.claude = new ClaudeAgentRuntime(claudeOptions);
  }

  async isAvailable(): Promise<boolean> {
    if (this.copilot && (await this.copilot.isAvailable())) return true;
    return this.claude.isAvailable();
  }

  get capabilities(): RuntimeCapabilities | undefined {
    const claude = this.claude.capabilities;
    if (this.copilot === null) return claude;
    const copilot = this.copilot.capabilities;
    // Either runtime may serve the next session, so advertise only what both
    // guarantee. A Copilot runtime that claims nothing makes its guarantees
    // unknown: repeating the required mode-verification flags on its behalf
    // would let a caller require enforcement that may not exist. Claude's
    // capabilities are all it has, and the fallback never exceeds them.
    if (copilot === undefined || claude === undefined) return undefined;
    // Recovery is opt-in per turn: it is safe to promise only when both
    // runtimes can actually resume a failed turn in its persisted session.
    const recovery = copilot.sessionRecovery === true && claude.sessionRecovery === true;
    return {
      readOnlyPermissions: true,
      requiredModeVerification: true,
      ...(recovery ? { sessionRecovery: true as const } : {}),
    };
  }

  async createSession(config: SessionConfig, options?: SessionCreationOptions): Promise<AgentSession> {
    if (this.copilot) {
      try {
        if (await this.copilot.isAvailable()) {
          this.active = this.copilot;
          return await this.copilot.createSession(config, options);
        }
      } catch {
        // fall through
      }
    }
    this.active = this.claude;
    // Transparency event via logger? Emit through session not available yet; log to stderr.
    // eslint-disable-next-line no-console
    console.warn('[condukt] Copilot unavailable; falling back to Claude runtime');
    return this.claude.createSession(config, options);
  }
}

export function createFallbackRuntime(copilot: AgentRuntime | null, claudeOptions: ClaudeRuntimeOptions = {}): AgentRuntime {
  return new FallbackRuntime(copilot, claudeOptions);
}
