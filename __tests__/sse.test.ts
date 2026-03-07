/**
 * SSE streaming utility tests.
 *
 * Verifies the replay-subscribe-heartbeat-cleanup pattern for both
 * execution-level and node-level SSE streams.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  createExecutionSSEStream,
  createNodeSSEStream,
  type EventBusLike,
  type StateRuntimeLike,
} from '../bridge/sse';
import type { ExecutionEvent, OutputEvent } from '../src/events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a fixed number of chunks from a ReadableStream. */
async function readChunks(
  stream: ReadableStream<Uint8Array>,
  count: number,
): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value));
  }
  reader.releaseLock();
  return chunks;
}

/** Parse an SSE `data:` frame into its JSON payload. */
function parseSSE(chunk: string): unknown {
  const match = chunk.match(/^data: (.+)\n\n$/);
  return match ? JSON.parse(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockStateRuntime(
  overrides?: Partial<StateRuntimeLike>,
): StateRuntimeLike {
  return {
    getProjection:
      overrides?.getProjection ?? (() => null),
    getNodeOutput:
      overrides?.getNodeOutput ??
      (() => ({ lines: [], offset: 0, total: 0, hasMore: false })),
  };
}

function createMockEventBus(): EventBusLike & {
  emit: (event: ExecutionEvent | OutputEvent) => void;
} {
  const listeners = new Set<
    (event: ExecutionEvent | OutputEvent) => void
  >();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    emit(event) {
      for (const fn of listeners) fn(event);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSE streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('execution stream replays snapshot first', async () => {
    const mockProjection = {
      id: 'exec-1',
      flowId: 'test-flow',
      status: 'running' as const,
      params: {},
      graph: { nodes: [], edges: [], activeNodes: [], completedPath: [] },
      totalCost: 0,
      metadata: {},
    };

    const stateRuntime = createMockStateRuntime({
      getProjection: () => mockProjection,
    });
    const eventBus = createMockEventBus();

    const stream = createExecutionSSEStream(
      stateRuntime,
      eventBus,
      'exec-1',
      60_000, // long heartbeat so it doesn't interfere
    );

    const chunks = await readChunks(stream, 1);
    const parsed = parseSSE(chunks[0]) as Record<string, unknown>;

    expect(parsed).toBeDefined();
    expect(parsed.type).toBe('snapshot');
    expect(parsed.projection).toEqual(mockProjection);
  });

  it('execution stream forwards live events', async () => {
    const stateRuntime = createMockStateRuntime();
    const eventBus = createMockEventBus();

    const stream = createExecutionSSEStream(
      stateRuntime,
      eventBus,
      'exec-1',
      60_000,
    );

    // No snapshot (getProjection returns null), so first chunk is a live event.
    const readPromise = readChunks(stream, 1);

    // Emit a matching live event after stream has started.
    eventBus.emit({
      type: 'node:started',
      executionId: 'exec-1',
      nodeId: 'step-1',
      ts: 1000,
    });

    const chunks = await readPromise;
    const parsed = parseSSE(chunks[0]) as Record<string, unknown>;
    expect(parsed.type).toBe('node:started');
    expect(parsed.executionId).toBe('exec-1');
  });

  it('heartbeat sent at configured interval', async () => {
    const stateRuntime = createMockStateRuntime();
    const eventBus = createMockEventBus();

    const stream = createExecutionSSEStream(
      stateRuntime,
      eventBus,
      'exec-1',
      500, // 500ms heartbeat for fast test
    );

    const readPromise = readChunks(stream, 1);

    // Advance past the heartbeat interval.
    vi.advanceTimersByTime(500);

    const chunks = await readPromise;
    const parsed = parseSSE(chunks[0]) as Record<string, unknown>;
    expect(parsed.type).toBe('heartbeat');
    expect(parsed.ts).toEqual(expect.any(Number));
  });

  it('cancel triggers cleanup', async () => {
    const unsubscribeFn = vi.fn();
    const eventBus: EventBusLike = {
      subscribe: () => unsubscribeFn,
    };
    const stateRuntime = createMockStateRuntime();

    const stream = createExecutionSSEStream(
      stateRuntime,
      eventBus,
      'exec-1',
      60_000,
    );

    const reader = stream.getReader();
    await reader.cancel();

    expect(unsubscribeFn).toHaveBeenCalledTimes(1);
  });

  it('node stream filters by executionId and nodeId', async () => {
    const stateRuntime = createMockStateRuntime();
    const eventBus = createMockEventBus();

    const stream = createNodeSSEStream(
      stateRuntime,
      eventBus,
      'exec-1',
      'node-A',
      60_000,
    );

    const readPromise = readChunks(stream, 1);

    // Emit event for wrong node — should be filtered out.
    eventBus.emit({
      type: 'node:output',
      executionId: 'exec-1',
      nodeId: 'node-B',
      content: 'wrong node',
      ts: 1,
    });

    // Emit event for wrong execution — should be filtered out.
    eventBus.emit({
      type: 'node:output',
      executionId: 'exec-2',
      nodeId: 'node-A',
      content: 'wrong exec',
      ts: 2,
    });

    // Emit event for correct execution + node — should pass through.
    eventBus.emit({
      type: 'node:output',
      executionId: 'exec-1',
      nodeId: 'node-A',
      content: 'correct',
      ts: 3,
    });

    const chunks = await readPromise;
    const parsed = parseSSE(chunks[0]) as Record<string, unknown>;
    expect(parsed.type).toBe('node:output');
    expect(parsed.nodeId).toBe('node-A');
    expect(parsed.content).toBe('correct');
  });

  it('node stream reconstructs reasoning type from stored prefix on replay', async () => {
    const stateRuntime = createMockStateRuntime({
      getNodeOutput: () => ({
        lines: [
          '\x00reasoning\x00thinking about approach',
          'visible output line',
          '\x00reasoning\x00more thinking',
        ],
        offset: 0,
        total: 3,
        hasMore: false,
      }),
    });

    const eventBus = createMockEventBus();

    const stream = createNodeSSEStream(
      stateRuntime,
      eventBus,
      'exec-1',
      'nodeA',
      60_000,
    );

    // Read 3 replayed events (one per stored line)
    const chunks = await readChunks(stream, 3);
    const events = chunks.map(c => parseSSE(c) as Record<string, unknown>);

    // First line: reasoning (prefix stripped)
    expect(events[0].type).toBe('node:reasoning');
    expect(events[0].content).toBe('thinking about approach');

    // Second line: regular output
    expect(events[1].type).toBe('node:output');
    expect(events[1].content).toBe('visible output line');

    // Third line: reasoning (prefix stripped)
    expect(events[2].type).toBe('node:reasoning');
    expect(events[2].content).toBe('more thinking');

    // All events share correct executionId and nodeId
    for (const event of events) {
      expect(event.executionId).toBe('exec-1');
      expect(event.nodeId).toBe('nodeA');
    }
  });

  it('empty replay starts with live events', async () => {
    // getProjection returns null → no snapshot replayed.
    const stateRuntime = createMockStateRuntime();
    const eventBus = createMockEventBus();

    const stream = createExecutionSSEStream(
      stateRuntime,
      eventBus,
      'exec-1',
      60_000,
    );

    const readPromise = readChunks(stream, 1);

    eventBus.emit({
      type: 'node:completed',
      executionId: 'exec-1',
      nodeId: 'step-1',
      action: 'done',
      elapsedMs: 100,
      ts: 5000,
    });

    const chunks = await readPromise;
    const parsed = parseSSE(chunks[0]) as Record<string, unknown>;

    // First chunk is the live event, not a snapshot.
    expect(parsed.type).toBe('node:completed');
    expect(parsed.executionId).toBe('exec-1');
  });

  it('node stream reconstructs tool events from stored prefix on replay', async () => {
    const stateRuntime = createMockStateRuntime({
      getNodeOutput: () => ({
        lines: [
          '\x00tool:start\x00bash\x00Running git log',
          'regular output line',
          '\x00tool:complete\x00bash\x005 commits found',
          '\x00reasoning\x00thinking about it',
        ],
        offset: 0,
        total: 4,
        hasMore: false,
      }),
    });

    const eventBus = createMockEventBus();

    const stream = createNodeSSEStream(
      stateRuntime,
      eventBus,
      'exec-1',
      'nodeA',
      60_000,
    );

    // Read 4 replayed events (one per stored line)
    const chunks = await readChunks(stream, 4);
    const events = chunks.map(c => parseSSE(c) as Record<string, unknown>);

    // Tool start
    expect(events[0].type).toBe('node:tool');
    expect(events[0].tool).toBe('bash');
    expect(events[0].phase).toBe('start');
    expect(events[0].summary).toBe('Running git log');

    // Regular output
    expect(events[1].type).toBe('node:output');
    expect(events[1].content).toBe('regular output line');

    // Tool complete
    expect(events[2].type).toBe('node:tool');
    expect(events[2].tool).toBe('bash');
    expect(events[2].phase).toBe('complete');
    expect(events[2].summary).toBe('5 commits found');

    // Reasoning
    expect(events[3].type).toBe('node:reasoning');
    expect(events[3].content).toBe('thinking about it');

    // All events share correct executionId and nodeId
    for (const event of events) {
      expect(event.executionId).toBe('exec-1');
      expect(event.nodeId).toBe('nodeA');
    }
  });
});
