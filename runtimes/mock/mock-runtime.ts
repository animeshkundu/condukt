/**
 * Deterministic mock AgentRuntime for testing.
 *
 * Accepts per-node configuration to produce predictable text, tool,
 * artifact, and error events. Useful for unit and integration tests
 * that need a controllable runtime without real subprocesses.
 */

import type { AgentRuntime, AgentSession, SessionConfig } from '../../src/types';
import * as fs from 'fs';
import * as path from 'path';

export interface MockNodeConfig {
  /** Text lines to emit (each becomes a 'text' event). */
  text?: string[];
  /** Reasoning lines to emit (each becomes a 'reasoning' event, emitted before text). */
  reasoning?: string[];
  /** Tool call sequence to emit as tool_start / tool_complete pairs. */
  tools?: Array<{ name: string; input: string; output: string }>;
  /** Artifact content to write to `<cwd>/<artifactFilename>` (if provided). */
  artifact?: string;
  /** If provided, emit this error instead of idle. */
  error?: Error;
  /** Delay in milliseconds before emitting events (simulates work). */
  delay?: number;
}

type SessionEvent =
  | { event: 'text'; handler: (text: string) => void }
  | { event: 'reasoning'; handler: (text: string) => void }
  | { event: 'tool_start'; handler: (tool: string, input: string, args: Record<string, unknown>) => void }
  | { event: 'tool_complete'; handler: (tool: string, output: string) => void }
  | { event: 'tool_output'; handler: (tool: string, output: string) => void }
  | { event: 'idle'; handler: () => void }
  | { event: 'error'; handler: (err: Error) => void };

/**
 * A deterministic mock runtime that replays configured events per node.
 *
 * The node is identified by the `cwd` basename of the SessionConfig —
 * this maps to how the scheduler sets `cwd` to include the node directory.
 * Alternatively, callers can provide a `nodeResolver` function to map
 * SessionConfig to a config key.
 */
export class MockRuntime implements AgentRuntime {
  readonly name = 'mock';
  private readonly configs: Record<string, MockNodeConfig>;
  private readonly nodeResolver: (config: SessionConfig) => string;

  constructor(
    configs: Record<string, MockNodeConfig>,
    options?: { nodeResolver?: (config: SessionConfig) => string },
  ) {
    this.configs = configs;
    this.nodeResolver = options?.nodeResolver ?? ((config) => path.basename(config.cwd));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: SessionConfig): Promise<AgentSession> {
    const nodeKey = this.nodeResolver(config);
    const nodeConfig = this.configs[nodeKey] ?? {};
    return new MockAgentSession(nodeConfig, config.cwd);
  }
}

class MockAgentSession implements AgentSession {
  readonly pid: number | null = null;
  private handlers: SessionEvent[] = [];
  private readonly nodeConfig: MockNodeConfig;
  private readonly cwd: string;
  private aborted = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(nodeConfig: MockNodeConfig, cwd: string) {
    this.nodeConfig = nodeConfig;
    this.cwd = cwd;
  }

  send(_prompt: string): void {
    const delay = this.nodeConfig.delay ?? 0;

    const execute = () => {
      if (this.aborted) return;

      // Emit reasoning events (before text, matching real agent behavior)
      if (this.nodeConfig.reasoning) {
        for (const line of this.nodeConfig.reasoning) {
          if (this.aborted) return;
          this.emit('reasoning', line);
        }
      }

      // Emit text events
      if (this.nodeConfig.text) {
        for (const line of this.nodeConfig.text) {
          if (this.aborted) return;
          this.emit('text', line);
        }
      }

      // Emit tool events
      if (this.nodeConfig.tools) {
        for (const tool of this.nodeConfig.tools) {
          if (this.aborted) return;
          this.emit('tool_start', tool.name, tool.input, {});
          this.emit('tool_complete', tool.name, tool.output);
        }
      }

      // Write artifact if configured
      if (this.nodeConfig.artifact !== undefined) {
        try {
          // Write the artifact content to a file named 'output.md' in cwd
          const artifactPath = path.join(this.cwd, 'output.md');
          fs.mkdirSync(this.cwd, { recursive: true });
          fs.writeFileSync(artifactPath, this.nodeConfig.artifact, 'utf-8');
        } catch {
          // Best effort — test may not have a writable cwd
        }
      }

      if (this.aborted) return;

      // Emit error or idle
      if (this.nodeConfig.error) {
        this.emit('error', this.nodeConfig.error);
      } else {
        this.emit('idle');
      }
    };

    if (delay > 0) {
      this.timer = setTimeout(execute, delay);
    } else {
      // Use microtask to keep async behavior consistent
      queueMicrotask(execute);
    }
  }

  // Overloads match AgentSession interface exactly.
  on(event: 'text', handler: (text: string) => void): void;
  on(event: 'tool_start', handler: (tool: string, input: string, args: Record<string, unknown>, callId?: string) => void): void;
  on(event: 'tool_complete', handler: (tool: string, output: string, callId?: string) => void): void;
  on(event: 'tool_output', handler: (tool: string, output: string) => void): void;
  on(event: 'idle', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'reasoning', handler: (text: string) => void): void;
  // Rich events: accepted but never fired by MockAgentSession.
  on(event: 'intent', handler: (intent: string) => void): void;
  on(event: 'usage', handler: (data: Record<string, unknown>) => void): void;
  on(event: 'tool_complete_rich', handler: (tool: string, contents: ReadonlyArray<Record<string, unknown>>, callId?: string) => void): void;
  on(event: 'subagent_start', handler: (name: string, data: Record<string, unknown>) => void): void;
  on(event: 'subagent_end', handler: (name: string, data: Record<string, unknown>) => void): void;
  on(event: 'permission', handler: (data: Record<string, unknown>) => void): void;
  on(event: 'compaction', handler: (phase: 'start' | 'complete', summary?: string) => void): void;
  on(event: string, handler: (...args: never[]) => void): void {
    this.handlers.push({ event, handler } as SessionEvent);
  }

  async abort(): Promise<void> {
    this.aborted = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers) {
      if (h.event === event) {
        (h.handler as (...a: unknown[]) => void)(...args);
      }
    }
  }
}
