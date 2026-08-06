import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reduce, replayEvents } from '../state/reducer';
import { _buildResumeStateForTesting } from '../bridge/bridge';
import { _resetLoopRegionForTesting, run, validateGraph } from '../src/scheduler';
import { FlowValidationError } from '../src/types';
import type {
  AgentRuntime,
  FlowGraph,
  LoopRegion,
  NodeEntry,
  NodeFn,
  NodeInput,
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

function timedLoopGraph(options: {
  budgetMs: number;
  maxRounds: number;
  exitAfterRound?: number;
}): {
  graph: FlowGraph;
  counts: Record<'produce' | 'decision' | 'done' | 'exhausted', number>;
} {
  const counts = { produce: 0, decision: 0, done: 0, exhausted: 0 };
  const graph: FlowGraph = {
    nodes: {
      produce: entry(async () => {
        counts.produce += 1;
        vi.advanceTimersByTime(40);
        return { action: 'default' };
      }),
      decision: entry(async () => {
        counts.decision += 1;
        vi.advanceTimersByTime(10);
        return {
          action: counts.decision === options.exitAfterRound ? 'exit' : 'continue',
        };
      }),
      done: entry(async () => {
        counts.done += 1;
        return { action: 'default' };
      }),
      exhausted: entry(async () => {
        counts.exhausted += 1;
        return { action: 'default' };
      }),
    },
    edges: {
      produce: { default: 'decision' },
      decision: { continue: 'produce', exit: 'done' },
    },
    start: ['produce'],
    loops: [{
      id: 'timed-loop',
      nodes: ['produce', 'decision'],
      entry: 'produce',
      decision: 'decision',
      continueOn: 'continue',
      exitOn: 'exit',
      maxRounds: options.maxRounds,
      budgetMs: options.budgetMs,
      onExhausted: 'exhausted',
    }],
  };

  return { graph, counts };
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
    expect(events.filter(event =>
      event.type === 'route:resolved' &&
      event.source === 'refine' &&
      event.loop?.key === 'region:review-loop'
    )).toHaveLength(2);
    expect(events.filter(event =>
      event.type === 'edge:traversed' &&
      event.source === 'refine' &&
      event.target === 'produce'
    )).toHaveLength(0);
  });

  it('limits total body executions with maxRounds', async () => {
    const counts: Record<string, number> = { produce: 0, decision: 0, done: 0 };
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
        done: entry(async () => {
          counts.done += 1;
          return { action: 'default' };
        }),
      },
      edges: {
        produce: { default: 'decision' },
        decision: { continue: 'produce', exit: 'done' },
      },
      start: ['produce'],
      loops: [{
        id: 'total-rounds',
        nodes: ['produce', 'decision'],
        entry: 'produce',
        decision: 'decision',
        continueOn: 'continue',
        exitOn: 'exit',
        maxRounds: 3,
      }],
    };

    await run(graph, runOptions(events));

    expect(counts).toEqual({ produce: 3, decision: 3, done: 1 });
    expect(events.filter(event =>
      event.type === 'node:reset' && event.nodeId === 'produce'
    )).toHaveLength(2);
    expect(events.find(event =>
      event.type === 'edge:traversed' && event.target === 'done'
    )).not.toHaveProperty('exhaustion');
  });

  it('exits through onExhausted before a round that cannot fit the time budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const events: ExecutionEvent[] = [];
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const { graph, counts } = timedLoopGraph({ budgetMs: 120, maxRounds: 10 });

      const result = await run(graph, { ...runOptions(events), logger });

      expect(result.completed).toBe(true);
      expect(counts).toEqual({ produce: 2, decision: 2, done: 0, exhausted: 1 });
      const timeExhaustion = {
        reason: 'time',
        budgetMs: 120,
        elapsedMs: 100,
        estimatedNextRoundMs: 50,
      };
      expect(events).toContainEqual(expect.objectContaining({
        type: 'edge:traversed',
        source: 'decision',
        target: 'exhausted',
        exhaustion: timeExhaustion,
      }));
      expect(logger.info).toHaveBeenCalledWith(
        "Loop region 'timed-loop' exhausted by time budget",
        timeExhaustion,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues when the remaining budget comfortably fits another round', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const events: ExecutionEvent[] = [];
      const { graph, counts } = timedLoopGraph({
        budgetMs: 200,
        maxRounds: 10,
        exitAfterRound: 3,
      });

      const result = await run(graph, runOptions(events));

      expect(result.completed).toBe(true);
      expect(counts).toEqual({ produce: 3, decision: 3, done: 1, exhausted: 0 });
      expect(events.some(event =>
        event.type === 'edge:traversed' && event.exhaustion !== undefined
      )).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses whichever loop bound trips first and records count exhaustion distinctly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const countEvents: ExecutionEvent[] = [];
      const countFirst = timedLoopGraph({ budgetMs: 1_000, maxRounds: 2 });
      await run(countFirst.graph, runOptions(countEvents));

      expect(countFirst.counts).toEqual({
        produce: 2,
        decision: 2,
        done: 0,
        exhausted: 1,
      });
      expect(countEvents).toContainEqual(expect.objectContaining({
        type: 'edge:traversed',
        exhaustion: { reason: 'count' },
      }));

      vi.setSystemTime(2_000);
      const timeEvents: ExecutionEvent[] = [];
      const timeFirst = timedLoopGraph({ budgetMs: 120, maxRounds: 10 });
      await run(timeFirst.graph, runOptions(timeEvents));

      expect(timeFirst.counts.produce).toBe(2);
      expect(timeEvents).toContainEqual(expect.objectContaining({
        type: 'edge:traversed',
        exhaustion: expect.objectContaining({ reason: 'time' }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives every region node its loop position, including regions with no budget', async () => {
    // Consumers otherwise have to format the round into the feedback string and parse it back
    // out. The region below deliberately omits budgetMs: loopRegionsByNode is only populated for
    // budgeted regions, so deriving loopContext from that map alone would silently yield nothing
    // here -- the exact class of failure this codebase keeps hitting.
    const seen: { node: string; round: number; iteration: number; regionId: string }[] = [];
    const record = (node: string) => async (input: NodeInput) => {
      if (input.loopContext) {
        seen.push({
          node,
          round: input.loopContext.round,
          iteration: input.loopContext.iteration,
          regionId: input.loopContext.regionId,
        });
      }
      return { action: node === 'decision' ? (seen.length >= 4 ? 'exit' : 'continue') : 'default' };
    };
    const events: ExecutionEvent[] = [];
    const graph: FlowGraph = {
      nodes: {
        produce: entry(record('produce')),
        decision: entry(record('decision')),
        done: entry(async () => ({ action: 'default' })),
      },
      edges: {
        produce: { default: 'decision' },
        decision: { continue: 'produce', exit: 'done' },
      },
      start: ['produce'],
      loops: [{
        id: 'unbudgeted',
        nodes: ['produce', 'decision'],
        entry: 'produce',
        decision: 'decision',
        continueOn: 'continue',
        exitOn: 'exit',
        maxRounds: 3,
      }],
    };

    await run(graph, runOptions(events));

    expect(seen.every(entry => entry.regionId === 'unbudgeted')).toBe(true);
    // Round is 1-based and iteration 0-based on the first pass, for both member nodes.
    expect(seen.slice(0, 2)).toEqual([
      { node: 'produce', round: 1, iteration: 0, regionId: 'unbudgeted' },
      { node: 'decision', round: 1, iteration: 0, regionId: 'unbudgeted' },
    ]);
    expect(seen[2]).toEqual({ node: 'produce', round: 2, iteration: 1, regionId: 'unbudgeted' });
  });

  it('carries loop feedback across a resume into the region entry node', async () => {
    // The scheduler seeds loopIterations from ResumeState but never seeded loopRetryContexts,
    // so a run interrupted mid-loop came back with input.retryContext undefined on the entry
    // node. Every downstream consumer then reads round zero and re-runs blind to why the
    // previous round was rejected.
    const seen: (string | undefined)[] = [];
    const events: ExecutionEvent[] = [];
    const graph: FlowGraph = {
      nodes: {
        produce: entry(async (input) => {
          seen.push(input.retryContext?.feedback);
          return { action: 'default' };
        }),
        decision: entry(async () => ({ action: 'exit' })),
      },
      edges: {
        produce: { default: 'decision' },
        decision: { continue: 'produce', exit: 'end' },
      },
      start: ['produce'],
      loops: [{
        id: 'feedback-resume',
        nodes: ['produce', 'decision'],
        entry: 'produce',
        decision: 'decision',
        continueOn: 'continue',
        exitOn: 'exit',
        maxRounds: 3,
        feedback: (_output, iteration) => `attempt ${iteration} of 3`,
      }],
    };

    const resumeFrom = {
      completedNodes: new Map<string, { action: string; finishedAt: number }>(),
      firedEdges: new Map<string, Set<string>>(),
      nodeStatuses: new Map<string, string>(),
      loopIterations: new Map([['region:feedback-resume', 2]]),
      loopRetryContexts: new Map([['produce', { priorOutput: null, feedback: 'attempt 2 of 3' }]]),
    };

    await run(graph, { ...runOptions(events), resumeFrom });

    expect(seen).toEqual(['attempt 2 of 3']);
  });

  it('resumes with only the remaining maxRounds budget', async () => {
    const counts: Record<string, number> = { produce: 0, decision: 0, done: 0 };
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
        done: entry(async () => {
          counts.done += 1;
          return { action: 'default' };
        }),
      },
      edges: {
        produce: { default: 'decision' },
        decision: { continue: 'produce', exit: 'done' },
      },
      start: ['produce'],
      loops: [{
        id: 'resumed-rounds',
        nodes: ['produce', 'decision'],
        entry: 'produce',
        decision: 'decision',
        continueOn: 'continue',
        exitOn: 'exit',
        maxRounds: 3,
      }],
    };
    const options = runOptions(events);
    const resumeFrom = {
      completedNodes: new Map<string, { action: string; finishedAt: number }>(),
      firedEdges: new Map<string, Set<string>>(),
      nodeStatuses: new Map<string, string>(),
      loopIterations: new Map([['region:resumed-rounds', 2]]),
    };

    await run(graph, { ...options, resumeFrom });

    expect(counts).toEqual({ produce: 1, decision: 1, done: 1 });
    expect(events.filter(event => event.type === 'node:reset')).toHaveLength(0);
  });

  it('requires exactly one loop bound and validates its range', () => {
    const neither = validationGraph([region({ maxIterations: undefined })]);
    const both = validationGraph([region({ maxRounds: 2 })]);
    const invalidRounds = validationGraph([
      region({ maxIterations: undefined, maxRounds: 0 }),
    ]);
    const invalidIterations = validationGraph([region({ maxIterations: -1 })]);
    const invalidBudget = validationGraph([region({ budgetMs: Number.NaN })]);

    for (const graph of [neither, both]) {
      expect(() => validateGraph(graph)).toThrow(
        "Loop region 'review-loop' must set exactly one of maxIterations or maxRounds",
      );
    }
    expect(() => validateGraph(invalidRounds)).toThrow(
      "Loop region 'review-loop' maxRounds must be at least 1",
    );
    expect(() => validateGraph(invalidIterations)).toThrow(
      "Loop region 'review-loop' maxIterations must be at least 0",
    );
    expect(() => validateGraph(invalidBudget)).toThrow(
      "Loop region 'review-loop' budgetMs must be a non-negative finite number",
    );
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

  it('removes a previously taken legacy loop-back edge at the reset boundary', async () => {
    let decisionRuns = 0;
    const events: ExecutionEvent[] = [];
    const graph: FlowGraph = {
      nodes: {
        entry: entry(async () => ({ action: 'default' })),
        decision: entry(async () => {
          decisionRuns += 1;
          return { action: decisionRuns <= 2 ? 'continue' : 'exit' };
        }),
        done: entry(async () => ({ action: 'default' })),
      },
      edges: {
        entry: { default: 'decision' },
        decision: { continue: 'entry', exit: 'done' },
      },
      start: ['entry'],
      loopFallback: {
        'decision:continue': {
          source: 'decision',
          action: 'continue',
          fallbackTarget: 'done',
          maxIterations: 3,
        },
      },
    };
    const options = runOptions(events);

    await run(graph, options);

    const sourceResetIndexes = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'node:reset' && event.nodeId === 'decision')
      .map(({ index }) => index);
    const throughSecondReset = events.slice(0, sourceResetIndexes[1] + 1);
    const projection = replayEvents(options.executionId, throughSecondReset);
    const resumeState = _buildResumeStateForTesting(
      projection,
      graph,
      throughSecondReset,
    );

    expect(sourceResetIndexes).toHaveLength(2);
    expect(projection.graph.edges.find(edge =>
      edge.source === 'decision' &&
      edge.target === 'entry' &&
      edge.action === 'continue'
    )?.state).toBe('default');
    expect(resumeState.firedEdges.get('entry')?.has('decision') ?? false).toBe(true);
  });

  it('reconstructs exactly the scheduler reset state while preserving external fan-in', async () => {
    const loop = region({
      nodes: ['produce', 'critique', 'refine'],
      entry: 'produce',
      decision: 'refine',
    });
    const graph: FlowGraph = {
      nodes: {
        external: entry(async () => ({ action: 'default' })),
        produce: entry(async () => ({ action: 'default' })),
        critique: entry(async () => ({ action: 'default' })),
        refine: entry(async () => ({ action: 'continue' })),
        outside: entry(async () => ({ action: 'default' })),
      },
      edges: {
        external: { default: 'produce' },
        produce: { default: 'critique' },
        critique: { default: 'refine' },
        refine: { continue: ['produce', 'outside'], exit: 'end' },
      },
      start: ['external'],
      loops: [loop],
    };
    const executionId = 'reset-equivalence';
    const beforeResetEvents: ExecutionEvent[] = [
      {
        type: 'run:started',
        executionId,
        flowId: 'reset-equivalence',
        params: {},
        graph: {
          nodes: Object.entries(graph.nodes).map(([id, node]) => ({
            id,
            displayName: node.displayName,
            nodeType: node.nodeType,
          })),
          edges: [
            { source: 'external', action: 'default', target: 'produce' },
            { source: 'produce', action: 'default', target: 'critique' },
            { source: 'critique', action: 'default', target: 'refine' },
            { source: 'refine', action: 'continue', target: 'produce' },
            { source: 'refine', action: 'continue', target: 'outside' },
            { source: 'refine', action: 'exit', target: 'end' },
          ],
        },
        ts: 1,
      },
      { type: 'edge:traversed', executionId, source: 'external', target: 'produce', action: 'default', ts: 2 },
      { type: 'edge:traversed', executionId, source: 'produce', target: 'critique', action: 'default', ts: 3 },
      { type: 'edge:traversed', executionId, source: 'critique', target: 'refine', action: 'default', ts: 4 },
      { type: 'edge:traversed', executionId, source: 'refine', target: 'produce', action: 'continue', ts: 5 },
      { type: 'edge:traversed', executionId, source: 'refine', target: 'outside', action: 'continue', ts: 6 },
    ];
    const projectionBeforeReset = replayEvents(executionId, beforeResetEvents);
    const completed = new Map([
      ['produce', { action: 'default', finishedAt: 1 }],
      ['critique', { action: 'default', finishedAt: 1 }],
      ['refine', { action: 'continue', finishedAt: 1 }],
    ]);
    const nodeStatuses = new Map([
      ['produce', 'completed'],
      ['critique', 'completed'],
      ['refine', 'completed'],
    ]);
    const schedulerFiredEdges = new Map<string, Set<string>>([
      ['produce', new Set(['external', 'refine'])],
      ['critique', new Set(['produce'])],
      ['refine', new Set(['critique'])],
      ['outside', new Set(['refine'])],
    ]);
    const resetEvents: ExecutionEvent[] = [];

    await _resetLoopRegionForTesting(
      loop,
      ['produce', 'outside'],
      1,
      executionId,
      completed,
      nodeStatuses,
      schedulerFiredEdges,
      new Set(),
      async event => {
        resetEvents.push(event);
      },
    );

    const projectionAfterReset = resetEvents.reduce(reduce, projectionBeforeReset);
    const projectedResumeState = _buildResumeStateForTesting(
      projectionAfterReset,
      graph,
      [...beforeResetEvents, ...resetEvents],
    );
    const carriers = resetEvents.filter(event =>
      event.type === 'node:reset' && event.clearedEdges !== undefined
    );

    expect(projectedResumeState.firedEdges).toEqual(schedulerFiredEdges);
    expect(schedulerFiredEdges).toEqual(new Map([
      ['produce', new Set(['external'])],
    ]));
    expect(carriers).toHaveLength(1);
    expect(carriers[0]).toMatchObject({
      clearedEdges: expect.arrayContaining([
        { source: 'produce', target: 'critique' },
        { source: 'critique', target: 'refine' },
        { source: 'refine', target: 'produce' },
        { source: 'refine', target: 'outside' },
      ]),
    });
    expect(projectionAfterReset.graph.edges.find(edge =>
      edge.source === 'external' && edge.target === 'produce'
    )?.state).toBe('taken');

    const replayedCarrier = reduce(projectionAfterReset, carriers[0]);
    expect(replayedCarrier).toEqual(projectionAfterReset);
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
