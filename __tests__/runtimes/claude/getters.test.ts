import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionConfig } from '../../../src/types';
import { ClaudeAgentSession } from '../../../runtimes/claude/claude-session';
import type { ClaudeQueryHandle, ClaudeSessionDeps } from '../../../runtimes/claude/claude-session';

const sdk = vi.hoisted(() => ({
  oneShotQueries: [] as Array<{ prompt: string; options: unknown }>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: (params: { prompt: string; options: unknown }) => {
      sdk.oneShotQueries.push(params);
      const frames: Record<string, unknown>[] = [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'handoff summary' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          duration_ms: 7,
          modelUsage: { m: { inputTokens: 3, outputTokens: 2 } },
        },
      ];
      return {
        async *[Symbol.asyncIterator]() {
          for (const frame of frames) yield frame as unknown as SDKMessage;
        },
        close: () => undefined,
      };
    },
  };
});

interface QueryCall {
  readonly prompt: string;
  readonly options: Options;
}

interface TranscriptMessage {
  uuid: string;
  type: string;
  message: Record<string, unknown>;
}

function config(extra: Partial<SessionConfig> = {}): SessionConfig {
  return {
    model: 'm',
    cwd: '/workspace',
    addDirs: [],
    timeout: 60_000,
    heartbeatTimeout: 60_000,
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
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
        output_tokens: 4,
      },
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
    modelUsage: {
      m: {
        inputTokens: 5,
        outputTokens: 4,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
      },
    },
    session_id: 's1',
    ...overrides,
  };
}

function handle(frames: readonly Record<string, unknown>[]): ClaudeQueryHandle {
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield frame as unknown as SDKMessage;
    },
  };
}

interface HarnessOptions {
  readonly config?: SessionConfig;
  readonly transcript?: TranscriptMessage[];
  readonly init?: Record<string, unknown>;
}

interface Harness {
  readonly session: ClaudeAgentSession;
  readonly calls: QueryCall[];
  readonly transcript: TranscriptMessage[];
  readonly forkCalls: Array<{ sessionId: string; options?: unknown }>;
}

function harness(options: HarnessOptions = {}): Harness {
  const calls: QueryCall[] = [];
  const transcript = options.transcript ?? [{
    uuid: 'u1',
    type: 'user',
    message: { role: 'user', content: 'hello' },
  }];
  const forkCalls: Array<{ sessionId: string; options?: unknown }> = [];

  const deps: ClaudeSessionDeps = {
    queryFn: (params) => {
      calls.push({ prompt: params.prompt, options: params.options });
      // A resumed turn reports the id it was asked to resume, so the fake
      // follows a post-truncate fork instead of failing the id check.
      const sessionId = typeof params.options.resume === 'string'
        ? params.options.resume
        : 's1';
      return handle([
        ...(options.init !== undefined
          ? [{ type: 'system', subtype: 'init', session_id: sessionId, ...options.init }]
          : []),
        assistantFrame('working', { session_id: sessionId }),
        resultFrame({ session_id: sessionId }),
      ]);
    },
    getSessionMessagesFn: async () => transcript as never,
    forkSessionFn: async (sessionId, forkOptions) => {
      forkCalls.push({ sessionId, options: forkOptions });
      return { sessionId: 's2' } as never;
    },
    sleepFn: async () => undefined,
  };

  return {
    session: new ClaudeAgentSession(options.config ?? config(), undefined, undefined, deps),
    calls,
    transcript,
    forkCalls,
  };
}

beforeEach(() => {
  sdk.oneShotQueries.length = 0;
});

