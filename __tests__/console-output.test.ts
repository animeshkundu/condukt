import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBridge } from '../bridge/bridge';
import { createConsoleOutputRenderer, type OutputEventSink } from '../src/console-output';
import type { OutputEvent } from '../src/events';
import type { AgentRuntime, ExecutionContext, FlowGraph } from '../src/types';
import { StateRuntime } from '../state/state-runtime';
import { MemoryStorage } from '../state/storage-memory';

function createMockRuntime(): AgentRuntime {
  return {
    name: 'mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockRejectedValue(new Error('No sessions expected')),
  };
}

function createOutputGraph(emit: (ctx: ExecutionContext) => void): FlowGraph {
  return {
    nodes: {
      worker: {
        displayName: 'Worker',
        nodeType: 'deterministic',
        fn: async (_input, ctx) => {
          emit(ctx);
          return { action: 'default' };
        },
      },
    },
    edges: {},
    start: ['worker'],
  };
}

async function waitForStatus(
  bridge: ReturnType<typeof createBridge>,
  executionId: string,
  status: 'completed' | 'failed',
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const projection = bridge.getExecution(executionId);
    if (!bridge.isRunning(executionId) && projection?.status === status) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Execution '${executionId}' did not reach '${status}'`);
}

function waitForCompletion(
  bridge: ReturnType<typeof createBridge>,
  executionId: string,
): Promise<void> {
  return waitForStatus(bridge, executionId, 'completed');
}

function emitText(ctx: ExecutionContext, content: string): void {
  ctx.emitOutput({
    type: 'node:output',
    executionId: ctx.executionId,
    nodeId: ctx.nodeId,
    content,
    ts: Date.now(),
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('console output renderer', () => {
  function writtenOutput(stdout: ReturnType<typeof vi.spyOn>): string {
    return stdout.mock.calls.map((call: unknown[]) => String(call[0])).join('');
  }

  function renderOutput(
    content: string,
    options?: Parameters<typeof createConsoleOutputRenderer>[0],
  ): string {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createConsoleOutputRenderer(options);
    renderer.emitOutput({
      type: 'node:output',
      executionId: 'exec',
      nodeId: 'worker',
      content,
      ts: 1,
    });
    renderer.flush();
    return writtenOutput(stdout);
  }

  it.each(['ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_', 'github_pat_'])(
    'redacts GitHub tokens with the %s prefix',
    (prefix) => {
      const token = `${prefix}${'a'.repeat(36)}`;
      const written = renderOutput(`token=${token}\n`);

      expect(written).toBe('[worker] token=[REDACTED]\n');
      expect(written).not.toContain(token);
    },
  );

  it('redacts Authorization header values', () => {
    const written = renderOutput([
      'Authorization: Bearer bearer-value',
      'authorization: Basic dXNlcjpwYXNzd29yZA==',
      'Authorization: Digest username="guest", response="secret"',
      '',
    ].join('\n'));

    expect(written).toBe([
      '[worker] Authorization: [REDACTED]',
      '[worker] authorization: [REDACTED]',
      '[worker] Authorization: [REDACTED]',
      '',
    ].join('\n'));
  });

  it('redacts Authorization header values embedded in objects', () => {
    const written = renderOutput([
      '{"Authorization":"Bearer bearer-value","safe":"visible"}',
      "{'authorization': 'Basic dXNlcjpwYXNz', 'safe': 'visible'}",
      '',
    ].join('\n'));

    expect(written).toBe([
      '[worker] {"Authorization":"[REDACTED]","safe":"visible"}',
      "[worker] {'authorization': '[REDACTED]', 'safe': 'visible'}",
      '',
    ].join('\n'));
  });

  it('redacts AWS access key IDs, secret access key assignments, and PEM private keys', () => {
    const accessKey = 'AKIAIOSFODNN7EXAMPLE';
    const secretKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const written = renderOutput([
      accessKey,
      `AWS_SECRET_ACCESS_KEY=${secretKey}`,
      `{"aws_secret_access_key":"${secretKey}"}`,
      '-----BEGIN PRIVATE KEY-----',
      'private-key-material',
      '-----END PRIVATE KEY-----',
      '',
    ].join('\n'));

    expect(written).not.toContain(accessKey);
    expect(written).not.toContain(secretKey);
    expect(written).not.toContain('private-key-material');
    expect(written.match(/\[REDACTED\]/gu)).toHaveLength(4);
  });

  it('redacts PEM private key blocks split across output events', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createConsoleOutputRenderer();

    for (const content of [
      'before\n-----BEGIN RSA PRIVATE KEY-----\nprivate-',
      'key-material\n-----END RSA PRIVATE KEY-----\nafter\n',
    ]) {
      renderer.emitOutput({
        type: 'node:output',
        executionId: 'exec',
        nodeId: 'worker',
        content,
        ts: 1,
      });
    }

    expect(writtenOutput(stdout)).toBe('[worker] before\n[worker] [REDACTED]\n[worker] after\n');
  });

  it('redacts complete PEM private key blocks on one line', () => {
    const written = renderOutput(
      'before -----BEGIN PRIVATE KEY-----private-key-material-----END PRIVATE KEY----- after\n',
    );

    expect(written).toBe('[worker] before [REDACTED] after\n');
  });

  it('redacts overlapping known secret values longest first', () => {
    const longer = 'prefix-consumer-secret-suffix';
    const written = renderOutput(`${longer}\n`, {
      knownSecrets: ['consumer-secret', longer],
    });

    expect(written).toBe('[worker] [REDACTED]\n');
    expect(written).not.toContain('prefix-[REDACTED]-suffix');
  });

  it('redacts secrets from node attribution before stdout', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const secret = 'node-secret';
    const renderer = createConsoleOutputRenderer({ knownSecrets: [secret] });

    renderer.emitOutput({
      type: 'node:output',
      executionId: 'exec',
      nodeId: `worker-${secret}`,
      content: 'visible\n',
      ts: 1,
    });

    expect(writtenOutput(stdout)).toBe('[worker-[REDACTED]] visible\n');
  });

  it('redacts before line-ending slicing', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const written = renderOutput(`${token}\r`);

    expect(written).toBe('[worker] [REDACTED]\n');
    expect(written).not.toContain(token.slice(0, -1));
  });

  it('does not emit a token prefix before later output completes it', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createConsoleOutputRenderer();
    const token = `ghp_${'a'.repeat(36)}`;

    renderer.emitOutput({
      type: 'node:output',
      executionId: 'exec',
      nodeId: 'worker',
      content: token.slice(0, 20),
      ts: 1,
    });
    expect(stdout).not.toHaveBeenCalled();

    renderer.emitOutput({
      type: 'node:output',
      executionId: 'exec',
      nodeId: 'worker',
      content: `${token.slice(20)}\nvisible\n`,
      ts: 2,
    });

    const written = writtenOutput(stdout);
    expect(written).toBe('[worker] [REDACTED]\n[worker] visible\n');
    expect(written).not.toContain(token.slice(0, 20));
  });

  it('does not emit a known-secret prefix before later output completes it', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const secret = 'known-consumer-secret';
    const renderer = createConsoleOutputRenderer({ knownSecrets: [secret] });

    renderer.emitOutput({
      type: 'node:output',
      executionId: 'exec',
      nodeId: 'worker',
      content: secret.slice(0, 8),
      ts: 1,
    });
    expect(stdout).not.toHaveBeenCalled();

    renderer.emitOutput({
      type: 'node:output',
      executionId: 'exec',
      nodeId: 'worker',
      content: `${secret.slice(8)}\nvisible\n`,
      ts: 2,
    });

    expect(writtenOutput(stdout)).toBe('[worker] [REDACTED]\n[worker] visible\n');
  });

  it('keeps overlapping known-secret prefixes raw across output events', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createConsoleOutputRenderer({
      knownSecrets: ['abcd1234', 'abcd'],
    });

    renderer.emitOutput({
      type: 'node:output',
      executionId: 'exec',
      nodeId: 'worker',
      content: 'abcd',
      ts: 1,
    });
    expect(stdout).not.toHaveBeenCalled();

    renderer.emitOutput({
      type: 'node:output',
      executionId: 'exec',
      nodeId: 'worker',
      content: '1234\n',
      ts: 2,
    });

    expect(writtenOutput(stdout)).toBe('[worker] [REDACTED]\n');
  });

  it('redacts multiline known secrets before line splitting', () => {
    const secret = 'first line\nsecond line';

    expect(renderOutput(`${secret}\nvisible\n`, { knownSecrets: [secret] })).toBe(
      '[worker] [REDACTED]\n[worker] visible\n',
    );
  });

  it('redacts complete buffered blocks before attributing each line during flush', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createConsoleOutputRenderer({
      knownSecrets: ['first line\r\nsecond secret'],
    });

    renderer.emitOutput({
      type: 'node:output',
      executionId: 'exec',
      nodeId: 'worker',
      content: 'first line\r\nsecond secret\n',
      ts: 1,
    });
    renderer.flush();

    expect(writtenOutput(stdout)).toBe('[worker] [REDACTED]\n');
  });

  it('attributes and normalizes each held partial-secret line during flush', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createConsoleOutputRenderer({
      knownSecrets: ['first line\r\nsecond secret'],
    });

    renderer.emitOutput({
      type: 'node:output',
      executionId: 'exec',
      nodeId: 'worker',
      content: 'first line\r\nsec\n',
      ts: 1,
    });
    expect(stdout).not.toHaveBeenCalled();

    renderer.flush();

    expect(writtenOutput(stdout)).toBe('[worker] first line\n[worker] sec\n');
  });

  it('does not leak a buffered secret when output types interleave', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createConsoleOutputRenderer({ renderReasoning: true });
    const token = `ghp_${'a'.repeat(36)}`;

    renderer.emitOutput({
      type: 'node:output', executionId: 'exec', nodeId: 'worker', content: token.slice(0, 20), ts: 1,
    });
    renderer.emitOutput({
      type: 'node:reasoning', executionId: 'exec', nodeId: 'worker', content: '', ts: 2,
    });
    renderer.emitOutput({
      type: 'node:output', executionId: 'exec', nodeId: 'worker', content: `${token.slice(20)}\n`, ts: 3,
    });

    expect(writtenOutput(stdout)).toBe('[worker] [REDACTED]\n');
  });

  it('preserves git SHAs and UUIDs', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const uuid = '123e4567-e89b-12d3-a456-426614174000';

    expect(renderOutput(`${sha} ${uuid}\n`)).toBe(`[worker] ${sha} ${uuid}\n`);
  });

  it('does not render reasoning by default', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createConsoleOutputRenderer();

    renderer.emitOutput({
      type: 'node:reasoning',
      executionId: 'exec',
      nodeId: 'reasoner',
      content: 'hidden reasoning\n',
      ts: 1,
    });

    expect(stdout).not.toHaveBeenCalled();
  });

  it('renders reasoning when enabled and concatenates deltas without a separator', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createConsoleOutputRenderer({ renderReasoning: true });

    renderer.emitOutput({
      type: 'node:reasoning',
      executionId: 'exec',
      nodeId: 'reasoner',
      content: 'ic',
      ts: 1,
    });
    renderer.emitOutput({
      type: 'node:reasoning',
      executionId: 'exec',
      nodeId: 'reasoner',
      content: 'm\n',
      ts: 2,
    });

    expect(writtenOutput(stdout)).toBe('[reasoner] icm\n');
  });

  it('uses a custom redactor instead of all built-in redaction', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const redactor = vi.fn((value: string) => value.replace('custom-secret', '[CUSTOM]'));
    const written = renderOutput([
      `${token} custom-secret`,
      '-----BEGIN PRIVATE KEY-----',
      'private-key-material',
      '-----END PRIVATE KEY-----',
      '',
    ].join('\n'), { redactor });

    expect(written).toBe([
      `[worker] ${token} [CUSTOM]`,
      '[worker] -----BEGIN PRIVATE KEY-----',
      '[worker] private-key-material',
      '[worker] -----END PRIVATE KEY-----',
      '',
    ].join('\n'));
    expect(redactor).toHaveBeenCalled();
  });

  it('invokes a custom redactor once per emitted line', () => {
    const redactor = vi.fn((value: string) => value);

    expect(renderOutput('unterminated', { redactor })).toBe('[worker] unterminated\n');
    expect(redactor).toHaveBeenCalledTimes(1);
  });

  it('swallows redactor failures without writing unredacted output', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createConsoleOutputRenderer({
      redactor: () => { throw new Error('redactor failed'); },
    });

    expect(() => renderer.emitOutput({
      type: 'node:output',
      executionId: 'exec',
      nodeId: 'worker',
      content: 'secret\n',
      ts: 1,
    })).not.toThrow();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('attributes interleaved output to each node', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const renderer = createConsoleOutputRenderer();
    const events: readonly OutputEvent[] = [
      { type: 'node:output', executionId: 'exec', nodeId: 'alpha', content: 'hel', ts: 1 },
      { type: 'node:output', executionId: 'exec', nodeId: 'beta', content: 'wor', ts: 2 },
      { type: 'node:output', executionId: 'exec', nodeId: 'alpha', content: 'lo\n', ts: 3 },
      { type: 'node:output', executionId: 'exec', nodeId: 'beta', content: 'ld\n', ts: 4 },
    ];

    for (const event of events) renderer.emitOutput(event);

    const written = stdout.mock.calls.map(call => String(call[0])).join('');
    expect(written).toBe('[alpha] hello\n[beta] world\n');
  });

  it('swallows stdout rendering failures', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('stdout unavailable');
    });
    const renderer = createConsoleOutputRenderer();

    expect(() => renderer.emitOutput({
      type: 'node:output',
      executionId: 'exec',
      nodeId: 'worker',
      content: 'still running\n',
      ts: 1,
    })).not.toThrow();
  });
});

describe('bridge output sink', () => {
  function setup(
    output?: OutputEventSink | false,
    options: Omit<NonNullable<Parameters<typeof createBridge>[2]>, 'emitOutput'> = {},
  ): {
    readonly bridge: ReturnType<typeof createBridge>;
    readonly stateRuntime: StateRuntime;
    readonly dir: string;
  } {
    const stateRuntime = new StateRuntime(new MemoryStorage());
    const bridge = output === undefined
      ? createBridge(createMockRuntime(), stateRuntime, options)
      : createBridge(createMockRuntime(), stateRuntime, { ...options, emitOutput: output });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-output-'));
    tempDirs.push(dir);
    return { bridge, stateRuntime, dir };
  }

  async function launchOutput(
    output: OutputEventSink | false | undefined,
    executionId: string,
  ): Promise<{ readonly stateRuntime: StateRuntime }> {
    const { bridge, stateRuntime, dir } = setup(output);
    await bridge.launch({
      executionId,
      graph: createOutputGraph(ctx => emitText(ctx, 'visible output')),
      dir,
      params: {},
    });
    await waitForCompletion(bridge, executionId);
    return { stateRuntime };
  }

  it('writes to stdout by default and still captures state', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { stateRuntime } = await launchOutput(undefined, 'default-output');

    const written = stdout.mock.calls.map(call => String(call[0])).join('');
    expect(written).toBe('[worker] visible output\n');
    expect(stateRuntime.getNodeOutput('default-output', 'worker').lines).toEqual(['visible output']);
  });

  it('threads redaction options through the bridge default renderer', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stateRuntime = new StateRuntime(new MemoryStorage());
    const secret = 'consumer-secret';
    const bridge = createBridge(createMockRuntime(), stateRuntime, {
      knownSecrets: [secret],
      outputRedactor: (value) => value.replace('visible', 'custom'),
      renderReasoning: true,
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-output-'));
    tempDirs.push(dir);
    const graph = createOutputGraph(ctx => {
      emitText(ctx, `visible ${secret}\n`);
      ctx.emitOutput({
        type: 'node:reasoning',
        executionId: ctx.executionId,
        nodeId: ctx.nodeId,
        content: 'visible reasoning\n',
        ts: Date.now(),
      });
    });

    await bridge.launch({ executionId: 'redacted-output', graph, dir, params: {} });
    await waitForCompletion(bridge, 'redacted-output');

    const written = stdout.mock.calls.map(call => String(call[0])).join('');
    expect(written).toBe('[worker] custom [REDACTED]\n[worker] custom reasoning\n');
  });

  it('uses a consumer sink instead of stdout and still captures state', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const sink = vi.fn<(event: OutputEvent) => void>();

    const { stateRuntime } = await launchOutput(sink, 'custom-output');

    expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      type: 'node:output',
      nodeId: 'worker',
      content: 'visible output',
    }));
    expect(stdout).not.toHaveBeenCalled();
    expect(stateRuntime.getNodeOutput('custom-output', 'worker').lines).toEqual(['visible output']);
  });

  it('can explicitly silence stdout and still captures state', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { stateRuntime } = await launchOutput(false, 'silent-output');

    expect(stdout).not.toHaveBeenCalled();
    expect(stateRuntime.getNodeOutput('silent-output', 'worker').lines).toEqual(['visible output']);
  });

  it('uses the configured sink for launch, resume, and retry', async () => {
    const sink = vi.fn<(event: OutputEvent) => void>();
    const { bridge, stateRuntime, dir } = setup(sink);
    let attempt = 0;
    const graph = createOutputGraph(ctx => {
      attempt += 1;
      emitText(ctx, `attempt ${attempt}\n`);
      if (attempt === 1) throw new Error('first attempt fails');
    });

    await bridge.launch({ executionId: 'lifecycle-output', graph, dir, params: {} });
    await waitForStatus(bridge, 'lifecycle-output', 'failed');

    const resumed = await bridge.resume('lifecycle-output', graph);
    expect(resumed).not.toBeNull();
    await waitForCompletion(bridge, 'lifecycle-output');

    await bridge.retryNode('lifecycle-output', 'worker', graph);
    await waitForCompletion(bridge, 'lifecycle-output');

    expect(sink.mock.calls.map(([event]) => (
      event.type === 'node:output' ? event.content : null
    )).filter(Boolean)).toEqual(['attempt 1\n', 'attempt 2\n', 'attempt 3\n']);
    expect(stateRuntime.getNodeOutput('lifecycle-output', 'worker').lines).toEqual([
      'attempt 1\\n',
      'attempt 2\\n',
      'attempt 3\\n',
    ]);
  });

  it('does not let a throwing consumer sink break the run', async () => {
    const sink: OutputEventSink = () => {
      throw new Error('sink failed');
    };

    const { stateRuntime } = await launchOutput(sink, 'throwing-output');

    expect(stateRuntime.getProjection('throwing-output')?.status).toBe('completed');
    expect(stateRuntime.getNodeOutput('throwing-output', 'worker').lines).toEqual(['visible output']);
  });
});
