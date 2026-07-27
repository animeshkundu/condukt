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
  LoopRegion,
} from './types';
import { FlowAbortedError, FlowValidationError, NO_OP_LOGGER } from './types';
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

  // Validate explicit multi-node loop regions.
  const claimedRegionNodes = new Map<string, string>();
  const regionIds = new Set<string>();
  for (const region of graph.loops ?? []) {
    if (regionIds.has(region.id)) {
      issues.push(`Loop region id '${region.id}' is duplicated`);
    }
    regionIds.add(region.id);

    const hasMaxIterations = region.maxIterations !== undefined;
    const hasMaxRounds = region.maxRounds !== undefined;
    if (hasMaxIterations === hasMaxRounds) {
      issues.push(
        `Loop region '${region.id}' must set exactly one of maxIterations or maxRounds`,
      );
    }
    if (region.maxIterations !== undefined && region.maxIterations < 0) {
      issues.push(`Loop region '${region.id}' maxIterations must be at least 0`);
    }
    if (region.maxRounds !== undefined && region.maxRounds < 1) {
      issues.push(`Loop region '${region.id}' maxRounds must be at least 1`);
    }
    if (
      region.budgetMs !== undefined
      && (!Number.isFinite(region.budgetMs) || region.budgetMs < 0)
    ) {
      issues.push(`Loop region '${region.id}' budgetMs must be a non-negative finite number`);
    }

    const regionNodes = new Set<string>();
    for (const nodeId of region.nodes) {
      if (regionNodes.has(nodeId)) {
        issues.push(`Loop region '${region.id}' contains duplicate node '${nodeId}'`);
        continue;
      }
      regionNodes.add(nodeId);

      if (!nodeIds.has(nodeId)) {
        issues.push(`Loop region '${region.id}' node '${nodeId}' does not exist in graph.nodes`);
      }

      const claimedBy = claimedRegionNodes.get(nodeId);
      if (claimedBy) {
        issues.push(
          `Loop regions '${claimedBy}' and '${region.id}' overlap at node '${nodeId}'`,
        );
      } else {
        claimedRegionNodes.set(nodeId, region.id);
      }
    }

    if (!regionNodes.has(region.entry)) {
      issues.push(`Loop region '${region.id}' entry '${region.entry}' is not in region.nodes`);
    }
    if (!regionNodes.has(region.decision)) {
      issues.push(`Loop region '${region.id}' decision '${region.decision}' is not in region.nodes`);
    }

    const regionEntries = new Set<string>();
    for (const startId of graph.start) {
      if (regionNodes.has(startId)) regionEntries.add(startId);
    }
    for (const [source, actionMap] of Object.entries(graph.edges)) {
      if (regionNodes.has(source)) continue;
      for (const edgeTarget of Object.values(actionMap)) {
        for (const target of normalizeTargets(edgeTarget)) {
          if (regionNodes.has(target)) regionEntries.add(target);
        }
      }
    }
    if (regionEntries.size > 1) {
      issues.push(
        `Loop region '${region.id}' has multiple entry nodes: ${[...regionEntries].join(', ')}`,
      );
    } else if (regionEntries.size === 1 && !regionEntries.has(region.entry)) {
      issues.push(
        `Loop region '${region.id}' external entry does not match declared entry '${region.entry}'`,
      );
    }

    const decisionEdges = graph.edges[region.decision];
    if (!decisionEdges || !Object.prototype.hasOwnProperty.call(decisionEdges, region.continueOn)) {
      issues.push(
        `Loop region '${region.id}' decision '${region.decision}' has no edge for continueOn action '${region.continueOn}'`,
      );
    }
    if (!decisionEdges || !Object.prototype.hasOwnProperty.call(decisionEdges, region.exitOn)) {
      issues.push(
        `Loop region '${region.id}' decision '${region.decision}' has no edge for exitOn action '${region.exitOn}'`,
      );
    }

    if (regionNodes.has(region.entry)) {
      const reachable = new Set<string>([region.entry]);
      const frontier = [region.entry];
      while (frontier.length > 0) {
        const source = frontier.pop();
        if (!source) continue;

        for (const [action, edgeTarget] of Object.entries(graph.edges[source] ?? {})) {
          if (source === region.decision && action === region.continueOn) continue;

          for (const target of normalizeTargets(edgeTarget)) {
            if (!regionNodes.has(target) || reachable.has(target)) continue;
            reachable.add(target);
            frontier.push(target);
          }
        }
      }

      for (const nodeId of regionNodes) {
        if (!reachable.has(nodeId)) {
          issues.push(
            `Loop region '${region.id}' node '${nodeId}' is not reachable from entry '${region.entry}'`,
          );
        }
      }
    }

    if (region.onExhausted !== undefined) {
      for (const target of normalizeTargets(region.onExhausted)) {
        if (target !== 'end' && !nodeIds.has(target)) {
          issues.push(
            `Loop region '${region.id}' onExhausted target '${target}' does not exist in graph.nodes`,
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
      const isRegionContinuation = graph.loops?.some(region =>
        region.decision === source && region.continueOn === action,
      ) ?? false;
      if (isRegionContinuation) continue;

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

  // For each remaining back-edge, require a loopFallback entry. Declared region
  // continuation edges were excluded from the adjacency list above.
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
  onTimeout: () => void,
): { promise: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Node timed out after ${seconds}s`));
      onTimeout();
    }, seconds * 1000);
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
  const clearedEdges: Array<{ source: string; target: string }> = [];

  // Reset each target node
  for (const target of targets) {
    completed.delete(target);
    nodeStatuses.delete(target);
    const firedSources = firedEdges.get(target);
    if (firedSources) {
      for (const source of firedSources) {
        clearedEdges.push({ source, target });
      }
      firedEdges.delete(target);
    }
    failedNodes.delete(target);
  }

  // Reset the source node
  completed.delete(sourceNodeId);
  nodeStatuses.delete(sourceNodeId);
  failedNodes.delete(sourceNodeId);

  // Clear ONLY the loop target entries from firedEdges[source]
  const sourceFiredSources = firedEdges.get(sourceNodeId);
  if (sourceFiredSources) {
    for (const target of targets) {
      if (sourceFiredSources.delete(target)) {
        clearedEdges.push({ source: target, target: sourceNodeId });
      }
    }
    // If no sources left, remove the entry entirely
    if (sourceFiredSources.size === 0) {
      firedEdges.delete(sourceNodeId);
    }
  }

  // Carry the complete batch delta once. Repeating this event is safe because
  // the projection reducer only restores the listed edges to 'default'.
  for (let index = 0; index < targets.length; index++) {
    await emitState({
      type: 'node:reset',
      executionId,
      nodeId: targets[index],
      reason: 'loop-back',
      iteration,
      sourceNodeId,
      ...(index === 0 && clearedEdges.length > 0 ? { clearedEdges } : {}),
      ts: Date.now(),
    });
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

/**
 * Reset an explicit loop region without disturbing external fan-in tokens.
 * Only sources inside the region reset set are removed from each reset node's inbox.
 */
async function resetLoopRegion(
  region: LoopRegion,
  continueTargets: readonly string[],
  iteration: number,
  executionId: string,
  completed: Map<string, { action: string; finishedAt: number }>,
  nodeStatuses: Map<string, string>,
  firedEdges: Map<string, Set<string>>,
  failedNodes: Set<string>,
  emitState: (event: ExecutionEvent) => Promise<void>,
): Promise<void> {
  const resetNodes = new Set([...region.nodes, region.decision]);
  const clearedEdges: Array<{ source: string; target: string }> = [];

  for (const nodeId of resetNodes) {
    completed.delete(nodeId);
    nodeStatuses.delete(nodeId);
    failedNodes.delete(nodeId);

    const firedSources = firedEdges.get(nodeId);
    if (firedSources) {
      for (const source of [...firedSources]) {
        if (resetNodes.has(source)) {
          firedSources.delete(source);
          clearedEdges.push({ source, target: nodeId });
        }
      }
      if (firedSources.size === 0) {
        firedEdges.delete(nodeId);
      }
    }
  }

  // Remove any prior decision continuation token, including from a target outside
  // the reset set, so an earlier iteration cannot make a later target ready.
  for (const target of continueTargets) {
    const firedSources = firedEdges.get(target);
    if (!firedSources) continue;
    if (firedSources.delete(region.decision)) {
      clearedEdges.push({ source: region.decision, target });
    }
    if (firedSources.size === 0) {
      firedEdges.delete(target);
    }
  }

  // Carry the complete batch delta once, including continuation targets outside
  // the reset set. Subsequent reset events only carry their node state change.
  let index = 0;
  for (const nodeId of resetNodes) {
    await emitState({
      type: 'node:reset',
      executionId,
      nodeId,
      reason: 'loop-back',
      iteration,
      sourceNodeId: region.decision,
      ...(index === 0 && clearedEdges.length > 0 ? { clearedEdges } : {}),
      ts: Date.now(),
    });
    index += 1;
  }
}

export const _resetLoopRegionForTesting = resetLoopRegion;

// ---------------------------------------------------------------------------
// Usage attribution
// ---------------------------------------------------------------------------

interface UsageAttribution {
  readonly usage: Readonly<Record<string, unknown>>;
  readonly provenance: 'main' | 'subagent';
}

interface ErrorWithNodeUsage extends Error {
  readonly nodeUsage?: {
    readonly attemptUsage?: readonly unknown[];
    readonly subagentUsage?: readonly unknown[];
  };
}

function appendUsageRecords(
  target: UsageAttribution[],
  values: unknown,
  provenance: UsageAttribution['provenance'],
): void {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target.push({
        usage: value as Readonly<Record<string, unknown>>,
        provenance,
      });
    }
  }
}

function usageAttributions(
  metadata: Readonly<Record<string, unknown>> | undefined,
): readonly UsageAttribution[] {
  if (!metadata) return [];
  const usages: UsageAttribution[] = [];
  if (Array.isArray(metadata.attemptUsage)) {
    appendUsageRecords(usages, metadata.attemptUsage, 'main');
  } else if (
    metadata.usage &&
    typeof metadata.usage === 'object' &&
    !Array.isArray(metadata.usage)
  ) {
    usages.push({
      usage: metadata.usage as Readonly<Record<string, unknown>>,
      provenance: 'main',
    });
  }
  appendUsageRecords(usages, metadata.subagentUsage, 'subagent');
  return usages;
}

function errorUsageAttributions(error: unknown): readonly UsageAttribution[] {
  if (!(error instanceof Error)) return [];
  const nodeUsage = (error as ErrorWithNodeUsage).nodeUsage;
  if (!nodeUsage) return [];
  const usages: UsageAttribution[] = [];
  appendUsageRecords(usages, nodeUsage.attemptUsage, 'main');
  appendUsageRecords(usages, nodeUsage.subagentUsage, 'subagent');
  return usages;
}

async function recordUsageCosts(
  usages: readonly UsageAttribution[],
  entry: NodeEntry,
  executionId: string,
  nodeId: string,
  costResolver: NonNullable<RunOptions['costResolver']>,
  emitState: RunOptions['emitState'],
): Promise<void> {
  for (const item of usages) {
    const tokens = Number(
      item.usage.totalTokens ??
      ((Number(item.usage.inputTokens) || 0) + (Number(item.usage.outputTokens) || 0)),
    ) || 0;
    const reportedModel = typeof item.usage.model === 'string'
      ? item.usage.model
      : undefined;
    const model = item.provenance === 'subagent'
      ? reportedModel ?? 'unknown'
      : reportedModel ?? entry.model ?? 'unknown';
    const usageWithProvenance: Readonly<Record<string, unknown>> = {
      ...item.usage,
      provenance: item.provenance,
    };
    const cost = costResolver(usageWithProvenance, model);
    await emitState({
      type: 'cost:recorded',
      executionId,
      nodeId,
      tokens,
      model,
      provenance: item.provenance,
      cost,
      ts: Date.now(),
    });
  }
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
    costResolver,
    resumeFrom,
    retryContexts,
  } = options;
  const logger = options.logger ?? NO_OP_LOGGER;
  void logger;

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
  const loopIterations = new Map<string, number>(); // legacy source:action or region:id → iteration count
  const loopRetryContexts = new Map<string, RetryContext>(); // nodeId → RetryContext for loop re-dispatch
  const loopRegionsByDecision = new Map<string, LoopRegion>();
  const loopRegionsByNode = new Map<string, LoopRegion>();
  const loopRegionTimings = new Map<string, {
    startedAt: number;
    roundStartedAt: number;
    maxRoundElapsedMs: number;
  }>();
  for (const region of graph.loops ?? []) {
    loopRegionsByDecision.set(region.decision, region);
    if (region.budgetMs !== undefined) {
      for (const nodeId of region.nodes) loopRegionsByNode.set(nodeId, region);
    }
  }

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
    for (const [loopKey, iteration] of resumeFrom.loopIterations) {
      loopIterations.set(loopKey, iteration);
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

    // Start a budgeted region's clock at its first entry, before dispatch.
    if (loopRegionsByNode.size > 0) {
      const batchStartedAt = Date.now();
      for (const nodeId of pending) {
        const region = loopRegionsByNode.get(nodeId);
        if (region && !loopRegionTimings.has(region.id)) {
          loopRegionTimings.set(region.id, {
            startedAt: batchStartedAt,
            roundStartedAt: batchStartedAt,
            maxRoundElapsedMs: 0,
          });
        }
      }
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

        // Give each dispatch its own cancellation scope. The node stops when either
        // the flow is stopped or this dispatch reaches its timeout.
        const nodeController = new AbortController();
        const nodeSignal = AbortSignal.any([signal, nodeController.signal]);

        let retryAttempt = 1;
        const execCtx: ExecutionContext = {
          executionId,
          nodeId,
          runtime,
          emitOutput,
          emitState,
          nextRetryAttempt: () => {
            retryAttempt += 1;
            return retryAttempt;
          },
          signal: nodeSignal,
        };

        const nodeStart = Date.now();
        const timeoutSecs = entry.timeout ?? 3600;

        // Dispatch with timeout (CR3: applies to ALL node types)
        // C3 fix: clear timer when node completes to prevent leaks
        const timeout = rejectAfterTimeout(timeoutSecs, nodeSignal, () => {
          nodeController.abort(new Error(`Node timed out after ${timeoutSecs}s`));
        });
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

        if (costResolver) {
          await recordUsageCosts(
            usageAttributions(output.metadata),
            entry,
            executionId,
            nodeId,
            costResolver,
            emitState,
          );
        }

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

        if (costResolver) {
          await recordUsageCosts(
            errorUsageAttributions(result.reason),
            graph.nodes[nodeId],
            executionId,
            nodeId,
            costResolver,
            emitState,
          );
        }

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
    const continuingRegionDecisionIds = new Set(
      newlyCompleted
        .filter(({ nodeId, output }) => {
          const region = loopRegionsByDecision.get(nodeId);
          return region?.continueOn === output.action;
        })
        .map(({ nodeId }) => nodeId),
    );
    const edgeCompletions = continuingRegionDecisionIds.size === 0
      ? newlyCompleted
      : [
          ...newlyCompleted.filter(({ nodeId }) =>
            !continuingRegionDecisionIds.has(nodeId),
          ),
          ...newlyCompleted.filter(({ nodeId }) =>
            continuingRegionDecisionIds.has(nodeId),
          ),
        ];

    // Process continuing region decisions last so reset clears every internal
    // contribution fired by body nodes that completed in the same batch.
    for (const { nodeId, output } of edgeCompletions) {
      const edgeMap = graph.edges[nodeId];
      if (!edgeMap) continue; // terminal node, no outgoing edges

      const action = output.action;
      let edgeTarget = edgeMap[action];
      if (!edgeTarget) {
        edgeTarget = edgeMap['default'];
      }
      if (!edgeTarget) continue;

      const targets = normalizeTargets(edgeTarget).filter(t => t !== 'end');
      const region = loopRegionsByDecision.get(nodeId);

      if (region && action === region.continueOn) {
        const loopKey = `region:${region.id}`;
        const currentIteration = (loopIterations.get(loopKey) ?? 0) + 1;
        loopIterations.set(loopKey, currentIteration);

        const effectiveMaxLoopBacks = region.maxRounds !== undefined
          ? region.maxRounds - 1
          : region.maxIterations!;
        const countExhausted = currentIteration > effectiveMaxLoopBacks;
        const timing = loopRegionTimings.get(region.id);
        let timeExhaustion: {
          reason: 'time';
          budgetMs: number;
          elapsedMs: number;
          estimatedNextRoundMs: number;
        } | undefined;

        if (!countExhausted && timing && region.budgetMs !== undefined) {
          const now = Date.now();
          const roundElapsedMs = now - timing.roundStartedAt;
          // The slowest completed round is deliberately conservative: a fast round
          // cannot pull the estimate down and tempt us into work that may be killed.
          timing.maxRoundElapsedMs = Math.max(timing.maxRoundElapsedMs, roundElapsedMs);
          const elapsedMs = now - timing.startedAt;
          if (elapsedMs + timing.maxRoundElapsedMs >= region.budgetMs) {
            timeExhaustion = {
              reason: 'time',
              budgetMs: region.budgetMs,
              elapsedMs,
              estimatedNextRoundMs: timing.maxRoundElapsedMs,
            };
          }
        }

        if (countExhausted || timeExhaustion) {
          const exhaustion = timeExhaustion ?? { reason: 'count' as const };
          const exhaustionTarget = region.onExhausted ?? edgeMap[region.exitOn];
          const exhaustionAction = region.onExhausted === undefined
            ? region.exitOn
            : action;
          if (region.budgetMs !== undefined) {
            logger.info(
              `Loop region '${region.id}' exhausted by ${exhaustion.reason} budget`,
              exhaustion,
            );
          }
          for (const target of normalizeTargets(exhaustionTarget)) {
            if (target !== 'end') {
              let sources = firedEdges.get(target);
              if (!sources) {
                sources = new Set();
                firedEdges.set(target, sources);
              }
              sources.add(nodeId);
            } else if (region.budgetMs === undefined) {
              continue;
            }
            await emitState({
              type: 'edge:traversed',
              executionId,
              source: nodeId,
              target,
              action: exhaustionAction,
              ...(region.budgetMs === undefined ? {} : { exhaustion }),
              ts: Date.now(),
            });
          }
        } else {
          if (timing) timing.roundStartedAt = Date.now();
          const entryNode = graph.nodes[region.entry];
          let priorOutput: string | null = null;
          if (entryNode.output) {
            const artifactPath = path.join(dir, entryNode.output);
            try {
              if (fs.existsSync(artifactPath)) {
                priorOutput = fs.readFileSync(artifactPath, 'utf-8');
              }
            } catch {
              // ignore
            }
          }
          const feedback = region.feedback
            ? region.feedback(output.artifact ?? null, currentIteration)
            : `iteration ${currentIteration}`;
          loopRetryContexts.set(region.entry, { priorOutput, feedback });

          await resetLoopRegion(
            region,
            targets,
            currentIteration,
            executionId,
            completed,
            nodeStatuses,
            firedEdges,
            failedNodes,
            emitState,
          );

          loopResets.push(region.entry);
        }
        continue;
      }

      // Check if this is a loop-back: any target is already completed or failed
      const loopBackTargets = targets.filter(t => completed.has(t) || failedNodes.has(t));

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
