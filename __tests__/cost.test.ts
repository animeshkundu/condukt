import { describe, expect, it, vi } from 'vitest';
import {
  NANO_AIU_PER_AIC,
  defaultCostResolver,
  nanoAiuToAic,
} from '../src/cost';
import type {
  AgentRuntime,
  ExecutionContext,
  FlowGraph,
  NodeEntry,
  NodeFn,
  NodeInput,
  RunOptions,
} from '../src/types';
import type { ExecutionEvent } from '../src/events';
import { run } from '../src/scheduler';
import { deterministic } from '../src/nodes';

describe('nanoAiuToAic', () => {
  it('converts nano AI units to AI credits (1 AIC = 1e9 nano-AIU)', () => {
    expect(NANO_AIU_PER_AIC).toBe(1_000_000_000);
    expect(nanoAiuToAic(1_000_000_000)).toBe(1);
    expect(nanoAiuToAic(2_500_000_000)).toBe(2.5);
    expect(nanoAiuToAic(450_000_000)).toBeCloseTo(0.45);
  });

  it('bills 0 for missing, non-finite, zero, or negative input', () => {
    expect(nanoAiuToAic(0)).toBe(0);
    expect(nanoAiuToAic(-5)).toBe(0);
    expect(nanoAiuToAic(Number.NaN)).toBe(0);
    expect(nanoAiuToAic(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('defaultCostResolver', () => {
  it('bills the direct totalNanoAiu charge as AIC', () => {
    expect(defaultCostResolver({ totalNanoAiu: 2_500_000_000 }, 'gpt-5.6-luna')).toBe(2.5);
  });

  it('reads the nested copilotUsage.totalNanoAiu charge', () => {
    expect(
      defaultCostResolver({ copilotUsage: { totalNanoAiu: 1_000_000_000 } }, 'gemini-3.8-flash'),
    ).toBe(1);
  });

  it('prefers the direct charge over the nested one', () => {
    expect(
      defaultCostResolver(
        { totalNanoAiu: 3_000_000_000, copilotUsage: { totalNanoAiu: 1_000_000_000 } },
        'model',
      ),
    ).toBe(3);
  });

  it('bills 0 when no charge is reported (tokens alone are not priced)', () => {
    expect(defaultCostResolver({ inputTokens: 10_000, outputTokens: 500 }, 'model')).toBe(0);
    expect(defaultCostResolver({}, undefined)).toBe(0);
    expect(defaultCostResolver({ totalNanoAiu: 'x' }, 'model')).toBe(0);
  });
});

describe('defaultCostResolver with the scheduler', () => {
  function mockRunOptions(overrides?: Partial<RunOptions>): RunOptions {
    const ac = new AbortController();
    const mockRuntime: AgentRuntime = {
      name: 'test-runtime',
      createSession: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
    };
    return {
      executionId: 'exec-1',
      dir: '/tmp/test-flow',
      params: {},
      runtime: mockRuntime,
      emitState: vi.fn().mockResolvedValue(undefined),
      emitOutput: vi.fn(),
      signal: ac.signal,
      ...overrides,
    };
  }

  function emittedEvents(opts: RunOptions): ExecutionEvent[] {
    const calls = (opts.emitState as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[ExecutionEvent]>;
    return calls.map(([event]) => event);
  }

  function mockEntry(fn: NodeFn): NodeEntry {
    return { fn, displayName: 'test-node', nodeType: 'deterministic' };
  }

  it('records nano-AIU usage as AIC cost events, including retries', async () => {
    const graph: FlowGraph = {
      nodes: {
        A: mockEntry(deterministic('Usage node', async () => ({
          action: 'default',
          metadata: {
            usage: { totalNanoAiu: 2_500_000_000, model: 'gpt-5.6-luna' },
            subagentUsage: [{ totalNanoAiu: 1_000_000_000, model: 'worker' }],
          },
        }))),
      },
      edges: {},
      start: ['A'],
    };
    const opts = mockRunOptions({ costResolver: defaultCostResolver });

    await run(graph, opts);

    const costs = emittedEvents(opts).filter((event) => event.type === 'cost:recorded');
    expect(costs).toHaveLength(2);
    expect(costs).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'A', cost: 2.5, provenance: 'main' }),
      expect.objectContaining({ nodeId: 'A', cost: 1, provenance: 'subagent' }),
    ]));
  });
});
