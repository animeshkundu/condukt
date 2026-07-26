import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockRuntime } from '../runtimes/mock/mock-runtime';
import { agent, dryRun } from '../src';
import type { FlowGraph, SessionConfig } from '../src/types';
import { verify } from '../src/verify';

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'condukt-dry-run-'));
}

function createSessionConfig(
  cwd: string,
  overrides: Partial<SessionConfig> = {},
): SessionConfig {
  return {
    model: 'mock',
    cwd,
    addDirs: [],
    timeout: 10,
    heartbeatTimeout: 10,
    ...overrides,
  };
}

describe('dryRun', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses each agent boundary and configured artifact filename', async () => {
    const dir = createTmpDir();
    dirs.push(dir);

    const first = agent({
      objective: 'produce A',
      output: 'a.json',
      promptBuilder: () => 'produce A',
      actionParser: (content) => JSON.parse(content).route === 'next' ? 'next' : 'stop',
    });
    const second = agent({
      objective: 'consume A and produce B',
      output: 'b.json',
      promptBuilder: (input) => {
        const inputPath = input.artifactPaths['a.json'];
        if (!inputPath || JSON.parse(fs.readFileSync(inputPath, 'utf-8')).value !== 1) {
          throw new Error('a.json was not resolved for the downstream node');
        }
        return 'produce B';
      },
      actionParser: (content) => JSON.parse(content).route,
    });

    const graph: FlowGraph = {
      nodes: {
        first: {
          fn: first,
          displayName: 'First',
          nodeType: 'agent',
          output: 'a.json',
        },
        second: {
          fn: second,
          displayName: 'Second',
          nodeType: 'agent',
          output: 'b.json',
          reads: ['a.json'],
        },
      },
      edges: {
        first: { next: 'second' },
        second: { done: 'end' },
      },
      start: ['first'],
    };

    const result = await dryRun(graph, {
      dir,
      executionId: 'dry-run-parity',
      fixtures: {
        first: { artifact: '{"route":"next","value":1}' },
        second: { artifact: '{"route":"done","value":2}' },
      },
    });

    expect(result.completed).toBe(true);
    expect(result.projection.status).toBe('completed');
    expect(result.projection.graph.completedPath).toEqual(['first', 'second']);
    expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf-8')).toContain('"value":1');
    expect(fs.readFileSync(path.join(dir, 'b.json'), 'utf-8')).toContain('"value":2');
    expect(fs.existsSync(path.join(dir, 'output.md'))).toBe(false);
  });

  it('surfaces an invalid fixture through the real actionParser', async () => {
    const dir = createTmpDir();
    dirs.push(dir);

    const graph: FlowGraph = {
      nodes: {
        parse: {
          fn: agent({
            objective: 'produce JSON',
            output: 'result.json',
            promptBuilder: () => 'produce JSON',
            actionParser: (content) => JSON.parse(content).route,
          }),
          displayName: 'Parse',
          nodeType: 'agent',
          output: 'result.json',
        },
        downstream: {
          fn: async () => ({ action: 'done' }),
          displayName: 'Downstream',
          nodeType: 'deterministic',
        },
      },
      edges: {
        parse: { next: 'downstream' },
      },
      start: ['parse'],
    };

    const result = await dryRun(graph, {
      dir,
      executionId: 'dry-run-invalid',
      fixtures: {
        parse: { artifact: 'not-json' },
      },
    });

    expect(result.completed).toBe(false);
    expect(result.projection.status).toBe('failed');
    expect(result.projection.graph.nodes.find((node) => node.id === 'parse')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Unexpected token'),
    });
    expect(result.projection.graph.nodes.find((node) => node.id === 'downstream')?.status).toBe('pending');
    expect(result.events.some((event) => event.type === 'node:failed' && event.nodeId === 'parse')).toBe(true);
  });

  it('advances artifact and text response sequences across real repair sends', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const textEvents: string[] = [];
    const runtime = new MockRuntime({
      repair: {
        artifact: ['bad', 'good'],
        text: [['first send'], ['second send']],
      },
    });
    const producer = agent({
      objective: 'repair output',
      output: 'repair.txt',
      promptBuilder: () => 'repair',
    });
    const repair = verify(producer, {
      maxIterations: 2,
      checks: [{
        name: 'is good',
        fn: async (_dir, content) => ({
          passed: content === 'good',
          feedback: content === 'good' ? 'passed' : 'expected good',
        }),
      }],
    });

    const output = await repair(
      { dir, params: {}, artifactPaths: {} },
      {
        executionId: 'sequence-test',
        nodeId: 'repair',
        runtime,
        emitOutput: (event) => {
          if (event.type === 'node:output') textEvents.push(event.content);
        },
        signal: new AbortController().signal,
      },
    );

    expect(output.action).toBe('default');
    expect(output.artifact).toBe('good');
    expect(output.metadata?._verifyIteration).toBe(2);
    expect(textEvents).toEqual(['first send', 'second send']);
    expect(fs.readFileSync(path.join(dir, 'repair.txt'), 'utf-8')).toBe('good');
  });

  it('repeats the last sequence value; the node output filename wins over a fixture override', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const runtime = new MockRuntime({
      node: {
        artifact: ['first', 'last'],
        artifactFilename: path.join('nested', 'forced.txt'),
      },
    });
    // Parity: the node's real configured output (SessionConfig.artifactFilename)
    // wins over a fixture-level filename override.
    const config = createSessionConfig(dir, {
      nodeId: 'node',
      artifactFilename: 'configured.txt',
    });

    for (let send = 0; send < 3; send += 1) {
      const session = await runtime.createSession(config);
      const idle = new Promise<void>((resolve) => session.on('idle', resolve));
      session.send('test');
      await idle;
    }

    // Sequence repeats its last value ('last'); parity keeps the configured filename.
    expect(fs.readFileSync(path.join(dir, 'configured.txt'), 'utf-8')).toBe('last');
    expect(fs.existsSync(path.join(dir, 'nested', 'forced.txt'))).toBe(false);
  });

  it('uses the fixture filename override only when no SessionConfig filename is present', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const runtime = new MockRuntime({
      node: { artifact: 'x', artifactFilename: 'override.txt' },
    });
    const config = createSessionConfig(dir, { nodeId: 'node' });
    const session = await runtime.createSession(config);
    const idle = new Promise<void>((resolve) => session.on('idle', resolve));
    session.send('test');
    await idle;

    expect(fs.readFileSync(path.join(dir, 'override.txt'), 'utf-8')).toBe('x');
  });

  it('prefers a member fixture and falls back to the existing node fixture', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const runtime = new MockRuntime({
      node: { artifact: ['node-first', 'node-second'] },
      'node:member-a': { artifact: 'member-a' },
    });

    const runSession = async (memberId: string, artifactFilename: string) => {
      const session = await runtime.createSession(createSessionConfig(dir, {
        nodeId: 'node',
        memberId,
        artifactFilename,
      }));
      const idle = new Promise<void>((resolve) => session.on('idle', resolve));
      session.send('test');
      await idle;
      return fs.readFileSync(path.join(dir, artifactFilename), 'utf-8');
    };

    await expect(runSession('member-a', 'member-a.txt')).resolves.toBe('member-a');
    await expect(runSession('missing-a', 'fallback-a.txt')).resolves.toBe('node-first');
    await expect(runSession('missing-b', 'fallback-b.txt')).resolves.toBe('node-second');
  });

  it('reports artifact write failures instead of emitting idle', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const blockingPath = path.join(dir, 'blocking-file');
    fs.writeFileSync(blockingPath, 'not a directory', 'utf-8');
    const runtime = new MockRuntime({
      node: {
        artifact: 'content',
        artifactFilename: path.join('blocking-file', 'artifact.txt'),
      },
    });
    const session = await runtime.createSession(createSessionConfig(dir, { nodeId: 'node' }));
    const outcome = new Promise<'error' | 'idle'>((resolve) => {
      session.on('error', () => resolve('error'));
      session.on('idle', () => resolve('idle'));
    });

    session.send('test');

    await expect(outcome).resolves.toBe('error');
  });
});
