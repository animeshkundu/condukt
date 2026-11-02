import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntime,
  AgentSession,
  RuntimeCapabilities,
  SessionConfig,
} from '../../../src/types';
import { ClaudeAgentRuntime, createClaudeRuntime } from '../../../runtimes/claude/claude-runtime';
import { FallbackRuntime, createFallbackRuntime } from '../../../runtimes/claude/fallback-runtime';

function config(extra: Partial<SessionConfig> = {}): SessionConfig {
  return {
    model: 'claude-sonnet-4-5',
    cwd: '/tmp',
    addDirs: [],
    timeout: 1,
    heartbeatTimeout: 1,
    ...extra,
  };
}

const stubSession = {
  pid: null,
  send: () => undefined,
  on: () => undefined,
  abort: async () => undefined,
} as unknown as AgentSession;

function fakeRuntime(
  name: string,
  available: boolean,
  capabilities?: RuntimeCapabilities,
): AgentRuntime {
  return {
    name,
    isAvailable: async () => available,
    createSession: async () => stubSession,
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
}

describe('claude runtime', () => {
  it('is available and advertises its guarantees', async () => {
    const runtime = createClaudeRuntime();
    expect(await runtime.isAvailable()).toBe(true);
    expect(runtime.name).toBe('claude');
    const claude = runtime as ClaudeAgentRuntime;
    expect(claude.capabilities).toEqual({
      readOnlyPermissions: true,
      requiredModeVerification: true,
      sessionRecovery: true,
    });
  });

  it('createSession returns a full session surface', async () => {
    const runtime = new ClaudeAgentRuntime();
    const session = await runtime.createSession(config());
    expect(typeof session.send).toBe('function');
    expect(typeof session.continueSession).toBe('function');
    expect(typeof session.abort).toBe('function');
    expect(session.history).toBeDefined();
    expect(session.metadata).toBeDefined();
    expect(session.usage).toBeDefined();
    await session.abort();
  });

  it('fallback prefers copilot when available', async () => {
    const copilot = fakeRuntime('copilot', true);
    const fallback = createFallbackRuntime(copilot);
    expect(await fallback.isAvailable()).toBe(true);
    const session = await fallback.createSession(config({ model: 'm' }));
    expect(session).toBe(stubSession);
  });

  it('fallback uses claude when copilot is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const copilot = fakeRuntime('copilot', false);
    const fallback = createFallbackRuntime(copilot);
    const session = await fallback.createSession(config({ model: 'm' }));
    expect(session).not.toBe(stubSession);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to Claude'));
    warn.mockRestore();
    await session.abort();
  });

  it('fallback advertises the copilot capabilities when copilot is configured', () => {
    const copilot = fakeRuntime('copilot', true, {
      readOnlyPermissions: true,
      requiredModeVerification: true,
      sessionRecovery: true,
    });
    expect(new FallbackRuntime(copilot).capabilities).toEqual(copilot.capabilities);
  });

  it('fallback advertises the claude capabilities without a copilot', () => {
    const fallback = createFallbackRuntime(null) as FallbackRuntime;
    expect(fallback.capabilities).toEqual({
      readOnlyPermissions: true,
      requiredModeVerification: true,
      sessionRecovery: true,
    });
  });
});
