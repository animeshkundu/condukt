import { describe, it, expect } from 'vitest';
import { buildAdvisorStandInServer } from '../../../runtimes/claude/one-shot';

describe('one-shot', () => {
  it('returns null when no advisor/standin', () => {
    const s = buildAdvisorStandInServer({ config: { model: 'm', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1 } as any, cwd: '/tmp', onToolUsage: () => {} });
    expect(s).toBeNull();
  });
  it('builds server with advisor', () => {
    const s = buildAdvisorStandInServer({ config: { model: 'm', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1, advisor: { model: 'advisor-m' } } as any, cwd: '/tmp', onToolUsage: () => {} });
    expect(s).not.toBeNull();
  });
  it('builds server with standin members', () => {
    const s = buildAdvisorStandInServer({ config: { model: 'm', cwd: '/tmp', addDirs: [], timeout: 1, heartbeatTimeout: 1, standIn: { members: ['a','b'] } } as any, cwd: '/tmp', onToolUsage: () => {} });
    expect(s).not.toBeNull();
  });
});