describe('Claude session getters', () => {
  describe('history.truncate', () => {
    it('forks before the target message, adopts the new id, and resumes it', async () => {
      const { session, calls, forkCalls, transcript } = harness();
      await session.continueSession('first turn');
      expect(session.history).toBeDefined();

      transcript.length = 0;
      transcript.push(
        { uuid: 'u0', type: 'user', message: { role: 'user', content: 'one' } },
        { uuid: 'u1', type: 'assistant', message: { role: 'assistant', content: 'two' } },
        { uuid: 'u2', type: 'user', message: { role: 'user', content: 'three' } },
      );
      const removed = await session.history.truncate('u2');

      expect(removed).toBe(1);
      // `upToMessageId` is inclusive, so fork at the message before u2.
      expect(forkCalls).toEqual([{
        sessionId: 's1',
        options: { dir: '/workspace', upToMessageId: 'u1' },
      }]);

      transcript.push({
        uuid: 'u3',
        type: 'user',
        message: { role: 'user', content: 'four' },
      });
      await session.continueSession('after truncate');
      expect(calls.at(-1)?.options.resume).toBe('s2');
    });

    it('rejects an unknown event id and a session without a transcript id', async () => {
      const { session, transcript } = harness();
      await expect(session.history.truncate('u1'))
        .rejects.toThrow('has not produced a session id');

      await session.continueSession('first turn');
      transcript.length = 0;
      transcript.push({ uuid: 'u0', type: 'user', message: { content: 'one' } });
      await expect(session.history.truncate('missing'))
        .rejects.toThrow("Unknown history event 'missing'");
    });

    it('keeps the session when asked to drop the very first message', async () => {
      const { session, forkCalls, transcript } = harness();
      await session.continueSession('first turn');
      transcript.length = 0;
      transcript.push({ uuid: 'u0', type: 'user', message: { content: 'one' } });

      expect(await session.history.truncate('u0')).toBe(0);
      expect(forkCalls).toEqual([]);
    });
  });

  describe('history.summarizeForHandoff', () => {
    it('summarizes the extracted transcript through an isolated one-shot', async () => {
      const { session } = harness({
        transcript: [
          {
            uuid: 'u1',
            type: 'user',
            message: {
              role: 'user',
              content: [
                { type: 'text', text: 'build the thing' },
                { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
              ],
            },
          },
          {
            uuid: 'u2',
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'built it' }] },
          },
        ],
      });
      await session.continueSession('go');

      await expect(session.history.summarizeForHandoff()).resolves.toBe('handoff summary');

      expect(sdk.oneShotQueries).toHaveLength(1);
      const [query] = sdk.oneShotQueries;
      expect(query?.prompt).toContain('build the thing');
      expect(query?.prompt).toContain('assistant: built it');
      const options = query?.options as Record<string, unknown>;
      expect(options.settingSources).toEqual([]);
      expect(options.tools).toEqual([]);
      expect(options.mcpServers).toEqual({});
      expect(options.permissionMode).toBe('dontAsk');
    });

    it('falls back to token counts when there is no session id', async () => {
      const { session } = harness();
      await expect(session.history.summarizeForHandoff()).resolves.toBe(
        'Session (no id): no usage recorded.',
      );
      expect(sdk.oneShotQueries).toEqual([]);
    });
  });

  describe('metadata', () => {
    it('reports the latest prompt size as the current context', async () => {
      const { session } = harness();
      await expect(session.metadata.getContextAttribution()).resolves.toBeNull();

      await session.continueSession('turn');
      await expect(session.metadata.getContextAttribution()).resolves.toEqual({
        totalTokens: 8,
        entries: [{ kind: 'used', id: 'context', label: 'Context', tokens: 8 }],
        compactions: { count: 0 },
      });
      await expect(session.metadata.getContextHeaviestMessages()).resolves.toEqual({
        totalTokens: 8,
        messages: [],
      });
      await expect(session.metadata.recomputeContextTokens()).resolves.toEqual({
        totalTokens: 8,
        messagesTokenCount: 8,
        systemTokenCount: 0,
      });
    });

    it('counts compactions once per completed boundary', async () => {
      const calls: QueryCall[] = [];
      const deps: ClaudeSessionDeps = {
        queryFn: (params) => {
          calls.push({ prompt: params.prompt, options: params.options });
          return handle([
            assistantFrame('working'),
            {
              type: 'system',
              subtype: 'compact_boundary',
              session_id: 's1',
              compact_metadata: { trigger: 'auto', pre_tokens: 100, post_tokens: 20 },
            },
            {
              type: 'system',
              subtype: 'status',
              session_id: 's1',
              compact_result: 'success',
            },
            resultFrame(),
          ]);
        },
        getSessionMessagesFn: async () => [] as never,
        forkSessionFn: async () => ({ sessionId: 's2' }) as never,
        sleepFn: async () => undefined,
      };
      const session = new ClaudeAgentSession(config(), undefined, undefined, deps);
      await session.continueSession('turn');

      const attribution = await session.metadata.getContextAttribution();
      expect(attribution?.compactions).toEqual({ count: 1 });
    });
  });

  describe('requireMode', () => {
    it('accepts a matching init readback', async () => {
      const { session } = harness({
        config: config({ requireMode: true }),
        init: { permissionMode: 'bypassPermissions', tools: ['Bash', 'Read'] },
      });

      await expect(session.continueSession('turn')).resolves.toBeUndefined();
    });

    it('fails the turn when the CLI applied a different permission mode', async () => {
      const { session } = harness({
        config: config({ requireMode: true }),
        init: { permissionMode: 'default', tools: ['Read'] },
      });

      const error = await session.continueSession('turn').then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('ClaudeConfigurationError');
      expect((error as Error).message).toContain("'default'");
      expect((error as Error).message).toContain("'bypassPermissions'");
    });

    it('rejects built-in tools the required read-only policy forbids', async () => {
      const { session } = harness({
        config: config({ requireMode: true, permissionPolicy: 'read-only' }),
        init: { permissionMode: 'dontAsk', tools: ['Read', 'Grep', 'Glob', 'Bash'] },
      });

      const error = await session.continueSession('turn').then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect((error as Error).name).toBe('ClaudeConfigurationError');
      expect((error as Error).message).toContain('Bash');
      expect((error as Error).message).not.toContain('Read');
    });

    it('ignores MCP names when checking the read-only tool set', async () => {
      const { session } = harness({
        config: config({ requireMode: true, permissionPolicy: 'read-only' }),
        init: {
          permissionMode: 'dontAsk',
          tools: ['Read', 'Grep', 'Glob', 'mcp__search__find'],
        },
      });

      await expect(session.continueSession('turn')).resolves.toBeUndefined();
    });
  });

  describe('usage.getMetrics', () => {
    it('reports one bucket per billed model and the latest call tokens', async () => {
      const { session } = harness();
      const empty = await session.usage.getMetrics();
      expect(empty.modelMetrics.m).toEqual({
        requests: { count: 0, cost: 0 },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });

      await session.continueSession('turn');
      const metrics = await session.usage.getMetrics();
      expect(metrics.modelMetrics.m).toEqual({
        requests: { count: 1, cost: 0 },
        usage: {
          inputTokens: 8,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
      });
      expect(metrics.currentModel).toBe('m');
      expect(metrics.lastCallInputTokens).toBe(8);
      expect(metrics.lastCallOutputTokens).toBe(4);
      expect(metrics.totalUserRequests).toBe(1);
      expect(metrics.totalApiDurationMs).toBe(0);
    });

    it('counts requests per model instead of charging the session total to each', async () => {
      const calls: Options[] = [];
      const deps: ClaudeSessionDeps = {
        queryFn: (params) => {
          calls.push(params.options);
          const turn = calls.length;
          return handle([
            assistantFrame('working', {
              session_id: 's1',
              message: { model: turn === 1 ? 'a' : 'b', content: [], usage: {} },
            }),
            resultFrame({
              session_id: 's1',
              uuid: `r${turn}`,
              // Cumulative, as the SDK reports it: turn 2 still carries a's total.
              modelUsage: turn === 1
                ? { a: { inputTokens: 10, outputTokens: 1 } }
                : { a: { inputTokens: 10, outputTokens: 1 }, b: { inputTokens: 20, outputTokens: 2 } },
            }),
          ]);
        },
        getSessionMessagesFn: async () => [],
        forkSessionFn: async () => ({ sessionId: 's2' }),
        sleepFn: async () => undefined,
      };
      const session = new ClaudeAgentSession(config(), undefined, undefined, deps);

      await session.continueSession('one');
      await session.continueSession('two');

      const metrics = await session.usage.getMetrics();
      // Two turns ran, but neither model served both: reporting 2 against
      // each would claim requests that never happened.
      expect(metrics.modelMetrics.a?.requests.count).toBe(1);
      expect(metrics.modelMetrics.b?.requests.count).toBe(1);
      expect(metrics.totalUserRequests).toBe(2);
      expect(metrics.modelMetrics.b?.usage).toEqual({
        inputTokens: 20,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });
  });
});
