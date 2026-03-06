/**
 * Flow framework events — the complete event contract.
 *
 * 15 execution events (persisted to JSONL event log).
 * 2 output events (streamed, not persisted in event log).
 *
 * All events carry executionId + ts. Zero domain types.
 */

// ---------------------------------------------------------------------------
// Graph skeleton — seeded from FlowGraph at run start
// ---------------------------------------------------------------------------

export interface GraphNodeSkeleton {
  readonly id: string;
  readonly displayName: string;
  readonly nodeType: string;
  readonly model?: string;
  readonly output?: string;
}

export interface GraphEdgeSkeleton {
  readonly source: string;
  readonly action: string;
  readonly target: string;
}

// ---------------------------------------------------------------------------
// Execution events (15 types — persisted to JSONL)
// ---------------------------------------------------------------------------

export interface RunStartedEvent {
  readonly type: 'run:started';
  readonly executionId: string;
  readonly flowId: string;
  readonly params: Record<string, unknown>;
  readonly graph: {
    readonly nodes: readonly GraphNodeSkeleton[];
    readonly edges: readonly GraphEdgeSkeleton[];
  };
  readonly ts: number;
}

export interface RunCompletedEvent {
  readonly type: 'run:completed';
  readonly executionId: string;
  readonly status: 'completed' | 'failed' | 'stopped' | 'crashed';
  readonly ts: number;
}

export interface RunResumedEvent {
  readonly type: 'run:resumed';
  readonly executionId: string;
  readonly resumingFrom: readonly string[];
  readonly ts: number;
}

export interface NodeStartedEvent {
  readonly type: 'node:started';
  readonly executionId: string;
  readonly nodeId: string;
  readonly ts: number;
}

export interface NodeCompletedEvent {
  readonly type: 'node:completed';
  readonly executionId: string;
  readonly nodeId: string;
  readonly action: string;
  readonly elapsedMs: number;
  readonly ts: number;
}

export interface NodeFailedEvent {
  readonly type: 'node:failed';
  readonly executionId: string;
  readonly nodeId: string;
  readonly error: string;
  readonly ts: number;
}

export interface NodeKilledEvent {
  readonly type: 'node:killed';
  readonly executionId: string;
  readonly nodeId: string;
  readonly ts: number;
}

export interface NodeSkippedEvent {
  readonly type: 'node:skipped';
  readonly executionId: string;
  readonly nodeId: string;
  readonly ts: number;
}

export interface NodeGatedEvent {
  readonly type: 'node:gated';
  readonly executionId: string;
  readonly nodeId: string;
  readonly gateType: string;
  readonly gateData?: Record<string, unknown>;
  readonly ts: number;
}

export interface GateResolvedEvent {
  readonly type: 'gate:resolved';
  readonly executionId: string;
  readonly nodeId: string;
  readonly resolution: string;
  readonly reason?: string;
  readonly ts: number;
}

export interface NodeRetryingEvent {
  readonly type: 'node:retrying';
  readonly executionId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly override?: string;
  readonly ts: number;
}

export interface EdgeTraversedEvent {
  readonly type: 'edge:traversed';
  readonly executionId: string;
  readonly source: string;
  readonly target: string;
  readonly action: string;
  readonly ts: number;
}

export interface ArtifactWrittenEvent {
  readonly type: 'artifact:written';
  readonly executionId: string;
  readonly nodeId: string;
  readonly path: string;
  readonly size: number;
  readonly ts: number;
}

export interface CostRecordedEvent {
  readonly type: 'cost:recorded';
  readonly executionId: string;
  readonly nodeId: string;
  readonly tokens: number;
  readonly model: string;
  readonly cost: number;
  readonly ts: number;
}

export interface MetadataEvent {
  readonly type: 'metadata';
  readonly executionId: string;
  readonly key: string;
  readonly value: unknown;
  readonly ts: number;
}

export interface NodeResetEvent {
  readonly type: 'node:reset';
  readonly executionId: string;
  readonly nodeId: string;
  readonly reason: 'loop-back';
  readonly iteration: number;
  readonly sourceNodeId: string;
  readonly ts: number;
}

/** Discriminated union of all execution events (persisted to JSONL). */
export type ExecutionEvent =
  | RunStartedEvent
  | RunCompletedEvent
  | RunResumedEvent
  | NodeStartedEvent
  | NodeCompletedEvent
  | NodeFailedEvent
  | NodeKilledEvent
  | NodeSkippedEvent
  | NodeGatedEvent
  | GateResolvedEvent
  | NodeRetryingEvent
  | EdgeTraversedEvent
  | ArtifactWrittenEvent
  | CostRecordedEvent
  | MetadataEvent
  | NodeResetEvent;

// ---------------------------------------------------------------------------
// Output events (2 types — streamed, NOT persisted in event log)
// ---------------------------------------------------------------------------

export interface NodeOutputEvent {
  readonly type: 'node:output';
  readonly executionId: string;
  readonly nodeId: string;
  readonly content: string;
  readonly ts: number;
}

export interface NodeToolEvent {
  readonly type: 'node:tool';
  readonly executionId: string;
  readonly nodeId: string;
  readonly tool: string;
  readonly phase: 'start' | 'complete';
  readonly summary: string;
  readonly ts: number;
}

/** Discriminated union of output events (streamed, not persisted). */
export type OutputEvent = NodeOutputEvent | NodeToolEvent;
