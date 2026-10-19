import { describe, it, expect } from 'vitest';
import { ClaudeAgentRuntime } from '../../../runtimes/claude/claude-runtime';

describe('claude getters', () => {
  it('metadata/usage/history defined', async () => {
    const r = new ClaudeAgentRuntime();
    const s: any = await r.createSession({ model: 'claude-sonnet-4-5', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1 } as any);
    expect(s.metadata).toBeDefined();
    expect(s.usage).toBeDefined();
    expect(s.history).toBeDefined();
    const attr = await s.metadata.getContextAttribution();
    expect(attr).toBeNull(); // no query run yet
    const metrics = await s.usage.getMetrics();
    expect(metrics.sessionStartTime).toBeTruthy();
    const summary = await s.history.summarizeForHandoff();
    expect(typeof summary).toBe('string');
  });
});
