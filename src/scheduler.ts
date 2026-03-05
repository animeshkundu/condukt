/**
 * Flow scheduler — graph walker, node dispatcher, fan-in tracker.
 *
 * Stateless: emits events via callbacks, reads/writes artifacts to dir.
 * The only mutable state is the per-run tracking (completed, firedEdges, pending).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  FlowGraph,
  NodeEntry,
  NodeInput,
  ExecutionContext,
  NodeOutput,
  RunOptions,
  RunResult,
  ResumeState,
} from './types';
import { FlowAbortedError, FlowValidationError } from './types';
import type {
  GraphNodeSkeleton,
  GraphEdgeSkeleton,
  ExecutionEvent,
} from './events';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateGraph(graph: FlowGraph): void {
  const issues: string[] = [];
  const nodeIds = new Set(Object.keys(graph.nodes));

  // Start nodes must exist
  for (const startId of graph.start) {
    if (!nodeIds.has(startId)) {
      issues.push(`Start node '${startId}' does not exist in graph.nodes`);
    }
  }

  // Edge sources and targets must exist (target may be 'end')
  for (const [source, actionMap] of Object.entries(graph.edges)) {
    if (!nodeIds.has(source)) {
      issues.push(`Edge source '${source}' does not exist in graph.nodes`);
    }
    for (const [action, target] of Object.entries(actionMap)) {
      if (target !== 'end' && !nodeIds.has(target)) {
        issues.push(
          `Edge target '${target}' (from '${source}' via '${action}') does not exist in graph.nodes`,
        );
      }
    }
  }

  // No duplicate output filenames across nodes
  const outputs = new Map<string, string>();
  for (const [nodeId, entry] of Object.entries(graph.nodes)) {
    if (entry.output) {
      const existing = outputs.get(entry.output);
      if (existing) {
        issues.push(
          `Duplicate output filename '${entry.output}' on nodes '${existing}' and '${nodeId}'`,
        );
      } else {
        outputs.set(entry.output, nodeId);
      }
    }
  }

  if (issues.length > 0) {
    throw new FlowValidationError(issues);
  }
}

// ---------------------------------------------------------------------------
// Frontier computation (used by bridge for resume/retry)
// ---------------------------------------------------------------------------

export function computeFrontier(
  graph: FlowGraph,
  state: ResumeState,
): string[] {
  const frontier: string[] = [];
  const completedSet = new Set(state.completedNodes.keys());

  // Start nodes that haven't completed
  for (const startId of graph.start) {
    if (!completedSet.has(startId)) {
      frontier.push(startId);
    }
  }

  // Nodes reachable via fired edges where all sources completed
  for (const [target, sources] of state.firedEdges) {
    if (completedSet.has(target)) continue;
    // Already in frontier from start check
    if (frontier.includes(target)) continue;

    let allSourcesCompleted = true;
    for (const src of sources) {
      if (!completedSet.has(src)) {
        allSourcesCompleted = false;
        break;
      }
    }
    if (allSourcesCompleted) {
      frontier.push(target);
    }
  }

  return frontier;
}

// ---------------------------------------------------------------------------
// Graph skeleton extraction
// ---------------------------------------------------------------------------

function extractSkeleton(graph: FlowGraph): {
  nodes: GraphNodeSkeleton[];
  edges: GraphEdgeSkeleton[];
} {
  const nodes: GraphNodeSkeleton[] = Object.entries(graph.nodes).map(
    ([id, entry]) => ({
      id,
      displayName: entry.displayName,
      nodeType: entry.nodeType,
      model: entry.model,
      output: entry.output,
    }),
  );

  const edges: GraphEdgeSkeleton[] = [];
  for (const [source, actionMap] of Object.entries(graph.edges)) {
    for (const [action, target] of Object.entries(actionMap)) {
      edges.push({ source, action, target });
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function rejectAfterTimeout(
  seconds: number,
  signal: AbortSignal,
): { promise: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Node timed out after ${seconds}s`)),
      seconds * 1000,
    );
    // Also clear timer on abort to prevent leaks
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  });
  return { promise, clear: () => clearTimeout(timer!) };
}

// ---------------------------------------------------------------------------
// Artifact path resolver
// ---------------------------------------------------------------------------

function resolveArtifactPaths(
  reads: readonly string[] | undefined,
  dir: string,
  outputMap: Map<string, string>, // filename → producing nodeId
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!reads) return result;
  for (const filename of reads) {
    if (outputMap.has(filename)) {
      result[filename] = path.join(dir, filename);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main run loop
// ---------------------------------------------------------------------------

export async function run(
  graph: FlowGraph,
  options: RunOptions,
): Promise<RunResult> {
  validateGraph(graph);

  const {
    executionId,
    dir,
    params,
    runtime,
    emitState,
    emitOutput,
    signal,
    resumeFrom,
    retryContexts,
  } = options;

  const skeleton = extractSkeleton(graph);
  const startTime = Date.now();

  // I5 fix: Only emit run:started for fresh runs, not resume/retry
  if (!resumeFrom) {
    await emitState({
      type: 'run:started',
      executionId,
      flowId: '',
      params: { ...params },
      graph: skeleton,
      ts: Date.now(),
    });
  }

  // Build output map: filename → nodeId (for artifact resolution)
  const outputMap = new Map<string, string>();
  for (const [nodeId, entry] of Object.entries(graph.nodes)) {
    if (entry.output) {
      outputMap.set(entry.output, nodeId);
    }
  }

  // Internal state
  const completed = new Map<string, { action: string; finishedAt: number }>();
  const firedEdges = new Map<string, Set<string>>(); // target → sources
  const nodeStatuses = new Map<string, string>();
  const failedNodes = new Set<string>();

  let pending: string[];

  if (resumeFrom) {
    // Pre-populate from resume state
    for (const [nodeId, info] of resumeFrom.completedNodes) {
      completed.set(nodeId, info);
    }
    for (const [target, sources] of resumeFrom.firedEdges) {
      firedEdges.set(target, new Set(sources));
    }
    for (const [nodeId, status] of resumeFrom.nodeStatuses) {
      nodeStatuses.set(nodeId, status);
    }

    // Compute frontier for resume
    pending = computeFrontier(graph, resumeFrom);

    await emitState({
      type: 'run:resumed',
      executionId,
      resumingFrom: [...pending],
      ts: Date.now(),
    });
  } else {
    pending = [...graph.start];
  }

  // Main loop
  while (pending.length > 0) {
    // Check abort before each batch
    if (signal.aborted) {
      for (const nodeId of pending) {
        await emitState({
          type: 'node:killed',
          executionId,
          nodeId,
          ts: Date.now(),
        });
      }
      await emitState({
        type: 'run:completed',
        executionId,
        status: 'stopped',
        ts: Date.now(),
      });
      throw new FlowAbortedError('Flow aborted');
    }

    // Emit node:started for all pending nodes first
    for (const nodeId of pending) {
      await emitState({
        type: 'node:started',
        executionId,
        nodeId,
        ts: Date.now(),
      });
    }

    // C2 fix: emit node:gated for gate-type nodes so frontend knows they're waiting
    for (const nodeId of pending) {
      const entry = graph.nodes[nodeId];
      if (entry.nodeType === 'gate') {
        await emitState({
          type: 'node:gated',
          executionId,
          nodeId,
          gateType: 'approval',
          ts: Date.now(),
        });
      }
    }

    // Dispatch all pending nodes in parallel
    const batchResults = await Promise.allSettled(
      pending.map(async (nodeId) => {
        const entry = graph.nodes[nodeId];

        // Delete stale artifact before dispatch
        if (entry.output) {
          const artifactPath = path.join(dir, entry.output);
          try {
            if (fs.existsSync(artifactPath)) {
              fs.unlinkSync(artifactPath);
            }
          } catch {
            // ignore
          }
        }

        // Resolve artifact paths for reads
        const artifactPaths = resolveArtifactPaths(entry.reads, dir, outputMap);

        // PARITY-1: Build NodeInput with retryContext from RunOptions if present
        const nodeInput: NodeInput = {
          dir,
          params,
          artifactPaths,
          retryContext: retryContexts?.[nodeId],
        };

        // Build ExecutionContext
        const execCtx: ExecutionContext = {
          executionId,
          nodeId,
          runtime,
          emitOutput,
          signal,
        };

        const nodeStart = Date.now();
        const timeoutSecs = entry.timeout ?? 3600;

        // Dispatch with timeout (CR3: applies to ALL node types)
        // C3 fix: clear timer when node completes to prevent leaks
        const timeout = rejectAfterTimeout(timeoutSecs, signal);
        try {
          const output: NodeOutput = await Promise.race([
            entry.fn(nodeInput, execCtx),
            timeout.promise,
          ]);
          timeout.clear();

          const elapsedMs = Date.now() - nodeStart;
          return { nodeId, output, elapsedMs, entry };
        } catch (err) {
          timeout.clear();
          throw err;
        }
      }),
    );

    // Abort check after batch: if signal was aborted during batch (e.g., gate abort),
    // treat all rejected nodes as killed and stop
    if (signal.aborted) {
      for (let i = 0; i < pending.length; i++) {
        const nodeId = pending[i];
        const result = batchResults[i];
        if (result.status === 'rejected') {
          await emitState({
            type: 'node:killed',
            executionId,
            nodeId,
            ts: Date.now(),
          });
        } else {
          const { output, elapsedMs, entry } = result.value;
          await emitState({
            type: 'node:completed',
            executionId,
            nodeId,
            action: output.action,
            elapsedMs,
            ts: Date.now(),
          });
        }
      }
      await emitState({
        type: 'run:completed',
        executionId,
        status: 'stopped',
        ts: Date.now(),
      });
      throw new FlowAbortedError('Flow aborted');
    }

    // Phase 1: Record completions + fire edges
    const newlyCompleted: Array<{
      nodeId: string;
      output: NodeOutput;
      elapsedMs: number;
      entry: NodeEntry;
    }> = [];

    for (let i = 0; i < pending.length; i++) {
      const nodeId = pending[i];
      const result = batchResults[i];

      if (result.status === 'fulfilled') {
        const { output, elapsedMs, entry } = result.value;

        // Emit node:completed
        await emitState({
          type: 'node:completed',
          executionId,
          nodeId,
          action: output.action,
          elapsedMs,
          ts: Date.now(),
        });

        // Write artifact if present
        if (output.artifact && entry.output) {
          const artifactPath = path.join(dir, entry.output);
          fs.writeFileSync(artifactPath, output.artifact, 'utf-8');
          await emitState({
            type: 'artifact:written',
            executionId,
            nodeId,
            path: artifactPath,
            size: output.artifact.length,
            ts: Date.now(),
          });
        }

        // Emit metadata events
        if (output.metadata) {
          for (const [key, value] of Object.entries(output.metadata)) {
            await emitState({
              type: 'metadata',
              executionId,
              key,
              value,
              ts: Date.now(),
            });
          }
        }

        completed.set(nodeId, {
          action: output.action,
          finishedAt: Date.now(),
        });
        nodeStatuses.set(nodeId, 'completed');
        newlyCompleted.push({ nodeId, output, elapsedMs, entry });
      } else {
        // Node failed
        const error =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);

        await emitState({
          type: 'node:failed',
          executionId,
          nodeId,
          error,
          ts: Date.now(),
        });

        failedNodes.add(nodeId);
        nodeStatuses.set(nodeId, 'failed');
      }
    }

    // Phase 1b: Fire edges for all completed nodes
    for (const { nodeId, output } of newlyCompleted) {
      const edgeMap = graph.edges[nodeId];
      if (!edgeMap) continue; // terminal node, no outgoing edges

      let target = edgeMap[output.action];
      if (!target) {
        target = edgeMap['default'];
      }

      if (target && target !== 'end') {
        // Record fired edge
        let sources = firedEdges.get(target);
        if (!sources) {
          sources = new Set();
          firedEdges.set(target, sources);
        }
        sources.add(nodeId);

        await emitState({
          type: 'edge:traversed',
          executionId,
          source: nodeId,
          target,
          action: output.action,
          ts: Date.now(),
        });
      }
      // If no matching edge at all: terminal node (flow ends here for this path)
    }

    // Phase 2: Determine which nodes are newly ready
    const nextPending: string[] = [];
    const completedSet = new Set(completed.keys());
    const pendingSet = new Set(pending);

    for (const [target, sources] of firedEdges) {
      if (completedSet.has(target)) continue;
      if (pendingSet.has(target)) continue;
      if (nextPending.includes(target)) continue;

      // Check: all sources that fired toward this target must be completed
      let allReady = true;
      for (const src of sources) {
        if (!completedSet.has(src)) {
          allReady = false;
          break;
        }
      }
      if (allReady) {
        nextPending.push(target);
      }
    }

    pending = nextPending;
  }

  // Determine final status
  const status = failedNodes.size > 0 ? 'failed' : 'completed';
  const durationMs = Date.now() - startTime;

  await emitState({
    type: 'run:completed',
    executionId,
    status,
    ts: Date.now(),
  });

  return {
    completed: status === 'completed',
    durationMs,
  };
}
