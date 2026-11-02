import { describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createMapState,
  mapSdkMessage,
} from '../../../runtimes/claude/message-mapper';
import type {
  ClaudeInitInfo,
  ClaudeResultOutcome,
  ClaudeSessionEmitter,
  MapOptions,
  MapState,
} from '../../../runtimes/claude/message-mapper';

interface Call {
  readonly event: string;
  readonly args: readonly unknown[];
}

function makeEmitter(): { emitter: ClaudeSessionEmitter; calls: Call[] } {
  const calls: Call[] = [];
  const spy = (event: string) => (...args: unknown[]): void => {
    calls.push({ event, args });
  };
  const emitter: ClaudeSessionEmitter = {
    text: spy('text'),
    reasoning: spy('reasoning'),
    toolStart: spy('toolStart'),
    toolComplete: spy('toolComplete'),
    toolCompleteRich: spy('toolCompleteRich'),
    toolOutput: spy('toolOutput'),
    idle: spy('idle'),
    error: spy('error'),
    usage: spy('usage'),
    compaction: spy('compaction'),
    subagentStart: spy('subagentStart'),
    subagentEnd: spy('subagentEnd'),
    permission: spy('permission'),
    toolUsage: spy('toolUsage'),
  };
  return { emitter, calls };
}

function opts(extra: Partial<MapOptions> = {}): MapOptions {
  return { includePartialMessages: false, ...extra };
}

function frame(value: Record<string, unknown>): SDKMessage {
  return value as unknown as SDKMessage;
}

function feed(
  messages: Record<string, unknown>[],
  options: MapOptions = opts(),
  state: MapState = createMapState(),
): { emitter: ClaudeSessionEmitter; calls: Call[]; state: MapState } {
  const { emitter, calls } = makeEmitter();
  for (const message of messages) mapSdkMessage(frame(message), emitter, state, options);
  return { emitter, calls, state };
}

const SUCCESS_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  uuid: 'r1',
  result: 'done',
  stop_reason: 'end_turn',
  num_turns: 1,
  duration_ms: 42,
  usage: { input_tokens: 10, output_tokens: 5 },
  modelUsage: {
    m1: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 1000,
      maxOutputTokens: 100,
    },
  },
  session_id: 's1',
};

