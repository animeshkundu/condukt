import { describe, it, expect } from 'vitest';
import {
  ResponsesStreamTranslator,
  StreamTranslationError,
  anthropicToResponses,
  mapResponsesToolChoice,
  responsesReasoning,
  responsesToAnthropic,
} from '../../../runtimes/claude/translate-responses';
import { eventData, events } from './helpers/sse';

describe('anthropicToResponses', () => {
  it('maps system to instructions, text items per role, tools and max_output_tokens', () => {
    const body = {
      system: 'sys',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
      tools: [{ name: 'Read', description: 'r', input_schema: { type: 'object' } }],
      max_tokens: 500,
    };
    const out = anthropicToResponses(body, 'gpt-6-luna');
    expect(out.instructions).toBe('sys');
    expect(out.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
    ]);
    expect(out.tools).toEqual([
      { type: 'function', name: 'Read', description: 'r', parameters: { type: 'object' } },
    ]);
    expect(out.max_output_tokens).toBe(500);
    expect(out.stream).toBe(false);
  });

  it('maps tool_use/tool_result (with synthesized id pairing) and drops thinking', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'tool_use', name: 'Read', input: { p: 1 } }, // no id
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', content: 'body' }] }, // no tool_use_id
      ],
    };
    const out = anthropicToResponses(body, 'gpt-6-luna');
    expect(out.input).toHaveLength(2);
    expect(out.input[0].type).toBe('function_call');
    expect(out.input[0].name).toBe('Read');
    expect(out.input[0].arguments).toBe('{"p":1}');
    expect(out.input[1].type).toBe('function_call_output');
    expect(out.input[1].call_id).toBe(out.input[0].call_id); // FIFO pairing
    expect(out.input[1].output).toBe('body');
  });

  it('rejects images, documents, unknown tool_choice and web-search server tools loudly', () => {
    expect(() =>
      anthropicToResponses({ messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }, 'gpt-6-luna'),
    ).toThrow(/does not accept image/);
    expect(() =>
      anthropicToResponses({ messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }] }, 'gpt-6-luna'),
    ).toThrow(/does not accept document/);
    expect(() =>
      anthropicToResponses(
        { messages: [], tools: [{ name: 'web_search' }], tool_choice: { type: 'any' } },
        'gpt-6-luna',
      ),
    ).toThrow(/not supported on the Responses path/);
    expect(() =>
      anthropicToResponses(
        { messages: [], tools: [{ name: 'web_search', type: 'web_search_20250305' }] },
        'gpt-6-luna',
      ),
    ).toThrow(/web search/);
  });

  it('maps tool_choice none by omitting tools entirely', () => {
    const out = anthropicToResponses(
      { messages: [], tools: [{ name: 'Read' }], tool_choice: { type: 'none' } },
      'gpt-6-luna',
    );
    expect(out.tools).toBeUndefined();
  });

  it('maps named tool_choice only for supported families', () => {
    const out = anthropicToResponses(
      { messages: [], tools: [{ name: 'Read' }], tool_choice: { type: 'tool', name: 'Read' } },
      'gpt-6-luna',
    );
    expect(out.tool_choice).toEqual({ type: 'function', name: 'Read' });
    expect(() =>
      anthropicToResponses(
        { messages: [], tools: [{ name: 'Read' }], tool_choice: { type: 'tool', name: 'Read' } },
        'muse-spark-1.3-contributor',
      ),
    ).toThrow(/does not accept a named tool_choice/);
  });

  it('maps reasoning effort with contributor max→xhigh rewrite', () => {
    expect(anthropicToResponses({ messages: [], thinking: { type: 'enabled', effort: 'high' } }, 'gpt-6-luna').reasoning).toEqual({
      effort: 'high',
    });
    expect(
      anthropicToResponses({ messages: [], thinking: { type: 'enabled', effort: 'max' } }, 'muse-spark-1.3-contributor').reasoning,
    ).toEqual({ effort: 'xhigh' });
    expect(anthropicToResponses({ messages: [] }, 'gpt-6-luna').reasoning).toBeUndefined();
    expect(() => responsesReasoning({ effort: 'bogus' }, 'gpt-6-luna')).toThrow(/does not accept/);
  });

  it('mapResponsesToolChoice handles auto/default', () => {
    expect(mapResponsesToolChoice(undefined, 'gpt-6-luna')).toBe('auto');
    expect(mapResponsesToolChoice('auto', 'gpt-6-luna')).toBe('auto');
    expect(mapResponsesToolChoice({ type: 'none' }, 'gpt-6-luna')).toBeNull();
  });
});

