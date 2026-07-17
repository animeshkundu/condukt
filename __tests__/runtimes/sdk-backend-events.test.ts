/**
 * SdkBackend event mapping tests.
 *
 * The SdkBackend wraps @github/copilot-sdk with a CopilotSession interface.
 * Since the SDK is loaded via dynamic import and the SdkSession class is
 * not exported, these tests verify the event mapping contracts by mocking
 * the SDK module and testing through SdkBackend.createSession().
 *
 * The mock replaces the dynamic `import()` call with a fake CopilotClient
 * that captures event handlers and lets us simulate SDK events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SdkBackend } from '../../runtimes/copilot/sdk-backend';
import { classifySdkEvent, KNOWN_SDK_EVENT_TYPES } from '../../runtimes/copilot/lifecycle-events';
import type { CopilotSession } from '../../runtimes/copilot/copilot-backend';

// ---------------------------------------------------------------------------
// Mock SDK types that mirror the real SDK's shape
// ---------------------------------------------------------------------------

type SdkEventHandler = (e: { type?: string; data?: Record<string, unknown> }) => void;

interface MockSdkSession {
  send: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  rpc: {
    mode: { set: ReturnType<typeof vi.fn> };
    compaction: { compact: ReturnType<typeof vi.fn> };
    mcp: { cancelSamplingExecution: ReturnType<typeof vi.fn> };
    ui: {
      handlePendingAutoModeSwitch: ReturnType<typeof vi.fn>;
      handlePendingSessionLimitsExhausted: ReturnType<typeof vi.fn>;
    };
  };
  on: (event: string | SdkEventHandler, handler?: SdkEventHandler) => void;
  /** Simulate an SDK event by type. */
  _emit: (type: string, data?: Record<string, unknown>) => void;
}

function createMockSdkSession(): MockSdkSession {
  const handlers = new Map<string, SdkEventHandler[]>();
  const catchAll: SdkEventHandler[] = [];

  const session: MockSdkSession = {
    send: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    rpc: {
      mode: { set: vi.fn().mockResolvedValue(undefined) },
      compaction: { compact: vi.fn().mockResolvedValue({ success: true, tokensRemoved: 0, messagesRemoved: 0 }) },
      mcp: { cancelSamplingExecution: vi.fn().mockResolvedValue({ cancelled: true }) },
      ui: {
        handlePendingAutoModeSwitch: vi.fn().mockResolvedValue({ success: true }),
        handlePendingSessionLimitsExhausted: vi.fn().mockResolvedValue({ success: true }),
      },
    },
    on: (eventOrHandler: string | SdkEventHandler, handler?: SdkEventHandler) => {
      if (typeof eventOrHandler === 'function') {
        catchAll.push(eventOrHandler);
      } else if (handler) {
        const list = handlers.get(eventOrHandler) ?? [];
        list.push(handler);
        handlers.set(eventOrHandler, list);
      }
    },
    _emit: (type: string, data?: Record<string, unknown>) => {
      const event = { type, data };
      const list = handlers.get(type) ?? [];
      for (const h of list) h(event);
      for (const h of catchAll) h(event);
    },
  };
  return session;
}

// ---------------------------------------------------------------------------
// Test helpers: create session and capture events
// ---------------------------------------------------------------------------

let mockSdkSession: MockSdkSession;
let mockSdkSessions: MockSdkSession[];
let mockCreateSession: ReturnType<typeof vi.fn<(config: Record<string, unknown>) => Promise<MockSdkSession>>>;
let originalFunction: typeof globalThis.Function;

/**
 * Creates a SdkBackend session with a mock SDK module.
 * Returns the CopilotSession and the mock so tests can simulate SDK events.
 */
async function createTestSession(options: ConstructorParameters<typeof SdkBackend>[0] = {}): Promise<{ session: CopilotSession; mock: MockSdkSession }> {
  const backend = new SdkBackend(options);
  const session = await backend.createSession({
    model: 'test-model',
    cwd: '.',
    addDirs: [],
    timeout: 3600,
    heartbeatTimeout: 120,
  });

  return { session, mock: mockSdkSession };
}

