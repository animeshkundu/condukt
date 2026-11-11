import { describe, expect, it } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionConfig } from '../../../src/types';
import { SessionRecoveryExhaustedError } from '../../../src/types';
import { ClaudeAgentSession } from '../../../runtimes/claude/claude-session';
import type {
  ClaudeQueryHandle,
  ClaudeSessionDeps,
} from '../../../runtimes/claude/claude-session';
import { CONTINUATION_PROMPT } from '../../../runtimes/claude/session-recovery';

interface QueryCall {
  readonly prompt: string;
  readonly options: Options;
}

interface RecordedEvent {
  readonly event: string;
  readonly args: readonly unknown[];
}

type QueryScript = (params: { readonly prompt: string; readonly options: Options }) => ClaudeQueryHandle;

function config(extra: Partial<SessionConfig> = {}): SessionConfig {
  return {
    model: 'm',
    cwd: '/workspace',
    addDirs: [],
    timeout: 60_000,
    heartbeatTimeout: 60_000,
    sessionRecovery: {
      maxContinuations: 2,
      budgetMs: 60_000,
      backoffBaseMs: 100,
      backoffMaxMs: 100,
      jitter: false,
      nativeRetryGraceMs: 0,
    },
    ...extra,
  };
}

function assistantFrame(
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: 's1',
    message: {
      model: 'm',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    ...extra,
  };
}

function resultFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    uuid: 'r1',
    num_turns: 1,
    duration_ms: 1,
    usage: {},
    modelUsage: {},
    session_id: 's1',
    ...overrides,
  };
}

const TRANSIENT_FAILURE = resultFrame({
  subtype: 'error_during_execution',
  is_error: true,
  errors: ['rate limited'],
  terminal_reason: 'api_error',
  uuid: 'rfail',
});

function handle(frames: readonly Record<string, unknown>[]): ClaudeQueryHandle {
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield frame as unknown as SDKMessage;
    },
  };
}

function turn(...frames: readonly Record<string, unknown>[]): QueryScript {
  return () => handle(frames);
}

interface Harness {
  readonly session: ClaudeAgentSession;
  readonly calls: QueryCall[];
  readonly events: RecordedEvent[];
  readonly sleeps: number[];
}

function harness(
  scripts: readonly QueryScript[],
  options: {
    readonly config?: SessionConfig;
    readonly transcript?: readonly Record<string, unknown>[];
    readonly onSleep?: (ms: number, session: ClaudeAgentSession) => Promise<void>;
  } = {},
): Harness {
  const calls: QueryCall[] = [];
  const events: RecordedEvent[] = [];
  const sleeps: number[] = [];
  let index = 0;

  const deps: ClaudeSessionDeps = {
    queryFn: (params) => {
      calls.push({ prompt: params.prompt, options: params.options });
      const script = scripts[index];
      index += 1;
      if (script === undefined) throw new Error('unexpected extra query call');
      return script(params);
    },
    getSessionMessagesFn: async () => (options.transcript ?? [{
      uuid: 'u1',
      type: 'user',
      message: { role: 'user', content: 'hi' },
    }]) as never,
    forkSessionFn: async () => {
      throw new Error('fork not expected');
    },
    sleepFn: async (ms) => {
      sleeps.push(ms);
      if (options.onSleep) await options.onSleep(ms, session);
    },
  };

  const session = new ClaudeAgentSession(
    options.config ?? config(),
    undefined,
    undefined,
    deps,
  );
  for (const event of ['recovery', 'idle', 'error', 'text']) {
    session.on(event, (...args: unknown[]) => {
      events.push({ event, args });
    });
  }
  return { session, calls, events, sleeps };
}

function phases(events: readonly RecordedEvent[]): string[] {
  return events
    .filter((entry) => entry.event === 'recovery')
    .map((entry) => (entry.args[0] as { phase: string }).phase);
}

function recoveryEvents(events: readonly RecordedEvent[]): Record<string, unknown>[] {
  return events
    .filter((entry) => entry.event === 'recovery')
    .map((entry) => entry.args[0] as Record<string, unknown>);
}

