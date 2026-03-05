/**
 * Non-agent node factories: deterministic() and gate().
 *
 * deterministic() — wraps a pure function as a NodeFn (ignores ExecutionContext).
 * gate() — returns a blocking NodeFn resolved externally via resolveGate().
 *
 * Gate mechanism:
 *   1. gate() creates a Promise + resolver, stores in module-level gateRegistry
 *   2. The scheduler dispatches the gate node; it blocks on the Promise
 *   3. External code (bridge/API) calls resolveGate() to unblock
 *   4. The scheduler sees the gate complete normally and proceeds
 *
 * Gate nodes listen for abort signals so they can be cleanly cancelled.
 * The gate registry is module-level (survives across requests but not restarts).
 * Restart recovery: the scheduler re-dispatches gate nodes, creating fresh resolvers (CR4).
 */

import type {
  ExecutionContext,
  NodeFn,
  NodeInput,
  NodeOutput,
} from './types';
import { FlowAbortedError } from './types';

// ---------------------------------------------------------------------------
// Deterministic node factory
// ---------------------------------------------------------------------------

/**
 * Wraps a pure async function as a NodeFn.
 * The ExecutionContext is available but typically unused — deterministic nodes
 * don't need runtime services or streaming output.
 *
 * @param _name - Display name (used for logging/debugging, not stored here)
 * @param fn - The computation. Receives NodeInput, returns NodeOutput.
 */
export function deterministic(
  _name: string,
  fn: (input: NodeInput) => Promise<NodeOutput>,
): NodeFn {
  return async (input: NodeInput, _ctx: ExecutionContext): Promise<NodeOutput> => {
    return fn(input);
  };
}

// ---------------------------------------------------------------------------
// Gate registry (globalThis — survives HMR and separate entry points, ARCH-2)
// ---------------------------------------------------------------------------

interface GateEntry {
  resolve: (output: NodeOutput) => void;
  reject: (err: Error) => void;
}

const GATE_REGISTRY_KEY = Symbol.for('__flow_gate_registry__');

/** globalThis-backed registry: survives HMR, separate entry points, bundler dedup. */
function getGateRegistry(): Map<string, GateEntry> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[GATE_REGISTRY_KEY]) {
    g[GATE_REGISTRY_KEY] = new Map<string, GateEntry>();
  }
  return g[GATE_REGISTRY_KEY] as Map<string, GateEntry>;
}

/**
 * Expose the registry for testing purposes only.
 * @internal
 */
export function _getGateRegistryForTesting(): Map<string, GateEntry> {
  return getGateRegistry();
}

// ---------------------------------------------------------------------------
// Gate node factory
// ---------------------------------------------------------------------------

/**
 * Creates a NodeFn that blocks until externally resolved via resolveGate().
 *
 * The gate:
 * - Registers a Promise resolver in the module-level gateRegistry
 * - Blocks (awaits the Promise) until resolveGate() is called
 * - Listens for abort signal to clean up on cancellation
 * - Returns { action: resolution } when resolved (e.g., 'approved', 'rejected')
 *
 * The scheduler emits node:gated after dispatching gate-type nodes.
 * The bridge emits gate:resolved when calling resolveGate().
 *
 * @param name - Optional gate type name (e.g., 'approval', 'quality-review').
 *               Used by the scheduler for the node:gated event's gateType field.
 */
export function gate(name?: string): NodeFn {
  // The name is captured in the closure but only used for documentation/debugging.
  // The scheduler reads the nodeType from NodeEntry to determine gate behavior.
  void name;

  return async (_input: NodeInput, ctx: ExecutionContext): Promise<NodeOutput> => {
    const key = `${ctx.executionId}:${ctx.nodeId}`;

    // Abort check: bail early if already aborted
    if (ctx.signal.aborted) {
      throw new FlowAbortedError('Gate aborted before registration');
    }

    return new Promise<NodeOutput>((resolve, reject) => {
      const registry = getGateRegistry();
      // Register resolver in the gate registry
      registry.set(key, { resolve, reject });

      // Listen for abort signal — clean up and reject if cancelled (AI-3: prevents memory leak)
      const onAbort = () => {
        registry.delete(key);
        reject(new FlowAbortedError('Gate aborted'));
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
  };
}

// ---------------------------------------------------------------------------
// Gate resolution (called by bridge from API endpoint)
// ---------------------------------------------------------------------------

/**
 * Resolves a waiting gate node, unblocking the scheduler.
 *
 * @param executionId - The execution containing the gate
 * @param nodeId - The gate node's ID
 * @param resolution - The action string (e.g., 'approved', 'rejected')
 * @param _reason - Optional human-readable reason (for audit, not used in output)
 * @returns true if the gate was found and resolved, false otherwise
 */
export function resolveGate(
  executionId: string,
  nodeId: string,
  resolution: string,
  _reason?: string,
): boolean {
  const key = `${executionId}:${nodeId}`;
  const registry = getGateRegistry();
  const entry = registry.get(key);
  if (!entry) {
    return false;
  }

  entry.resolve({ action: resolution });
  registry.delete(key);
  return true;
}