// We need to mock the `new Function('specifier', 'return import(specifier)')` pattern.
// The SdkBackend uses this to dynamically import @github/copilot-sdk.
beforeEach(() => {
  mockSdkSession = createMockSdkSession();
  mockSdkSessions = [mockSdkSession];
  mockCreateSession = vi.fn<(config: Record<string, unknown>) => Promise<MockSdkSession>>()
    .mockImplementation(async () => mockSdkSessions.shift() ?? mockSdkSession);
  originalFunction = globalThis.Function;

  // Replace Function constructor so that when SdkBackend creates its dynamic import
  // function, we intercept and return our mock SDK module.
  const mockFunction = function (...args: string[]): Function {
    if (args.length === 2 && args[0] === 'specifier' && args[1] === 'return import(specifier)') {
      return () => Promise.resolve({
        CopilotClient: class MockCopilotClient {
          async createSession(config: Record<string, unknown>) {
            const onEvent = config.onEvent as SdkEventHandler | undefined;
            onEvent?.({ type: 'session.start', data: { early: true } });
            return mockCreateSession(config);
          }
          stop() { return Promise.resolve(); }
          forceStop() { return Promise.resolve(); }
        },
        approveAll: () => ({}),
      });
    }
    return originalFunction(...args);
  };
  (globalThis as Record<string, unknown>).Function = mockFunction as unknown as typeof Function;
});

