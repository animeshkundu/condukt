import { describe, expect, it } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionConfig } from '../../../src/types';
import { ClaudeAgentSession } from '../../../runtimes/claude/claude-session';
import type { ClaudeQueryHandle, ClaudeSessionDeps } from '../../../runtimes/claude/claude-session';
import { CONDUKT_MCP_SERVER_NAME, INTERNAL_MCP_TOOL_NAMES } from '../../../runtimes/claude/one-shot';

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

function handle(): ClaudeQueryHandle {
  const frames: Record<string, unknown>[] = [
    { type: 'assistant', session_id: 's1', message: { model: 'm', content: [{ type: 'text', text: 'ok' }] } },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      uuid: 'r1',
      duration_ms: 1,
      usage: {},
      modelUsage: { m: { inputTokens: 1, outputTokens: 1 } },
      session_id: 's1',
    },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield frame as unknown as SDKMessage;
    },
  };
}

async function optionsFor(extra: Partial<SessionConfig>): Promise<Options> {
  const calls: Options[] = [];
  const deps: ClaudeSessionDeps = {
    queryFn: (params) => {
      calls.push(params.options);
      return handle();
    },
    getSessionMessagesFn: async () => [],
    forkSessionFn: async () => ({ sessionId: 's2' }),
    sleepFn: async () => undefined,
  };
  const session = new ClaudeAgentSession(config(extra), undefined, undefined, deps);
  await session.continueSession('go');
  const options = calls[0];
  if (options === undefined) throw new Error('no query was issued');
  return options;
}

describe('Claude session turn options', () => {
  it('allow-lists the internal advisor tools under dontAsk', async () => {
    const options = await optionsFor({
      permissionPolicy: 'read-only',
      advisor: { model: 'advisor-m' },
    });

    expect(options.permissionMode).toBe('dontAsk');
    expect(options.allowedTools).toEqual(expect.arrayContaining([...INTERNAL_MCP_TOOL_NAMES]));
    // The server is registered under the name those qualified names assume.
    expect(Object.keys(options.mcpServers ?? {})).toContain(CONDUKT_MCP_SERVER_NAME);
  });

  it('adds nothing when no internal server is registered', async () => {
    const options = await optionsFor({ permissionPolicy: 'read-only' });

    expect(options.permissionMode).toBe('dontAsk');
    expect(options.allowedTools ?? []).not.toEqual(expect.arrayContaining([...INTERNAL_MCP_TOOL_NAMES]));
    expect((options.mcpServers as Record<string, unknown> | undefined)?.[CONDUKT_MCP_SERVER_NAME])
      .toBeUndefined();
  });

  it('leaves the allow-list alone when permissions are bypassed', async () => {
    const options = await optionsFor({ advisor: { model: 'advisor-m' } });

    // bypassPermissions auto-approves everything, so no allow-list entry is
    // needed for the advisor and none is invented.
    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.allowedTools ?? []).not.toContain(INTERNAL_MCP_TOOL_NAMES[0]);
    expect(Object.keys(options.mcpServers ?? {})).toContain(CONDUKT_MCP_SERVER_NAME);
  });
});
