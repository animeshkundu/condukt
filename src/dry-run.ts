import type { MockNodeConfig } from '../runtimes/mock/mock-runtime';
import { MockRuntime } from '../runtimes/mock/mock-runtime';
import { MemoryStorage } from '../state/storage-memory';
import { StateRuntime } from '../state/state-runtime';
import type { ExecutionEvent } from './events';
import { run } from './scheduler';
import type { ExecutionProjection, FlowGraph } from './types';

export interface DryRunOptions {
  readonly dir: string;
  readonly params?: Record<string, unknown>;
  readonly fixtures: Readonly<Record<string, MockNodeConfig>>;
  readonly executionId?: string;
}

export interface DryRunResult {
  readonly completed: boolean;
  readonly projection: ExecutionProjection;
  readonly events: ExecutionEvent[];
}

let executionSequence = 0;

function createExecutionId(): string {
  executionSequence += 1;
  return `dry-run-${Date.now()}-${executionSequence}`;
}

export async function dryRun(
  graph: FlowGraph,
  options: DryRunOptions,
): Promise<DryRunResult> {
  const executionId = options.executionId ?? createExecutionId();
  const events: ExecutionEvent[] = [];
  const storage = new MemoryStorage();
  const stateRuntime = new StateRuntime(storage);
  const runtime = new MockRuntime(options.fixtures);
  const controller = new AbortController();

  const result = await run(graph, {
    executionId,
    dir: options.dir,
    params: options.params ?? {},
    runtime,
    emitState: async (event) => {
      events.push(event);
      await stateRuntime.handleEvent(event);
    },
    emitOutput: (event) => {
      stateRuntime.handleOutput(event);
    },
    signal: controller.signal,
  });

  const projection = stateRuntime.getProjection(executionId);
  if (!projection) {
    throw new Error(`Dry run '${executionId}' completed without a projection`);
  }

  return {
    completed: result.completed,
    projection,
    events,
  };
}
