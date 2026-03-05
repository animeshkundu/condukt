import { describe, it, expect, vi } from 'vitest';
import { adaptCopilotBackend } from '../runtimes/copilot/copilot-adapter';
import type { CopilotBackend, CopilotSession } from '../runtimes/copilot/copilot-backend';

describe('adaptCopilotBackend', () => {
  function createMockBackend(overrides?: Partial<CopilotBackend>): CopilotBackend {
    return {
      name: 'test-backend',
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue(createMockSession()),
      ...overrides,
    };
  }

  function createMockSession(): CopilotSession {
    return {
      pid: 12345,
      send: vi.fn(),
      on: vi.fn(),
      abort: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('preserves the backend name', () => {
    const backend = createMockBackend();
    const runtime = adaptCopilotBackend(backend);
    expect(runtime.name).toBe('test-backend');
  });

  it('delegates isAvailable to backend', async () => {
    const backend = createMockBackend();
    const runtime = adaptCopilotBackend(backend);
    const result = await runtime.isAvailable();
    expect(result).toBe(true);
    expect(backend.isAvailable).toHaveBeenCalled();
  });

  it('maps SessionConfig and delegates createSession', async () => {
    const mockSession = createMockSession();
    const createSession = vi.fn().mockResolvedValue(mockSession);
    const backend = createMockBackend({ createSession });
    const runtime = adaptCopilotBackend(backend);

    const session = await runtime.createSession({
      model: 'claude-opus-4.6',
      cwd: '/test/dir',
      addDirs: ['/test/dir'],
      timeout: 3600,
      heartbeatTimeout: 120,
    });

    // Verify session is passed through
    expect(session.pid).toBe(12345);
    expect(session.send).toBeDefined();
    expect(session.on).toBeDefined();
    expect(session.abort).toBeDefined();

    // Verify createSession was called with mapped config
    expect(createSession).toHaveBeenCalledWith({
      model: 'claude-opus-4.6',
      cwd: '/test/dir',
      addDirs: ['/test/dir'],
      timeout: 3600,
      heartbeatTimeout: 120,
    });
  });

  it('session events work through the adapter', async () => {
    const handlers = new Map<string, Function>();
    const mockSession: CopilotSession = {
      pid: 999,
      send: vi.fn(),
      on: vi.fn((event: string, handler: Function) => {
        handlers.set(event, handler);
      }),
      abort: vi.fn().mockResolvedValue(undefined),
    };

    const backend = createMockBackend({
      createSession: vi.fn().mockResolvedValue(mockSession),
    });

    const runtime = adaptCopilotBackend(backend);
    const session = await runtime.createSession({
      model: 'test',
      cwd: '.',
      addDirs: [],
      timeout: 60,
      heartbeatTimeout: 10,
    });

    // Wire up event handlers
    const textHandler = vi.fn();
    session.on('text', textHandler);
    expect(mockSession.on).toHaveBeenCalledWith('text', textHandler);
  });

  it('handles unavailable backend', async () => {
    const backend = createMockBackend({
      isAvailable: vi.fn().mockResolvedValue(false),
    });
    const runtime = adaptCopilotBackend(backend);
    expect(await runtime.isAvailable()).toBe(false);
  });
});
