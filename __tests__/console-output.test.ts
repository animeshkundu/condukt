import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBridge } from '../bridge/bridge';
import { createConsoleOutputRenderer, type OutputEventSink } from '../src/console-output';
import type { OutputEvent } from '../src/events';
import type { AgentRuntime, ExecutionContext, FlowGraph } from '../src/types';
import { StateRuntime } from '../state/state-runtime';
import { MemoryStorage } from '../state/storage-memory';

function createMockRuntime(): AgentRuntime {
  return {
    name: 'mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockRejectedValue(new Error('No sessions expected')),
  };
}

function createOutputGraph(emit: (ctx: ExecutionContext) => void): FlowGraph {
  return {
    nodes: {
      worker: {
        displayName: 'Worker',
        nodeType: 'deterministic',
        fn: async (_input, ctx) => {
          emit(ctx);
          return { action: 'default' };
        },
      },
    },
    edges: {},
    start: ['worker'],
  };
}

async function waitForStatus(
  bridge: ReturnType<typeof createBridge>,
  executionId: string,
  status: 'completed' | 'failed',
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const projection = bridge.getExecution(executionId);
    if (!bridge.isRunning(executionId) && projection?.status === status) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Execution '${executionId}' did not reach '${status}'`);
}

function waitForCompletion(
  bridge: ReturnType<typeof createBridge>,
  executionId: string,
): Promise<void> {
  return waitForStatus(bridge, executionId, 'completed');
}

function emitText(ctx: ExecutionContext, content: string): void {
  ctx.emitOutput({
    type: 'node:output',
    executionId: ctx.executionId,
    nodeId: ctx.nodeId,
    content,
    ts: Date.now(),
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('console output renderer', () => {
  it('concatenates reasoning deltas without a separator', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createConsoleOutputRenderer();

    renderer.emitOutput({
      type: 'node:reasoning',
      executionId: 'exec',
      nodeId: 'reasoner',
      content: 'ic',
      ts: 1,
    });
    renderer.emitOutput({
      type: 'node:reasoning',
      executionId: 'exec',
      nodeId: 'reasoner',
      content: 'm\n',
      ts: 2,
    });

    const written = stdout.mock.calls.map(call => String(call[0])).join('');
    expect(written).toBe('[reasoner] icm\n');
  });

  it('attributes interleaved output to each node', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createConsoleOutputRenderer();
    const events: readonly OutputEvent[] = [
      { type: 'node:output', executionId: 'exec', nodeId: 'alpha', content: 'hel', ts: 1 },
      { type: 'node:output', executionId: 'exec', nodeId: 'beta', content: 'wor', ts: 2 },
      { type: 'node:output', executionId: 'exec', nodeId: 'alpha', content: 'lo\n', ts: 3 },
      { type: 'node:output', executionId: 'exec', nodeId: 'beta', content: 'ld\n', ts: 4 },
    ];

    for (const event of events) renderer.emitOutput(event);

    const written = stdout.mock.calls.map(call => String(call[0])).join('');
    expect(written).toBe('[alpha] hello\n[beta] world\n');
  });

  it('swallows stdout rendering failures', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('stdout unavailable');
    });
    const renderer = createConsoleOutputRenderer();

    expect(() => renderer.emitOutput({
      type: 'node:output',
      executionId: 'exec',
      nodeId: 'worker',
      content: 'still running\n',
      ts: 1,
    })).not.toThrow();
  });
});

describe('bridge output sink', () => {
  function setup(output?: OutputEventSink | false): {
    readonly bridge: ReturnType<typeof createBridge>;
    readonly stateRuntime: StateRuntime;
    readonly dir: string;
  } {
    const stateRuntime = new StateRuntime(new MemoryStorage());
    const bridge = output === undefined
      ? createBridge(createMockRuntime(), stateRuntime)
      : createBridge(createMockRuntime(), stateRuntime, { emitOutput: output });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-output-'));
    tempDirs.push(dir);
    return { bridge, stateRuntime, dir };
  }

  async function launchOutput(
    output: OutputEventSink | false | undefined,
    executionId: string,
  ): Promise<{ readonly stateRuntime: StateRuntime }> {
    const { bridge, stateRuntime, dir } = setup(output);
    await bridge.launch({
      executionId,
      graph: createOutputGraph(ctx => emitText(ctx, 'visible output')),
      dir,
      params: {},
    });
    await waitForCompletion(bridge, executionId);
    return { stateRuntime };
  }

  it('writes to stdout by default and still captures state', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { stateRuntime } = await launchOutput(undefined, 'default-output');

    const written = stdout.mock.calls.map(call => String(call[0])).join('');
    expect(written).toBe('[worker] visible output\n');
    expect(stateRuntime.getNodeOutput('default-output', 'worker').lines).toEqual(['visible output']);
  });

  it('uses a consumer sink instead of stdout and still captures state', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const sink = vi.fn<(event: OutputEvent) => void>();

    const { stateRuntime } = await launchOutput(sink, 'custom-output');

    expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      type: 'node:output',
      nodeId: 'worker',
      content: 'visible output',
    }));
    expect(stdout).not.toHaveBeenCalled();
    expect(stateRuntime.getNodeOutput('custom-output', 'worker').lines).toEqual(['visible output']);
  });

  it('can explicitly silence stdout and still captures state', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { stateRuntime } = await launchOutput(false, 'silent-output');

    expect(stdout).not.toHaveBeenCalled();
    expect(stateRuntime.getNodeOutput('silent-output', 'worker').lines).toEqual(['visible output']);
  });

  it('uses the configured sink for launch, resume, and retry', async () => {
    const sink = vi.fn<(event: OutputEvent) => void>();
    const { bridge, stateRuntime, dir } = setup(sink);
    let attempt = 0;
    const graph = createOutputGraph(ctx => {
      attempt += 1;
      emitText(ctx, `attempt ${attempt}\n`);
      if (attempt === 1) throw new Error('first attempt fails');
    });

    await bridge.launch({ executionId: 'lifecycle-output', graph, dir, params: {} });
    await waitForStatus(bridge, 'lifecycle-output', 'failed');

    const resumed = await bridge.resume('lifecycle-output', graph);
    expect(resumed).not.toBeNull();
    await waitForCompletion(bridge, 'lifecycle-output');

    await bridge.retryNode('lifecycle-output', 'worker', graph);
    await waitForCompletion(bridge, 'lifecycle-output');

    expect(sink.mock.calls.map(([event]) => (
      event.type === 'node:output' ? event.content : null
    )).filter(Boolean)).toEqual(['attempt 1\n', 'attempt 2\n', 'attempt 3\n']);
    expect(stateRuntime.getNodeOutput('lifecycle-output', 'worker').lines).toEqual([
      'attempt 1\\n',
      'attempt 2\\n',
      'attempt 3\\n',
    ]);
  });

  it('does not let a throwing consumer sink break the run', async () => {
    const sink: OutputEventSink = () => {
      throw new Error('sink failed');
    };

    const { stateRuntime } = await launchOutput(sink, 'throwing-output');

    expect(stateRuntime.getProjection('throwing-output')?.status).toBe('completed');
    expect(stateRuntime.getNodeOutput('throwing-output', 'worker').lines).toEqual(['visible output']);
  });
});
