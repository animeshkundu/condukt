import { describe, it, expect } from 'vitest';
import { ClaudeAgentRuntime, createClaudeRuntime } from '../../../runtimes/claude/claude-runtime';
import { FallbackRuntime, createFallbackRuntime } from '../../../runtimes/claude/fallback-runtime';

describe('claude runtime', () => {
  it('is available (sdk installed)', async () => {
    const r = createClaudeRuntime();
    expect(await r.isAvailable()).toBe(true);
    expect(r.name).toBe('claude');
  });
  it('createSession returns session with send/abort', async () => {
    const r = createClaudeRuntime();
    const s = await r.createSession({ model: 'claude-sonnet-4-5', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1 } as any);
    expect(typeof s.send).toBe('function');
    expect(typeof s.abort).toBe('function');
    await s.abort();
  });
  it('fallback prefers copilot when available', async () => {
    const copilot = { name: 'copilot', isAvailable: async () => true, createSession: async () => ({ pid: null, send() {}, abort: async () => {}, on() {} }) } as any;
    const f = createFallbackRuntime(copilot);
    expect(await f.isAvailable()).toBe(true);
    const s = await f.createSession({ model: 'm', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1 } as any);
    expect(s).toBeDefined();
  });
  it('fallback uses claude when copilot unavailable', async () => {
    const copilot = { name: 'copilot', isAvailable: async () => false, createSession: async () => { throw new Error('no'); } } as any;
    const f = createFallbackRuntime(copilot);
    const s = await f.createSession({ model: 'm', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1 } as any);
    expect(s).toBeDefined();
  });
});
