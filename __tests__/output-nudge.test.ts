/**
 * Declared-output guard tests.
 *
 * The guard exists because a node's declared artifact lands only if the model
 * calls its file-writing tool. When the first turn forgets, the guard asks the
 * *same* session for it rather than letting the outer loop start a fresh one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agent } from '../src/agent';
import { MissingRequiredOutputError, FlowAbortedError } from '../src/types';
import type {
  AgentRuntime,
  AgentSession,
  ExecutionContext,
  NodeInput,
  SessionConfig,
} from '../src/types';
import { MockRuntime } from '../runtimes/mock';

const OUTPUT = 'artifacts/00-evidence.md';

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'condukt-output-nudge-'));
}

function nodeInput(dir: string): NodeInput {
  return { dir, params: {}, artifactPaths: {} };
}

function context(
  runtime: AgentRuntime,
  signal?: AbortSignal,
): ExecutionContext {
  return {
    executionId: 'exec-nudge',
    nodeId: 'node-1',
    runtime,
    emitOutput: vi.fn(),
    signal: signal ?? new AbortController().signal,
  };
}

/**
 * A runtime whose session records `continueSession` calls, so a test can assert
 * the guard never reached for a warm continuation (or reached for exactly one).
 */
function recordingRuntime(options: {
  readonly onContinue?: (index: number) => void;
  readonly hasContinueSession?: boolean;
}): { runtime: AgentRuntime; continuations: string[] } {
  const continuations: string[] = [];
  let index = 0;
  const session = (): AgentSession => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const settle = () => {
      for (const handler of handlers.get('idle') ?? []) handler();
    };
    const base: Record<string, unknown> = {
      pid: null,
      send: () => queueMicrotask(() => {
        for (const handler of handlers.get('text') ?? []) handler('done');
        settle();
      }),
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      abort: vi.fn().mockResolvedValue(undefined),
    };
    if (options.hasContinueSession !== false) {
      base.continueSession = async (prompt: string) => {
        continuations.push(prompt);
        index += 1;
        options.onContinue?.(index);
        settle();
      };
    }
    return base as unknown as AgentSession;
  };
  return {
    runtime: {
      name: 'recording',
      createSession: vi.fn().mockImplementation(
        async (_config: SessionConfig) => session(),
      ),
      isAvailable: vi.fn().mockResolvedValue(true),
    },
    continuations,
  };
}