describe('responsesToAnthropic (non-stream)', () => {
  it('maps output text, function calls, status and usage', () => {
    const resp = {
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"p":1}' },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        input_tokens_details: { cached_tokens: 25 },
        cache_write_tokens: 5,
        output_tokens_details: { reasoning_tokens: 30 },
      },
    };
    const msg = responsesToAnthropic(resp, 'claude-x');
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(msg.content[1]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'Read', input: { p: 1 } });
    expect(msg.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 25,
      cache_creation_input_tokens: 5,
      reasoning_tokens: 30,
    });
  });

  it('maps incomplete statuses and throws on unknown reasons', () => {
    expect(
      responsesToAnthropic({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }] }, 'm').stop_reason,
    ).toBe('max_tokens');
    expect(
      responsesToAnthropic({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }, 'm').stop_reason,
    ).toBe('content_filter');
    expect(() => responsesToAnthropic({ status: 'incomplete', incomplete_details: { reason: 'wat' }, output: [] }, 'm')).toThrow(
      /unknown reason/,
    );
  });

  it('throws on failed statuses, hollow completions and invalid args', () => {
    expect(() => responsesToAnthropic({ status: 'failed', error: { message: 'boom' } }, 'm')).toThrow(/failed: boom/);
    expect(() => responsesToAnthropic({ status: 'completed', output: [{ type: 'reasoning' }] }, 'm')).toThrow(
      /completed with no content blocks \(dropped: reasoning\)/,
    );
    expect(() =>
      responsesToAnthropic({ status: 'completed', output: [{ type: 'function_call', name: 'x', arguments: 'nope' }] }, 'm'),
    ).toThrow(/invalid function-call arguments/);
  });
});

