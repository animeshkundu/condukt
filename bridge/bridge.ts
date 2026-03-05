/**
 * Bridge — orchestration layer between flow framework and external consumers (API, CLI).
 *
 * Responsibilities:
 * - Launch: concurrency check, dedup, dir creation, scheduler.run()
 * - Stop: abort signal, mark running nodes as killed
 * - Resume: rebuild ResumeState from projection, computeFrontier, run
 * - Retry: reset target + downstream, assemble RetryContext, computeFrontier, run
 * - Skip: emit node:skipped
 * - Approve gate: resolve pending gate, emit gate:resolved
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentRuntime,
  ExecutionProjection,
  FlowGraph,
  ResumeState,
  RetryContext,
  RunOptions,
} from '../src/types';
import { FlowAbortedError } from '../src/types';
import { run, computeFrontier } from '../src/scheduler';
import { resolveGate } from '../src/nodes';
import type { StateRuntime } from '../state/state-runtime';
import type { ExecutionEvent } from '../src/events';

const MAX_CONCURRENT = 10;

// ---------------------------------------------------------------------------
// Public API interface
// ---------------------------------------------------------------------------

export interface BridgeApi {
  launch(params: LaunchParams): Promise<string>;
  stop(executionId: string): Promise<void>;
  resume(executionId: string, graph: FlowGraph): Promise<{ resumingFrom: string[] } | null>;
  retryNode(executionId: string, nodeId: string, graph: FlowGraph, override?: string): Promise<void>;
  skipNode(executionId: string, nodeId: string): Promise<void>;
  approveGate(executionId: string, nodeId: string, resolution: string, reason?: string): Promise<void>;
  getExecution(executionId: string): ExecutionProjection | null;
  listExecutions(): ExecutionProjection[];
  isRunning(executionId: string): boolean;
}

export interface LaunchParams {
  readonly executionId: string;
  readonly graph: FlowGraph;
  readonly dir: string;
  readonly params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Bridge factory
// ---------------------------------------------------------------------------

export function createBridge(
  runtime: AgentRuntime,
  stateRuntime: StateRuntime,
): BridgeApi {

  // ARCH-2: Track running executions per-bridge (not module-level)
  const runningExecutions = new Map<string, {
    controller: AbortController;
    promise: Promise<void>;
  }>();

  async function launch(params: LaunchParams): Promise<string> {
    const { executionId, graph, dir } = params;

    // Concurrency check
    if (runningExecutions.size >= MAX_CONCURRENT) {
      throw new Error(`Concurrency limit: ${MAX_CONCURRENT} executions already running`);
    }

    // Dedup check — reject if same executionId is already running
    if (runningExecutions.has(executionId)) {
      throw new Error(`Execution '${executionId}' is already running`);
    }

    // Ensure working directory exists
    fs.mkdirSync(dir, { recursive: true });

    const controller = new AbortController();

    // C4 fix: persist working directory in params for resume (SWE-6: use __flow namespace)
    const paramsWithDir = { ...params.params, __flow: { dir } };

    const runOptions: RunOptions = {
      executionId,
      dir,
      params: paramsWithDir,
      runtime,
      emitState: async (event) => {
        await stateRuntime.handleEvent(event);
      },
      emitOutput: (event) => {
        stateRuntime.handleOutput(event);
      },
      signal: controller.signal,
    };

    // Start flow execution (non-blocking — runs in background)
    const promise = (async () => {
      try {
        await run(graph, runOptions);
      } catch (err) {
        if (err instanceof FlowAbortedError) {
          // Already handled by scheduler (run:completed with 'stopped')
          return;
        }
        // Unexpected error — emit run:completed with 'failed'
        await stateRuntime.handleEvent({
          type: 'run:completed',
          executionId,
          status: 'failed',
          ts: Date.now(),
        });
      } finally {
        runningExecutions.delete(executionId);
      }
    })();

    runningExecutions.set(executionId, { controller, promise });
    return executionId;
  }

  async function stop(executionId: string): Promise<void> {
    const running = runningExecutions.get(executionId);
    if (!running) {
      throw new Error(`Execution '${executionId}' is not running`);
    }

    // Abort the flow — scheduler will emit node:killed + run:completed
    running.controller.abort();

    // Wait for the flow to actually stop
    try {
      await running.promise;
    } catch {
      // Expected — abort causes errors
    }
  }

  async function resume(
    executionId: string,
    graph: FlowGraph,
  ): Promise<{ resumingFrom: string[] } | null> {
    const projection = stateRuntime.getProjection(executionId);
    if (!projection) return null;

    if (projection.status !== 'crashed' && projection.status !== 'failed' && projection.status !== 'stopped') {
      throw new Error(`Cannot resume execution in '${projection.status}' status`);
    }

    // Build ResumeState from projection
    const resumeState = buildResumeState(projection);
    const frontier = computeFrontier(graph, resumeState);

    if (frontier.length === 0) return null;

    // C4 fix: use persisted working directory from params (SWE-6: __flow namespace)
    const flowMeta = projection.params.__flow as { dir: string } | undefined;
    const dir = flowMeta?.dir ?? '.';
    fs.mkdirSync(dir, { recursive: true });

    const controller = new AbortController();

    const runOptions: RunOptions = {
      executionId,
      dir,
      params: projection.params,
      runtime,
      emitState: async (event) => {
        await stateRuntime.handleEvent(event);
      },
      emitOutput: (event) => {
        stateRuntime.handleOutput(event);
      },
      signal: controller.signal,
      resumeFrom: resumeState,
    };

    const promise = (async () => {
      try {
        await run(graph, runOptions);
      } catch (err) {
        if (!(err instanceof FlowAbortedError)) {
          await stateRuntime.handleEvent({
            type: 'run:completed',
            executionId,
            status: 'failed',
            ts: Date.now(),
          });
        }
      } finally {
        runningExecutions.delete(executionId);
      }
    })();

    runningExecutions.set(executionId, { controller, promise });
    return { resumingFrom: frontier };
  }

  async function retryNode(
    executionId: string,
    nodeId: string,
    graph: FlowGraph,
    override?: string,
  ): Promise<void> {
    // I4 fix: prevent concurrent schedulers on same execution
    if (runningExecutions.has(executionId)) {
      throw new Error(`Execution '${executionId}' is still running. Stop it before retrying.`);
    }

    const projection = stateRuntime.getProjection(executionId);
    if (!projection) throw new Error(`Execution '${executionId}' not found`);

    const node = projection.graph.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error(`Node '${nodeId}' not found`);

    if (!['failed', 'killed', 'completed'].includes(node.status)) {
      throw new Error(`Cannot retry node in '${node.status}' status`);
    }

    // Emit retry event
    await stateRuntime.handleEvent({
      type: 'node:retrying',
      executionId,
      nodeId,
      attempt: (node.attempt ?? 0) + 1,
      override,
      ts: Date.now(),
    });

    // Build ResumeState: mark this node + downstream as pending
    const resumeState = buildResumeState(projection);
    // Remove the retried node and its downstream from completedNodes
    resetNodeAndDownstream(resumeState, nodeId, graph);

    const frontier = computeFrontier(graph, resumeState);

    // PARITY-1: Assemble RetryContext for the retried node
    let priorOutput: string | null = null;
    if (node.output) {
      const artifactPath = path.join(
        (projection.params.__flow as { dir: string } | undefined)?.dir ?? '.',
        node.output,
      );
      try {
        priorOutput = fs.readFileSync(artifactPath, 'utf-8');
      } catch {
        priorOutput = null;
      }
    }

    const retryContext: RetryContext = {
      priorOutput,
      feedback: `Retry attempt ${(node.attempt ?? 0) + 1}`,
      override,
    };

    const controller = new AbortController();

    const runOptions: RunOptions = {
      executionId,
      dir: (projection.params.__flow as { dir: string } | undefined)?.dir ?? '.',
      params: projection.params,
      runtime,
      emitState: async (event) => {
        await stateRuntime.handleEvent(event);
      },
      emitOutput: (event) => {
        stateRuntime.handleOutput(event);
      },
      signal: controller.signal,
      resumeFrom: resumeState,
      retryContexts: { [nodeId]: retryContext },
    };

    const promise = (async () => {
      try {
        await run(graph, runOptions);
      } catch (err) {
        if (!(err instanceof FlowAbortedError)) {
          await stateRuntime.handleEvent({
            type: 'run:completed',
            executionId,
            status: 'failed',
            ts: Date.now(),
          });
        }
      } finally {
        runningExecutions.delete(executionId);
      }
    })();

    runningExecutions.set(executionId, { controller, promise });
  }

  async function skipNode(executionId: string, nodeId: string): Promise<void> {
    const projection = stateRuntime.getProjection(executionId);
    if (!projection) throw new Error(`Execution '${executionId}' not found`);

    const node = projection.graph.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error(`Node '${nodeId}' not found`);

    if (node.status !== 'pending' && node.status !== 'gated' && node.status !== 'failed') {
      throw new Error(`Cannot skip node in '${node.status}' status`);
    }

    await stateRuntime.handleEvent({
      type: 'node:skipped',
      executionId,
      nodeId,
      ts: Date.now(),
    });
  }

  async function approveGate(
    executionId: string,
    nodeId: string,
    resolution: string,
    reason?: string,
  ): Promise<void> {
    const resolved = resolveGate(executionId, nodeId, resolution);
    if (!resolved) {
      throw new Error(`No pending gate found for node '${nodeId}' in execution '${executionId}'`);
    }

    await stateRuntime.handleEvent({
      type: 'gate:resolved',
      executionId,
      nodeId,
      resolution,
      reason,
      ts: Date.now(),
    });
  }

  function getExecution(executionId: string): ExecutionProjection | null {
    return stateRuntime.getProjection(executionId);
  }

  function listExecutions(): ExecutionProjection[] {
    return stateRuntime.listExecutions();
  }

  function isRunning(executionId: string): boolean {
    return runningExecutions.has(executionId);
  }

  return {
    launch,
    stop,
    resume,
    retryNode,
    skipNode,
    approveGate,
    getExecution,
    listExecutions,
    isRunning,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResumeState(projection: ExecutionProjection): ResumeState {
  const completedNodes = new Map<string, { action: string; finishedAt: number }>();
  const firedEdges = new Map<string, Set<string>>();
  const nodeStatuses = new Map<string, string>();

  for (const node of projection.graph.nodes) {
    nodeStatuses.set(node.id, node.status);
    if (node.status === 'completed' && node.finishedAt) {
      completedNodes.set(node.id, {
        action: node.action ?? 'default',
        finishedAt: node.finishedAt,
      });
    }
  }

  // Reconstruct firedEdges from taken edges
  for (const edge of projection.graph.edges) {
    if (edge.state === 'taken') {
      if (!firedEdges.has(edge.target)) {
        firedEdges.set(edge.target, new Set());
      }
      firedEdges.get(edge.target)!.add(edge.source);
    }
  }

  return { completedNodes, firedEdges, nodeStatuses };
}

function resetNodeAndDownstream(
  state: ResumeState,
  nodeId: string,
  graph: FlowGraph,
): void {
  // Reset this node
  (state.completedNodes as Map<string, unknown>).delete(nodeId);
  (state.nodeStatuses as Map<string, string>).set(nodeId, 'pending');

  // Find and reset downstream nodes (BFS)
  const queue = [nodeId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const edges = graph.edges[current];
    if (!edges) continue;

    for (const target of Object.values(edges)) {
      if (target !== 'end' && !visited.has(target)) {
        (state.completedNodes as Map<string, unknown>).delete(target);
        (state.nodeStatuses as Map<string, string>).set(target, 'pending');
        // Also clear fired edges to this target
        (state.firedEdges as Map<string, Set<string>>).delete(target);
        queue.push(target);
      }
    }
  }
}
