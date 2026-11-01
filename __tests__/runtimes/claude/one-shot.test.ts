import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionConfig, ToolUsageData } from '../../../src/types';
import {
  buildAdvisorStandInServer,
  CONDUKT_MCP_SERVER_NAME,
  INTERNAL_MCP_TOOL_NAMES,
  runOneShot,
} from '../../../runtimes/claude/one-shot';

const sdk = vi.hoisted(() => ({
  queries: [] as Array<{ prompt: string; options: Record<string, unknown> }>,
  frames: [] as Record<string, unknown>[],
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  const query = (params: { prompt: string; options: Record<string, unknown> }) => {
    sdk.queries.push(params);
    return {
      async *[Symbol.asyncIterator]() {
        for (const frame of sdk.frames) yield frame as unknown as SDKMessage;
      },
      close: () => undefined,
    };
  };
  const createSdkMcpServer = (options: { name: string; tools?: readonly unknown[] }) => ({
    type: 'sdk' as const,
    name: options.name,
    instance: {},
    // Exposed so tests can invoke a handler directly instead of driving the
    // MCP transport; the real server hides them behind the protocol.
    tools: options.tools,
  });
  return {
    ...actual,
    query: query as unknown as typeof actual.query,
    createSdkMcpServer: createSdkMcpServer as unknown as typeof actual.createSdkMcpServer,
  };
});

function config(extra: Partial<SessionConfig> = {}): SessionConfig {
  return {
    model: 'm',
    cwd: '/workspace',
    addDirs: [],
    timeout: 1,
    heartbeatTimeout: 1,
    ...extra,
  };
}

function assistantFrame(text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  };
}

function resultFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    duration_ms: 42,
    modelUsage: {
      m: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
      },
    },
    ...overrides,
  };
}

interface ServerTool {
  readonly name: string;
  readonly handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function toolsOf(server: unknown): ServerTool[] {
  return (server as { tools: ServerTool[] }).tools;
}

const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'fake' };

beforeEach(() => {
  sdk.queries.length = 0;
  sdk.frames = [assistantFrame('answer'), resultFrame()];
});

