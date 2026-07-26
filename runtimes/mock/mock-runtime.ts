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
  /** Text lines to emit, or one text value per send. */
  readonly text?: readonly string[] | readonly (readonly string[])[];
  /** Reasoning lines to emit (each becomes a 'reasoning' event, emitted before text). */
  readonly reasoning?: readonly string[];
  /** Tool call sequence to emit as tool_start / tool_complete pairs. */
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly input: string;
    readonly output: string;
  }>;
  /** Artifact content to write, or one artifact value per send. */
  readonly artifact?: string | readonly string[];
  /** Override the SessionConfig-derived artifact filename. */
  readonly artifactFilename?: string;
  /** If provided, emit this error instead of idle. */
  readonly error?: Error;
  /** Delay in milliseconds before emitting events (simulates work). */
  readonly delay?: number;
}

type SessionEvent =
  | { event: 'text'; handler: (text: string) => void }
  | { event: 'reasoning'; handler: (text: string) => void }
  | { event: 'tool_start'; handler: (tool: string, input: string, args: Record<string, unknown>) => void }
  | { event: 'tool_complete'; handler: (tool: string, output: string) => void }
  | { event: 'tool_output'; handler: (tool: string, output: string) => void }
  | { event: 'idle'; handler: () => void }
  | { event: 'error'; handler: (err: Error) => void };

function sequenceValue<T>(values: readonly T[], index: number): T | undefined {
  if (values.length === 0) return undefined;
  return values[Math.min(index, values.length - 1)];
}

function resolveText(
  configured: MockNodeConfig['text'],
  responseIndex: number,
): readonly string[] {
  if (!configured) return [];
  const arrayCount = configured.filter((value) => Array.isArray(value)).length;
  if (arrayCount > 0 && arrayCount < configured.length) {
    throw new Error(
      'MockNodeConfig.text must be string[] (one response) or string[][] (per-send), not mixed',
    );
  }
  if (arrayCount === configured.length && configured.length > 0) {
    return sequenceValue(configured as readonly (readonly string[])[], responseIndex) ?? [];
  }
  return configured as readonly string[];
}

function resolveArtifact(
  configured: MockNodeConfig['artifact'],
  responseIndex: number,
): string | undefined {
  if (configured === undefined || typeof configured === 'string') return configured;
  return sequenceValue(configured, responseIndex);
}

/**
 * A deterministic mock runtime that replays configured events per node.
 *
 * The node is identified by `SessionConfig.nodeId` when provided, falling back
 * to the `cwd` basename for callers that create sessions directly. Callers can
 * also provide a `nodeResolver` function to map SessionConfig to a config key.
 */
export class MockRuntime implements AgentRuntime {
  readonly name = 'mock';
  private readonly configs: Readonly<Record<string, MockNodeConfig>>;
  private readonly nodeResolver: (config: SessionConfig) => string;
  private readonly responseIndexes = new Map<string, number>();

  constructor(
    configs: Readonly<Record<string, MockNodeConfig>>,
    options?: { readonly nodeResolver?: (config: SessionConfig) => string },
  ) {
    this.configs = configs;
    this.nodeResolver = options?.nodeResolver
      ?? ((config) => config.nodeId ?? path.basename(config.cwd));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: SessionConfig): Promise<AgentSession> {
    const nodeKey = this.nodeResolver(config);
    const nodeConfig = this.configs[nodeKey] ?? {};
    // Parity: the node's real configured output (SessionConfig.artifactFilename,
    // set by agent() from config.output) wins so the mock writes where the node
    // actually reads. nodeConfig.artifactFilename is only an override for tests
    // driving MockRuntime directly (no SessionConfig filename present).
    const artifactFilename = config.artifactFilename
      ?? nodeConfig.artifactFilename
      ?? 'output.md';
    return new MockAgentSession(
      nodeConfig,
      config.cwd,
      artifactFilename,
      () => this.claimResponseIndex(nodeKey),
    );
  }

  private claimResponseIndex(nodeKey: string): number {
    const index = this.responseIndexes.get(nodeKey) ?? 0;
    this.responseIndexes.set(nodeKey, index + 1);
    return index;
  }
}

class MockAgentSession implements AgentSession {
  readonly pid: number | null = null;
  private handlers: SessionEvent[] = [];
  private readonly nodeConfig: MockNodeConfig;
  private readonly cwd: string;
  private readonly artifactFilename: string;
  private readonly claimResponseIndex: () => number;
  private aborted = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    nodeConfig: MockNodeConfig,
    cwd: string,
    artifactFilename: string,
    claimResponseIndex: () => number,
  ) {
    this.nodeConfig = nodeConfig;
    this.cwd = cwd;
    this.artifactFilename = artifactFilename;
    this.claimResponseIndex = claimResponseIndex;
  }

  send(_prompt: string): void {
    const delay = this.nodeConfig.delay ?? 0;
    const responseIndex = this.claimResponseIndex();

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
      const text = resolveText(this.nodeConfig.text, responseIndex);
      for (const line of text) {
        if (this.aborted) return;
        this.emit('text', line);
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
      const artifact = resolveArtifact(this.nodeConfig.artifact, responseIndex);
      if (artifact !== undefined) {
        try {
          const artifactPath = path.join(this.cwd, this.artifactFilename);
          fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
          fs.writeFileSync(artifactPath, artifact, 'utf-8');
        } catch (error) {
          this.emit(
            'error',
            error instanceof Error ? error : new Error(String(error)),
          );
          return;
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
