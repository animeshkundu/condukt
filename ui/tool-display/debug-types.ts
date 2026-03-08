/**
 * Agent debug event types — fully serializable, zero framework dependencies.
 *
 * Adapted from VS Code Copilot Chat agentDebugTypes.ts (MIT).
 * const enum → string union (enums don't survive cross-package boundaries).
 */

// ── Event categories ─────────────────────────────────────────────────────────

export type AgentDebugEventCategory =
  | 'discovery'
  | 'toolCall'
  | 'llmRequest'
  | 'error'
  | 'loopControl';

// ── Base event ───────────────────────────────────────────────────────────────

export interface IAgentDebugEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly category: AgentDebugEventCategory;
  readonly sessionId: string;
  readonly summary: string;
  readonly details: Record<string, unknown>;
  /** When set, this event is a child of the event with the given id. */
  readonly parentEventId?: string;
}

// ── Discovery ────────────────────────────────────────────────────────────────

export type DiscoveryResourceType = 'instruction' | 'skill' | 'agent' | 'prompt';
export type DiscoverySource = 'workspace' | 'user' | 'org' | 'extension';

export interface IDiscoveryEvent extends IAgentDebugEvent {
  readonly category: 'discovery';
  readonly resourceType: DiscoveryResourceType;
  readonly source: DiscoverySource;
  readonly resourcePath: string;
  readonly matched: boolean;
  readonly applyToPattern?: string;
  readonly discoveryDurationMs?: number;
}

// ── Tool call ────────────────────────────────────────────────────────────────

export type ToolCallStatus = 'pending' | 'success' | 'failure';

export interface IToolCallEvent extends IAgentDebugEvent {
  readonly category: 'toolCall';
  readonly toolName: string;
  readonly argsSummary: string;
  readonly status: ToolCallStatus;
  readonly durationMs?: number;
  readonly resultSummary?: string;
  readonly errorMessage?: string;
  readonly isSubAgent?: boolean;
  readonly childCount?: number;
  readonly subAgentName?: string;
  readonly requestLogEntryId?: string;
}

// ── LLM request ──────────────────────────────────────────────────────────────

export interface ILLMRequestEvent extends IAgentDebugEvent {
  readonly category: 'llmRequest';
  readonly requestName: string;
  readonly durationMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
  readonly totalTokens: number;
  readonly status: 'success' | 'failure' | 'canceled';
  readonly errorMessage?: string;
  readonly model?: string;
  readonly timeToFirstTokenMs?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly requestLogEntryId?: string;
}

// ── Error ────────────────────────────────────────────────────────────────────

export type ErrorType =
  | 'toolFailure'
  | 'rateLimit'
  | 'contextOverflow'
  | 'timeout'
  | 'networkError'
  | 'redundancy';

export interface IErrorEvent extends IAgentDebugEvent {
  readonly category: 'error';
  readonly errorType: ErrorType;
  readonly originalError?: string;
  readonly toolName?: string;
}

// ── Loop control ─────────────────────────────────────────────────────────────

export type LoopAction = 'start' | 'iteration' | 'yield' | 'stop';

export interface ILoopControlEvent extends IAgentDebugEvent {
  readonly category: 'loopControl';
  readonly loopAction: LoopAction;
  readonly iterationIndex?: number;
  readonly reason?: string;
}

// ── Discriminated union ──────────────────────────────────────────────────────

export type AgentDebugEvent =
  | IDiscoveryEvent
  | IToolCallEvent
  | ILLMRequestEvent
  | IErrorEvent
  | ILoopControlEvent;

// ── Filter ───────────────────────────────────────────────────────────────────

export interface IAgentDebugEventFilter {
  readonly categories?: readonly AgentDebugEventCategory[];
  readonly sessionId?: string;
  readonly timeRange?: { readonly start: number; readonly end: number };
  readonly statusFilter?: string;
}

// ── Session summary ──────────────────────────────────────────────────────────

export interface ISessionSummary {
  readonly toolCount: number;
  readonly totalTokens: number;
  readonly durationMs: number;
  readonly errorCount: number;
  readonly cachedTokenRatio: number;
}