describe('one-shot', () => {
  it('runs isolated and forwards the bridge environment', async () => {
    const result = await runOneShot({
      model: 'm',
      prompt: 'p',
      cwd: '/workspace',
      system: 'you are an advisor',
      env,
    });

    expect(result).toEqual({
      text: 'answer',
      usages: [{
        inputTokens: 13,
        outputTokens: 5,
        totalTokens: 18,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        model: 'm',
        duration: 42,
      }],
      model: 'm',
    });
    expect(sdk.queries).toHaveLength(1);
    const options = sdk.queries[0]?.options ?? {};
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.allowDangerouslySkipPermissions).toBe(false);
    expect(options.tools).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.settingSources).toEqual([]);
    expect(options.systemPrompt).toBe('you are an advisor');
    const passedEnv = options.env as Record<string, string>;
    expect(passedEnv.ANTHROPIC_BASE_URL).toBe(env.ANTHROPIC_BASE_URL);
    expect(passedEnv.ANTHROPIC_API_KEY).toBe(env.ANTHROPIC_API_KEY);
    // The SDK replaces the child environment, so the CLI still needs PATH.
    expect(passedEnv.PATH).toBe(process.env.PATH);
  });

  it('falls back to the result text and skips zero-usage models', async () => {
    sdk.frames = [resultFrame({
      result: 'from result',
      modelUsage: { m: { inputTokens: 0, outputTokens: 0 } },
    })];

    const result = await runOneShot({ model: 'm', prompt: 'p', cwd: '/workspace' });

    expect(result.text).toBe('from result');
    expect(result.usages).toEqual([]);
  });

  it('does not start a query after its signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runOneShot({
      model: 'm',
      prompt: 'p',
      cwd: '/workspace',
      signal: controller.signal,
    });

    expect(result).toEqual({ text: '', usages: [], model: 'm' });
    expect(sdk.queries).toHaveLength(0);
  });

  it('forwards session cancellation into advisor one-shots', async () => {
    const usages: ToolUsageData[] = [];
    const controller = new AbortController();
    const server = buildAdvisorStandInServer({
      config: config({ advisor: { model: 'advisor-m' } }),
      cwd: '/workspace',
      signal: controller.signal,
      onToolUsage: (data) => usages.push(data),
    });

    const [advisor] = toolsOf(server);
    controller.abort();
    const response = await advisor?.handler({ question: 'q' }, {});

    // A stopped run must not keep billing an upstream.
    expect(response?.content[0]?.text).toBe('');
    expect(sdk.queries).toHaveLength(0);
    expect(usages).toHaveLength(1);
    expect(usages[0]?.usages).toEqual([]);
  });

  it('names the internal server and its qualified tools consistently', () => {
    expect(CONDUKT_MCP_SERVER_NAME).toBe('condukt');
    expect(INTERNAL_MCP_TOOL_NAMES).toEqual(['mcp__condukt__advisor', 'mcp__condukt__stand_in']);
  });

  it('returns null without an advisor or stand-in', () => {
    expect(buildAdvisorStandInServer({
      config: config(),
      cwd: '/workspace',
      onToolUsage: () => undefined,
    })).toBeNull();
  });

  it('forwards the bridge environment to advisor one-shots', async () => {
    const usages: ToolUsageData[] = [];
    const server = buildAdvisorStandInServer({
      config: config({ advisor: { model: 'advisor-m', system: 'be sharp' } }),
      cwd: '/workspace',
      env,
      onToolUsage: (data) => usages.push(data),
    });
    expect(server).not.toBeNull();

    const [advisor] = toolsOf(server);
    expect(advisor?.name).toBe('advisor');
    const response = await advisor?.handler(
      { question: 'Is it correct?', transcript: 'we did things' },
      {},
    );

    expect(response?.content[0]?.text).toBe('answer');
    const query = sdk.queries.at(-1);
    expect(query?.prompt).toContain('be sharp');
    expect(query?.prompt).toContain('Question: Is it correct?');
    expect(query?.prompt).toContain('Transcript:\nwe did things');
    expect((query?.options.env as Record<string, string>).ANTHROPIC_BASE_URL)
      .toBe(env.ANTHROPIC_BASE_URL);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      tool: 'advisor',
      model: 'advisor-m',
      usages: [{ inputTokens: 13, outputTokens: 5 }],
    });
    expect(usages[0]?.sectionSizes?.promptChars).toBeGreaterThan(0);
  });

  it('runs one isolated query per stand-in member and merges their usage', async () => {
    const usages: ToolUsageData[] = [];
    const server = buildAdvisorStandInServer({
      config: config({ standIn: { members: ['a', 'b'] } }),
      cwd: '/workspace',
      env,
      onToolUsage: (data) => usages.push(data),
    });
    expect(server).not.toBeNull();

    const [standIn] = toolsOf(server);
    expect(standIn?.name).toBe('stand_in');
    const response = await standIn?.handler({ question: 'Vote?' }, {});

    expect(sdk.queries).toHaveLength(2);
    expect(sdk.queries.map((query) => query.options.model)).toEqual(['a', 'b']);
    for (const query of sdk.queries) {
      expect((query.options.env as Record<string, string>).ANTHROPIC_BASE_URL)
        .toBe(env.ANTHROPIC_BASE_URL);
    }
    expect(response?.content[0]?.text).toBe('answer\n---\nanswer');
    expect(usages[0]).toMatchObject({ tool: 'stand_in', model: 'a,b' });
    expect(usages[0]?.usages).toHaveLength(2);
  });

  it('disables stand_in when members and memberCount are both set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = buildAdvisorStandInServer({
      config: config({ standIn: { members: ['a'], memberCount: 3 } }),
      cwd: '/workspace',
      onToolUsage: () => undefined,
    });
    expect(server).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('members or memberCount'));
    warn.mockRestore();
  });
});