describe('message-mapper', () => {
  describe('assistant frames', () => {
    it('maps text/reasoning/tool_use with the parent tool call id', () => {
      const { calls } = feed([{
        type: 'assistant',
        parent_tool_use_id: 'p1',
        message: {
          model: 'm1',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'thinking', thinking: 'hmm' },
            { type: 'tool_use', id: 'c1', name: 'Read', input: { x: 1 } },
          ],
        },
      }]);
      expect(calls.map((call) => call.event)).toEqual(['text', 'reasoning', 'toolStart']);
      expect(calls[0]?.args).toEqual(['hi', 'p1']);
      expect(calls[1]?.args).toEqual(['hmm']);
      expect(calls[2]?.args).toEqual(['Read', '{"x":1}', { x: 1 }, 'c1', 'p1']);
    });

    it('reports the latest prompt size without emitting usage from assistant frames', () => {
      const onAssistantUsage = vi.fn();
      const { calls, state } = feed([{
        type: 'assistant',
        message: {
          model: 'm1',
          content: [{ type: 'text', text: 'hi' }],
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
            output_tokens: 3,
          },
        },
      }], opts({ onAssistantUsage }));
      expect(onAssistantUsage).toHaveBeenCalledWith(8, 3);
      expect(state.lastCallContextTokens).toBe(8);
      expect(calls.some((call) => call.event === 'usage')).toBe(false);
    });
  });

  describe('streaming deltas', () => {
    it('emits text deltas and suppresses the assistant echo', () => {
      const state = createMapState();
      const { calls } = feed([
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'he' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'llo' } } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
      ], opts({ includePartialMessages: true }), state);
      const texts = calls.filter((call) => call.event === 'text').map((call) => call.args[0]);
      expect(texts).toEqual(['he', 'llo']);
    });

    it('assembles a streamed tool_use block and emits toolStart at block stop', () => {
      const state = createMapState();
      const { calls } = feed([
        {
          type: 'stream_event',
          parent_tool_use_id: 'p1',
          event: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'c1', name: 'Grep' },
          },
        },
        {
          type: 'stream_event',
          parent_tool_use_id: 'p1',
          event: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"pattern":' },
          },
        },
        {
          type: 'stream_event',
          parent_tool_use_id: 'p1',
          event: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '"x"}' },
          },
        },
        {
          type: 'stream_event',
          parent_tool_use_id: 'p1',
          event: { type: 'content_block_stop', index: 1 },
        },
      ], opts({ includePartialMessages: true }), state);
      expect(calls).toEqual([{
        event: 'toolStart',
        args: ['Grep', '{"pattern":"x"}', { pattern: 'x' }, 'c1', 'p1'],
      }]);
    });
  });

  describe('tool results', () => {
    it('emits toolComplete with the parent and rich blocks for non-text content', () => {
      const state = createMapState();
      const { calls } = feed([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: {} }],
          },
        },
        {
          type: 'user',
          parent_tool_use_id: 'p1',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'c1',
              content: [
                { type: 'text', text: 'pic' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
                },
              ],
            }],
          },
        },
      ], opts(), state);
      const complete = calls.find((call) => call.event === 'toolComplete');
      expect(complete?.args).toEqual(['Read', 'pic\n[image]', 'c1', 'p1']);
      const rich = calls.find((call) => call.event === 'toolCompleteRich');
      expect(rich?.args).toEqual([
        'Read',
        [{ type: 'image', data: 'AAA', mimeType: 'image/png' }],
        'c1',
      ]);
    });

    it('does not emit empty tool_output for tool_progress frames', () => {
      const { calls } = feed([{ type: 'tool_progress', tool_name: 'Bash', elapsed_time_seconds: 3 }]);
      expect(calls).toEqual([]);
    });
  });

  describe('result', () => {
    it('reports an outcome instead of finishing when onResult is supplied', () => {
      const onResult = vi.fn<(outcome: ClaudeResultOutcome) => void>();
      const { calls } = feed([SUCCESS_RESULT], opts({ onResult }));
      expect(onResult).toHaveBeenCalledTimes(1);
      expect(onResult.mock.calls[0]?.[0]).toMatchObject({
        subtype: 'success',
        isError: false,
        errors: [],
        stopReason: 'end_turn',
        numTurns: 1,
        durationMs: 42,
      });
      expect(calls.some((call) => call.event === 'idle')).toBe(false);
    });

    it('falls back to idle on a clean result', () => {
      const { calls } = feed([SUCCESS_RESULT]);
      expect(calls.map((call) => call.event)).toContain('idle');
    });

    it('never reports idle for success + is_error', () => {
      const onResult = vi.fn<(outcome: ClaudeResultOutcome) => void>();
      feed([{ ...SUCCESS_RESULT, is_error: true, api_error_status: 503 }], opts({ onResult }));
      expect(onResult.mock.calls[0]?.[0]?.isError).toBe(true);
      expect(onResult.mock.calls[0]?.[0]?.apiErrorStatus).toBe(503);

      const fallback = feed([{ ...SUCCESS_RESULT, is_error: true, api_error_status: 503 }]);
      expect(fallback.calls.map((call) => call.event)).not.toContain('idle');
      expect(fallback.calls.map((call) => call.event)).toContain('error');
    });

    it('carries error evidence from a failed result', () => {
      const onResult = vi.fn<(outcome: ClaudeResultOutcome) => void>();
      feed([{
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        uuid: 'r2',
        errors: ['boom'],
        terminal_reason: 'api_error',
        num_turns: 2,
        duration_ms: 10,
        usage: {},
        modelUsage: {},
      }], opts({ onResult }));
      expect(onResult.mock.calls[0]?.[0]).toMatchObject({
        subtype: 'error_during_execution',
        isError: true,
        errors: ['boom'],
        terminalReason: 'api_error',
      });
    });

    it('reports the resume reason when resume rescued a turn', () => {
      const onResult = vi.fn<(outcome: ClaudeResultOutcome) => void>();
      feed([{ ...SUCCESS_RESULT, resume_reason: 'interrupted' }], opts({ onResult }));
      expect(onResult.mock.calls[0]?.[0]?.resumeReason).toBe('interrupted');
    });
  });

  describe('usage ledger', () => {
    it('emits per-model deltas keyed by the result uuid', () => {
      const state = createMapState();
      const { calls } = feed([SUCCESS_RESULT], opts(), state);
      const records = calls
        .filter((call) => call.event === 'usage')
        .map((call) => call.args[0] as Record<string, unknown>);
      expect(records).toEqual([{
        inputTokens: 13,
        outputTokens: 5,
        totalTokens: 18,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        model: 'm1',
        apiCallId: 'r1:m1',
        duration: 42,
      }]);

      const second = feed([{
        ...SUCCESS_RESULT,
        uuid: 'r2',
        modelUsage: {
          m1: {
            inputTokens: 25,
            outputTokens: 8,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 1,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 1000,
            maxOutputTokens: 100,
          },
        },
      }], opts(), state);
      const delta = second.calls
        .filter((call) => call.event === 'usage')
        .map((call) => call.args[0] as Record<string, unknown>);
      expect(delta).toEqual([{
        // 28 cumulative (25 in + 2 cache read + 1 cache write) minus 13.
        inputTokens: 15,
        outputTokens: 3,
        totalTokens: 18,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        model: 'm1',
        apiCallId: 'r2:m1',
        duration: 42,
      }]);
    });

    it('does not reset the baseline on a zeroed crash result', () => {
      const state = createMapState();
      feed([SUCCESS_RESULT], opts(), state);
      const zeroed = feed([{
        ...SUCCESS_RESULT,
        uuid: 'r2',
        modelUsage: {},
        usage: {},
      }], opts(), state);
      expect(zeroed.calls.some((call) => call.event === 'usage')).toBe(false);
      const resumed = feed([{
        ...SUCCESS_RESULT,
        uuid: 'r3',
        modelUsage: {
          m1: {
            inputTokens: 15,
            outputTokens: 6,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 1,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 1000,
            maxOutputTokens: 100,
          },
        },
      }], opts(), state);
      const record = resumed.calls.find((call) => call.event === 'usage')?.args[0] as
        | Record<string, unknown>
        | undefined;
      expect(record?.inputTokens).toBe(5);
      expect(record?.outputTokens).toBe(1);
    });

    it('seeds the baseline on a resumed session and bills only the main loop', () => {
      const state = createMapState();
      const { calls } = feed([
        { type: 'assistant', message: { model: 'm1', content: [] } },
        SUCCESS_RESULT,
      ], opts({ resumed: true }), state);
      const records = calls
        .filter((call) => call.event === 'usage')
        .map((call) => call.args[0] as Record<string, unknown>);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        model: 'm1',
        apiCallId: 'r1:m1',
      });
    });

    it('ignores subagent frames when attributing main-loop usage', () => {
      const state = createMapState();
      const { calls } = feed([
        {
          type: 'stream_event',
          parent_tool_use_id: 'p1',
          event: { type: 'message_start', message: { model: 'sub-x' } },
        },
        {
          type: 'assistant',
          parent_tool_use_id: 'p1',
          message: { model: 'sub-y', content: [] },
        },
        SUCCESS_RESULT,
      ], opts({ resumed: true }), state);
      const record = calls.find((call) => call.event === 'usage')?.args[0] as
        | Record<string, unknown>
        | undefined;
      // Only main-loop frames name the model `result.usage` bills; borrowing a
      // subagent's model would charge the main loop to the wrong one.
      expect(record?.model).toBe('m1');
      expect(record?.apiCallId).toBe('r1:m1');
    });

    it('attributes main-loop usage to the model named by the main-loop start', () => {
      const state = createMapState();
      const { calls } = feed([
        { type: 'stream_event', event: { type: 'message_start', message: { model: 'b' } } },
        {
          ...SUCCESS_RESULT,
          modelUsage: {
            a: { inputTokens: 100, outputTokens: 10 },
            b: { inputTokens: 10, outputTokens: 5 },
          },
        },
      ], opts({ resumed: true }), state);
      const record = calls.find((call) => call.event === 'usage')?.args[0] as
        | Record<string, unknown>
        | undefined;
      // Two models in the snapshot; the main-loop start disambiguates.
      expect(record?.model).toBe('b');
      expect(record?.inputTokens).toBe(10);
    });
  });

  describe('system messages', () => {
    it('reads back the applied permission mode and tool set from init', () => {
      const onInit = vi.fn<(info: ClaudeInitInfo) => void>();
      feed([{
        type: 'system',
        subtype: 'init',
        permissionMode: 'dontAsk',
        tools: ['Read', 'mcp__s__search'],
        agents: ['Explore'],
        model: 'm1',
        cwd: '/w',
      }], opts({ onInit }));
      expect(onInit).toHaveBeenCalledWith({
        permissionMode: 'dontAsk',
        tools: ['Read', 'mcp__s__search'],
        agents: ['Explore'],
        model: 'm1',
        cwd: '/w',
      });
    });

    it('emits compaction start and completion once across status and boundary', () => {
      const onCompaction = vi.fn();
      const { calls } = feed([
        { type: 'system', subtype: 'status', status: 'compacting' },
        { type: 'system', subtype: 'status', compact_result: 'success' },
        {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 100, post_tokens: 20 },
        },
      ], opts({ onCompaction }));
      const compactions = calls
        .filter((call) => call.event === 'compaction')
        .map((call) => call.args[0]);
      expect(compactions).toEqual(['start', 'complete']);
      expect(onCompaction).toHaveBeenCalledTimes(1);
    });

    it('reports a boundary completion with its metadata', () => {
      const onCompaction = vi.fn();
      const { calls } = feed([{
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 20, duration_ms: 5 },
      }], opts({ onCompaction }));
      expect(calls).toEqual([{ event: 'compaction', args: ['complete'] }]);
      expect(onCompaction).toHaveBeenCalledWith({
        trigger: 'manual',
        preTokens: 100,
        postTokens: 20,
        durationMs: 5,
      });
    });

    it('reports a failed compaction without a completion', () => {
      const onCompactionFailed = vi.fn();
      const onCompaction = vi.fn();
      const { calls } = feed([{
        type: 'system',
        subtype: 'status',
        compact_result: 'failed',
        compact_error: 'disk full',
      }], opts({ onCompactionFailed, onCompaction }));
      expect(onCompactionFailed).toHaveBeenCalledWith('disk full');
      expect(onCompaction).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    it('surfaces SDK-native retries', () => {
      const onApiRetry = vi.fn();
      feed([{
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 250,
        error_status: 429,
        error: 'rate limited',
      }], opts({ onApiRetry }));
      expect(onApiRetry).toHaveBeenCalledWith({
        attempt: 2,
        maxRetries: 5,
        delayMs: 250,
        status: 429,
        error: 'rate limited',
        noResponse: false,
      });
    });

    it('pairs task_started with task_notification', () => {
      const { calls } = feed([
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 't1',
          tool_use_id: 'tu1',
          subagent_type: 'Explore',
          description: 'scan the repo',
          spawn_depth: 1,
          is_backgrounded: false,
        },
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 't1',
          status: 'completed',
          usage: { total_tokens: 9, duration_ms: 100 },
        },
      ]);
      const started = calls.find((call) => call.event === 'subagentStart');
      expect(started?.args).toEqual(['Explore', {
        taskId: 't1',
        toolCallId: 'tu1',
        subagentType: 'Explore',
        spawnDepth: 1,
        description: 'scan the repo',
        isBackgrounded: false,
      }]);
      const ended = calls.find((call) => call.event === 'subagentEnd');
      expect(ended?.args).toEqual(['Explore', {
        taskId: 't1',
        toolCallId: 't1',
        status: 'completed',
        totalTokens: 9,
        duration: 100,
      }]);
    });

    it('maps permission denials', () => {
      const { calls } = feed([{
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'tu1',
        decision_reason_type: 'rule',
        decision_reason: 'denied by policy',
        agent_id: 'a1',
        message: 'nope',
      }]);
      expect(calls).toEqual([{
        event: 'permission',
        args: [{
          kind: 'rule',
          detail: 'denied by policy',
          approved: false,
          tool: 'Bash',
          toolCallId: 'tu1',
          agentId: 'a1',
          reasonType: 'rule',
          reason: 'denied by policy',
          message: 'nope',
        }],
      }]);
    });
  });

  it('returns true only for terminal result messages', () => {
    const { emitter } = makeEmitter();
    const state = createMapState();
    expect(mapSdkMessage(frame(SUCCESS_RESULT), emitter, state, opts())).toBe(true);
    expect(mapSdkMessage(frame({ type: 'assistant', message: { content: [] } }), emitter, state, opts())).toBe(false);
  });
});