describe('declared-output guard', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('continues the same session once when the first turn writes no artifact', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const runtime = new MockRuntime(
      { 'node-1': { artifact: [undefined, '# evidence'] } },
      { nodeResolver: (config) => config.nodeId ?? 'node-1' },
    );
    const nodeFn = agent({
      output: OUTPUT,
      requireOutput: true,
      promptBuilder: () => 'go',
      outputNudge: { backoffBaseMs: 1, backoffMaxMs: 1 },
    });
    const ctx = context(runtime);

    const result = await nodeFn(nodeInput(dir), ctx);

    expect(fs.readFileSync(path.join(dir, OUTPUT), 'utf-8')).toBe('# evidence');
    expect(result.metadata?.outputNudges).toBe(1);
    expect(result.metadata?.outputNudgeWritten).toBe(true);
    expect(ctx.emitOutput).toHaveBeenCalledWith(expect.objectContaining({
      type: 'node:output',
      content: expect.stringContaining('continuing the same session (nudge 1/2)'),
    }));
  });

  it('names the path and the nudge count when the guard is exhausted', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const runtime = new MockRuntime(
      { 'node-1': { artifact: undefined } },
      { nodeResolver: (config) => config.nodeId ?? 'node-1' },
    );
    const nodeFn = agent({
      output: OUTPUT,
      requireOutput: true,
      promptBuilder: () => 'go',
      outputNudge: { maxNudges: 2, backoffBaseMs: 1, backoffMaxMs: 1 },
    });

    await expect(nodeFn(nodeInput(dir), context(runtime))).rejects.toThrow(
      MissingRequiredOutputError,
    );
    await expect(nodeFn(nodeInput(dir), context(runtime))).rejects.toThrow(
      new RegExp(`'${OUTPUT}'.*after 2 in-session nudge\\(s\\)`, 's'),
    );
  });

  it('honours maxNudges and treats a whitespace-only write as a miss', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const runtime = new MockRuntime(
      { 'node-1': { artifact: ['   \n\t ', '# real'] } },
      { nodeResolver: (config) => config.nodeId ?? 'node-1' },
    );
    const nodeFn = agent({
      output: OUTPUT,
      requireOutput: true,
      promptBuilder: () => 'go',
      outputNudge: { maxNudges: 2, backoffBaseMs: 1, backoffMaxMs: 1 },
    });

    const result = await nodeFn(nodeInput(dir), context(runtime));

    expect(result.metadata?.outputNudges).toBe(1);
    expect(fs.readFileSync(path.join(dir, OUTPUT), 'utf-8')).toBe('# real');
  });

  it('sends no continuation when requireOutput is off', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const { runtime, continuations } = recordingRuntime({});
    const nodeFn = agent({
      output: OUTPUT,
      promptBuilder: () => 'go',
      outputNudge: { backoffBaseMs: 1, backoffMaxMs: 1 },
    });

    const result = await nodeFn(nodeInput(dir), context(runtime));

    expect(continuations).toEqual([]);
    expect(result.metadata?.outputNudges).toBeUndefined();
  });

  it('fails closed without continuing when the policy is disabled', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const { runtime, continuations } = recordingRuntime({});
    const nodeFn = agent({
      output: OUTPUT,
      requireOutput: true,
      promptBuilder: () => 'go',
      outputNudge: false,
    });

    // `outputNudge: false` turns the recovery off, not the requirement: the miss
    // stays terminal, which is the pre-guard behaviour.
    await expect(nodeFn(nodeInput(dir), context(runtime))).rejects.toThrow(
      MissingRequiredOutputError,
    );

    expect(continuations).toEqual([]);
  });

  it('fails loudly rather than silently when the runtime cannot continue a session', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const { runtime, continuations } = recordingRuntime({ hasContinueSession: false });
    const nodeFn = agent({
      output: OUTPUT,
      requireOutput: true,
      promptBuilder: () => 'go',
      outputNudge: { backoffBaseMs: 1, backoffMaxMs: 1 },
    });
    const ctx = context(runtime);

    await expect(nodeFn(nodeInput(dir), ctx)).rejects.toThrow(MissingRequiredOutputError);

    expect(continuations).toEqual([]);
    expect(ctx.emitOutput).toHaveBeenCalledWith(expect.objectContaining({
      type: 'node:output',
      content: expect.stringContaining("cannot continue the session (no continueSession)"),
    }));
  });

  it('reports the miss when the nudge turn itself fails', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const { runtime, continuations } = recordingRuntime({
      onContinue: () => {
        throw new Error('transport refused the continuation');
      },
    });
    const nodeFn = agent({
      output: OUTPUT,
      requireOutput: true,
      promptBuilder: () => 'go',
      outputNudge: { maxNudges: 3, backoffBaseMs: 1, backoffMaxMs: 1 },
    });

    await expect(nodeFn(nodeInput(dir), context(runtime))).rejects.toThrow(
      MissingRequiredOutputError,
    );
    // One attempt, then stop. A failed continuation is not retried as a nudge.
    expect(continuations).toHaveLength(1);
  });

  it('aborts out of a nudge instead of reporting the miss as a guard failure', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const controller = new AbortController();
    const runtime = new MockRuntime(
      { 'node-1': { artifact: undefined } },
      { nodeResolver: (config) => config.nodeId ?? 'node-1' },
    );
    const nodeFn = agent({
      output: OUTPUT,
      requireOutput: true,
      promptBuilder: () => 'go',
      outputNudge: { maxNudges: 2, backoffBaseMs: 200, backoffMaxMs: 200, jitter: false },
    });

    const pending = nodeFn(nodeInput(dir), context(runtime, controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(pending).rejects.toThrow(FlowAbortedError);
  });

  it('never re-creates or resumes a session to recover an artifact', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const { runtime, continuations } = recordingRuntime({});
    const nodeFn = agent({
      output: OUTPUT,
      requireOutput: true,
      promptBuilder: () => 'go',
      outputNudge: { maxNudges: 3, backoffBaseMs: 1, backoffMaxMs: 1 },
    });

    await expect(nodeFn(nodeInput(dir), context(runtime))).rejects.toThrow(
      MissingRequiredOutputError,
    );

    expect(continuations).toHaveLength(3);
    expect(runtime.createSession).toHaveBeenCalledOnce();
  });

  it('uses the caller-supplied nudge prompt when one is configured', async () => {
    const dir = createTmpDir();
    dirs.push(dir);
    const { runtime, continuations } = recordingRuntime({});
    const nodeFn = agent({
      output: OUTPUT,
      requireOutput: true,
      promptBuilder: () => 'go',
      outputNudge: {
        maxNudges: 1,
        backoffBaseMs: 1,
        backoffMaxMs: 1,
        prompt: ({ outputPath, attempt, maxNudges }) =>
          `apply_patch ${outputPath} (${attempt}/${maxNudges})`,
      },
    });

    await expect(nodeFn(nodeInput(dir), context(runtime))).rejects.toThrow(
      MissingRequiredOutputError,
    );

    expect(continuations).toEqual([`apply_patch ${OUTPUT} (1/1)`]);
  });

  it('hands the prompt the absolute path, so a consumer can name the file its tool will see', async () => {
    // The consumer supplies the prompt because it knows which tool performs the
    // write, and a tool needs the absolute path: the node's cwd can be a
    // checkout while the artifact lives in the execution directory.
    const dir = createTmpDir();
    dirs.push(dir);
    const { runtime, continuations } = recordingRuntime({});
    let seen: { outputPath: string; artifactPath: string } | null = null;
    const nodeFn = agent({
      output: OUTPUT,
      requireOutput: true,
      promptBuilder: () => 'go',
      outputNudge: {
        maxNudges: 1,
        backoffBaseMs: 1,
        backoffMaxMs: 1,
        prompt: ({ outputPath, artifactPath }) => {
          seen = { outputPath, artifactPath };
          return `write ${artifactPath}`;
        },
      },
    });

    await expect(nodeFn(nodeInput(dir), context(runtime))).rejects.toThrow(
      MissingRequiredOutputError,
    );

    expect(seen!.outputPath).toBe(OUTPUT);
    expect(path.isAbsolute(seen!.artifactPath)).toBe(true);
    expect(continuations).toEqual([`write ${path.join(dir, OUTPUT)}`]);
  });
});
