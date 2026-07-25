import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { replayEvents } from '../state/reducer';
import { run, validateGraph } from '../src/scheduler';
import { FlowValidationError } from '../src/types';
import type {
  AgentRuntime,
  FlowGraph,
  LoopRegion,
  NodeEntry,
  NodeFn,
  RetryContext,
  RunOptions,
} from '../src/types';
import type { ExecutionEvent } from '../src/events';

function entry(fn: NodeFn, output?: string): NodeEntry {
  return {
    fn,
    displayName: 'test',
    nodeType: 'deterministic',
    output,
  };
}

function runOptions(events: ExecutionEvent[]): RunOptions {
  const runtime: AgentRuntime = {
    name: 'test-runtime',
    createSession: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
  };

  return {
    executionId: `loop-region-${Date.now()}-${Math.random()}`,
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'loop-region-')),
    params: {},
    runtime,
    emitState: async event => {
      events.push(event);
    },
    emitOutput: vi.fn(),
    signal: new AbortController().signal,
  };
}

function region(overrides?: Partial<LoopRegion>): LoopRegion {
  return {
    id: 'review-loop',
    nodes: ['produce', 'critique', 'refine'],
    entry: 'produce',
    decision: 'refine',
    continueOn: 'continue',
    exitOn: 'exit',
    maxIterations: 3,
    ...overrides,
  };
}

function validationGraph(loops: readonly LoopRegion[]): FlowGraph {
  return {
    nodes: {
      produce: entry(async () => ({ action: 'default' })),
      critique: entry(async () => ({ action: 'default' })),
      refine: entry(async () => ({ action: 'exit' })),
      other: entry(async () => ({ action: 'exit' })),
    },
    edges: {
      produce: { default: 'critique' },
      critique: { default: 'refine' },
      refine: { continue: 'produce', exit: 'end' },
      other: { continue: 'produce', exit: 'end' },
    },
    start: ['produce'],
    loops,
  };
}

