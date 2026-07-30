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
import {
  createConsoleOutputRenderer,
  type OutputEventSink,
  type OutputRedactor,
  type ToolOutputMode,
} from '../src/console-output';
import type { StateRuntime } from '../state/state-runtime';
import type { ExecutionEvent, OutputEvent } from '../src/events';

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

export interface BridgeOptions {
  /**
   * Receives streamed output after state capture. Defaults to an attributed
   * plain-text stdout renderer. Pass false to silence bridge console output.
   */
  readonly emitOutput?: OutputEventSink | false;
  /** Literal values scrubbed from default stdout output. */
  readonly knownSecrets?: readonly string[];
  /** Replaces the built-in stdout redactor. Known secrets are still scrubbed afterward. */
  readonly outputRedactor?: OutputRedactor;
  /** Render node:reasoning events to stdout. Defaults to false. */
  readonly renderReasoning?: boolean;
  /** Render complete model requests to stdout. Defaults to true. */
  readonly renderPrompts?: boolean;
  /**
   * Raw tool-result rendering: hidden (default), a compact preview, or full.
   * Tool calls always render as one compact line.
   */
  readonly toolOutputMode?: ToolOutputMode;
  /** Maximum redacted tool-call or tool-output preview length. Defaults to 200. */
  readonly toolPreviewMaxChars?: number;
}

// ---------------------------------------------------------------------------
// Bridge factory
// ---------------------------------------------------------------------------

