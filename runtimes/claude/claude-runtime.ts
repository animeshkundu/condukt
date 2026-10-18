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
  // Claude does not expose Copilot-style permission callbacks or post-set mode
  // readback, and same-session recovery beyond resume is not implemented.
  // Claim no capabilities so agent.ts fails fast on explicitly-requested
  // policies rather than silently degrading.
  readonly capabilities: RuntimeCapabilities | undefined = undefined;
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
      // CLI may be bundled; don't hard-fail availability on CLI probe.
      return true;
    }
  }

  async createSession(config: SessionConfig, options?: SessionCreationOptions): Promise<AgentSession> {
    return new ClaudeAgentSession(config, options, this.options.bridge);
  }
}

export function createClaudeRuntime(options: ClaudeRuntimeOptions = {}): AgentRuntime {
  return new ClaudeAgentRuntime(options);
}