describe('Claude same-session recovery', () => {
  it('resumes the failed session and nudges it with the continuation prompt', async () => {
    const { session, calls, events } = harness([
      turn(
        assistantFrame('working'),
        resultFrame(TRANSIENT_FAILURE),
      ),
      turn(
        assistantFrame('done', { uuid: 'ra' }),
        resultFrame(),
      ),
    ]);

    await session.continueSession('do the task');

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe('do the task');
    expect(calls[0]?.options.resume).toBeUndefined();
    expect(calls[1]?.prompt).toBe(CONTINUATION_PROMPT);
    expect(calls[1]?.options.resume).toBe('s1');
    expect(phases(events)).toEqual(['scheduled', 'resuming', 'continuation-sent', 'recovered']);
    const [scheduled, resuming, sent, recovered] = recoveryEvents(events);
    expect(scheduled).toMatchObject({
      continuation: 1,
      maxContinuations: 2,
      sessionId: 's1',
      delayMs: 100,
      errorCode: 'api_error',
    });
    expect(resuming).toMatchObject({ continuation: 1, sessionId: 's1' });
    expect(sent).toMatchObject({ continuation: 1, sessionId: 's1' });
    expect(recovered).toMatchObject({ continuation: 1, sessionId: 's1' });
    expect(events.filter((entry) => entry.event === 'idle')).toHaveLength(1);
    expect(events.filter((entry) => entry.event === 'error')).toHaveLength(0);
  });

  it('exhausts after the continuation limit and names the stage', async () => {
    const { session, calls, events } = harness([
      turn(assistantFrame('working'), resultFrame(TRANSIENT_FAILURE)),
      turn(assistantFrame('again'), resultFrame({ ...TRANSIENT_FAILURE, uuid: 'rf1' })),
      turn(assistantFrame('again'), resultFrame({ ...TRANSIENT_FAILURE, uuid: 'rf2' })),
    ]);

    const error = await session.continueSession('do the task').then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(SessionRecoveryExhaustedError);
    expect(calls).toHaveLength(3);
    const exhausted = recoveryEvents(events).at(-1);
    expect(exhausted).toMatchObject({
      phase: 'exhausted',
      continuation: 2,
      maxContinuations: 2,
      stage: 'continuation',
      reason: 'continuation limit exhausted',
    });
    expect(phases(events)).toEqual([
      'scheduled', 'resuming', 'continuation-sent',
      'scheduled', 'resuming', 'continuation-sent',
      'exhausted',
    ]);
    expect(events.filter((entry) => entry.event === 'error')).toHaveLength(1);
    expect(events.some((entry) => entry.event === 'idle')).toBe(false);
  });

  it('exhausts after three consecutive rate-limit failures before the continuation limit', async () => {
    const rateLimited = (uuid: string) => resultFrame({
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['rate limited'],
      terminal_reason: 'api_error',
      api_error_status: 429,
      uuid,
    });
    const { session, calls, events } = harness([
      turn(assistantFrame('working'), rateLimited('r0')),
      turn(assistantFrame('again'), rateLimited('r1')),
      turn(assistantFrame('again'), rateLimited('r2')),
    ], {
      config: config({
        sessionRecovery: {
          maxContinuations: 5,
          maxConsecutiveRateLimits: 3,
          budgetMs: 60_000,
          backoffBaseMs: 100,
          backoffMaxMs: 100,
          jitter: false,
          nativeRetryGraceMs: 0,
        },
      }),
    });

    const error = await session.continueSession('do the task').then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(SessionRecoveryExhaustedError);
    expect(calls).toHaveLength(3);
    const exhausted = recoveryEvents(events).at(-1);
    expect(exhausted).toMatchObject({
      phase: 'exhausted',
      continuation: 2,
      stage: 'continuation',
      statusCode: 429,
      reason: '3 consecutive rate-limit (429) failures',
    });
  });

  it('resets the rate-limit streak after a different recoverable failure', async () => {
    const failed = (uuid: string, status: number) => resultFrame({
      subtype: 'error_during_execution',
      is_error: true,
      errors: [status === 429 ? 'rate limited' : 'server error'],
      terminal_reason: 'api_error',
      api_error_status: status,
      uuid,
    });
    const { session, calls, events } = harness([
      turn(assistantFrame('working'), failed('r0', 429)),
      turn(assistantFrame('again'), failed('r1', 500)),
      turn(assistantFrame('again'), failed('r2', 429)),
      turn(assistantFrame('again'), failed('r3', 429)),
    ], {
      config: config({
        sessionRecovery: {
          maxContinuations: 3,
          maxConsecutiveRateLimits: 2,
          budgetMs: 60_000,
          backoffBaseMs: 100,
          backoffMaxMs: 100,
          jitter: false,
          nativeRetryGraceMs: 0,
        },
      }),
    });

    const error = await session.continueSession('do the task').then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(SessionRecoveryExhaustedError);
    expect(calls).toHaveLength(4);
    const exhausted = recoveryEvents(events).at(-1);
    expect(exhausted).toMatchObject({
      phase: 'exhausted',
      continuation: 3,
      stage: 'continuation',
      reason: '2 consecutive rate-limit (429) failures',
    });
  });

  it('fails fast on a non-recoverable result without resuming', async () => {
    const { session, calls, events } = harness([
      turn(
        assistantFrame('working'),
        resultFrame({
          subtype: 'error_max_turns',
          is_error: true,
          errors: ['max turns reached'],
        }),
      ),
    ]);

    const error = await session.continueSession('do the task').then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('max turns reached');
    expect((error as Error).name).toBe('ClaudeResultError');
    expect(calls).toHaveLength(1);
    expect(phases(events)).toEqual([]);
    expect(events.filter((entry) => entry.event === 'error')).toHaveLength(1);
  });

  it('gives an SDK-native retry its grace window before resuming', async () => {
    const { session, calls, events, sleeps } = harness([
      turn(
        assistantFrame('working'),
        {
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          max_retries: 5,
          retry_delay_ms: 250,
          error_status: 429,
          error: 'rate limited',
          session_id: 's1',
        },
        resultFrame(TRANSIENT_FAILURE),
      ),
      turn(assistantFrame('done'), resultFrame()),
    ], {
      config: config({
        sessionRecovery: {
          maxContinuations: 2,
          budgetMs: 60_000,
          backoffBaseMs: 100,
          backoffMaxMs: 100,
          jitter: false,
          nativeRetryGraceMs: 500,
        },
      }),
    });

    await session.continueSession('do the task');

    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([500, 100]);
    expect(phases(events)).toEqual([
      'native-retry', 'scheduled', 'resuming', 'continuation-sent', 'recovered',
    ]);
    expect(recoveryEvents(events)[0]).toMatchObject({
      phase: 'native-retry',
      continuation: 0,
      statusCode: 429,
      errorCode: 'rate limited',
      reason: 'native retry 2/5 did not recover',
    });
  });

  it('treats a resumed session with a different id as fatal', async () => {
    const { session, calls, events } = harness([
      turn(assistantFrame('working'), resultFrame(TRANSIENT_FAILURE)),
      turn(
        assistantFrame('wrong session', { session_id: 'other' }),
        resultFrame({ session_id: 'other' }),
      ),
    ]);

    const error = await session.continueSession('do the task').then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(SessionRecoveryExhaustedError);
    const exhausted = recoveryEvents(events).at(-1);
    expect(exhausted).toMatchObject({
      phase: 'exhausted',
      stage: 'resume',
      continuation: 1,
    });
    expect(String(exhausted?.reason)).toContain('resumed unexpected session');
    expect(calls).toHaveLength(2);
    expect(events.some((entry) => entry.event === 'idle')).toBe(false);
  });

  it('ends recovery with the audit stage when the transcript is empty', async () => {
    const { session, calls, events } = harness([
      turn(assistantFrame('working'), resultFrame(TRANSIENT_FAILURE)),
    ], {
      config: config({
        sessionRecovery: {
          maxContinuations: 1,
          budgetMs: 60_000,
          backoffBaseMs: 100,
          backoffMaxMs: 100,
          jitter: false,
          nativeRetryGraceMs: 0,
        },
      }),
      transcript: [],
    });

    const error = await session.continueSession('do the task').then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(SessionRecoveryExhaustedError);
    expect(calls).toHaveLength(1);
    const exhausted = recoveryEvents(events).at(-1);
    expect(exhausted).toMatchObject({ phase: 'exhausted', stage: 'audit', continuation: 1 });
    expect(String(exhausted?.reason)).toContain('No transcript found');
  });

  it('reconnects and nudges again after a failed resume attempt', async () => {
    const { session, calls, events } = harness([
      turn(assistantFrame('working'), resultFrame(TRANSIENT_FAILURE)),
      () => { throw new Error('socket hang up'); },
      turn(assistantFrame('done'), resultFrame()),
    ]);

    await session.continueSession('do the task');

    expect(calls.map((call) => call.prompt)).toEqual([
      'do the task',
      CONTINUATION_PROMPT,
      CONTINUATION_PROMPT,
    ]);
    expect(phases(events)).toEqual([
      'scheduled', 'resuming',
      'scheduled', 'resuming', 'continuation-sent', 'recovered',
    ]);
    expect(calls[2]?.options.resume).toBe('s1');
  });

  it('recovers when the first stream ends without a result', async () => {
    const { session, calls, events } = harness([
      turn(assistantFrame('working')),
      turn(assistantFrame('done'), resultFrame()),
    ]);

    await session.continueSession('do the task');

    expect(calls).toHaveLength(2);
    expect(phases(events)).toContain('recovered');
  });

  it('does not recover when the caller disabled the policy', async () => {
    const { session, calls, events } = harness([
      turn(assistantFrame('working'), resultFrame(TRANSIENT_FAILURE)),
    ], {
      config: config({ sessionRecovery: false }),
    });

    const error = await session.continueSession('do the task').then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('rate limited');
    expect(calls).toHaveLength(1);
    expect(phases(events)).toEqual([]);
    expect(events.filter((entry) => entry.event === 'error')).toHaveLength(1);
  });

  it('stops the recovery loop on abort', async () => {
    const { session, calls, events } = harness([
      turn(assistantFrame('working'), resultFrame(TRANSIENT_FAILURE)),
    ], {
      onSleep: async (_ms, current) => {
        await current.abort();
      },
    });

    await session.continueSession('do the task');

    expect(calls).toHaveLength(1);
    expect(phases(events)).toEqual(['scheduled']);
    expect(events.some((entry) => entry.event === 'idle')).toBe(false);
    expect(events.some((entry) => entry.event === 'error')).toBe(false);
  });
});