describe('loop regions', () => {
  it('runs the three-node body N + 1 times for N loop-backs before exit', async () => {
    const counts: Record<string, number> = {
      produce: 0,
      critique: 0,
      refine: 0,
      done: 0,
    };
    const events: ExecutionEvent[] = [];

    const graph: FlowGraph = {
      nodes: {
        produce: entry(async () => {
          counts.produce += 1;
          return { action: 'default' };
        }),
        critique: entry(async () => {
          counts.critique += 1;
          return { action: 'default' };
        }),
        refine: entry(async () => {
          counts.refine += 1;
          return { action: counts.refine <= 2 ? 'continue' : 'exit' };
        }),
        done: entry(async () => {
          counts.done += 1;
          return { action: 'default' };
        }),
      },
      edges: {
        produce: { default: 'critique' },
        critique: { default: 'refine' },
        refine: { continue: 'produce', exit: 'done' },
      },
      start: ['produce'],
      loops: [region()],
    };

    const result = await run(graph, runOptions(events));

    expect(result.completed).toBe(true);
    const loopBacks = 2;
    const expectedBodyExecutions = loopBacks + 1;
    expect(counts).toEqual({
      produce: expectedBodyExecutions,
      critique: expectedBodyExecutions,
      refine: expectedBodyExecutions,
      done: 1,
    });
    expect(events.filter(event =>
      event.type === 'node:started' && event.nodeId === 'produce'
    )).toHaveLength(3);
    expect(events.filter(event =>
      event.type === 'node:reset' && event.nodeId === 'produce'
    )).toHaveLength(2);
  });

  it('fires onExhausted exactly once without starting another epoch', async () => {
    const counts: Record<string, number> = { produce: 0, decision: 0, exhausted: 0 };
    const events: ExecutionEvent[] = [];
    const graph: FlowGraph = {
      nodes: {
        produce: entry(async () => {
          counts.produce += 1;
          return { action: 'default' };
        }),
        decision: entry(async () => {
          counts.decision += 1;
          return { action: 'continue' };
        }),
        exhausted: entry(async () => {
          counts.exhausted += 1;
          return { action: 'default' };
        }),
      },
      edges: {
        produce: { default: 'decision' },
        decision: { continue: 'produce', exit: 'end' },
      },
      start: ['produce'],
      loops: [{
        id: 'bounded',
        nodes: ['produce', 'decision'],
        entry: 'produce',
        decision: 'decision',
        continueOn: 'continue',
        exitOn: 'exit',
        maxIterations: 1,
        onExhausted: 'exhausted',
      }],
    };

    await run(graph, runOptions(events));

    expect(counts).toEqual({ produce: 2, decision: 2, exhausted: 1 });
    expect(events.filter(event =>
      event.type === 'edge:traversed' &&
      event.source === 'decision' &&
      event.target === 'exhausted'
    )).toHaveLength(1);
    expect(events.filter(event => event.type === 'node:reset')).toHaveLength(2);
  });

  it('routes exhaustion through exitOn when onExhausted is absent', async () => {
    const counts: Record<string, number> = { produce: 0, decision: 0, downstream: 0 };
    const events: ExecutionEvent[] = [];
    const graph: FlowGraph = {
      nodes: {
        produce: entry(async () => {
          counts.produce += 1;
          return { action: 'default' };
        }),
        decision: entry(async () => {
          counts.decision += 1;
          return { action: 'continue' };
        }),
        downstream: entry(async () => {
          counts.downstream += 1;
          return { action: 'default' };
        }),
      },
      edges: {
        produce: { default: 'decision' },
        decision: { continue: 'produce', exit: 'downstream' },
      },
      start: ['produce'],
      loops: [{
        id: 'exit-on-exhaustion',
        nodes: ['produce', 'decision'],
        entry: 'produce',
        decision: 'decision',
        continueOn: 'continue',
        exitOn: 'exit',
        maxIterations: 1,
      }],
    };

    const result = await run(graph, runOptions(events));

    expect(result.completed).toBe(true);
    expect(counts).toEqual({ produce: 2, decision: 2, downstream: 1 });
    expect(events.filter(event =>
      event.type === 'edge:traversed' &&
      event.source === 'decision' &&
      event.target === 'downstream' &&
      event.action === 'exit'
    )).toHaveLength(1);
    expect(events.filter(event =>
      event.type === 'node:started' && event.nodeId === 'produce'
    )).toHaveLength(2);
  });

  it('preserves external fan-in while clearing and rebuilding internal contributions', async () => {
    const counts: Record<string, number> = {
      external: 0,
      produce: 0,
      critique: 0,
      refine: 0,
      optional: 0,
    };
    const events: ExecutionEvent[] = [];
    const graph: FlowGraph = {
      nodes: {
        external: entry(async () => {
          counts.external += 1;
          return { action: 'default' };
        }),
        produce: entry(async () => {
          counts.produce += 1;
          return {
            action: counts.produce === 1 ? 'withOptional' : 'withoutOptional',
          };
        }),
        critique: entry(async () => {
          counts.critique += 1;
          return { action: 'default' };
        }),
        optional: entry(async () => {
          counts.optional += 1;
          return { action: counts.optional === 1 ? 'send' : 'skip' };
        }),
        refine: entry(async () => {
          counts.refine += 1;
          return { action: counts.refine === 1 ? 'continue' : 'exit' };
        }),
      },
      edges: {
        external: { default: 'produce' },
        produce: {
          withOptional: ['critique', 'optional'],
          withoutOptional: 'critique',
        },
        critique: { default: 'refine' },
        optional: { send: 'refine', skip: 'end' },
        refine: { continue: 'produce', exit: 'end' },
      },
      start: ['external'],
      loops: [region({ nodes: ['produce', 'critique', 'optional', 'refine'] })],
    };

    await run(graph, runOptions(events));

    expect(counts).toEqual({
      external: 1,
      produce: 2,
      critique: 2,
      refine: 2,
      optional: 1,
    });
    expect(events.filter(event =>
      event.type === 'edge:traversed' &&
      event.source === 'external' &&
      event.target === 'produce'
    )).toHaveLength(1);
    expect(events.filter(event =>
      event.type === 'edge:traversed' &&
      event.source === 'produce' &&
      event.target === 'critique'
    )).toHaveLength(2);
    expect(events.filter(event =>
      event.type === 'edge:traversed' &&
      event.source === 'critique' &&
      event.target === 'refine'
    )).toHaveLength(2);
    expect(events.filter(event =>
      event.type === 'edge:traversed' &&
      event.source === 'optional' &&
      event.target === 'refine'
    )).toHaveLength(1);
  });

  it('resets every region status and failure without resetting downstream or unrelated nodes', async () => {
    let flakyAttempts = 0;
    let decisionAttempts = 0;
    const events: ExecutionEvent[] = [];
    const options = runOptions(events);
    const graph: FlowGraph = {
      nodes: {
        entry: entry(async () => ({ action: 'default' })),
        flaky: entry(async () => {
          flakyAttempts += 1;
          if (flakyAttempts === 1) throw new Error('first epoch failure');
          return { action: 'default' };
        }),
        decision: entry(async () => {
          decisionAttempts += 1;
          return { action: decisionAttempts === 1 ? 'continue' : 'exit' };
        }),
        downstream: entry(async () => ({ action: 'default' })),
        unrelated: entry(async () => ({ action: 'default' })),
      },
      edges: {
        entry: { default: ['flaky', 'decision'] },
        decision: { continue: 'entry', exit: 'downstream' },
      },
      start: ['entry', 'unrelated'],
      loops: [{
        id: 'failure-reset',
        nodes: ['entry', 'flaky', 'decision'],
        entry: 'entry',
        decision: 'decision',
        continueOn: 'continue',
        exitOn: 'exit',
        maxIterations: 2,
      }],
    };

    const result = await run(graph, options);
    const projection = replayEvents(options.executionId, events);
    const resetNodeIds = events
      .filter(event => event.type === 'node:reset')
      .map(event => event.nodeId)
      .sort();

    expect(result.completed).toBe(true);
    expect(flakyAttempts).toBe(2);
    expect(resetNodeIds).toEqual(['decision', 'entry', 'flaky']);
    expect(resetNodeIds).not.toContain('downstream');
    expect(resetNodeIds).not.toContain('unrelated');
    for (const nodeId of ['entry', 'flaky', 'decision', 'downstream', 'unrelated']) {
      const node = projection.graph.nodes.find(candidate => candidate.id === nodeId);
      expect(node?.status).toBe('completed');
      expect(node?.error).toBeUndefined();
    }
  });

  it('threads decision output through feedback to the next entry retry context', async () => {
    let entryAttempts = 0;
    let decisionAttempts = 0;
    let received: RetryContext | undefined;
    const events: ExecutionEvent[] = [];
    const graph: FlowGraph = {
      nodes: {
        produce: entry(async input => {
          entryAttempts += 1;
          if (input.retryContext) received = input.retryContext;
          return { action: 'default', artifact: `draft-${entryAttempts}` };
        }, 'draft.txt'),
        decision: entry(async () => {
          decisionAttempts += 1;
          return decisionAttempts === 1
            ? { action: 'continue', artifact: 'tighten the argument' }
            : { action: 'exit' };
        }),
      },
      edges: {
        produce: { default: 'decision' },
        decision: { continue: 'produce', exit: 'end' },
      },
      start: ['produce'],
      loops: [{
        id: 'feedback',
        nodes: ['produce', 'decision'],
        entry: 'produce',
        decision: 'decision',
        continueOn: 'continue',
        exitOn: 'exit',
        maxIterations: 2,
        feedback: (decisionOutput, iteration) =>
          `round ${iteration}: ${decisionOutput ?? 'no feedback'}`,
      }],
    };

    await run(graph, runOptions(events));

    expect(received).toEqual({
      priorOutput: 'draft-1',
      feedback: 'round 1: tighten the argument',
    });
  });

  it('rejects overlapping loop regions', () => {
    const graph = validationGraph([
      region(),
      {
        id: 'overlap',
        nodes: ['produce', 'other'],
        entry: 'produce',
        decision: 'other',
        continueOn: 'continue',
        exitOn: 'exit',
        maxIterations: 2,
      },
    ]);

    expect(() => validateGraph(graph)).toThrow(FlowValidationError);
    try {
      validateGraph(graph);
    } catch (error) {
      expect((error as FlowValidationError).issues.some(issue => issue.includes('overlap'))).toBe(true);
    }
  });

  it('rejects an entry that is not in region.nodes', () => {
    const graph = validationGraph([
      region({ nodes: ['critique', 'refine'] }),
    ]);

    expect(() => validateGraph(graph)).toThrow(FlowValidationError);
    try {
      validateGraph(graph);
    } catch (error) {
      expect((error as FlowValidationError).issues.some(issue =>
        issue.includes("entry 'produce' is not in region.nodes")
      )).toBe(true);
    }
  });

  it('rejects a region with multiple external entry nodes', () => {
    const graph: FlowGraph = {
      nodes: {
        entry: entry(async () => ({ action: 'default' })),
        decision: entry(async () => ({ action: 'exit' })),
        external: entry(async () => ({ action: 'default' })),
      },
      edges: {
        entry: { default: 'decision' },
        decision: { continue: 'entry', exit: 'end' },
        external: { default: 'decision' },
      },
      start: ['entry', 'external'],
      loops: [{
        id: 'multi-entry',
        nodes: ['entry', 'decision'],
        entry: 'entry',
        decision: 'decision',
        continueOn: 'continue',
        exitOn: 'exit',
        maxIterations: 2,
      }],
    };

    expect(() => validateGraph(graph)).toThrow(FlowValidationError);
    try {
      validateGraph(graph);
    } catch (error) {
      expect((error as FlowValidationError).issues.some(issue =>
        issue.includes('multiple entry nodes')
      )).toBe(true);
    }
  });

  it('rejects a body node unreachable from the region entry', () => {
    const graph: FlowGraph = {
      nodes: {
        entry: entry(async () => ({ action: 'default' })),
        decision: entry(async () => ({ action: 'exit' })),
        detached: entry(async () => ({ action: 'default' })),
      },
      edges: {
        entry: { default: 'decision' },
        decision: { continue: 'entry', exit: 'end' },
      },
      start: ['entry'],
      loops: [{
        id: 'unreachable-body',
        nodes: ['entry', 'decision', 'detached'],
        entry: 'entry',
        decision: 'decision',
        continueOn: 'continue',
        exitOn: 'exit',
        maxIterations: 2,
      }],
    };

    expect(() => validateGraph(graph)).toThrow(FlowValidationError);
    try {
      validateGraph(graph);
    } catch (error) {
      expect((error as FlowValidationError).issues).toContain(
        "Loop region 'unreachable-body' node 'detached' is not reachable from entry 'entry'",
      );
    }
  });

  it('rejects a decision missing continueOn or exitOn edges', () => {
    const graph: FlowGraph = {
      nodes: {
        entry: entry(async () => ({ action: 'default' })),
        decision: entry(async () => ({ action: 'exit' })),
      },
      edges: {
        entry: { default: 'decision' },
        decision: { other: 'end' },
      },
      start: ['entry'],
      loops: [{
        id: 'missing-actions',
        nodes: ['entry', 'decision'],
        entry: 'entry',
        decision: 'decision',
        continueOn: 'continue',
        exitOn: 'exit',
        maxIterations: 2,
      }],
    };

    expect(() => validateGraph(graph)).toThrow(FlowValidationError);
    try {
      validateGraph(graph);
    } catch (error) {
      const issues = (error as FlowValidationError).issues;
      expect(issues.some(issue => issue.includes('continueOn'))).toBe(true);
      expect(issues.some(issue => issue.includes('exitOn'))).toBe(true);
    }
  });
});
