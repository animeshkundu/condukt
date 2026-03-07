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
  EdgeTarget,
  RetryContext,
} from './types';
import { FlowAbortedError, FlowValidationError } from './types';
import type {
  GraphNodeSkeleton,
  GraphEdgeSkeleton,
  ExecutionEvent,
} from './events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize an EdgeTarget to an array of strings. */
export function normalizeTargets(target: EdgeTarget): string[] {
  if (typeof target === 'string') return [target];
  return [...target];
}

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
    for (const [action, edgeTarget] of Object.entries(actionMap)) {
      for (const target of normalizeTargets(edgeTarget)) {
        if (target !== 'end' && !nodeIds.has(target)) {
          issues.push(
            `Edge target '${target}' (from '${source}' via '${action}') does not exist in graph.nodes`,
          );
        }
      }
    }
  }

  // Cycle detection: DFS from every node. If a back-edge is found, require a loopFallback entry.
  // Build adjacency list from edges
  const adj = new Map<string, Array<{ target: string; source: string; action: string }>>();
  for (const [source, actionMap] of Object.entries(graph.edges)) {
    for (const [action, edgeTarget] of Object.entries(actionMap)) {
      for (const target of normalizeTargets(edgeTarget)) {
        if (target === 'end') continue;
        if (!adj.has(source)) adj.set(source, []);
        adj.get(source)!.push({ target, source, action });
      }
    }
  }

  // DFS cycle detection
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodeIds) color.set(id, WHITE);

  // Track which edge introduced a back-edge for loopFallback validation
  const backEdges: Array<{ source: string; action: string; target: string }> = [];

  function dfs(node: string): void {
    color.set(node, GRAY);
    for (const edge of adj.get(node) ?? []) {
      const c = color.get(edge.target);
      if (c === GRAY) {
        // Back-edge found — this creates a cycle
        backEdges.push(edge);
      } else if (c === WHITE) {
        dfs(edge.target);
      }
    }
    color.set(node, BLACK);
  }

  for (const id of nodeIds) {
    if (color.get(id) === WHITE) dfs(id);
  }

  // For each back-edge, require a loopFallback entry
  for (const edge of backEdges) {
    const key = `${edge.source}:${edge.action}`;
    const fallback = graph.loopFallback?.[key];
    if (!fallback) {
      issues.push(
        `Cycle detected: edge '${edge.source}' → '${edge.target}' via '${edge.action}' ` +
        `requires a loopFallback entry keyed by '${key}'`,
      );
    }
  }

  // Validate loopFallback targets exist
  if (graph.loopFallback) {
    for (const [key, entry] of Object.entries(graph.loopFallback)) {
      for (const target of normalizeTargets(entry.fallbackTarget)) {
        if (target !== 'end' && !nodeIds.has(target)) {
          issues.push(
            `loopFallback '${key}' fallbackTarget '${target}' does not exist in graph.nodes`,
          );
        }
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
    for (const [action, edgeTarget] of Object.entries(actionMap)) {
      for (const target of normalizeTargets(edgeTarget)) {
        edges.push({ source, action, target });
      }
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
// Loop-back reset
// ---------------------------------------------------------------------------

/**
 * Reset the loop body: clear target nodes + source node from completed/nodeStatuses/firedEdges.
 * Emit node:reset events for each. Does NOT cascade downstream.
 *
 * The Reset Contract:
 * - MUST reset: each target node (clear from completed, nodeStatuses, firedEdges[target])
 * - MUST reset: the source node (clear from completed, nodeStatuses)
 * - MUST clear: ONLY the target entries from firedEdges[source] (not other fan-in sources)
 * - MUST emit: node:reset for every reset node, BEFORE re-dispatch
 * - MUST NOT: reset downstream nodes or unrelated fan-in sources
 */
async function resetLoopBody(
  targets: string[],
  sourceNodeId: string,
  iteration: number,
  executionId: string,
  completed: Map<string, { action: string; finishedAt: number }>,
  nodeStatuses: Map<string, string>,
  firedEdges: Map<string, Set<string>>,
  failedNodes: Set<string>,
  emitState: (event: ExecutionEvent) => Promise<void>,
): Promise<void> {
  // Reset each target node
  for (const target of targets) {
    completed.delete(target);
    nodeStatuses.delete(target);
    firedEdges.delete(target);
    failedNodes.delete(target);

    await emitState({
      type: 'node:reset',
      executionId,
      nodeId: target,
      reason: 'loop-back',
      iteration,
      sourceNodeId,
      ts: Date.now(),
    });
  }

  // Reset the source node
  completed.delete(sourceNodeId);
  nodeStatuses.delete(sourceNodeId);
  failedNodes.delete(sourceNodeId);

  // Clear ONLY the loop target entries from firedEdges[source]
  const sourceFiredSources = firedEdges.get(sourceNodeId);
  if (sourceFiredSources) {
    for (const target of targets) {
      sourceFiredSources.delete(target);
    }
    // If no sources left, remove the entry entirely
    if (sourceFiredSources.size === 0) {
      firedEdges.delete(sourceNodeId);
    }
  }

  await emitState({
    type: 'node:reset',
    executionId,
    nodeId: sourceNodeId,
    reason: 'loop-back',
    iteration,
    sourceNodeId,
    ts: Date.now(),
  });
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
  const loopIterations = new Map<string, number>(); // source:action → iteration count
  const loopRetryContexts = new Map<string, RetryContext>(); // nodeId → RetryContext for loop re-dispatch

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
        // Loop-back provides retryContext via loopRetryContexts
        const nodeInput: NodeInput = {
          dir,
          params,
          artifactPaths,
          retryContext: retryContexts?.[nodeId] ?? loopRetryContexts.get(nodeId),
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

    // Phase 1b: Fire edges for all completed nodes (with loop-back detection)
    const loopResets: string[] = []; // nodes to re-dispatch after loop-back reset

    for (const { nodeId, output } of newlyCompleted) {
      const edgeMap = graph.edges[nodeId];
      if (!edgeMap) continue; // terminal node, no outgoing edges

      const action = output.action;
      let edgeTarget = edgeMap[action];
      if (!edgeTarget) {
        edgeTarget = edgeMap['default'];
      }
      if (!edgeTarget) continue;

      const targets = normalizeTargets(edgeTarget).filter(t => t !== 'end');

      // Check if this is a loop-back: any target is already in the completed set
      const loopBackTargets = targets.filter(t => completed.has(t));

      if (loopBackTargets.length > 0) {
        // Loop-back detected
        const loopKey = `${nodeId}:${action}`;
        const currentIteration = (loopIterations.get(loopKey) ?? 0) + 1;
        loopIterations.set(loopKey, currentIteration);

        // Check maxIterations (per-edge or graph-level)
        const fallbackEntry = graph.loopFallback?.[loopKey];
        const maxIter = fallbackEntry?.maxIterations ?? graph.maxIterations ?? 3;

        if (currentIteration > maxIter) {
          // Max iterations exceeded — route to fallback
          if (fallbackEntry) {
            const fallbackTargets = normalizeTargets(fallbackEntry.fallbackTarget);
            for (const fbTarget of fallbackTargets) {
              if (fbTarget === 'end') continue;
              let sources = firedEdges.get(fbTarget);
              if (!sources) {
                sources = new Set();
                firedEdges.set(fbTarget, sources);
              }
              sources.add(nodeId);
              await emitState({
                type: 'edge:traversed',
                executionId,
                source: nodeId,
                target: fbTarget,
                action,
                ts: Date.now(),
              });
            }
          }
          // If no fallback entry (shouldn't happen with validation), flow just stops here
        } else {
          // Reset loop body and re-dispatch
          // Read prior artifacts for RetryContext before resetting
          for (const target of loopBackTargets) {
            const entry = graph.nodes[target];
            let priorOutput: string | null = null;
            if (entry.output) {
              const artifactPath = path.join(dir, entry.output);
              try {
                if (fs.existsSync(artifactPath)) {
                  priorOutput = fs.readFileSync(artifactPath, 'utf-8');
                }
              } catch {
                // ignore
              }
            }
            const fallback = graph.loopFallback?.[`${nodeId}:${action}`];
            const feedback = fallback?.feedbackExtractor
              ? fallback.feedbackExtractor(output.artifact ?? null, output.metadata ?? {})
              : `iteration ${currentIteration}`;
            loopRetryContexts.set(target, { priorOutput, feedback });
          }

          await resetLoopBody(
            loopBackTargets,
            nodeId,
            currentIteration,
            executionId,
            completed,
            nodeStatuses,
            firedEdges,
            failedNodes,
            emitState,
          );

          // Fire edges and queue for re-dispatch
          for (const target of loopBackTargets) {
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
              action,
              ts: Date.now(),
            });

            loopResets.push(target);
          }

          // Also fire non-loop-back targets normally
          for (const target of targets.filter(t => !loopBackTargets.includes(t))) {
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
              action,
              ts: Date.now(),
            });
          }
        }
      } else {
        // Normal edge firing (no loop-back)
        for (const target of targets) {
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
            action,
            ts: Date.now(),
          });
        }
      }
    }

    // Phase 2: Determine which nodes are newly ready
    const nextPending: string[] = [...loopResets]; // include loop-back resets
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

    // All-fail fan-out detection: if all fired sources for a target have failed,
    // the target will never run. Mark as skipped.
    for (const [target, sources] of firedEdges) {
      if (completedSet.has(target)) continue;
      if (failedNodes.has(target)) continue;
      if (nodeStatuses.get(target) === 'skipped') continue;
      if (nextPending.includes(target)) continue;

      let allFailed = true;
      for (const src of sources) {
        if (!failedNodes.has(src)) {
          allFailed = false;
          break;
        }
      }
      if (allFailed && sources.size > 0) {
        nodeStatuses.set(target, 'skipped');
        await emitState({
          type: 'node:skipped',
          executionId,
          nodeId: target,
          ts: Date.now(),
        });
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
