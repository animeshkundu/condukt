/**
 * Integration test — exercises the full pipeline from launch to completion.
 *
 * Uses the CI/CD counter-test composition with MemoryStorage,
 * proving the framework works end-to-end without any investigation
 * domain code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, validateGraph, computeFrontier } from '../src/scheduler';
import { MemoryStorage } from '../state/storage-memory';
import { StateRuntime } from '../state/state-runtime';
import { reduce, createEmptyProjection, replayEvents } from '../state/reducer';
import { resolveGate, _getGateRegistryForTesting } from '../src/nodes';
import { cicdFlow } from '../examples/counter-test/cicd';
import type { RunOptions, AgentRuntime } from '../src/types';
import type { ExecutionEvent } from '../src/events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRuntime(): AgentRuntime {
  return {
    name: 'mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockRejectedValue(new Error('No sessions in deterministic flow')),
  };
}

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flow-int-'));
}

// ---------------------------------------------------------------------------
// Full pipeline integration tests
// ---------------------------------------------------------------------------

describe('integration: CI/CD pipeline end-to-end', () => {
  let storage: MemoryStorage;
  let stateRuntime: StateRuntime;
  let tmpDir: string;
  const events: ExecutionEvent[] = [];

  beforeEach(() => {
    storage = new MemoryStorage();
    stateRuntime = new StateRuntime(storage);
    tmpDir = createTmpDir();
    events.length = 0;
    _getGateRegistryForTesting().clear();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('runs a complete CI/CD pipeline with gate approval', async () => {
    const controller = new AbortController();

    const options: RunOptions = {
      executionId: 'int-001',
      dir: tmpDir,
      params: { testsPassing: true },
      runtime: createMockRuntime(),
      emitState: async (event) => {
        events.push(event);
        await stateRuntime.handleEvent(event);
      },
      emitOutput: vi.fn(),
      signal: controller.signal,
    };

    // Start the flow (will block at gate)
    const runPromise = run(cicdFlow, options);

    // Wait for gate to be registered
    await new Promise(resolve => setTimeout(resolve, 50));

    // Approve the gate
    const resolved = resolveGate('int-001', 'approval', 'approved');
    expect(resolved).toBe(true);

    // Wait for completion
    const result = await runPromise;
    expect(result.completed).toBe(true);

    // Verify events were emitted
    const types = events.map(e => e.type);
    expect(types).toContain('run:started');
    expect(types).toContain('run:completed');
    expect(types.filter(t => t === 'node:started').length).toBeGreaterThanOrEqual(5);
    expect(types.filter(t => t === 'node:completed').length).toBeGreaterThanOrEqual(5);
    expect(types.filter(t => t === 'edge:traversed').length).toBeGreaterThanOrEqual(4);

    // Verify projection
    const projection = stateRuntime.getProjection('int-001');
    expect(projection).not.toBeNull();
    expect(projection!.status).toBe('completed');
    expect(projection!.graph.nodes.every(n => n.status === 'completed')).toBe(true);

    // Verify metadata from test node
    expect(projection!.metadata.testCount).toBe(42);
  });

  it('handles gate rejection — deploy is skipped', async () => {
    const controller = new AbortController();

    const options: RunOptions = {
      executionId: 'int-002',
      dir: tmpDir,
      params: {},
      runtime: createMockRuntime(),
      emitState: async (event) => {
        events.push(event);
        await stateRuntime.handleEvent(event);
      },
      emitOutput: vi.fn(),
      signal: controller.signal,
    };

    const runPromise = run(cicdFlow, options);
    await new Promise(resolve => setTimeout(resolve, 50));

    // Reject the gate
    resolveGate('int-002', 'approval', 'rejected');
    const result = await runPromise;

    // Flow should complete (gate rejection routes to 'end')
    expect(result.completed).toBe(true);

    const projection = stateRuntime.getProjection('int-002');
    expect(projection).not.toBeNull();

    // Deploy should NOT have run (gate rejected → end)
    const deployNode = projection!.graph.nodes.find(n => n.id === 'deploy');
    expect(deployNode?.status).toBe('pending'); // Never reached
  });

  it('stops mid-execution via abort signal', async () => {
    const controller = new AbortController();

    const options: RunOptions = {
      executionId: 'int-003',
      dir: tmpDir,
      params: {},
      runtime: createMockRuntime(),
      emitState: async (event) => {
        events.push(event);
        await stateRuntime.handleEvent(event);
      },
      emitOutput: vi.fn(),
      signal: controller.signal,
    };

    const runPromise = run(cicdFlow, options);
    await new Promise(resolve => setTimeout(resolve, 50));

    // Abort while gate is blocking
    controller.abort();

    await expect(runPromise).rejects.toThrow('aborted');

    const projection = stateRuntime.getProjection('int-003');
    expect(projection!.status).toBe('stopped');
  });

  it('event replay reconstructs projection correctly', async () => {
    const controller = new AbortController();

    const options: RunOptions = {
      executionId: 'int-004',
      dir: tmpDir,
      params: { testsPassing: true },
      runtime: createMockRuntime(),
      emitState: async (event) => {
        events.push(event);
        await stateRuntime.handleEvent(event);
      },
      emitOutput: vi.fn(),
      signal: controller.signal,
    };

    const runPromise = run(cicdFlow, options);
    await new Promise(resolve => setTimeout(resolve, 50));
    resolveGate('int-004', 'approval', 'approved');
    await runPromise;

    // Rebuild projection from events
    const rebuilt = replayEvents('int-004', events);
    const cached = stateRuntime.getProjection('int-004');

    // Both should have the same final state
    expect(rebuilt.status).toBe(cached!.status);
    expect(rebuilt.graph.completedPath.length).toBe(cached!.graph.completedPath.length);
    expect(rebuilt.totalCost).toBe(cached!.totalCost);
    expect(rebuilt.metadata.testCount).toBe(cached!.metadata.testCount);
  });

  it('parallel start: lint + test run in same batch', async () => {
    const controller = new AbortController();
    const nodeStartOrder: string[] = [];

    const options: RunOptions = {
      executionId: 'int-005',
      dir: tmpDir,
      params: {},
      runtime: createMockRuntime(),
      emitState: async (event) => {
        events.push(event);
        if (event.type === 'node:started') {
          nodeStartOrder.push(event.nodeId);
        }
        await stateRuntime.handleEvent(event);
      },
      emitOutput: vi.fn(),
      signal: controller.signal,
    };

    const runPromise = run(cicdFlow, options);
    await new Promise(resolve => setTimeout(resolve, 50));
    resolveGate('int-005', 'approval', 'approved');
    await runPromise;

    // lint and test should both start before build
    const lintIdx = nodeStartOrder.indexOf('lint');
    const testIdx = nodeStartOrder.indexOf('test');
    const buildIdx = nodeStartOrder.indexOf('build');

    expect(lintIdx).toBeLessThan(buildIdx);
    expect(testIdx).toBeLessThan(buildIdx);
  });

  it('computeFrontier works for resume after crash', () => {
    // Simulate a partially completed state
    const resumeState = {
      completedNodes: new Map([
        ['lint', { action: 'default', finishedAt: 1000 }],
        ['test', { action: 'default', finishedAt: 1000 }],
      ]),
      firedEdges: new Map([
        ['build', new Set(['lint', 'test'])],
      ]),
      nodeStatuses: new Map([
        ['lint', 'completed'],
        ['test', 'completed'],
        ['build', 'pending'],
        ['approval', 'pending'],
        ['deploy', 'pending'],
      ]),
      loopIterations: new Map(),
    };

    const frontier = computeFrontier(cicdFlow, resumeState);
    expect(frontier).toEqual(['build']); // Only build is ready
  });

  it('crash recovery marks running as crashed', () => {
    // Simulate a running execution
    const projection = createEmptyProjection('int-crash');
    const running = reduce(projection, {
      type: 'run:started',
      executionId: 'int-crash',
      flowId: '',
      params: {},
      graph: { nodes: [], edges: [] },
      ts: 1000,
    });

    storage.writeProjection('int-crash', running);

    // Recover on startup
    stateRuntime.recoverOnStartup();

    const recovered = stateRuntime.getProjection('int-crash');
    expect(recovered!.status).toBe('crashed');
  });
});
