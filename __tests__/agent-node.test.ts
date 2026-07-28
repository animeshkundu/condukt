import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentNode, dryRun, toValidator } from '../src';
import type {
  AgentRuntime,
  AgentSession,
  ExecutionContext,
  FlowGraph,
  NodeEntry,
  NodeInput,
  SessionConfig,
} from '../src/types';

interface StructuredResult {
  readonly status: string;
  readonly count: number;
}

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'condukt-agent-node-'));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStructured(value: unknown): StructuredResult | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.status !== 'string' || typeof value.count !== 'number') {
    return undefined;
  }
  return { status: value.status, count: value.count };
}

function completedAction(result: Awaited<ReturnType<typeof dryRun>>, nodeId: string): string | undefined {
  return result.projection.graph.nodes.find((node) => node.id === nodeId)?.action;
}

describe('agentNode', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'uses the agent default', timeout: undefined, expected: 5 * 60 * 60 },
    { name: 'preserves an explicit timeout', timeout: 37, expected: 37 },
  ])('$name', async ({ timeout, expected }) => {
    const dir = createTmpDir();
    dirs.push(dir);
    const captured: SessionConfig[] = [];
    const runtime: AgentRuntime = {
      name: 'timeout-config-runtime',
      createSession: vi.fn().mockImplementation(async (sessionConfig: SessionConfig) => {
        captured.push(sessionConfig);
        const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
        return {
          pid: null,
          send: () => queueMicrotask(() => {
            for (const handler of handlers.get('text') ?? []) handler('done');
            for (const handler of handlers.get('idle') ?? []) handler();
          }),
          on: (event: string, handler: (...args: unknown[]) => void) => {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
          },
          abort: vi.fn().mockResolvedValue(undefined),
        } as unknown as AgentSession;
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
    };
    const entry = agentNode({
      prompt: 'Work',
      model: 'test-model',
      ...(timeout === undefined ? {} : { timeout }),
    });
    const context: ExecutionContext = {
      executionId: 'timeout-config',
      nodeId: 'agent',
      runtime,
      emitOutput: vi.fn(),
      signal: new AbortController().signal,
    };

    expect(entry.timeout).toBe(expected);
    await entry.fn({ dir, params: {}, artifactPaths: {} }, context);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.timeout).toBe(expected);
  });

  it('forwards contextTier, thinkingBudget, and MCP servers through the plain agent node', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const runtime: AgentRuntime = {
      name: 'config-capture-runtime',
      createSession: vi.fn().mockImplementation(async () => {
        const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
        return {
          pid: null,
          send: () => queueMicrotask(() => {
            for (const handler of handlers.get('text') ?? []) handler('done');
            for (const handler of handlers.get('idle') ?? []) handler();
          }),
          on: (event: string, handler: (...args: unknown[]) => void) => {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
          },
          abort: vi.fn().mockResolvedValue(undefined),
        } as unknown as AgentSession;
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
    };
    const entry = agentNode({
      prompt: 'Work',
      model: 'gpt-5.6-sol',
      contextTier: 'long_context',
      thinkingBudget: 'xhigh',
      mcpServers: {
        node: { command: 'node-mcp', args: ['--stdio'] },
      },
    });
    const context: ExecutionContext = {
      executionId: 'config-capture',
      nodeId: 'agent',
      runtime,
      emitOutput: vi.fn(),
      signal: new AbortController().signal,
    };

    await entry.fn({ dir, params: {}, artifactPaths: {} }, context);

    expect(runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.6-sol',
        contextTier: 'long_context',
        thinkingBudget: 'xhigh',
        mcpServers: {
          node: { command: 'node-mcp', args: ['--stdio'] },
        },
      }),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('validates, routes, writes canonical JSON, and exposes it to downstream reads', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    let downstreamValue: StructuredResult | undefined;

    const structured = agentNode({
      prompt: (_input, reads) => {
        if (!isRecord(reads['seed.json']) || reads['seed.json'].topic !== 'widgets') {
          throw new Error('Structured prompt did not receive parsed upstream reads');
        }
        return 'Count the widgets';
      },
      model: 'mock-model',
      schema: parseStructured,
      output: 'result.json',
      reads: ['seed.json'],
      displayName: 'Structured agent',
      route: (value) => value.status,
    });
    const downstream: NodeEntry = {
      fn: async (input) => {
        const resultPath = input.artifactPaths['result.json'];
        downstreamValue = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as StructuredResult;
        return { action: 'done' };
      },
      displayName: 'Downstream',
      nodeType: 'deterministic',
      reads: ['result.json'],
    };
    const graph: FlowGraph = {
      nodes: {
        seed: {
          fn: async () => ({ action: 'next', artifact: '{"topic":"widgets"}' }),
          displayName: 'Seed',
          nodeType: 'deterministic',
          output: 'seed.json',
        },
        structured,
        downstream,
      },
      edges: {
        seed: { next: 'structured' },
        structured: { success: 'downstream' },
        downstream: { done: 'end' },
      },
      start: ['seed'],
    };

    const result = await dryRun(graph, {
      dir,
      fixtures: {
        structured: {
          artifact: 'Here is the result:\n```json\n{"status":"success","count":3}\n```',
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(completedAction(result, 'structured')).toBe('success');
    expect(structured).toMatchObject({
      displayName: 'Structured agent',
      nodeType: 'agent',
      output: 'result.json',
      reads: ['seed.json'],
      model: 'mock-model',
    });
    expect(downstreamValue).toEqual({ status: 'success', count: 3 });
    expect(fs.readFileSync(path.join(dir, 'result.json'), 'utf-8')).toBe(
      JSON.stringify({ status: 'success', count: 3 }, null, 2),
    );
  });

  it('repairs invalid structured output with a second model send', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const graph: FlowGraph = {
      nodes: {
        repair: agentNode({
          prompt: 'Return a result',
          model: 'mock-model',
          schema: {
            validate: (value) => {
              const parsed = parseStructured(value);
              return parsed
                ? { ok: true, value: parsed }
                : { ok: false, issues: ['status and count are required'] };
            },
          },
          output: 'repair.json',
          route: (value) => value.status,
          structuredRetry: 1,
        }),
      },
      edges: { repair: {} },
      start: ['repair'],
    };

    const result = await dryRun(graph, {
      dir,
      fixtures: {
        repair: {
          artifact: ['not valid JSON', '{"status":"recovered","count":2}'],
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(completedAction(result, 'repair')).toBe('recovered');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'repair.json'), 'utf-8'))).toEqual({
      status: 'recovered',
      count: 2,
    });
  });

  it('validates model text when the output artifact is malformed', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const graph: FlowGraph = {
      nodes: {
        backup: agentNode({
          prompt: 'Return a result',
          model: 'mock-model',
          schema: parseStructured,
          output: 'backup.json',
          structuredRetry: 0,
          route: (value) => value.status,
        }),
      },
      edges: { backup: {} },
      start: ['backup'],
    };

    const result = await dryRun(graph, {
      dir,
      fixtures: {
        backup: {
          artifact: 'malformed artifact',
          text: ['{"status":"from-text","count":4}'],
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(completedAction(result, 'backup')).toBe('from-text');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'backup.json'), 'utf-8'))).toEqual({
      status: 'from-text',
      count: 4,
    });
  });

  it('uses fallback after structured retries are exhausted', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    let fallbackRaw = '';
    let fallbackError = '';
    let downstreamValue: StructuredResult | undefined;

    const graph: FlowGraph = {
      nodes: {
        fallback: agentNode({
          prompt: 'Return a result',
          model: 'mock-model',
          schema: parseStructured,
          output: 'fallback.json',
          structuredRetry: 1,
          fallback: (raw, error) => {
            fallbackRaw = raw;
            fallbackError = error.message;
            return { status: 'fallback', count: 0 };
          },
          route: (value) => value.status,
        }),
        downstream: {
          fn: async (input) => {
            downstreamValue = JSON.parse(
              fs.readFileSync(input.artifactPaths['fallback.json'], 'utf-8'),
            ) as StructuredResult;
            return { action: 'done' };
          },
          displayName: 'Downstream',
          nodeType: 'deterministic',
          reads: ['fallback.json'],
        },
      },
      edges: {
        fallback: { fallback: 'downstream' },
        downstream: { done: 'end' },
      },
      start: ['fallback'],
    };

    const result = await dryRun(graph, {
      dir,
      fixtures: {
        fallback: { artifact: ['first invalid', 'second invalid'] },
      },
    });

    expect(result.completed).toBe(true);
    expect(fallbackRaw).toBe('second invalid');
    expect(fallbackError).toContain('no valid JSON value');
    expect(completedAction(result, 'fallback')).toBe('fallback');
    expect(downstreamValue).toEqual({ status: 'fallback', count: 0 });
  });

  it('returns fail and removes invalid output when no fallback is configured', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const graph: FlowGraph = {
      nodes: {
        failure: agentNode({
          prompt: 'Return a result',
          model: 'mock-model',
          schema: parseStructured,
          output: 'failure.json',
          structuredRetry: 0,
        }),
      },
      edges: { failure: {} },
      start: ['failure'],
    };

    const result = await dryRun(graph, {
      dir,
      fixtures: { failure: { artifact: 'invalid' } },
    });

    expect(result.completed).toBe(true);
    expect(completedAction(result, 'failure')).toBe('fail');
    expect(fs.existsSync(path.join(dir, 'failure.json'))).toBe(false);
  });

  it('preserves raw output and supports typed routing without a schema', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const graph: FlowGraph = {
      nodes: {
        plain: agentNode({
          prompt: 'Return plain text',
          model: 'mock-model',
          output: 'plain.txt',
          route: (raw) => raw === 'plain response' ? 'plain' : 'unexpected',
        }),
      },
      edges: { plain: {} },
      start: ['plain'],
    };

    const result = await dryRun(graph, {
      dir,
      fixtures: { plain: { artifact: 'plain response' } },
    });

    expect(result.completed).toBe(true);
    expect(completedAction(result, 'plain')).toBe('plain');
    expect(fs.readFileSync(path.join(dir, 'plain.txt'), 'utf-8')).toBe('plain response');
  });

  it('repairs after a schema validator throws', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    let validationCalls = 0;
    const graph: FlowGraph = {
      nodes: {
        repair: agentNode({
          prompt: 'Return a result',
          model: 'mock-model',
          schema: {
            validate: (value) => {
              validationCalls += 1;
              if (validationCalls === 1) throw new Error('validator crashed');
              const parsed = parseStructured(value);
              return parsed
                ? { ok: true, value: parsed }
                : { ok: false, issues: ['invalid result'] };
            },
          },
          structuredRetry: 1,
          route: (value) => value.status,
        }),
      },
      edges: { repair: {} },
      start: ['repair'],
    };

    const result = await dryRun(graph, {
      dir,
      fixtures: {
        repair: {
          text: [
            ['{"status":"first","count":1}'],
            ['{"status":"recovered","count":2}'],
          ],
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(validationCalls).toBe(2);
    expect(completedAction(result, 'repair')).toBe('recovered');
  });

  it('selects the valid JSON value when the response embeds multiple candidates', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const graph: FlowGraph = {
      nodes: {
        pick: agentNode<StructuredResult>({
          prompt: 'Return a result',
          model: 'mock-model',
          output: 'pick.json',
          schema: {
            validate: (value) => {
              const parsed = parseStructured(value);
              return parsed && parsed.status === 'real'
                ? { ok: true, value: parsed }
                : { ok: false, issues: ['not the real result'] };
            },
          },
          route: (value) => value.status,
        }),
      },
      edges: { pick: {} },
      start: ['pick'],
    };

    const result = await dryRun(graph, {
      dir,
      fixtures: {
        pick: {
          artifact: 'Example first: {"status":"demo","count":0}\nActual answer: {"status":"real","count":2}',
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(completedAction(result, 'pick')).toBe('real');
  });

  it('adapts Standard Schema validators without a dependency', async () => {
    const validator = toValidator<StructuredResult>({
      '~standard': {
        validate: (value) => {
          const parsed = parseStructured(value);
          return parsed
            ? { value: parsed }
            : { issues: [{ message: 'Expected a structured result', path: ['result'] }] };
        },
      },
    });

    await expect(validator.validate({ status: 'ok', count: 1 })).resolves.toEqual({
      ok: true,
      value: { status: 'ok', count: 1 },
    });
    await expect(validator.validate({ status: 'bad' })).resolves.toEqual({
      ok: false,
      issues: ['result: Expected a structured result'],
    });
  });

  it('shares one retry deadline across structured repair sends', async () => {
    vi.useFakeTimers();
    try {
      const input: NodeInput = { dir: createTmpDir(), params: {}, artifactPaths: {} };
      dirs.push(input.dir);
      const sendTimes: number[] = [];
      const abortCalls: Array<ReturnType<typeof vi.fn>> = [];
      const runtime: AgentRuntime = {
        name: 'structured-deadline-runtime',
        createSession: vi.fn().mockImplementation(async () => {
          const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
          const abort = vi.fn().mockImplementation(async () => {
            for (const handler of handlers.get('error') ?? []) {
              handler(new Error('session aborted'));
            }
          });
          abortCalls.push(abort);
          return {
            pid: null,
            send: () => {
              sendTimes.push(Date.now());
              const delay = sendTimes.length === 1 ? 60 : 80;
              setTimeout(() => {
                for (const handler of handlers.get('text') ?? []) handler('not JSON');
                for (const handler of handlers.get('idle') ?? []) handler();
              }, delay);
            },
            on: (event: string, handler: (...args: unknown[]) => void) => {
              handlers.set(event, [...(handlers.get(event) ?? []), handler]);
            },
            abort,
          } as unknown as AgentSession;
        }),
        isAvailable: vi.fn().mockResolvedValue(true),
      };
      const entry = agentNode({
        prompt: 'Return a result',
        model: 'mock-model',
        schema: parseStructured,
        structuredRetry: 1,
        retry: { budgetMs: 100 },
      });
      const context: ExecutionContext = {
        executionId: 'structured-deadline',
        nodeId: 'repair',
        runtime,
        emitOutput: vi.fn(),
        signal: new AbortController().signal,
      };

      const resultPromise = entry.fn(input, context);
      const resultExpectation = expect(resultPromise).rejects.toThrow('session aborted');
      await vi.advanceTimersByTimeAsync(100);
      await resultExpectation;

      expect(sendTimes).toHaveLength(2);
      expect(sendTimes[1] - sendTimes[0]).toBe(60);
      expect(runtime.createSession).toHaveBeenCalledTimes(2);
      expect(abortCalls[1]).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits monotonic retry attempts across structured repair sends', async () => {
    vi.useFakeTimers();
    try {
      const input: NodeInput = { dir: createTmpDir(), params: {}, artifactPaths: {} };
      dirs.push(input.dir);
      const responses = [
        { kind: 'error' as const },
        { kind: 'invalid' as const },
        { kind: 'error' as const },
        { kind: 'valid' as const },
      ];
      const runtime: AgentRuntime = {
        name: 'monotonic-retry-runtime',
        createSession: vi.fn().mockImplementation(async () => {
          const response = responses.shift();
          const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
          return {
            pid: null,
            send: () => queueMicrotask(() => {
              if (response?.kind === 'error') {
                for (const handler of handlers.get('error') ?? []) {
                  handler(Object.assign(new Error('temporary'), { statusCode: 503 }));
                }
                return;
              }
              const text = response?.kind === 'valid'
                ? '{"status":"done","count":1}'
                : 'not JSON';
              for (const handler of handlers.get('text') ?? []) handler(text);
              for (const handler of handlers.get('idle') ?? []) handler();
            }),
            on: (event: string, handler: (...args: unknown[]) => void) => {
              handlers.set(event, [...(handlers.get(event) ?? []), handler]);
            },
            abort: vi.fn().mockResolvedValue(undefined),
          } as unknown as AgentSession;
        }),
        isAvailable: vi.fn().mockResolvedValue(true),
      };
      let retryAttempt = 1;
      const emitState = vi.fn().mockResolvedValue(undefined);
      const entry = agentNode({
        prompt: 'Return a result',
        model: 'mock-model',
        schema: parseStructured,
        structuredRetry: 1,
        retry: { maxAttempts: 2, backoffBaseMs: 100, jitter: false },
      });
      const context: ExecutionContext = {
        executionId: 'monotonic-retry',
        nodeId: 'repair',
        runtime,
        emitOutput: vi.fn(),
        emitState,
        nextRetryAttempt: () => {
          retryAttempt += 1;
          return retryAttempt;
        },
        signal: new AbortController().signal,
      };

      const resultPromise = entry.fn(input, context);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.action).toBe('default');
      const attempts = emitState.mock.calls.map(([event]) => (
        event as { readonly attempt: number }
      ).attempt);
      expect(attempts).toEqual([2, 3]);
    } finally {
      vi.useRealTimers();
    }
  });
});
