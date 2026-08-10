/**
 * CopilotBackend interface -- the abstraction over how we talk to copilot CLI.
 *
 * Three implementations:
 * - SubprocessBackend: Proven, works today (child_process.spawn)
 * - SdkBackend: Uses @github/copilot-sdk (CopilotClient over JSON-RPC/stdio)
 * - AcpBackend: Structured events via ACP protocol (copilot --acp)
 *
 * The orchestrator depends on this interface, not on any implementation.
 */

import type { AdvisorConfig, PanelToolConfig } from '../../src/types';
import type { SubagentLimits, SubagentRosterOption } from './subagents';

export interface MCPServerConfig {
  readonly type?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly tools?: readonly string[];
  readonly timeout?: number;
  readonly [key: string]: unknown;
}

export interface CustomAgentConfig {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly tools?: readonly string[] | null;
  readonly prompt: string;
  readonly mcpServers?: Readonly<Record<string, MCPServerConfig>>;
  readonly infer?: boolean;
  readonly skills?: readonly string[];
  readonly model?: string;
}

export interface DefaultAgentConfig {
  readonly excludedTools?: readonly string[];
}

export type CompactionMode = 'stock' | 'aggressive' | 'adaptive';
export type SessionMode = 'autopilot' | 'plan';

export interface SessionConfig extends SubagentLimits {
  /** Model to use: "claude-opus-4.6", "gpt-5.4", etc. */
  readonly model: string;
  /** Thinking budget level for extended thinking models */
  readonly thinkingBudget?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Context-window tier to request from the Copilot SDK. */
  readonly contextTier?: 'default' | 'long_context';
  /** Stock documented compaction is default; aggressive and adaptive are opt-in. */
  readonly compactionMode?: CompactionMode;
  /** Session behavior mode. Defaults to autopilot. */
  readonly mode?: SessionMode;
  readonly advisor?: AdvisorConfig;
  readonly panel?: PanelToolConfig;
  /** MCP server configurations for the root session, or false to disable them. */
  readonly mcpServers?: Readonly<Record<string, MCPServerConfig>> | false;
  /** Working directory for the agent (repo root) */
  readonly cwd: string;
  /** Additional directories the agent can access. [] = isolation (step 2a) */
  readonly addDirs: readonly string[];
  /** Hard timeout -- kill after this many seconds */
  readonly timeout: number;
  /** Heartbeat timeout -- kill if no output for this many seconds */
  readonly heartbeatTimeout: number;
  /** System message to append to the agent's context (SdkBackend only). */
  readonly systemMessage?: string;
  /** Tool allow-list: only these tools are available (SdkBackend only). */
  readonly availableTools?: readonly string[];
  /** Tool deny-list: these tools are excluded (SdkBackend only). */
  readonly excludedTools?: readonly string[];
  /** Custom subagent definitions (SdkBackend only). */
  readonly customAgents?: readonly CustomAgentConfig[];
  /** Stable subagent model/settings roster, or false to opt out (SdkBackend only). */
  readonly subagentRoster?: SubagentRosterOption;
  /** Main-agent configuration (SdkBackend only). */
  readonly defaultAgent?: DefaultAgentConfig;
  /** Built-in subagents unavailable to this session (SdkBackend only). */
  readonly excludedBuiltinAgents?: readonly string[];
}

// ---------------------------------------------------------------------------
// Rich event types (emitted by SdkBackend, not by SubprocessBackend)
// ---------------------------------------------------------------------------

/** Token usage metrics from assistant.usage events. */
export interface UsageData {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly model?: string;
  readonly [key: string]: unknown;
}

/** Structured tool result with content blocks (from tool.execution_complete). */
export interface RichToolResult {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly contents: ReadonlyArray<ContentBlock>;
}

/** A content block from a tool result (image, text, resource, etc.). */
export interface ContentBlock {
  readonly type: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly uri?: string;
  readonly name?: string;
  readonly title?: string;
  readonly alt?: string;
  readonly [key: string]: unknown;
}

/** Permission request data from the agent. */
export interface PermissionInfo {
  readonly kind?: string;
  readonly detail?: string;
  readonly approved?: boolean;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Session interface
// ---------------------------------------------------------------------------

export interface ContextAttributionEntry {
  readonly kind: string;
  readonly id: string;
  readonly label: string;
  readonly tokens: number;
  readonly parentId?: string;
  readonly attributes?: Readonly<Record<string, string | undefined>>;
}

export interface SessionContextAttribution {
  readonly totalTokens: number;
  readonly entries: readonly ContextAttributionEntry[];
  readonly compactions: { readonly count: number };
}

export interface ContextHeaviestMessage {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  readonly tokens: number;
}

export interface ContextHeaviestMessages {
  readonly totalTokens: number;
  readonly messages: readonly ContextHeaviestMessage[];
}

export interface RecomputedContextTokens {
  readonly totalTokens: number;
  readonly messagesTokenCount: number;
  readonly systemTokenCount: number;
}

export interface SessionUsageTokenDetail {
  readonly tokenCount: number;
}

export interface SessionUsageCodeChanges {
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly filesModifiedCount: number;
  readonly filesModified: readonly string[];
}

export interface SessionUsageModelMetric {
  readonly requests: {
    readonly count: number;
    readonly cost: number;
  };
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens?: number;
  };
  readonly cacheExpiresAt?: string;
  readonly totalNanoAiu?: number;
  readonly tokenDetails?: Readonly<Record<string, SessionUsageTokenDetail | undefined>>;
}