export function createBridge(
  runtime: AgentRuntime,
  stateRuntime: StateRuntime,
  options?: BridgeOptions,
): BridgeApi {
  const consoleRenderer = options?.emitOutput === undefined
    ? createConsoleOutputRenderer({
      knownSecrets: options?.knownSecrets,
      redactor: options?.outputRedactor,
      renderReasoning: options?.renderReasoning,
      renderPrompts: options?.renderPrompts,
      toolOutputMode: options?.toolOutputMode,
      toolPreviewMaxChars: options?.toolPreviewMaxChars,
    })
    : null;
  const outputSink = options?.emitOutput === undefined
    ? consoleRenderer?.emitOutput
    : options.emitOutput || undefined;

  function handleOutput(event: OutputEvent): void {
    stateRuntime.handleOutput(event);
    try {
      outputSink?.(event);
    } catch {
      // Consumer output sinks must not interrupt an execution.
    }
  }

  function flushNodeOutput(event: ExecutionEvent): void {
    if (
      event.type === 'node:completed'
      || event.type === 'node:failed'
      || event.type === 'node:killed'
    ) {
      consoleRenderer?.flushNode(event.executionId, event.nodeId);
    }
  }

  async function handleState(event: ExecutionEvent): Promise<void> {
    await stateRuntime.handleEvent(event);
    flushNodeOutput(event);
  }

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
      emitState: handleState,
      emitOutput: handleOutput,
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
        consoleRenderer?.flushExecution(executionId);
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

    // Build ResumeState from projection + events (for loopIterations reconstruction)
    const events = stateRuntime.readEvents(executionId);
    const resumeState = buildResumeState(projection, graph, events);
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
      emitState: handleState,
      emitOutput: handleOutput,
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
        consoleRenderer?.flushExecution(executionId);
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
    const retryEvents = stateRuntime.readEvents(executionId);
    const resumeState = buildResumeState(projection, graph, retryEvents);
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
      emitState: handleState,
      emitOutput: handleOutput,
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
        consoleRenderer?.flushExecution(executionId);
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

function buildResumeState(
  projection: ExecutionProjection,
  graph: FlowGraph,
  events?: readonly ExecutionEvent[],
): ResumeState {
  const completedNodes = new Map<string, { action: string; finishedAt: number }>();
  const firedEdges = new Map<string, Set<string>>();
  const nodeStatuses = new Map<string, string>();
  const readyNodes = new Set<string>();
  const atomicSources = new Set<string>();
  const pendingAtomicRoutes = new Set<string>();
  const routedGateAttempts = new Set<string>();
  const legacyCompletedAttempts = new Set<string>();

  if (events) {
    for (const event of events) {
      if (event.type === 'node:started' || event.type === 'node:gated') {
        routedGateAttempts.delete(event.nodeId);
        legacyCompletedAttempts.delete(event.nodeId);
      } else if (event.type === 'gate:resolved') {
        // The bridge persists this after unblocking the gate but before the
        // scheduler records completion. A crash in that window must re-open the
        // gate rather than treating an unactioned resolution as a routed node.
        // Ignore late audit events after an atomic or legacy completion.
        if (
          !routedGateAttempts.has(event.nodeId)
          && !legacyCompletedAttempts.has(event.nodeId)
        ) {
          pendingAtomicRoutes.add(event.nodeId);
        }
      } else if (event.type === 'node:completed') {
        if (event.routingExpected) {
          pendingAtomicRoutes.add(event.nodeId);
        } else {
          // Legacy completions predate atomic routing records.
          pendingAtomicRoutes.delete(event.nodeId);
          legacyCompletedAttempts.add(event.nodeId);
        }
      } else if (event.type === 'route:resolved') {
        atomicSources.add(event.source);
        pendingAtomicRoutes.delete(event.source);
        routedGateAttempts.add(event.source);
      } else if (event.type === 'node:reset') {
        pendingAtomicRoutes.delete(event.nodeId);
        routedGateAttempts.delete(event.nodeId);
        legacyCompletedAttempts.delete(event.nodeId);
      }
    }
  }

  for (const node of projection.graph.nodes) {
    const mustRerun = pendingAtomicRoutes.has(node.id);
    nodeStatuses.set(node.id, mustRerun ? 'pending' : node.status);
    if (mustRerun) readyNodes.add(node.id);
    if (!mustRerun && node.status === 'completed' && node.finishedAt) {
      completedNodes.set(node.id, {
        action: node.action ?? 'default',
        finishedAt: node.finishedAt,
      });
    }
  }

  if (events) {
    for (const event of events) {
      if (event.type === 'node:completed') {
        if (pendingAtomicRoutes.has(event.nodeId)) {
          completedNodes.delete(event.nodeId);
          nodeStatuses.set(event.nodeId, 'pending');
          readyNodes.add(event.nodeId);
        } else {
          readyNodes.delete(event.nodeId);
          completedNodes.set(event.nodeId, {
            action: event.action,
            finishedAt: event.ts,
          });
          nodeStatuses.set(event.nodeId, 'completed');
        }
        continue;
      }
      if (event.type === 'node:reset') {
        completedNodes.delete(event.nodeId);
        nodeStatuses.set(event.nodeId, 'pending');
        continue;
      }
      if (event.type !== 'route:resolved') continue;

      for (const sources of firedEdges.values()) {
        sources.delete(event.source);
      }
      for (const [target, sources] of firedEdges) {
        if (sources.size === 0) firedEdges.delete(target);
      }

      if (event.loop) {
        for (const edge of event.loop.clearedEdges) {
          const sources = firedEdges.get(edge.target);
          sources?.delete(edge.source);
          if (sources?.size === 0) firedEdges.delete(edge.target);
        }
        for (const nodeId of event.loop.resetNodes) {
          completedNodes.delete(nodeId);
          nodeStatuses.set(nodeId, 'pending');
        }
        for (const target of event.loop.readyTargets) {
          readyNodes.add(target);
        }
      }
      for (const target of event.loop?.firedTargets ?? event.targets) {
        if (target === 'end') continue;
        let sources = firedEdges.get(target);
        if (!sources) {
          sources = new Set();
          firedEdges.set(target, sources);
        }
        sources.add(event.source);
      }
    }
  }

  // A torn latest route supersedes earlier attempts by the same source. Do not
  // revive an old loop/fan-out contribution while the source is being rerun.
  if (pendingAtomicRoutes.size > 0) {
    for (const [target, sources] of firedEdges) {
      for (const source of pendingAtomicRoutes) sources.delete(source);
      if (sources.size === 0) firedEdges.delete(target);
    }
  }

  // Old logs have no route:resolved events, so retain their per-edge projection state.
  for (const edge of projection.graph.edges) {
    if (
      edge.state === 'taken'
      && !atomicSources.has(edge.source)
      && !pendingAtomicRoutes.has(edge.source)
    ) {
      if (!firedEdges.has(edge.target)) {
        firedEdges.set(edge.target, new Set());
      }
      firedEdges.get(edge.target)!.add(edge.source);
    }
  }

  // Reconstruct loopIterations from atomic loop routes, with node:reset fallback for old logs.
  const loopIterations = new Map<string, number>();
  if (events) {
    const loopRegionsByDecision = new Map(
      (graph.loops ?? []).map(region => [region.decision, region] as const),
    );
    const edgeActions = new Map<string, string>();
    for (const event of events) {
      if (event.type === 'route:resolved' && event.loop) {
        const current = loopIterations.get(event.loop.key) ?? 0;
        if (event.loop.iteration > current) {
          loopIterations.set(event.loop.key, event.loop.iteration);
        }
      } else if (event.type === 'edge:traversed') {
        edgeActions.set(`${event.source}:${event.target}`, event.action);
      }
    }

    for (const event of events) {
      if (event.type === 'node:reset') {
        const region = loopRegionsByDecision.get(event.sourceNodeId);
        const action = edgeActions.get(`${event.sourceNodeId}:${event.nodeId}`);
        const key = region
          ? `region:${region.id}`
          : action
            ? `${event.sourceNodeId}:${action}`
            : undefined;
        if (key) {
          const current = loopIterations.get(key) ?? 0;
          if (event.iteration > current) {
            loopIterations.set(key, event.iteration);
          }
        }
      }
    }
  }

  return { completedNodes, firedEdges, nodeStatuses, loopIterations, readyNodes };
}

export const _buildResumeStateForTesting = buildResumeState;

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

    for (const [action, edgeTarget] of Object.entries(edges)) {
      // A declared continuation re-enters an earlier loop round; it is not a
      // downstream dependency of the decision node in the retry operation.
      const isLoopContinuation = graph.loops?.some(region =>
        region.decision === current && region.continueOn === action,
      ) ?? false;
      if (isLoopContinuation) continue;

      const targets = Array.isArray(edgeTarget) ? edgeTarget : [edgeTarget];
      for (const target of targets) {
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
}
