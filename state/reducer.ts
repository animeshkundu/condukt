/**
 * Pure projection reducer — folds ExecutionEvents into ExecutionProjection.
 *
 * Zero I/O. Exhaustive switch with `never` default. All updates are immutable.
 */

import type {
  ExecutionProjection,
  ProjectionNode,
  ProjectionEdge,
} from '../src/types';
import type { ExecutionEvent } from '../src/events';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmptyProjection(id: string, flowId?: string): ExecutionProjection {
  return {
    id,
    flowId: flowId ?? '',
    status: 'pending',
    params: {},
    graph: {
      nodes: [],
      edges: [],
      activeNodes: [],
      completedPath: [],
    },
    totalCost: 0,
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_COMPLETED_PATH = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateNode(
  state: ExecutionProjection,
  nodeId: string,
  updater: (node: ProjectionNode) => ProjectionNode,
): ExecutionProjection {
  const nodes = state.graph.nodes.map((n) =>
    n.id === nodeId ? updater(n) : n,
  );
  // Recalculate activeNodes: nodes with status 'running', 'gated', or 'retrying'
  const activeNodes = nodes
    .filter((n) => n.status === 'running' || n.status === 'gated' || n.status === 'retrying')
    .map((n) => n.id);
  return {
    ...state,
    graph: { ...state.graph, nodes, activeNodes },
  };
}

function updateEdge(
  state: ExecutionProjection,
  source: string,
  target: string,
  newState: ProjectionEdge['state'],
): ExecutionProjection {
  const edges = state.graph.edges.map((e) => {
    if (e.source === source && e.target === target) {
      return { ...e, state: newState };
    }
    // Mark sibling edges from the same source as 'not_taken' if still 'default'
    if (e.source === source && e.state === 'default') {
      return { ...e, state: 'not_taken' as const };
    }
    return e;
  });
  return { ...state, graph: { ...state.graph, edges } };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function reduce(
  state: ExecutionProjection,
  event: ExecutionEvent,
): ExecutionProjection {
  switch (event.type) {
    case 'run:started': {
      const nodes: ProjectionNode[] = event.graph.nodes.map((n) => ({
        id: n.id,
        displayName: n.displayName,
        nodeType: n.nodeType,
        model: n.model,
        status: 'pending',
        attempt: 0,
        iteration: 0,
        output: n.output,
      }));
      const edges: ProjectionEdge[] = event.graph.edges.map((e) => ({
        source: e.source,
        action: e.action,
        target: e.target,
        state: 'default' as const,
      }));
      return {
        ...state,
        status: 'running',
        flowId: event.flowId,
        params: { ...event.params },
        startedAt: event.ts,
        graph: {
          nodes,
          edges,
          activeNodes: [],
          completedPath: [],
        },
      };
    }

    case 'run:completed': {
      let updated: ExecutionProjection = {
        ...state,
        status: event.status,
        finishedAt: event.ts,
      };
      // When execution crashes or stops, mark running nodes accordingly
      if (event.status === 'crashed' || event.status === 'stopped') {
        const nodes = updated.graph.nodes.map(n =>
          n.status === 'running' || n.status === 'retrying'
            ? { ...n, status: event.status, finishedAt: event.ts }
            : n
        );
        const activeNodes = nodes
          .filter(n => n.status === 'running' || n.status === 'gated' || n.status === 'retrying')
          .map(n => n.id);
        updated = {
          ...updated,
          graph: { ...updated.graph, nodes, activeNodes },
        };
      }
      return updated;
    }

    case 'run:resumed':
      return {
        ...state,
        status: 'running',
      };

    case 'node:started':
      return updateNode(state, event.nodeId, (n) => ({
        ...n,
        status: 'running',
        startedAt: event.ts,
        attempt: n.attempt + 1,
      }));

    case 'node:completed': {
      // Don't overwrite 'skipped' status — gate rejection takes precedence over
      // the scheduler's node:completed (which fires after the gate Promise resolves)
      const existing = state.graph.nodes.find(n => n.id === event.nodeId);
      if (existing?.status === 'skipped') return state;

      const updated = updateNode(state, event.nodeId, (n) => ({
        ...n,
        status: 'completed',
        action: event.action,
        finishedAt: event.ts,
        elapsedMs: event.elapsedMs,
      }));
      const newPath = [...updated.graph.completedPath, event.nodeId];
      return {
        ...updated,
        graph: {
          ...updated.graph,
          completedPath: newPath.length > MAX_COMPLETED_PATH
            ? newPath.slice(-MAX_COMPLETED_PATH)
            : newPath,
        },
      };
    }

    case 'node:failed':
      return updateNode(state, event.nodeId, (n) => ({
        ...n,
        status: 'failed',
        finishedAt: event.ts,
        error: event.error,
      }));

    case 'node:killed':
      return updateNode(state, event.nodeId, (n) => ({
        ...n,
        status: 'killed',
        finishedAt: event.ts,
      }));

    case 'node:skipped':
      return updateNode(state, event.nodeId, (n) => ({
        ...n,
        status: 'skipped',
        finishedAt: event.ts,
      }));

    case 'node:gated':
      return updateNode(state, event.nodeId, (n) => ({
        ...n,
        status: 'gated',
        gateData: event.gateData,
      }));

    case 'gate:resolved': {
      const resolvedStatus =
        event.resolution === 'rejected' ? 'skipped' : 'completed';
      const updated = updateNode(state, event.nodeId, (n) => ({
        ...n,
        status: resolvedStatus,
        action: event.resolution,
        finishedAt: event.ts,
      }));
      // If not rejected, also add to completedPath
      if (resolvedStatus === 'completed') {
        const newPath = [...updated.graph.completedPath, event.nodeId];
        return {
          ...updated,
          graph: {
            ...updated.graph,
            completedPath: newPath.length > MAX_COMPLETED_PATH
              ? newPath.slice(-MAX_COMPLETED_PATH)
              : newPath,
          },
        };
      }
      return updated;
    }

    case 'node:retrying':
      return updateNode(state, event.nodeId, (n) => ({
        ...n,
        status: 'retrying',
        attempt: event.attempt,
        error: undefined,
        finishedAt: undefined,
        elapsedMs: undefined,
      }));

    case 'edge:traversed':
      return updateEdge(state, event.source, event.target, 'taken');

    case 'artifact:written':
      // Artifacts are stored separately — no projection change
      return state;

    case 'cost:recorded':
      return {
        ...state,
        totalCost: state.totalCost + event.cost,
      };

    case 'metadata': {
      // CR1: array merge semantics — arrays accumulate, scalars overwrite
      const existing = state.metadata[event.key];
      let merged: unknown;
      if (Array.isArray(existing) && Array.isArray(event.value)) {
        merged = [...existing, ...event.value];
      } else {
        merged = event.value;
      }
      return {
        ...state,
        metadata: { ...state.metadata, [event.key]: merged },
      };
    }

    case 'node:reset':
      return updateNode(state, event.nodeId, (n) => ({
        ...n,
        status: 'pending',
        iteration: event.iteration,
        action: undefined,
        finishedAt: undefined,
        elapsedMs: undefined,
        error: undefined,
      }));

    default: {
      // Exhaustiveness check — if this errors, a new event type was added without a case
      const _exhaustive: never = event;
      throw new Error(`Unhandled event type: ${(_exhaustive as ExecutionEvent).type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export function replayEvents(
  id: string,
  events: readonly ExecutionEvent[],
): ExecutionProjection {
  return events.reduce<ExecutionProjection>(
    (state, event) => reduce(state, event),
    createEmptyProjection(id),
  );
}