describe('ResponsesStreamTranslator', () => {
  function pushAll(t: ResponsesStreamTranslator, evts: Record<string, any>[]): string[] {
    const frames: string[] = [];
    for (const e of evts) frames.push(...t.push(e));
    return frames;
  }

  it('translates a text turn: lazy start, deltas, completed close', () => {
    const t = new ResponsesStreamTranslator({ requestedModel: 'claude-x', estimatedInput: 12, messageId: 'msg_1' });
    const frames = pushAll(t, [
      { type: 'response.created', response: {} },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
      { type: 'response.content_part.added', output_index: 0, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'he' },
      { type: 'response.output_text.delta', output_index: 0, delta: 'llo' },
      { type: 'response.output_text.done', output_index: 0, text: 'hello' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 20, output_tokens: 7, input_tokens_details: { cached_tokens: 3 } } },
      },
    ]);
    expect(events(frames)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(eventData(frames, 'content_block_delta').map((d) => d.delta.text).join('')).toBe('hello');
    const final = eventData(frames, 'message_delta')[0];
    expect(final.delta.stop_reason).toBe('end_turn');
    expect(final.usage.output_tokens).toBe(7);
    expect(final.usage.cache_read_input_tokens).toBe(3);
    expect(t.isTerminal).toBe(true);
  });

  it('translates a function call turn with argument deltas and tool_use close', () => {
    const t = new ResponsesStreamTranslator({ requestedModel: 'm', messageId: 'msg_2' });
    const frames = pushAll(t, [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_9', name: 'Read' },
      },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"p":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '1}' },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"p":1}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_9', name: 'Read' } },
      { type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 4 } } },
    ]);
    const start = eventData(frames, 'content_block_start')[0];
    expect(start.content_block).toMatchObject({ type: 'tool_use', id: 'call_9', name: 'Read' });
    const partial = eventData(frames, 'content_block_delta').map((d) => d.delta.partial_json).join('');
    expect(partial).toBe('{"p":1}');
    expect(eventData(frames, 'message_delta')[0].delta.stop_reason).toBe('tool_use');
  });

  it('closes a text block before opening a tool block', () => {
    const t = new ResponsesStreamTranslator({ requestedModel: 'm', messageId: 'msg_3' });
    const frames = pushAll(t, [
      { type: 'response.content_part.added', output_index: 0, part: { type: 'output_text' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'txt' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'c', name: 'T' } },
      { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{}' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call' } },
      { type: 'response.completed', response: {} },
    ]);
    const evts = events(frames);
    const textStop = evts.indexOf('content_block_stop');
    const toolStart = evts.indexOf('content_block_start', textStop);
    expect(textStop).toBeGreaterThan(-1);
    expect(toolStart).toBeGreaterThan(textStop);
  });

  it('treats missing terminal events as an error (fail closed)', () => {
    const t = new ResponsesStreamTranslator({ requestedModel: 'm', messageId: 'msg_4' });
    pushAll(t, [{ type: 'response.content_part.added', output_index: 0, part: { type: 'output_text' } }]);
    const frames = t.endOfStream();
    expect(events(frames)).toContain('error');
    expect(eventData(frames, 'error')[0].error.message).toMatch(/without a terminal event/);
  });

  it('incomplete max_output_tokens closes as max_tokens; truncated tool args raise', () => {
    const ok = new ResponsesStreamTranslator({ requestedModel: 'm', messageId: 'msg_5' });
    const frames = pushAll(ok, [
      { type: 'response.content_part.added', output_index: 0, part: { type: 'output_text' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'partial' },
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: {} } },
    ]);
    expect(eventData(frames, 'message_delta')[0].delta.stop_reason).toBe('max_tokens');

    const bad = new ResponsesStreamTranslator({ requestedModel: 'm', messageId: 'msg_6' });
    expect(() => {
      pushAll(bad, [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'T' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"p":' },
        { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
      ]);
    }).toThrow(/truncated a turn with 1 incomplete tool call/);
  });

  it('surfaces upstream failures as errors with partial frames attached', () => {
    const t = new ResponsesStreamTranslator({ requestedModel: 'm', messageId: 'msg_7' });
    pushAll(t, [{ type: 'response.content_part.added', output_index: 0, part: { type: 'output_text' } }]);
    let caught: StreamTranslationError | null = null;
    try {
      t.push({ type: 'response.failed', response: { error: { message: 'kaput' } } });
    } catch (e) {
      caught = e as StreamTranslationError;
    }
    expect(caught).toBeInstanceOf(StreamTranslationError);
    expect(caught?.message).toMatch(/kaput/);
    expect(caught?.frames.length).toBe(0);
  });

  it('fail() after start closes open blocks and emits an error event', () => {
    const t = new ResponsesStreamTranslator({ requestedModel: 'm', messageId: 'msg_8' });
    pushAll(t, [
      { type: 'response.content_part.added', output_index: 0, part: { type: 'output_text' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'x' },
    ]);
    const evts = events(t.fail('died'));
    expect(evts).toEqual(['content_block_stop', 'error']);
  });

  it('reports final usage through onFinalUsage on response.completed', () => {
    const seen: unknown[] = [];
    const t = new ResponsesStreamTranslator({
      requestedModel: 'm',
      messageId: 'msg_9',
      onFinalUsage: (u) => seen.push(u),
    });
    pushAll(t, [
      { type: 'response.created', response: {} },
      { type: 'response.output_text.delta', output_index: 0, delta: 'x' },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 9,
            output_tokens: 4,
            input_tokens_details: { cached_tokens: 3 },
            cache_write_tokens: 1,
          },
        },
      },
    ]);
    expect(seen).toEqual([
      { inputTokens: 9, outputTokens: 4, cacheReadTokens: 3, cacheCreationTokens: 1, measured: true },
    ]);
  });

  it('reports null without usage and tolerates a throwing callback', () => {
    const seen: unknown[] = [];
    const t = new ResponsesStreamTranslator({
      requestedModel: 'm',
      messageId: 'msg_10',
      onFinalUsage: (u) => seen.push(u),
    });
    pushAll(t, [
      { type: 'response.created', response: {} },
      { type: 'response.completed', response: {} },
    ]);
    expect(seen).toEqual([null]);

    const boom = new ResponsesStreamTranslator({
      requestedModel: 'm',
      messageId: 'msg_11',
      onFinalUsage: () => {
        throw new Error('boom');
      },
    });
    expect(() =>
      pushAll(boom, [
        { type: 'response.created', response: {} },
        { type: 'response.completed', response: {} },
      ]),
    ).not.toThrow();
  });
});
