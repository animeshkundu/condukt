import { describe, it, expect, vi } from 'vitest';
import { adaptCopilotBackend } from '../runtimes/copilot/copilot-adapter';
import type { CopilotBackend, CopilotSession } from '../runtimes/copilot/copilot-backend';
import { SdkBackend } from '../runtimes/copilot/sdk-backend';

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

  it('forwards runtime capabilities without manufacturing them', () => {
    const capabilities = {
      readOnlyPermissions: true as const,
      requiredModeVerification: true as const,
      sessionRecovery: true as const,
    };
    const withCapabilities = adaptCopilotBackend(createMockBackend({ capabilities }));
    expect(withCapabilities.capabilities).toBe(capabilities);

    const withoutCapabilities = adaptCopilotBackend(createMockBackend());
    expect(withoutCapabilities).not.toHaveProperty('capabilities');
  });

  it('advertises same-session recovery from SdkBackend', () => {
    const runtime = adaptCopilotBackend(new SdkBackend());
    expect(runtime.capabilities?.sessionRecovery).toBe(true);
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
    expect(createSession).toHaveBeenCalledWith(
      {
        model: 'claude-opus-4.6',
        cwd: '/test/dir',
        addDirs: ['/test/dir'],
        timeout: 3600,
        heartbeatTimeout: 120,
      },
      undefined,
    );
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

  it('forwards mode, systemMessage, tool filters, contextTier, and subagent config to the backend', async () => {
    const createSession = vi.fn().mockResolvedValue(createMockSession());
    const backend = createMockBackend({ createSession });
    const runtime = adaptCopilotBackend(backend);

    await runtime.createSession({
      model: 'gpt-5.6-sol',
      cwd: '/test/dir',
      addDirs: ['/test/dir'],
      timeout: 3600,
      heartbeatTimeout: 120,
      contextTier: 'long_context',
      mode: 'plan',
      permissionPolicy: 'read-only',
      requireMode: true,
      advisor: { model: 'advisor-model', thinkingBudget: 'high' },
      standIn: { memberCount: 3, thinkingBudget: 'high' },
      mcpServers: { browser: { command: 'browser-mcp' } },
      systemMessage: 'You are a reviewer. Respond with JSON.',
      availableTools: ['view', 'glob'],
      excludedTools: ['apply_patch'],
      customAgents: [{
        name: 'reviewer',
        displayName: 'Reviewer',
        description: 'Reviews code',
        tools: ['builtin:*'],
        prompt: 'Find defects.',
        mcpServers: { local: { type: 'local', command: 'server' } },
        infer: true,
        skills: ['review'],
        model: 'fast-model',
      }],
      subagentRoster: {
        explore: { model: 'gemini-3.6-flash', contextTier: 'long_context' },
      },
      subagentsEnabled: true,
      maxDepth: 1,
      maxConcurrency: 2,
      defaultAgent: { excludedTools: ['task'] },
      excludedBuiltinAgents: ['explore'],
      sessionRecovery: { maxContinuations: 23, jitter: false },
    });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        contextTier: 'long_context',
        mode: 'plan',
        permissionPolicy: 'read-only',
        requireMode: true,
        advisor: { model: 'advisor-model', thinkingBudget: 'high' },
        mcpServers: { browser: { command: 'browser-mcp' } },
        systemMessage: 'You are a reviewer. Respond with JSON.',
        availableTools: ['view', 'glob'],
        excludedTools: ['apply_patch'],
        customAgents: [expect.objectContaining({ name: 'reviewer', model: 'fast-model' })],
        subagentRoster: {
          explore: { model: 'gemini-3.6-flash', contextTier: 'long_context' },
        },
        subagentsEnabled: true,
        maxDepth: 1,
        maxConcurrency: 2,
        defaultAgent: { excludedTools: ['task'] },
        excludedBuiltinAgents: ['explore'],
        sessionRecovery: { maxContinuations: 23, jitter: false },
      }),
      undefined,
    );
  });

  it('omits optional subagent fields when unset', async () => {
    const createSession = vi.fn().mockResolvedValue(createMockSession());
    const runtime = adaptCopilotBackend(createMockBackend({ createSession }));

    await runtime.createSession({
      model: 'test-model',
      cwd: '/test/dir',
      addDirs: [],
      timeout: 60,
      heartbeatTimeout: 10,
    });

    const forwarded = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty('compactionMode');
    expect(forwarded).not.toHaveProperty('mode');
    expect(forwarded).not.toHaveProperty('permissionPolicy');
    expect(forwarded).not.toHaveProperty('requireMode');
    expect(forwarded).not.toHaveProperty('customAgents');
    expect(forwarded).not.toHaveProperty('subagentRoster');
    expect(forwarded).not.toHaveProperty('subagentsEnabled');
    expect(forwarded).not.toHaveProperty('maxDepth');
    expect(forwarded).not.toHaveProperty('maxConcurrency');
    expect(forwarded).not.toHaveProperty('defaultAgent');
    expect(forwarded).not.toHaveProperty('excludedBuiltinAgents');
    expect(forwarded).not.toHaveProperty('sessionRecovery');
  });

  it('handles unavailable backend', async () => {
    const backend = createMockBackend({
      isAvailable: vi.fn().mockResolvedValue(false),
    });
    const runtime = adaptCopilotBackend(backend);
    expect(await runtime.isAvailable()).toBe(false);
  });
});
