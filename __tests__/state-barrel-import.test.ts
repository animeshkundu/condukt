import { describe, it, expect } from 'vitest';

describe('state barrel split', () => {
  it('state barrel does not export FileStorage', async () => {
    // Dynamic import to test the actual barrel
    const stateExports = await import('../state/index');
    expect('FileStorage' in stateExports).toBe(false);
    expect(stateExports.StateRuntime).toBeDefined();
    expect(stateExports.MemoryStorage).toBeDefined();
    expect(stateExports.reduce).toBeDefined();
  });

  it('state/server exports FileStorage', async () => {
    const serverExports = await import('../state/server');
    expect(serverExports.FileStorage).toBeDefined();
  });
});
