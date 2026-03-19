/**
 * Flow framework type system — generic, zero domain imports.
 *
 * Three primitives: agent(), deterministic(), gate()
 * One combinator: verify()
 * One composition: FlowGraph + run()
 */

import type { ExecutionEvent, OutputEvent } from './events';

// ---------------------------------------------------------------------------
// Branded types (opt-in — structural, zero runtime cost)
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Branded execution identifier. Create: `'my-id' as ExecutionId` */
export type ExecutionId = Brand<string, 'ExecutionId'>;

// ---------------------------------------------------------------------------
// Computation contract
// ---------------------------------------------------------------------------

/**
 * The fundamental callable unit.
 * Receives NodeInput (composition data) + ExecutionContext (runtime services).
 * Returns a routing action + optional artifact.
 */
export type NodeFn = (input: NodeInput, ctx: ExecutionContext) => Promise<NodeOutput>;

/** What every node receives — composition-defined, framework-opaque. */
export interface NodeInput {
  readonly dir: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly artifactPaths: Readonly<Record<string, string>>;
  readonly retryContext?: RetryContext;
}

/** What every node returns — the scheduler handles event emission from this. */
export interface NodeOutput {
  readonly action: string;
  readonly artifact?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Populated on retry: prior output + check feedback + user override. */
export interface RetryContext {
  readonly priorOutput: string | null;
  readonly feedback: string;
  readonly override?: string;
}

/** Runtime services injected by the scheduler — not shared mutable state. */
export interface ExecutionContext {
  readonly executionId: string;
  readonly nodeId: string;
  readonly runtime: AgentRuntime;
  readonly emitOutput: (event: OutputEvent) => void;
  readonly signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Fan-out / loop-back
// ---------------------------------------------------------------------------

/** An edge target: single node or fan-out to multiple nodes. */
export type EdgeTarget = string | readonly string[];

/** Configuration for a loop-back fallback when maxIterations is exceeded. */
export interface LoopFallbackEntry {
  readonly source: string;
  readonly action: string;
  readonly fallbackTarget: EdgeTarget;
  readonly maxIterations?: number;
  /** Extract rich feedback from source node output for loop-back retry context. */
  readonly feedbackExtractor?: (
    sourceOutput: string | null,
    sourceMetadata: Record<string, unknown>,
  ) => string;
}

// ---------------------------------------------------------------------------
// Composition contract
// ---------------------------------------------------------------------------

/** A complete flow graph: nodes + edges + start. */
export interface FlowGraph {
  readonly nodes: Readonly<Record<string, NodeEntry>>;
  readonly edges: Readonly<Record<string, Readonly<Record<string, EdgeTarget>>>>;
  readonly start: readonly string[];
  readonly maxIterations?: number;
  readonly loopFallback?: Readonly<Record<string, LoopFallbackEntry>>;
}

/** A node in the flow graph. */
export interface NodeEntry {
  readonly fn: NodeFn;
  readonly displayName: string;
  readonly nodeType: 'agent' | 'deterministic' | 'gate' | 'verify';
  readonly output?: string;
  readonly reads?: readonly string[];
  readonly model?: string;
  readonly timeout?: number; // seconds, default 3600
}

// ---------------------------------------------------------------------------
// Execution contract
// ---------------------------------------------------------------------------

export interface RunOptions {
  readonly executionId: string;
  readonly dir: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly runtime: AgentRuntime;
  readonly emitState: (event: ExecutionEvent) => Promise<void>;
  readonly emitOutput: (event: OutputEvent) => void;
  readonly signal: AbortSignal;
  readonly resumeFrom?: ResumeState;
  /** PARITY-1: RetryContext for specific nodes (nodeId → RetryContext). */
  readonly retryContexts?: Readonly<Record<string, RetryContext>>;
}

export interface RunResult {
  readonly completed: boolean;
  readonly durationMs: number;
}

export interface ResumeState {
  readonly completedNodes: Map<string, { action: string; finishedAt: number }>;
  readonly firedEdges: Map<string, Set<string>>; // target → sources that routed there
  readonly nodeStatuses: Map<string, string>;
  readonly loopIterations: Map<string, number>; // source:action → iteration count
}

// ---------------------------------------------------------------------------
// Runtime contract (implemented by CopilotBackend, Claude SDK, etc.)
// ---------------------------------------------------------------------------

export interface AgentRuntime {
  createSession(config: SessionConfig): Promise<AgentSession>;
  isAvailable(): Promise<boolean>;
  readonly name: string;
}

export type ThinkingBudget = 'low' | 'medium' | 'high' | 'xhigh';

export interface SessionConfig {
  readonly model: string;
  readonly thinkingBudget?: ThinkingBudget;
  readonly cwd: string;
  readonly addDirs: readonly string[];
  readonly timeout: number;      // seconds
  readonly heartbeatTimeout: number; // seconds
  /** System message to append to the agent's context (SdkBackend only). */
  readonly systemMessage?: string;
  /** Tool allow-list: only these tools are available (SdkBackend only). */
  readonly availableTools?: readonly string[];
  /** Tool deny-list: these tools are excluded (SdkBackend only). */
  readonly excludedTools?: readonly string[];
}

export interface AgentSession {
  readonly pid: number | null;
  send(prompt: string): void;
  // Core events (all backends)
  on(event: 'text', handler: (text: string) => void): void;
  on(event: 'tool_start', handler: (tool: string, input: string, args: Record<string, unknown>, callId?: string) => void): void;
  on(event: 'tool_complete', handler: (tool: string, output: string, callId?: string) => void): void;
  on(event: 'tool_output', handler: (tool: string, output: string) => void): void;
  on(event: 'idle', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'reasoning', handler: (text: string) => void): void;
  // Rich events (SdkBackend fires these; SubprocessBackend silently stores handlers)
  on(event: 'intent', handler: (intent: string) => void): void;
  on(event: 'usage', handler: (data: Record<string, unknown>) => void): void;
  on(event: 'tool_complete_rich', handler: (tool: string, contents: ReadonlyArray<Record<string, unknown>>, callId?: string) => void): void;
  on(event: 'subagent_start', handler: (name: string, data: Record<string, unknown>) => void): void;
  on(event: 'subagent_end', handler: (name: string, data: Record<string, unknown>) => void): void;
  on(event: 'permission', handler: (data: Record<string, unknown>) => void): void;
  on(event: 'compaction', handler: (phase: string, summary?: string) => void): void;
  abort(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent factory config
// ---------------------------------------------------------------------------

export type PromptOutput = string | { system: string; user: string };

export interface ToolRef {
  readonly id: string;
  readonly displayName: string;
}

export interface AgentConfig {
  readonly objective: string;
  readonly tools: readonly ToolRef[];
  readonly output?: string;
  readonly reads?: readonly string[];
  readonly model?: string;
  readonly thinkingBudget?: ThinkingBudget;
  readonly isolation?: boolean;
  readonly timeout?: number;         // seconds, default 3600
  readonly heartbeatTimeout?: number; // seconds, default 120
  /** Override session cwd. Default: input.dir. Use for running in repo dir while artifacts go to input.dir. */
  readonly cwdResolver?: (input: NodeInput) => string;
  readonly setup?: (input: NodeInput) => void | Promise<void>;
  readonly teardown?: (input: NodeInput) => void | Promise<void>;
  readonly promptBuilder: (input: NodeInput) => PromptOutput; // REQUIRED — no generic fallback
  readonly actionParser?: (artifactContent: string) => string;
  readonly completionIndicators?: readonly string[]; // GT-3 crash recovery
  /** System message appended to the agent's context (SdkBackend only). */
  readonly systemMessage?: string;
  /** Tool allow-list (SdkBackend only). */
  readonly availableTools?: readonly string[];
  /** Tool deny-list (SdkBackend only). */
  readonly excludedTools?: readonly string[];
}

// ---------------------------------------------------------------------------
// Projection (materialized view — the API serves this directly)
// ---------------------------------------------------------------------------

export interface ExecutionProjection {
  readonly id: string;
  readonly flowId: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'crashed';
  readonly params: Record<string, unknown>;
  readonly graph: {
    readonly nodes: ReadonlyArray<ProjectionNode>;
    readonly edges: ReadonlyArray<ProjectionEdge>;
    readonly activeNodes: readonly string[];
    readonly completedPath: readonly string[];
  };
  readonly totalCost: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly metadata: Record<string, unknown>;
}

export interface ProjectionNode {
  readonly id: string;
  readonly displayName: string;
  readonly nodeType: string;
  readonly model?: string;
  readonly status: string;
  readonly action?: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly elapsedMs?: number;
  readonly attempt: number;
  readonly iteration?: number;
  readonly error?: string;
  readonly output?: string;
  readonly gateData?: Record<string, unknown>;
}

export interface ProjectionEdge {
  readonly source: string;
  readonly action: string;
  readonly target: string;
  readonly state: 'default' | 'taken' | 'not_taken';
}

// ---------------------------------------------------------------------------
// Storage contract
// ---------------------------------------------------------------------------

export interface OutputPage {
  readonly lines: readonly string[];
  readonly offset: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface StorageEngine {
  appendEvent(execId: string, event: ExecutionEvent): void;
  readEvents(execId: string): ExecutionEvent[];
  writeProjection(execId: string, projection: ExecutionProjection): void;
  readProjection(execId: string): ExecutionProjection | null;
  writeArtifact(execId: string, nodeId: string, name: string, content: string): void;
  readArtifact(execId: string, nodeId: string, name: string): string | null;
  appendOutput(execId: string, nodeId: string, line: string): void;
  readOutput(execId: string, nodeId: string, offset?: number, limit?: number): OutputPage;
  closeOutput(execId: string, nodeId: string): void;
  delete(execId: string): boolean;
  listExecutionIds(): string[];
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Type-safe params access: `getParams<MyParams>(projection)` (CR2) */
export function getParams<T>(projection: ExecutionProjection): T {
  return projection.params as T;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FlowAbortedError extends Error {
  constructor(reason: string = 'Flow aborted') {
    super(reason);
    this.name = 'FlowAbortedError';
  }
}

export class FlowValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Flow validation failed:\n${issues.map(i => `  - ${i}`).join('\n')}`);
    this.name = 'FlowValidationError';
  }
}
