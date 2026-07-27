import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dryRun, panelNode } from '../src';
import type {
  AgentRuntime,
  AgentSession,
  ExecutionContext,
  FlowGraph,
  NodeInput,
  SessionConfig,
} from '../src/types';

interface Vote {
  readonly choice: string;
}

interface Decision {
  readonly choice: string;
}

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'condukt-panel-node-'));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseVote(value: unknown): Vote | undefined {
  if (!isRecord(value) || typeof value.choice !== 'string') return undefined;
  return { choice: value.choice };
}

function majority(verdicts: readonly Vote[]): Decision {
  const counts = new Map<string, number>();
  for (const verdict of verdicts) {
    counts.set(verdict.choice, (counts.get(verdict.choice) ?? 0) + 1);
  }
  const choice = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  if (!choice) throw new Error('Cannot reconcile an empty panel');
  return { choice };
}

function action(
  result: Awaited<ReturnType<typeof dryRun>>,
  nodeId: string,
): string | undefined {
  return result.projection.graph.nodes.find((node) => node.id === nodeId)?.action;
}

const members = [
  { id: 'owner', model: 'owner-model' },
  { id: 'peer-a', model: 'peer-a-model' },
  { id: 'peer-b', model: 'peer-b-model' },
] as const;

describe('panelNode', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies panel context and effort defaults while member values take precedence', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const captured: SessionConfig[] = [];
    const runtime: AgentRuntime = {
      name: 'panel-config-runtime',
      createSession: vi.fn().mockImplementation(async (sessionConfig: SessionConfig) => {
        captured.push(sessionConfig);
        const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
        return {
          pid: null,
          send: () => queueMicrotask(() => {
            for (const handler of handlers.get('text') ?? []) {
              handler(sessionConfig.memberId ?? 'member');
            }
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
    const entry = panelNode({
      prompt: 'Vote',
      contextTier: 'long_context',
      thinkingBudget: 'high',
      members: [
        { id: 'inherited', model: 'inherited-model' },
        {
          id: 'overridden',
          model: 'overridden-model',
          contextTier: 'default',
          thinkingBudget: 'low',
        },
      ],
      reconcile: (verdicts: readonly string[]) => verdicts.join(','),
    });
    const context: ExecutionContext = {
      executionId: 'panel-config',
      nodeId: 'panel',
      runtime,
      emitOutput: vi.fn(),
      signal: new AbortController().signal,
    };

    await entry.fn({ dir, params: {}, artifactPaths: {} }, context);

    const byMember = new Map(captured.map((config) => [config.memberId, config]));
    expect(byMember.get('inherited')).toEqual(expect.objectContaining({
      model: 'inherited-model',
      contextTier: 'long_context',
      thinkingBudget: 'high',
    }));
    expect(byMember.get('overridden')).toEqual(expect.objectContaining({
      model: 'overridden-model',
      contextTier: 'default',
      thinkingBudget: 'low',
    }));
  });

  it('reconciles a three-member fixture sequence, routes, and writes JSON', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const graph: FlowGraph = {
      nodes: {
        panel: panelNode({
          prompt: 'Vote',
          members,
          memberSchema: parseVote,
          reconcile: majority,
          route: (result) => result.choice,
          output: 'decision.json',
        }),
      },
      edges: { panel: {} },
      start: ['panel'],
    };

    const result = await dryRun(graph, {
      dir,
      fixtures: {
        panel: {
          artifact: [
            '{"choice":"continue"}',
            '{"choice":"exit"}',
            '{"choice":"continue"}',
          ],
        },
      },
    });

    expect(action(result, 'panel')).toBe('continue');
    expect(fs.readFileSync(path.join(dir, 'decision.json'), 'utf-8')).toBe(
      JSON.stringify({ choice: 'continue' }, null, 2),
    );
  });

  it('excludes an invalid member and records failure metadata', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    let reconciled: readonly Vote[] = [];
    let receivedMeta: readonly { readonly ok: boolean }[] = [];
    const graph: FlowGraph = {
      nodes: {
        panel: panelNode({
          prompt: 'Vote',
          members,
          memberSchema: parseVote,
          structuredRetry: 0,
          reconcile: (verdicts, meta) => {
            reconciled = verdicts;
            receivedMeta = meta;
            return majority(verdicts);
          },
        }),
      },
      edges: { panel: {} },
      start: ['panel'],
    };

    await dryRun(graph, {
      dir,
      fixtures: {
        panel: {
          artifact: [
            '{"choice":"continue"}',
            'not JSON',
            '{"choice":"exit"}',
          ],
        },
      },
    });

    expect(reconciled).toEqual([{ choice: 'continue' }, { choice: 'exit' }]);
    expect(receivedMeta.map((entry) => entry.ok)).toEqual([true, false, true]);
  });

  it('uses fallback when every member fails validation', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    let fallbackError = '';
    const graph: FlowGraph = {
      nodes: {
        panel: panelNode({
          prompt: 'Vote',
          members,
          memberSchema: parseVote,
          structuredRetry: 0,
          reconcile: majority,
          fallback: (error) => {
            fallbackError = error.message;
            return { choice: 'fallback' };
          },
          route: (result) => result.choice,
        }),
      },
      edges: { panel: {} },
      start: ['panel'],
    };

    const result = await dryRun(graph, {
      dir,
      fixtures: { panel: { artifact: ['bad-1', 'bad-2', 'bad-3'] } },
    });

    expect(action(result, 'panel')).toBe('fallback');
    expect(fallbackError).toContain('no valid JSON value');
  });

  it('returns fail when every member fails and no fallback exists', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const graph: FlowGraph = {
      nodes: {
        panel: panelNode({
          prompt: 'Vote',
          members,
          memberSchema: parseVote,
          structuredRetry: 0,
          reconcile: majority,
        }),
      },
      edges: { panel: {} },
      start: ['panel'],
    };

    const result = await dryRun(graph, {
      dir,
      fixtures: { panel: { artifact: ['bad-1', 'bad-2', 'bad-3'] } },
    });

    expect(action(result, 'panel')).toBe('fail');
  });

  it('drives LoopRegion continuation and exit as its decision node', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    let reconciliations = 0;
    const graph: FlowGraph = {
      nodes: {
        produce: {
          fn: async () => ({ action: 'default' }),
          displayName: 'Produce',
          nodeType: 'deterministic',
        },
        panel: panelNode({
          prompt: 'Vote',
          members: [{ model: 'owner' }],
          memberSchema: parseVote,
          reconcile: (verdicts) => {
            reconciliations += 1;
            return verdicts[0] ?? { choice: 'exit' };
          },
          route: (result) => result.choice,
        }),
        done: {
          fn: async () => ({ action: 'default' }),
          displayName: 'Done',
          nodeType: 'deterministic',
        },
      },
      edges: {
        produce: { default: 'panel' },
        panel: { continue: 'produce', exit: 'done' },
      },
      start: ['produce'],
      loops: [{
        id: 'panel-loop',
        nodes: ['produce', 'panel'],
        entry: 'produce',
        decision: 'panel',
        continueOn: 'continue',
        exitOn: 'exit',
        maxRounds: 2,
      }],
    };

    const result = await dryRun(graph, {
      dir,
      fixtures: {
        panel: {
          artifact: ['{"choice":"continue"}', '{"choice":"exit"}'],
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(reconciliations).toBe(2);
    expect(action(result, 'panel')).toBe('exit');
    expect(action(result, 'done')).toBe('default');
  });

  it('runs members concurrently while preserving input order', async () => {
    vi.useFakeTimers();
    try {
      const input: NodeInput = { dir: createTmpDir(), params: {}, artifactPaths: {} };
      dirs.push(input.dir);
      const membersByModel = new Map([
        ['first', { choice: 'first', delay: 80 }],
        ['second', { choice: 'second', delay: 40 }],
        ['third', { choice: 'third', delay: 10 }],
      ]);
      let active = 0;
      let maxConcurrent = 0;
      let reconciled: readonly Vote[] = [];
      let receivedMeta: readonly { readonly member: { readonly id?: string } }[] = [];
      const runtime: AgentRuntime = {
        name: 'parallel-order-runtime',
        createSession: vi.fn().mockImplementation(async (sessionConfig: SessionConfig) => {
          const fixture = membersByModel.get(sessionConfig.model);
          if (!fixture) throw new Error(`Missing fixture for ${sessionConfig.model}`);
          const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
          return {
            pid: null,
            send: () => {
              active += 1;
              maxConcurrent = Math.max(maxConcurrent, active);
              setTimeout(() => {
                active -= 1;
                for (const handler of handlers.get('text') ?? []) {
                  handler(JSON.stringify({ choice: fixture.choice }));
                }
                for (const handler of handlers.get('idle') ?? []) handler();
              }, fixture.delay);
            },
            on: (event: string, handler: (...args: unknown[]) => void) => {
              handlers.set(event, [...(handlers.get(event) ?? []), handler]);
            },
            abort: vi.fn().mockResolvedValue(undefined),
          } as unknown as AgentSession;
        }),
        isAvailable: vi.fn().mockResolvedValue(true),
      };
      const entry = panelNode({
        prompt: 'Vote',
        members: [
          { id: 'first-id', model: 'first' },
          { id: 'second-id', model: 'second' },
          { id: 'third-id', model: 'third' },
        ],
        memberSchema: parseVote,
        reconcile: (verdicts, meta) => {
          reconciled = verdicts;
          receivedMeta = meta;
          return { choice: verdicts.map((verdict) => verdict.choice).join(',') };
        },
      });
      const context: ExecutionContext = {
        executionId: 'parallel-order',
        nodeId: 'panel',
        runtime,
        emitOutput: vi.fn(),
        signal: new AbortController().signal,
      };

      const resultPromise = entry.fn(input, context);
      await vi.advanceTimersByTimeAsync(80);
      const result = await resultPromise;

      expect(result.artifact).toBe(JSON.stringify({ choice: 'first,second,third' }, null, 2));
      expect(maxConcurrent).toBe(3);
      expect(reconciled.map((verdict) => verdict.choice)).toEqual(['first', 'second', 'third']);
      expect(receivedMeta.map((entry) => entry.member.id)).toEqual([
        'first-id',
        'second-id',
        'third-id',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates a member error while siblings finish', async () => {
    vi.useFakeTimers();
    try {
      const input: NodeInput = { dir: createTmpDir(), params: {}, artifactPaths: {} };
      dirs.push(input.dir);
      const aborted: string[] = [];
      let receivedMeta: readonly { readonly member: { readonly id?: string }; readonly ok: boolean }[] = [];
      const runtime: AgentRuntime = {
        name: 'parallel-isolation-runtime',
        createSession: vi.fn().mockImplementation(async (sessionConfig: SessionConfig) => {
          const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
          let completed = false;
          return {
            pid: null,
            send: () => {
              const failed = sessionConfig.memberId === 'bad';
              setTimeout(() => {
                completed = true;
                if (failed) {
                  for (const handler of handlers.get('error') ?? []) handler(new Error('member failed'));
                  return;
                }
                for (const handler of handlers.get('text') ?? []) {
                  handler(JSON.stringify({ choice: sessionConfig.memberId }));
                }
                for (const handler of handlers.get('idle') ?? []) handler();
              }, failed ? 10 : 40);
            },
            on: (event: string, handler: (...args: unknown[]) => void) => {
              handlers.set(event, [...(handlers.get(event) ?? []), handler]);
            },
            abort: vi.fn().mockImplementation(async () => {
              if (!completed && sessionConfig.memberId) aborted.push(sessionConfig.memberId);
            }),
          } as unknown as AgentSession;
        }),
        isAvailable: vi.fn().mockResolvedValue(true),
      };
      const entry = panelNode({
        prompt: 'Vote',
        members: [
          { id: 'good-a', model: 'a' },
          { id: 'bad', model: 'bad' },
          { id: 'good-b', model: 'b' },
        ],
        memberSchema: parseVote,
        reconcile: (verdicts, meta) => {
          receivedMeta = meta;
          return { choice: verdicts.map((verdict) => verdict.choice).join(',') };
        },
      });
      const context: ExecutionContext = {
        executionId: 'parallel-isolation',
        nodeId: 'panel',
        runtime,
        emitOutput: vi.fn(),
        signal: new AbortController().signal,
      };

      const resultPromise = entry.fn(input, context);
      await vi.advanceTimersByTimeAsync(40);
      const result = await resultPromise;

      expect(result.artifact).toBe(JSON.stringify({ choice: 'good-a,good-b' }, null, 2));
      expect(receivedMeta.map((entry) => entry.ok)).toEqual([true, false, true]);
      expect(aborted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses unique temporary artifacts and only writes the reconciled output', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const artifactPaths: string[] = [];
    const runtime: AgentRuntime = {
      name: 'panel-artifact-runtime',
      createSession: vi.fn().mockImplementation(async (sessionConfig: SessionConfig) => {
        const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
        return {
          pid: null,
          send: () => {
            if (!sessionConfig.artifactFilename) throw new Error('Missing artifact filename');
            artifactPaths.push(sessionConfig.artifactFilename);
            const artifact = JSON.stringify({ choice: sessionConfig.memberId });
            const artifactPath = path.join(sessionConfig.cwd, sessionConfig.artifactFilename);
            fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
            fs.writeFileSync(artifactPath, artifact, 'utf-8');
            queueMicrotask(() => {
              for (const handler of handlers.get('idle') ?? []) handler();
            });
          },
          on: (event: string, handler: (...args: unknown[]) => void) => {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
          },
          abort: vi.fn().mockResolvedValue(undefined),
        } as unknown as AgentSession;
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
    };
    const entry = panelNode({
      prompt: 'Vote',
      members: [
        { id: 'alpha', model: 'alpha-model' },
        { id: 'beta', model: 'beta-model' },
      ],
      memberSchema: parseVote,
      output: 'decision.json',
      reconcile: (verdicts) => ({
        choice: verdicts.map((verdict) => verdict.choice).join(','),
      }),
    });
    const context: ExecutionContext = {
      executionId: 'artifact-execution',
      nodeId: 'panel-node',
      runtime,
      emitOutput: vi.fn(),
      signal: new AbortController().signal,
    };

    await entry.fn({ dir, params: {}, artifactPaths: {} }, context);

    expect(new Set(artifactPaths).size).toBe(2);
    expect(artifactPaths).toEqual([
      '.condukt/artifact-execution-panel-node-panel-member-0.json',
      '.condukt/artifact-execution-panel-node-panel-member-1.json',
    ]);
    expect(fs.readFileSync(path.join(dir, 'decision.json'), 'utf-8')).toBe(
      JSON.stringify({ choice: 'alpha,beta' }, null, 2),
    );
    for (const artifactPath of artifactPaths) {
      expect(fs.existsSync(path.join(dir, artifactPath))).toBe(false);
    }
  });

  it('keys mock fixtures by member deterministically across repeated runs', async () => {
    for (let run = 0; run < 5; run += 1) {
      const dir = createTmpDir();
      dirs.push(dir);
      let reconciled: readonly Vote[] = [];
      const graph: FlowGraph = {
        nodes: {
          panel: panelNode({
            prompt: 'Vote',
            members,
            memberSchema: parseVote,
            reconcile: (verdicts) => {
              reconciled = verdicts;
              return majority(verdicts);
            },
          }),
        },
        edges: { panel: {} },
        start: ['panel'],
      };

      await dryRun(graph, {
        dir,
        fixtures: {
          'panel:owner': { artifact: '{"choice":"owner"}', delay: 30 },
          'panel:peer-a': { artifact: '{"choice":"peer-a"}', delay: 20 },
          'panel:peer-b': { artifact: '{"choice":"peer-b"}', delay: 10 },
        },
      });

      expect(reconciled.map((verdict) => verdict.choice)).toEqual([
        'owner',
        'peer-a',
        'peer-b',
      ]);
    }
  });

  it('applies one shared deadline to all parallel members', async () => {
    vi.useFakeTimers();
    try {
      const input: NodeInput = { dir: createTmpDir(), params: {}, artifactPaths: {} };
      dirs.push(input.dir);
      const sendTimes: number[] = [];
      const abortTimes: number[] = [];
      const runtime: AgentRuntime = {
        name: 'panel-deadline-runtime',
        createSession: vi.fn().mockImplementation(async () => {
          const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
          let timer: ReturnType<typeof setTimeout> | undefined;
          return {
            pid: null,
            send: () => {
              sendTimes.push(Date.now());
              timer = setTimeout(() => {
                for (const handler of handlers.get('text') ?? []) handler('vote');
                for (const handler of handlers.get('idle') ?? []) handler();
              }, 200);
            },
            on: (event: string, handler: (...args: unknown[]) => void) => {
              handlers.set(event, [...(handlers.get(event) ?? []), handler]);
            },
            abort: vi.fn().mockImplementation(async () => {
              abortTimes.push(Date.now());
              if (timer !== undefined) clearTimeout(timer);
            }),
          } as unknown as AgentSession;
        }),
        isAvailable: vi.fn().mockResolvedValue(true),
      };
      const entry = panelNode({
        prompt: 'Vote',
        members: [{ model: 'first' }, { model: 'second' }, { model: 'third' }],
        retry: { budgetMs: 100 },
        reconcile: (verdicts: readonly string[]) => verdicts.join(','),
      });
      const context: ExecutionContext = {
        executionId: 'panel-deadline',
        nodeId: 'panel',
        runtime,
        emitOutput: vi.fn(),
        signal: new AbortController().signal,
      };

      const startedAt = Date.now();
      const resultPromise = entry.fn(input, context);
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.action).toBe('fail');
      expect(sendTimes).toHaveLength(3);
      expect(new Set(sendTimes)).toEqual(new Set([startedAt]));
      expect(abortTimes).toHaveLength(6);
      expect(new Set(abortTimes)).toEqual(new Set([startedAt + 100]));
      expect(runtime.createSession).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