export interface SessionUsageMetrics {
  readonly totalPremiumRequestCost: number;
  readonly totalUserRequests: number;
  readonly totalNanoAiu?: number;
  readonly tokenDetails?: Readonly<Record<string, SessionUsageTokenDetail | undefined>>;
  readonly totalApiDurationMs: number;
  readonly sessionStartTime: string;
  readonly codeChanges: SessionUsageCodeChanges;
  readonly modelMetrics: Readonly<Record<string, SessionUsageModelMetric | undefined>>;
  readonly currentModel?: string;
  readonly lastCallInputTokens: number;
  readonly lastCallOutputTokens: number;
}

export interface CopilotSessionMetadata {
  getContextAttribution(): Promise<SessionContextAttribution | null>;
  getContextHeaviestMessages(limit?: number): Promise<ContextHeaviestMessages>;
  recomputeContextTokens(modelId?: string): Promise<RecomputedContextTokens>;
}

export interface CopilotSessionUsage {
  getMetrics(): Promise<SessionUsageMetrics>;
}

export interface CopilotSessionHistory {
  /** Produce a markdown summary suitable for handing the session to a successor. */
  summarizeForHandoff(): Promise<string>;
  /** Remove the identified persisted event and every later event. */
  truncate(eventId: string): Promise<number>;
}

export interface CopilotSession {
  /** Subprocess PID (if applicable) for kill operations */
  readonly pid: number | null;

  /** Native long-session history operations when supported by the backend. */
  readonly history?: CopilotSessionHistory;

  /** Native context diagnostics when supported by the backend. */
  readonly metadata?: CopilotSessionMetadata;

  /** Native accumulated usage metrics when supported by the backend. */
  readonly usage?: CopilotSessionUsage;

  /** Send a prompt to the agent. Agent begins working. */
  send(prompt: string): void;

  // Core events (7 — emitted by all backends)
  /** Subscribe to streaming text output from the agent */
  on(event: 'text', handler: (text: string, parentToolCallId?: string) => void): void;
  /** Subscribe to tool execution start (file read, bash, Kusto, etc.) */
  on(event: 'tool_start', handler: (tool: string, input: string, args: Record<string, unknown>, callId?: string, parentToolCallId?: string) => void): void;
  /** Subscribe to tool execution completion */
  on(event: 'tool_complete', handler: (tool: string, output: string, callId?: string, parentToolCallId?: string) => void): void;
  /** Subscribe to tool execution output (partial results with tool attribution) */
  on(event: 'tool_output', handler: (tool: string, output: string, parentToolCallId?: string) => void): void;
  /** Agent finished all work */
  on(event: 'idle', handler: () => void): void;
  /** Agent encountered an error */
  on(event: 'error', handler: (err: Error) => void): void;
  /** Subscribe to reasoning/thinking token output from the agent */
  on(event: 'reasoning', handler: (text: string) => void): void;

  // Rich events (SdkBackend only; SubprocessBackend silently stores handlers, never fires)
  /** Agent announced its intent / what it's doing */
  on(event: 'intent', handler: (intent: string) => void): void;
  /** Token usage / cost metrics */
  on(event: 'usage', handler: (data: UsageData) => void): void;
  /** Structured tool completion with content blocks */
  on(event: 'tool_complete_rich', handler: (tool: string, contents: ReadonlyArray<ContentBlock>, callId?: string) => void): void;
  /** Sub-agent started */
  on(event: 'subagent_start', handler: (name: string, data: Record<string, unknown>) => void): void;
  /** Sub-agent ended (completed or failed) */
  on(event: 'subagent_end', handler: (name: string, data: Record<string, unknown>) => void): void;
  /** Permission request from the agent */
  on(event: 'permission', handler: (data: PermissionInfo) => void): void;
  /** Context compaction started or completed (infinite sessions) */
  on(event: 'compaction', handler: (phase: 'start' | 'complete', summary?: string) => void): void;

  /** Abort the session -- kill the agent process */
  abort(): Promise<void>;
}

export interface SessionCreationOptions {
  readonly signal?: AbortSignal;
}

export interface CopilotBackend {
  /** Create a new agent session with the given configuration */
  createSession(
    config: SessionConfig,
    options?: SessionCreationOptions,
  ): Promise<CopilotSession>;

  /** Check if copilot CLI is available */
  isAvailable(): Promise<boolean>;

  /** Get the backend type name (for logging) */
  readonly name: string;
}