afterEach(() => {
  globalThis.Function = originalFunction;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SdkBackend event mapping', () => {
  it('classifies the authoritative SDK 1.0.6 top-level event catalog', () => {
    const eventTypes = [
      'abort', 'assistant.idle', 'assistant.intent', 'assistant.message_delta',
      'assistant.message_start', 'assistant.message', 'assistant.reasoning_delta',
      'assistant.reasoning', 'assistant.streaming_delta', 'assistant.tool_call_delta',
      'assistant.turn_end', 'assistant.turn_start', 'assistant.usage',
      'auto_mode_switch.completed', 'auto_mode_switch.requested', 'capabilities.changed',
      'command.completed', 'command.execute', 'command.queued', 'commands.changed',
      'elicitation.completed', 'elicitation.requested', 'exit_plan_mode.completed',
      'exit_plan_mode.requested', 'external_tool.completed', 'external_tool.requested',
      'hook.end', 'hook.progress', 'hook.start', 'mcp_app.tool_call_complete',
      'mcp.headers_refresh_completed', 'mcp.headers_refresh_required',
      'mcp.oauth_completed', 'mcp.oauth_required', 'model.call_failure',
      'pending_messages.modified', 'permission.completed', 'permission.requested',
      'sampling.completed', 'sampling.requested', 'session_limits_exhausted.completed',
      'session_limits_exhausted.requested', 'session.autopilot_objective_changed',
      'session.background_tasks_changed', 'session.binary_asset', 'session.canvas.closed',
      'session.canvas.opened', 'session.canvas.recorded', 'session.canvas.registry_changed',
      'session.canvas.removed', 'session.canvas.unavailable', 'session.compaction_complete',
      'session.compaction_start', 'session.context_changed', 'session.custom_agents_updated',
      'session.custom_notification', 'session.error', 'session.extensions_loaded',
      'session.extensions.attachments_pushed', 'session.handoff', 'session.idle',
      'session.info', 'session.mcp_server_status_changed', 'session.mcp_servers_loaded',
      'session.mode_changed', 'session.model_change', 'session.permissions_changed',
      'session.plan_changed', 'session.remote_steerable_changed', 'session.resume',
      'session.schedule_cancelled', 'session.schedule_created', 'session.schedule_rearmed',
      'session.session_limits_changed', 'session.shutdown', 'session.skills_loaded',
      'session.snapshot_rewind', 'session.start', 'session.task_complete',
      'session.title_changed', 'session.todos_changed', 'session.tools_updated',
      'session.truncation', 'session.usage_checkpoint', 'session.usage_info',
      'session.warning', 'session.workspace_file_changed', 'skill.invoked',
      'subagent.completed', 'subagent.deselected', 'subagent.failed',
      'subagent.selected', 'subagent.started', 'system.message', 'system.notification',
      'tool.execution_complete', 'tool.execution_partial_result',
      'tool.execution_progress', 'tool.execution_start', 'tool.user_requested',
      'user_input.completed', 'user_input.requested', 'user.message',
    ];

    expect(KNOWN_SDK_EVENT_TYPES.size).toBe(eventTypes.length);
    for (const type of eventTypes) expect(classifySdkEvent(type), type).toBeDefined();
    for (const phantom of ['assistant.tool_call', 'blob', 'agent_completed', 'agent_idle', 'shell_completed', 'shell_detached_completed']) {
      expect(classifySdkEvent(phantom), phantom).toBeUndefined();
    }
  });
  it('forwards contextTier and configDir to the SDK session config', async () => {
    const backend = new SdkBackend({ configDir: '/project' });
    await backend.createSession({
      model: 'test-model',
      contextTier: 'long_context',
      cwd: '.',
      addDirs: [],
      timeout: 3600,
      heartbeatTimeout: 120,
    }).then(session => session.send('test prompt'));

    await vi.waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        contextTier: 'long_context',
        configDir: '/project',
      }));
    });
  });

  it('treats SDK 0.2 lifecycle events as informational without changing turn state', async () => {
    const { session, mock } = await createTestSession();
    const idleHandler = vi.fn();
    const errorHandler = vi.fn();
    session.on('idle', idleHandler);
    session.on('error', errorHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const type of [
      'session.skills_loaded', 'session.extensions_loaded', 'agent_completed', 'agent_idle',
      'mcp.oauth_required', 'mcp.oauth_completed', 'command.execute', 'commands.changed',
      'shell_completed', 'shell_detached_completed', 'system.notification', 'blob',
    ]) mock._emit(type);

    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('Unhandled event'));
    expect(idleHandler).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();
    mock._emit('session.idle');
    expect(idleHandler).toHaveBeenCalledOnce();
    stderr.mockRestore();
  });

  it('deduplicates streamed text from assistant.message', async () => {
    const { session, mock } = await createTestSession();

    const textHandler = vi.fn();
    session.on('text', textHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    mock._emit('assistant.message_delta', { deltaContent: 'Hello ' });
    mock._emit('assistant.message_delta', { deltaContent: 'world' });
    mock._emit('assistant.message', { content: 'Hello world!' });

    expect(textHandler.mock.calls.map(([text]) => text)).toEqual(['Hello ', 'world', '!']);
  });

  it('deduplicates interleaved root and sub-agent streams independently', async () => {
    const { session, mock } = await createTestSession();
    const textHandler = vi.fn();
    session.on('text', textHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('assistant.message_delta', { deltaContent: 'root ', parentToolCallId: undefined });
    mock._emit('assistant.message_delta', { deltaContent: 'sub ', parentToolCallId: 'tc-parent-1' });
    mock._emit('assistant.message_delta', { deltaContent: 'text', parentToolCallId: undefined });
    mock._emit('assistant.message', { content: 'sub text!', parentToolCallId: 'tc-parent-1' });
    mock._emit('assistant.message', { content: 'root text!', parentToolCallId: undefined });

    expect(textHandler.mock.calls).toEqual([
      ['root ', undefined],
      ['sub ', 'tc-parent-1'],
      ['text', undefined],
      ['text!', 'tc-parent-1'],
      ['!', undefined],
    ]);
  });

  it('resets dedup state at send and terminal turn boundaries', async () => {
    const { session, mock } = await createTestSession();
    const textHandler = vi.fn();
    session.on('text', textHandler);
    session.send('first prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('assistant.message_delta', { deltaContent: 'same' });
    mock._emit('session.task_complete');

    const secondMock = createMockSdkSession();
    mockSdkSessions.push(secondMock);
    session.send('second prompt');
    await new Promise(r => setTimeout(r, 50));
    secondMock._emit('assistant.message', { content: 'same again' });
    secondMock._emit('assistant.message_delta', { deltaContent: 'stale' });
    secondMock._emit('session.task_complete');

    expect(textHandler.mock.calls.map(([text]) => text)).toEqual(['same', 'same again', 'stale']);
  });

  it('emits a final message without prior deltas and forgets its stream state', async () => {
    const { session, mock } = await createTestSession();
    const textHandler = vi.fn();
    session.on('text', textHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('assistant.message', { content: 'complete' });
    mock._emit('assistant.message', { content: 'complete again' });

    expect(textHandler.mock.calls.map(([text]) => text)).toEqual(['complete', 'complete again']);
  });

  it('keeps unfinished sub-agent delta state while another stream finalizes', async () => {
    const { session, mock } = await createTestSession();
    const textHandler = vi.fn();
    session.on('text', textHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('assistant.message_delta', { deltaContent: 'sub ', parentToolCallId: 'tc-parent-1' });
    mock._emit('assistant.message_delta', { deltaContent: 'root ' });
    mock._emit('assistant.message', { content: 'root done' });
    mock._emit('assistant.message', { content: 'sub done', parentToolCallId: 'tc-parent-1' });

    expect(textHandler.mock.calls).toEqual([
      ['sub ', 'tc-parent-1'],
      ['root ', undefined],
      ['done', undefined],
      ['done', 'tc-parent-1'],
    ]);
  });

  it('ignores stale abort and text events from a cleaned-up prior turn', async () => {
    vi.useFakeTimers();
    try {
      const secondMock = createMockSdkSession();
      mockSdkSessions.push(secondMock);
      const { session, mock: firstMock } = await createTestSession();
      const textHandler = vi.fn();
      const errorHandler = vi.fn();
      session.on('text', textHandler);
      session.on('error', errorHandler);

      session.send('first prompt');
      await vi.advanceTimersByTimeAsync(0);
      firstMock._emit('session.idle');
      session.send('second prompt');
      await vi.advanceTimersByTimeAsync(0);

      firstMock._emit('assistant.message_delta', { deltaContent: 'stale delta' });
      firstMock._emit('assistant.message', { content: 'stale final' });
      firstMock._emit('abort', { reason: 'remote_command' });
      secondMock._emit('assistant.message', { content: 'fresh' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(textHandler.mock.calls.map(([text]) => text)).toEqual(['fresh']);
      expect(errorHandler).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers a stuck compaction after an intentional abort', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      mock.rpc.compaction.compact.mockRejectedValueOnce(new Error('compact failed'));
      mock.abort.mockImplementationOnce(async () => {
        mock._emit('abort', { reason: 'user_initiated' });
        mock._emit('session.idle');
      });

      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      mock._emit('session.compaction_start');
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(2000);

      expect(errorHandler).not.toHaveBeenCalled();
      expect(mock.send).toHaveBeenLastCalledWith({ prompt: 'Continue from where you left off.' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-arm heartbeat when the session fails during recovery send', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      mock.rpc.compaction.compact.mockRejectedValueOnce(new Error('compact failed'));
      let resolveRecovery!: () => void;
      const recoverySend = new Promise<void>(resolve => { resolveRecovery = resolve; });
      mock.send.mockResolvedValueOnce(undefined).mockReturnValueOnce(recoverySend);

      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      mock._emit('session.compaction_start');
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 2000);
      expect(mock.send).toHaveBeenLastCalledWith({ prompt: 'Continue from where you left off.' });

      mock._emit('session.error', { message: 'failed during recovery send' });
      resolveRecovery();
      await vi.advanceTimersByTimeAsync(120 * 1000);

      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ message: 'failed during recovery send' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a delayed abort throughout compaction recovery', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      mock.rpc.compaction.compact.mockRejectedValueOnce(new Error('compact failed'));
      let resolveRecovery!: () => void;
      const recoverySend = new Promise<void>(resolve => { resolveRecovery = resolve; });
      mock.send.mockResolvedValueOnce(undefined).mockReturnValueOnce(recoverySend);

      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      mock._emit('session.compaction_start');
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 7000);
      mock._emit('abort', { reason: 'user_initiated' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(errorHandler).not.toHaveBeenCalled();
      resolveRecovery();
      await vi.advanceTimersByTimeAsync(0);
      expect(mock.send).toHaveBeenLastCalledWith({ prompt: 'Continue from where you left off.' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('send after abort emits an error instead of silently hanging', async () => {
    const { session } = await createTestSession();
    const errorHandler = vi.fn();
    session.on('error', errorHandler);

    await session.abort();
    errorHandler.mockClear();
    session.send('must not run');

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ message: 'Session is aborted' }));
  });

  it('ignores a late old-session idle during the next send setup gap', async () => {
    const secondMock = createMockSdkSession();
    let resolveSecond!: (session: MockSdkSession) => void;
    const secondCreation = new Promise<MockSdkSession>(resolve => { resolveSecond = resolve; });
    mockCreateSession
      .mockResolvedValueOnce(mockSdkSession)
      .mockReturnValueOnce(secondCreation);

    const { session, mock: firstMock } = await createTestSession();
    const idleHandler = vi.fn();
    session.on('idle', idleHandler);
    session.send('first prompt');
    await new Promise(r => setTimeout(r, 50));
    firstMock._emit('session.idle');
    expect(idleHandler).toHaveBeenCalledOnce();

    session.send('second prompt');
    firstMock._emit('session.idle');
    resolveSecond(secondMock);
    await new Promise(r => setTimeout(r, 50));
    secondMock._emit('session.idle');

    expect(idleHandler).toHaveBeenCalledTimes(2);
  });

  it('clears timers and emits one error when SDK send rejects asynchronously', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      mock.send.mockRejectedValueOnce(new Error('send failed'));

      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);
      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ message: 'send failed' }));

      await vi.advanceTimersByTimeAsync(3600 * 1000);
      expect(errorHandler).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears unfinished tool state before the next turn', async () => {
    const secondMock = createMockSdkSession();
    mockSdkSessions.push(secondMock);
    const { session, mock: firstMock } = await createTestSession();
    const toolOutputHandler = vi.fn();
    session.on('tool_output', toolOutputHandler);
    session.send('first prompt');
    await new Promise(r => setTimeout(r, 50));

    firstMock._emit('tool.execution_start', {
      toolName: 'Bash', toolCallId: 'reused-id', arguments: {}, parentToolCallId: 'old-parent',
    });
    firstMock._emit('session.idle');
    session.send('second prompt');
    await new Promise(r => setTimeout(r, 50));
    secondMock._emit('tool.execution_partial_result', { toolCallId: 'reused-id', partialOutput: 'new output' });

    expect(toolOutputHandler).not.toHaveBeenCalled();
    secondMock._emit('tool.execution_start', {
      toolName: 'Read', toolCallId: 'reused-id', arguments: {}, parentToolCallId: 'new-parent',
    });
    expect(toolOutputHandler).toHaveBeenCalledWith('Read', 'new output', 'new-parent');
  });

  it('fails unknown failure-shaped events instead of hanging', async () => {
    const { session, mock } = await createTestSession();
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('future.transport_fatal', { failed: true, error: 'future failure' });

    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('future.transport_fatal'),
    }));
  });

  it('treats error shutdown as terminal failure and routine shutdown as benign', async () => {
    const { session, mock } = await createTestSession();
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('session.shutdown', { shutdownType: 'routine' });
    expect(errorHandler).not.toHaveBeenCalled();
    mock._emit('session.shutdown', { shutdownType: 'error', errorReason: 'CLI crashed' });
    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ message: 'CLI crashed' }));
  });

  it('applies headless policies to pending requests', async () => {
    const { session, mock } = await createTestSession();
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('sampling.requested', { requestId: 'sampling-1' });
    mock._emit('auto_mode_switch.requested', { requestId: 'switch-1' });
    mock._emit('session_limits_exhausted.requested', { requestId: 'limit-1' });
    mock._emit('mcp.headers_refresh_required', { requestId: 'headers-1' });
    await vi.waitFor(() => {
      expect(mock.rpc.mcp.cancelSamplingExecution).toHaveBeenCalledWith({ requestId: 'sampling-1' });
      expect(mock.rpc.ui.handlePendingAutoModeSwitch).toHaveBeenCalledWith({
        requestId: 'switch-1', response: 'yes',
      });
      expect(mock.rpc.ui.handlePendingSessionLimitsExhausted).toHaveBeenCalledWith({
        requestId: 'limit-1', response: { action: 'cancel' },
      });
    });
  });

  it('lets eligible auto-switch errors reach the pending switch policy', async () => {
    const { session, mock } = await createTestSession();
    const errorHandler = vi.fn();
    session.on('error', errorHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('session.error', {
      message: 'rate limited', errorType: 'rate_limit', eligibleForAutoSwitch: true,
    });
    mock._emit('auto_mode_switch.requested', { requestId: 'switch-rate-limit' });

    expect(errorHandler).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mock.rpc.ui.handlePendingAutoModeSwitch).toHaveBeenCalledWith({
        requestId: 'switch-rate-limit', response: 'yes',
      });
    });
  });

  it('treats custom_agents_updated as benign and omits binary payload logging', async () => {
    const { session, mock } = await createTestSession();
    const errorHandler = vi.fn();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    session.on('error', errorHandler);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('session.custom_agents_updated', { agents: [] });
    mock._emit('session.binary_asset', { data: 'x'.repeat(10_000) });

    expect(errorHandler).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('x'.repeat(100)));
    stderr.mockRestore();
  });

  it('uses real top-level event names rather than phantom nested discriminators', async () => {
    const { session, mock } = await createTestSession();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    session.send('test prompt');
    await new Promise(r => setTimeout(r, 50));

    mock._emit('system.notification', { kind: { type: 'agent_idle' } });
    mock._emit('assistant.tool_call_delta', { inputDelta: '{}' });

    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('Unknown event'));
    stderr.mockRestore();
  });

  it('parentToolCallId forwarded from assistant.message', async () => {
    const { session, mock } = await createTestSession();

    const textHandler = vi.fn();
    session.on('text', textHandler);
    session.send('test prompt');

    // Wait for async _run to set up handlers
    await new Promise(r => setTimeout(r, 50));

    mock._emit('assistant.message', {
      content: 'Hello from sub-agent',
      parentToolCallId: 'tc-parent-1',
    });

    expect(textHandler).toHaveBeenCalledWith('Hello from sub-agent', 'tc-parent-1');
  });

  it('parentToolCallId forwarded from tool.execution_start', async () => {
    const { session, mock } = await createTestSession();

    const toolStartHandler = vi.fn();
    session.on('tool_start', toolStartHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    mock._emit('tool.execution_start', {
      toolName: 'Read',
      toolCallId: 'tc-1',
      arguments: { file_path: 'src/app.ts' },
      parentToolCallId: 'tc-parent-1',
    });

    expect(toolStartHandler).toHaveBeenCalledWith(
      'Read',
      expect.any(String),
      expect.objectContaining({ file_path: 'src/app.ts' }),
      'tc-1',
      'tc-parent-1',
    );
  });

  it('_callIdToParent map populated from tool.execution_start for partial_result lookups', async () => {
    const { session, mock } = await createTestSession();

    const toolOutputHandler = vi.fn();
    session.on('tool_output', toolOutputHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    // Start a tool with parentToolCallId
    mock._emit('tool.execution_start', {
      toolName: 'Bash',
      toolCallId: 'tc-child-1',
      arguments: { command: 'npm test' },
      parentToolCallId: 'tc-parent-1',
    });

    // Partial result arrives — should look up parentToolCallId from the map
    mock._emit('tool.execution_partial_result', {
      toolCallId: 'tc-child-1',
      partialOutput: 'test output line',
    });

    expect(toolOutputHandler).toHaveBeenCalledWith('Bash', 'test output line', 'tc-parent-1');
  });

  it('subagent.started extracts toolCallId as named field', async () => {
    const { session, mock } = await createTestSession();

    const subagentStartHandler = vi.fn();
    session.on('subagent_start', subagentStartHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    mock._emit('subagent.started', {
      agentName: 'reviewer',
      agentDisplayName: 'Code Reviewer',
      toolCallId: 'tc-sa-1',
    });

    expect(subagentStartHandler).toHaveBeenCalledWith(
      'Code Reviewer',
      expect.objectContaining({ toolCallId: 'tc-sa-1' }),
    );
  });

  it('subagent.started does NOT emit synthetic tool_start', async () => {
    const { session, mock } = await createTestSession();

    const toolStartHandler = vi.fn();
    session.on('tool_start', toolStartHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    mock._emit('subagent.started', {
      agentName: 'worker',
      toolCallId: 'tc-sa-1',
    });

    // No tool_start event should have been emitted for the sub-agent
    expect(toolStartHandler).not.toHaveBeenCalled();
  });

  it('model.call_failure emits error instead of hanging', async () => {
    const { session, mock } = await createTestSession();

    const errorHandler = vi.fn();
    const idleHandler = vi.fn();
    session.on('error', errorHandler);
    session.on('idle', idleHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    mock._emit('model.call_failure', {
      errorMessage: 'transient upstream failure',
      statusCode: 503,
      model: 'test-model',
      source: 'top_level',
    });

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('transient upstream failure'),
    }));
    expect(idleHandler).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mock.abort).toHaveBeenCalledOnce();
      expect(mock.disconnect).toHaveBeenCalledOnce();
    });
  });

  it('fails an abort-only turn after a short grace window', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      const errorHandler = vi.fn();
      session.on('error', errorHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('abort', { reason: 'remote_command' });
      await vi.advanceTimersByTimeAsync(999);
      expect(errorHandler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('remote_command'),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels abort failure when session.idle arrives during grace', async () => {
    vi.useFakeTimers();
    try {
      const { session, mock } = await createTestSession();
      const errorHandler = vi.fn();
      const idleHandler = vi.fn();
      session.on('error', errorHandler);
      session.on('idle', idleHandler);
      session.send('test prompt');
      await vi.advanceTimersByTimeAsync(0);

      mock._emit('abort', { reason: 'user_initiated' });
      mock._emit('session.idle');
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleHandler).toHaveBeenCalledOnce();
      expect(errorHandler).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('session.task_complete emits idle and cleans up', async () => {
    const { session, mock } = await createTestSession();

    const idleHandler = vi.fn();
    session.on('idle', idleHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    mock._emit('session.task_complete');

    expect(idleHandler).toHaveBeenCalledOnce();
  });

  it('session.task_complete is safe when session.idle also fires', async () => {
    const { session, mock } = await createTestSession();

    const idleHandler = vi.fn();
    session.on('idle', idleHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    // Both events fire — _cleanup() no-ops on second call
    mock._emit('session.task_complete');
    mock._emit('session.idle');

    expect(idleHandler).toHaveBeenCalledOnce();
  });

  it('content ?? detailedContent ordering matches spec', async () => {
    const { session, mock } = await createTestSession();

    const toolCompleteHandler = vi.fn();
    session.on('tool_complete', toolCompleteHandler);
    session.send('test prompt');

    await new Promise(r => setTimeout(r, 50));

    // Pre-seed tool name mapping
    mock._emit('tool.execution_start', {
      toolName: 'Read',
      toolCallId: 'tc-1',
      arguments: {},
    });

    // Complete with both content and detailedContent — content should take precedence
    mock._emit('tool.execution_complete', {
      toolCallId: 'tc-1',
      result: {
        content: 'short result',
        detailedContent: 'verbose detailed result',
      },
    });

    expect(toolCompleteHandler).toHaveBeenCalledWith('Read', 'short result', 'tc-1', undefined);

    // Now test fallback to detailedContent when content is missing
    toolCompleteHandler.mockClear();

    mock._emit('tool.execution_start', {
      toolName: 'Grep',
      toolCallId: 'tc-2',
      arguments: {},
    });

    mock._emit('tool.execution_complete', {
      toolCallId: 'tc-2',
      result: {
        detailedContent: 'verbose fallback result',
      },
    });

    expect(toolCompleteHandler).toHaveBeenCalledWith('Grep', 'verbose fallback result', 'tc-2', undefined);
  });
});
