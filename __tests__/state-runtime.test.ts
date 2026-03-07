import { describe, it, expect, beforeEach } from 'vitest';
import { StateRuntime } from '../state/state-runtime';
import { MemoryStorage } from '../state/storage-memory';
import type { ExecutionEvent } from '../src/events';
import type { OutputEvent } from '../src/events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runStartedEvent(executionId = 'exec-1'): ExecutionEvent {
  return {
    type: 'run:started',
    executionId,
    flowId: 'test-flow',
    params: { repo: 'test-repo' },
    graph: {
      nodes: [
        { id: 'A', displayName: 'Step A', nodeType: 'agent' },
        { id: 'B', displayName: 'Step B', nodeType: 'deterministic' },
      ],
      edges: [{ source: 'A', action: 'default', target: 'B' }],
    },
    ts: 1000,
  };
}

function nodeStartedEvent(nodeId: string, executionId = 'exec-1'): ExecutionEvent {
  return {
    type: 'node:started',
    executionId,
    nodeId,
    ts: 2000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StateRuntime', () => {
  let storage: MemoryStorage;
  let runtime: StateRuntime;

  beforeEach(() => {
    storage = new MemoryStorage();
    runtime = new StateRuntime(storage);
  });

  it('handleEvent updates projection in cache', async () => {
    await runtime.handleEvent(runStartedEvent());

    const projection = runtime.getProjection('exec-1');
    expect(projection).not.toBeNull();
    expect(projection!.status).toBe('running');
    expect(projection!.flowId).toBe('test-flow');
    expect(projection!.graph.nodes).toHaveLength(2);
  });

  it('handleEvent persists events in storage', async () => {
    await runtime.handleEvent(runStartedEvent());
    await runtime.handleEvent(nodeStartedEvent('A'));

    const events = storage.readEvents('exec-1');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('run:started');
    expect(events[1].type).toBe('node:started');
  });

  it('listExecutions returns cached projections', async () => {
    await runtime.handleEvent(runStartedEvent('exec-1'));
    await runtime.handleEvent(runStartedEvent('exec-2'));

    const executions = runtime.listExecutions();
    expect(executions).toHaveLength(2);
    const ids = executions.map((e) => e.id);
    expect(ids).toContain('exec-1');
    expect(ids).toContain('exec-2');
  });

  it('recoverOnStartup marks running executions as crashed (R12a, R12b)', () => {
    // Simulate a running execution that was persisted before a crash
    const startEvent = runStartedEvent('exec-crash');
    storage.appendEvent('exec-crash', startEvent);
    // Write a projection with status 'running'
    storage.writeProjection('exec-crash', {
      id: 'exec-crash',
      flowId: 'test-flow',
      status: 'running',
      params: {},
      graph: {
        nodes: [
          { id: 'A', displayName: 'Step A', nodeType: 'agent', status: 'running', attempt: 1, iteration: 0 },
        ],
        edges: [],
        activeNodes: ['A'],
        completedPath: [],
      },
      totalCost: 0,
      startedAt: 1000,
      metadata: {},
    });

    // Create a fresh runtime and recover
    const freshRuntime = new StateRuntime(storage);
    freshRuntime.recoverOnStartup();

    const projection = freshRuntime.getProjection('exec-crash');
    expect(projection).not.toBeNull();
    expect(projection!.status).toBe('crashed');

    // Verify crash event was appended to storage
    const events = storage.readEvents('exec-crash');
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe('run:completed');
    expect((lastEvent as { status: string }).status).toBe('crashed');
  });

  it('recoverOnStartup hydrates cache for non-running executions', () => {
    // Simulate a completed execution in storage (SYS-5: event log is source of truth)
    storage.appendEvent('exec-done', runStartedEvent('exec-done'));
    storage.appendEvent('exec-done', {
      type: 'run:completed',
      executionId: 'exec-done',
      status: 'completed',
      ts: 2000,
    });

    const freshRuntime = new StateRuntime(storage);
    freshRuntime.recoverOnStartup();

    const executions = freshRuntime.listExecutions();
    expect(executions).toHaveLength(1);
    expect(executions[0].id).toBe('exec-done');
    expect(executions[0].status).toBe('completed');
  });

  it('rebuildProjection replays events from storage', () => {
    // Manually write events to storage (bypassing handleEvent)
    storage.appendEvent('exec-rebuild', runStartedEvent('exec-rebuild'));
    storage.appendEvent('exec-rebuild', {
      type: 'node:started',
      executionId: 'exec-rebuild',
      nodeId: 'A',
      ts: 2000,
    });
    storage.appendEvent('exec-rebuild', {
      type: 'node:completed',
      executionId: 'exec-rebuild',
      nodeId: 'A',
      action: 'default',
      elapsedMs: 500,
      ts: 2500,
    });

    const projection = runtime.rebuildProjection('exec-rebuild');
    expect(projection.status).toBe('running'); // run not completed
    expect(projection.graph.completedPath).toContain('A');
    expect(projection.graph.nodes.find((n) => n.id === 'A')!.status).toBe('completed');

    // Also cached
    expect(runtime.getProjection('exec-rebuild')).toBe(projection);
  });

  it('handleOutput stores output lines', () => {
    const outputEvent: OutputEvent = {
      type: 'node:output',
      executionId: 'exec-1',
      nodeId: 'A',
      content: 'Hello world',
      ts: 2000,
    };
    runtime.handleOutput(outputEvent);
    runtime.handleOutput({
      type: 'node:output',
      executionId: 'exec-1',
      nodeId: 'A',
      content: 'Second line',
      ts: 2100,
    });

    const output = runtime.getNodeOutput('exec-1', 'A');
    expect(output.lines).toEqual(['Hello world', 'Second line']);
    expect(output.total).toBe(2);
  });

  it('delete removes from cache and storage', async () => {
    await runtime.handleEvent(runStartedEvent('exec-del'));
    expect(runtime.getProjection('exec-del')).not.toBeNull();

    const deleted = runtime.delete('exec-del');
    expect(deleted).toBe(true);
    expect(runtime.getProjection('exec-del')).toBeNull();
    expect(runtime.listExecutions()).toHaveLength(0);
    expect(storage.readEvents('exec-del')).toEqual([]);
  });

  it('handleOutput fires onOutput callback for node:output', () => {
    const calls: OutputEvent[] = [];
    const rt = new StateRuntime(storage, undefined, (event) => calls.push(event));
    const outputEvent: OutputEvent = {
      type: 'node:output',
      executionId: 'exec-1',
      nodeId: 'A',
      content: 'hello',
      ts: 1000,
    };
    rt.handleOutput(outputEvent);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(outputEvent);
  });

  it('handleOutput fires onOutput callback for node:reasoning', () => {
    const calls: OutputEvent[] = [];
    const rt = new StateRuntime(storage, undefined, (event) => calls.push(event));
    const reasoningEvent: OutputEvent = {
      type: 'node:reasoning',
      executionId: 'exec-1',
      nodeId: 'A',
      content: 'thinking about it',
      ts: 1000,
    };
    rt.handleOutput(reasoningEvent);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(reasoningEvent);
  });

  it('handleOutput fires onOutput callback for node:tool', () => {
    const calls: OutputEvent[] = [];
    const rt = new StateRuntime(storage, undefined, (event) => calls.push(event));
    const toolEvent: OutputEvent = {
      type: 'node:tool',
      executionId: 'exec-1',
      nodeId: 'A',
      tool: 'search',
      phase: 'start',
      summary: 'searching...',
      ts: 1000,
    };
    rt.handleOutput(toolEvent);
    // node:tool is not persisted but callback should still fire
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(toolEvent);
  });

  it('handleOutput persists node:reasoning with prefix and reconstructs on read', () => {
    const rt = new StateRuntime(storage);
    rt.handleOutput({
      type: 'node:reasoning',
      executionId: 'exec-1',
      nodeId: 'A',
      content: 'deep thought',
      ts: 1000,
    });
    rt.handleOutput({
      type: 'node:output',
      executionId: 'exec-1',
      nodeId: 'A',
      content: 'visible output',
      ts: 1100,
    });

    const output = rt.getNodeOutput('exec-1', 'A');
    expect(output.lines).toHaveLength(2);
    // Reasoning is stored with prefix
    expect(output.lines[0]).toBe('\x00reasoning\x00deep thought');
    // Regular output is stored as-is
    expect(output.lines[1]).toBe('visible output');
  });
});
