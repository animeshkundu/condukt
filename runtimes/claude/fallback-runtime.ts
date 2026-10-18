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
    // Intersection: Claude is more permissive; Copilot is the stricter superset claimant.
    // We advertise Claude's capabilities only when Copilot absent.
    if (this.copilot?.capabilities) return this.copilot.capabilities;
    return this.claude.capabilities;
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
