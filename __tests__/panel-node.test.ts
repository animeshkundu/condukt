import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dryRun, panelNode } from '../src';
import type { FlowGraph } from '../src/types';

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
});
