/**
 * Node factory tests — deterministic pass/fail, gate approve/reject/abort.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  AgentRuntime,
  ExecutionContext,
  NodeInput,
} from '../src/types';
import { FlowAbortedError } from '../src/types';
import {
  deterministic,
  gate,
  resolveGate,
  _getGateRegistryForTesting,
} from '../src/nodes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockInput(): NodeInput {
  return {
    dir: '/tmp/test-nodes',
    params: { key: 'value' },
    artifactPaths: {},
  };
}

function createMockContext(
  overrides?: Partial<ExecutionContext>,
): ExecutionContext {
  const ac = new AbortController();
  const mockRuntime: AgentRuntime = {
    name: 'test-runtime',
    createSession: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
  };

  return {
    executionId: 'exec-1',
    nodeId: 'node-1',
    runtime: mockRuntime,
    emitOutput: vi.fn(),
    signal: ac.signal,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deterministic()
// ---------------------------------------------------------------------------

describe('deterministic', () => {
  it('wraps a function returning pass action', async () => {
    const fn = deterministic('quality-check', async (input) => {
      return { action: 'pass', artifact: `Checked ${input.dir}` };
    });

    const input = createMockInput();
    const ctx = createMockContext();
    const result = await fn(input, ctx);

    expect(result.action).toBe('pass');
    expect(result.artifact).toBe('Checked /tmp/test-nodes');
  });

  it('wraps a function returning fail action', async () => {
    const fn = deterministic('validation', async (_input) => {
      return { action: 'fail', metadata: { reason: 'missing sections' } };
    });

    const input = createMockInput();
    const ctx = createMockContext();
    const result = await fn(input, ctx);

    expect(result.action).toBe('fail');
    expect(result.metadata).toEqual({ reason: 'missing sections' });
  });

  it('propagates errors from wrapped function', async () => {
    const fn = deterministic('failing-check', async () => {
      throw new Error('Check exploded');
    });

    const input = createMockInput();
    const ctx = createMockContext();

    await expect(fn(input, ctx)).rejects.toThrow('Check exploded');
  });

  it('has access to full NodeInput', async () => {
    const fn = deterministic('param-reader', async (input) => {
      const key = input.params.key as string;
      return { action: key === 'value' ? 'match' : 'no-match' };
    });

    const input = createMockInput();
    const ctx = createMockContext();
    const result = await fn(input, ctx);

    expect(result.action).toBe('match');
  });
});

// ---------------------------------------------------------------------------
// gate()
// ---------------------------------------------------------------------------

describe('gate', () => {
  beforeEach(() => {
    // Clear gate registry before each test
    const registry = _getGateRegistryForTesting();
    registry.clear();
  });

  afterEach(() => {
    const registry = _getGateRegistryForTesting();
    registry.clear();
  });

  it('blocks until resolved with approved', async () => {
    const gateFn = gate('approval');
    const input = createMockInput();
    const ctx = createMockContext({ executionId: 'exec-gate', nodeId: 'gate-1' });

    // Start the gate (it will block)
    const gatePromise = gateFn(input, ctx);

    // Verify gate is registered
    const registry = _getGateRegistryForTesting();
    expect(registry.has('exec-gate:gate-1')).toBe(true);

    // Resolve the gate
    const resolved = resolveGate('exec-gate', 'gate-1', 'approved');
    expect(resolved).toBe(true);

    // Gate should now complete
    const result = await gatePromise;
    expect(result.action).toBe('approved');

    // Registry should be cleaned up
    expect(registry.has('exec-gate:gate-1')).toBe(false);
  });

  it('blocks until resolved with rejected', async () => {
    const gateFn = gate('quality-review');
    const input = createMockInput();
    const ctx = createMockContext({ executionId: 'exec-gate', nodeId: 'gate-2' });

    const gatePromise = gateFn(input, ctx);

    const resolved = resolveGate('exec-gate', 'gate-2', 'rejected');
    expect(resolved).toBe(true);

    const result = await gatePromise;
    expect(result.action).toBe('rejected');
  });

  it('resolveGate returns false for unknown gate', () => {
    const result = resolveGate('exec-unknown', 'gate-unknown', 'approved');
    expect(result).toBe(false);
  });

  it('rejects on abort signal', async () => {
    const gateFn = gate('approval');
    const input = createMockInput();
    const ac = new AbortController();
    const ctx = createMockContext({
      executionId: 'exec-abort',
      nodeId: 'gate-abort',
      signal: ac.signal,
    });

    const gatePromise = gateFn(input, ctx);

    // Verify gate is registered
    const registry = _getGateRegistryForTesting();
    expect(registry.has('exec-abort:gate-abort')).toBe(true);

    // Abort
    ac.abort();

    await expect(gatePromise).rejects.toThrow(FlowAbortedError);

    // Registry should be cleaned up
    expect(registry.has('exec-abort:gate-abort')).toBe(false);
  });

  it('throws immediately if signal already aborted', async () => {
    const gateFn = gate('approval');
    const input = createMockInput();
    const ac = new AbortController();
    ac.abort();
    const ctx = createMockContext({
      executionId: 'exec-preabort',
      nodeId: 'gate-preabort',
      signal: ac.signal,
    });

    await expect(gateFn(input, ctx)).rejects.toThrow(FlowAbortedError);

    // Should not be registered
    const registry = _getGateRegistryForTesting();
    expect(registry.has('exec-preabort:gate-preabort')).toBe(false);
  });

  it('multiple gates can coexist independently', async () => {
    const gate1Fn = gate('approval');
    const gate2Fn = gate('review');
    const input = createMockInput();

    const ctx1 = createMockContext({ executionId: 'exec-multi', nodeId: 'gate-a' });
    const ctx2 = createMockContext({ executionId: 'exec-multi', nodeId: 'gate-b' });

    const promise1 = gate1Fn(input, ctx1);
    const promise2 = gate2Fn(input, ctx2);

    const registry = _getGateRegistryForTesting();
    expect(registry.size).toBe(2);

    // Resolve gate-b first
    resolveGate('exec-multi', 'gate-b', 'approved');
    const result2 = await promise2;
    expect(result2.action).toBe('approved');

    // gate-a still waiting
    expect(registry.has('exec-multi:gate-a')).toBe(true);

    // Resolve gate-a
    resolveGate('exec-multi', 'gate-a', 'rejected');
    const result1 = await promise1;
    expect(result1.action).toBe('rejected');

    expect(registry.size).toBe(0);
  });
});
