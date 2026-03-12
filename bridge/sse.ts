/**
 * SSE streaming utilities for the bridge layer.
 *
 * Extracts the replay-subscribe-heartbeat-cleanup pattern into reusable
 * stream factories. Consumers pass minimal interfaces (EventBusLike,
 * StateRuntimeLike) to avoid tight coupling to concrete classes.
 */

import type { ExecutionProjection, OutputPage } from '../src/types';
import type { ExecutionEvent, OutputEvent } from '../src/events';

// ---------------------------------------------------------------------------
// Minimal interfaces — consumers pass their own implementations
// ---------------------------------------------------------------------------

/** Minimal event-bus interface. Consumers pass their own pub-sub. */
export interface EventBusLike {
  readonly subscribe: (fn: (event: ExecutionEvent | OutputEvent) => void) => () => void;
}

/** StateRuntime-like read interface. Avoids tight coupling to StateRuntime class. */
export interface StateRuntimeLike {
  readonly getProjection: (execId: string) => ExecutionProjection | null;
  readonly getNodeOutput: (
    execId: string,
    nodeId: string,
    offset: number,
    limit: number,
  ) => OutputPage;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

const DEFAULT_HEARTBEAT_MS = 30_000;

function createSSEStream(
  replayFn: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  filterFn: (event: ExecutionEvent | OutputEvent) => boolean,
  eventBus: EventBusLike,
  heartbeatMs: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;

  return new ReadableStream({
    start(controller) {
      replayFn(controller);

      const unsubscribe = eventBus.subscribe((event) => {
        if (!filterFn(event)) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Stream closed by client
        }
      });

      const timer = setInterval(() => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() })}\n\n`,
            ),
          );
        } catch {
          clearInterval(timer);
        }
      }, heartbeatMs);

      cleanup = () => {
        unsubscribe();
        clearInterval(timer);
      };
    },
    cancel() {
      cleanup?.();
    },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an SSE stream for an execution.
 * Replays projection snapshot, then streams live events filtered by executionId.
 */
export function createExecutionSSEStream(
  stateRuntime: StateRuntimeLike,
  eventBus: EventBusLike,
  executionId: string,
  heartbeatMs: number = DEFAULT_HEARTBEAT_MS,
): ReadableStream<Uint8Array> {
  return createSSEStream(
    (controller) => {
      const projection = stateRuntime.getProjection(executionId);
      if (projection) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'snapshot', projection })}\n\n`,
          ),
        );
      }
    },
    (event) => event.executionId === executionId,
    eventBus,
    heartbeatMs,
  );
}

function unescapeFromLog(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\\\/g, '\\');
}

/**
 * Create an SSE stream for a specific node's output.
 * Replays stored output lines, then streams live events filtered by executionId + nodeId.
 */
export function createNodeSSEStream(
  stateRuntime: StateRuntimeLike,
  eventBus: EventBusLike,
  executionId: string,
  nodeId: string,
  heartbeatMs: number = DEFAULT_HEARTBEAT_MS,
): ReadableStream<Uint8Array> {
  return createSSEStream(
    (controller) => {
      const page = stateRuntime.getNodeOutput(executionId, nodeId, 0, 10_000);
      const encoder = new TextEncoder();
      const REASONING_PREFIX = '\x00reasoning\x00';
      const TOOL_OUTPUT_PREFIX = '\x00tool:output\x00';
      const TOOL_PREFIX = '\x00tool:';
      for (const line of page.lines) {
        if (line.startsWith(REASONING_PREFIX)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'node:reasoning', executionId, nodeId,
            content: unescapeFromLog(line.slice(REASONING_PREFIX.length)), ts: 0,
          })}\n\n`));
        } else if (line.startsWith(TOOL_OUTPUT_PREFIX)) {
          const rest = line.slice(TOOL_OUTPUT_PREFIX.length);
          const sepIdx = rest.indexOf('\x00');
          const tool = sepIdx >= 0 ? rest.slice(0, sepIdx) : '';
          const content = sepIdx >= 0 ? unescapeFromLog(rest.slice(sepIdx + 1)) : unescapeFromLog(rest);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'node:output', executionId, nodeId, content, tool, ts: 0,
          })}\n\n`));
        } else if (line.startsWith(TOOL_PREFIX)) {
          const rest = line.slice(1); // skip leading \x00
          const parts = rest.split('\x00');
          const phase = (parts[0] ?? '').split(':')[1] ?? 'start';
          const tool = parts[1] ?? '';
          const summary = unescapeFromLog(parts[2] ?? '');
          // 4th field: JSON-encoded args (only for tool:start, added in Phase 2)
          let args: Record<string, unknown> | undefined;
          if (phase === 'start' && parts[3]) {
            try { args = JSON.parse(unescapeFromLog(parts[3])); } catch { /* old format */ }
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'node:tool', executionId, nodeId, tool, phase, summary,
            ...(args ? { args } : {}),
            ts: 0,
          })}\n\n`));
        } else if (/^\{"type":"(session\.|assistant\.turn_|pending_messages)/.test(line)) {
          // Skip raw CLI JSONL leaked by older SubprocessBackend versions
        } else {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'node:output', executionId, nodeId, content: unescapeFromLog(line), ts: 0,
          })}\n\n`));
        }
      }
    },
    (event) => {
      if (event.executionId !== executionId) return false;
      if ('nodeId' in event && (event as { nodeId: string }).nodeId === nodeId)
        return true;
      return false;
    },
    eventBus,
    heartbeatMs,
  );
}
