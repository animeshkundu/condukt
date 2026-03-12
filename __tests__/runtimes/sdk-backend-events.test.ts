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
import type { CopilotSession } from '../../runtimes/copilot/copilot-backend';

// ---------------------------------------------------------------------------
// Mock SDK types that mirror the real SDK's shape
// ---------------------------------------------------------------------------

type SdkEventHandler = (e: { type?: string; data?: Record<string, unknown> }) => void;

interface MockSdkSession {
  send: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
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
let originalFunction: typeof globalThis.Function;

/**
 * Creates a SdkBackend session with a mock SDK module.
 * Returns the CopilotSession and the mock so tests can simulate SDK events.
 */
async function createTestSession(): Promise<{ session: CopilotSession; mock: MockSdkSession }> {
  const backend = new SdkBackend({});
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
  originalFunction = globalThis.Function;

  // Replace Function constructor so that when SdkBackend creates its dynamic import
  // function, we intercept and return our mock SDK module.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as Record<string, unknown>).Function = class MockFunction extends originalFunction {
    constructor(...args: string[]) {
      // Detect the dynamic import pattern used by SdkBackend
      if (args.length === 2 && args[0] === 'specifier' && args[1] === 'return import(specifier)') {
        // Return a function that resolves to our mock SDK module
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fn = (() => {
          return Promise.resolve({
            CopilotClient: class MockCopilotClient {
              createSession() {
                return Promise.resolve(mockSdkSession);
              }
              stop() { return Promise.resolve(); }
              forceStop() { return Promise.resolve(); }
            },
            approveAll: () => ({}),
          });
        }) as unknown as MockFunction;
        return fn;
      }
      // @ts-expect-error -- forwarding to original Function constructor
      return new originalFunction(...args);
    }
  } as typeof Function;
});

afterEach(() => {
  globalThis.Function = originalFunction;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SdkBackend event mapping', () => {
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

    // idle emitted at least once (double-fire is safe)
    expect(idleHandler.mock.calls.length).toBeGreaterThanOrEqual(1);
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
