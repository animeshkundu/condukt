import type { AgentRuntime, AgentSession, SessionConfig, SessionCreationOptions, RuntimeCapabilities } from '../../src/types';
import { ClaudeAgentSession } from './claude-session';
import type { BridgeRuntimeConfig } from './protocol-bridge';

export interface ClaudeRuntimeOptions {
  /**
   * Point the Claude CLI at the in-process protocol bridge, translating
   * its Anthropic traffic to OpenCode Go / Zen upstreams (Anthropic
   * pass-through, OpenAI chat/completions, or OpenAI Responses — chosen
   * per model). One bridge is started lazily per session and closed on
   * abort.
   */
  readonly bridge?: BridgeRuntimeConfig;
}

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly name = 'claude';
  /**
   * - `readOnlyPermissions`: read-only is enforced with a positive built-in
   *   allow-list plus `dontAsk`, not a deny-list.
   * - `requiredModeVerification`: `init` reads the applied permission mode
   *   and tool set back, so `requireMode` is a verified contract.
   * - `sessionRecovery`: bounded same-session resume with the fixed
   *   continuation prompt (ADR-009; string-prompt mode has no empty turn).
   */
  readonly capabilities: RuntimeCapabilities = {
    readOnlyPermissions: true,
    requiredModeVerification: true,
    sessionRecovery: true,
  };
  private readonly options: ClaudeRuntimeOptions;

  constructor(options: ClaudeRuntimeOptions = {}) {
    this.options = options;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await import('@anthropic-ai/claude-agent-sdk');
    } catch {
      return false;
    }
    // Verify the Claude Code CLI is reachable.
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync(process.env.CLAUDE_CODE_EXECUTABLE ?? 'claude', ['--version'], { timeout: 5000, stdio: 'ignore' });
      return true;
    } catch {
      // Without an explicit path the CLI may be bundled with the SDK, so a
      // failed probe is not proof of absence. With one, the operator named
      // the binary: a path that does not run is a misconfiguration, and
      // answering "available" here defers the failure to the first turn.
      const explicit = (process.env.CLAUDE_CODE_EXECUTABLE ?? '').trim();
      return explicit.length === 0;
    }
  }

  async createSession(config: SessionConfig, options?: SessionCreationOptions): Promise<AgentSession> {
    return new ClaudeAgentSession(config, options, this.options.bridge);
  }
}

export function createClaudeRuntime(options: ClaudeRuntimeOptions = {}): AgentRuntime {
  return new ClaudeAgentRuntime(options);
}
