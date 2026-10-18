import { describe, it, expect } from 'vitest';
import {
  ChatStreamTranslator,
  anthropicToOpenAI,
  applyChatExtras,
  estimateInputTokens,
  openAIToAnthropic,
  parseToolArgs,
} from '../../../runtimes/claude/translate-chat';
import { eventData, events, parseFrames } from './helpers/sse';

describe('anthropicToOpenAI', () => {
  it('maps system, messages, sampling and stop sequences', () => {
    const body = {
      model: 'x',
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ['END'],
    };
    const out = anthropicToOpenAI(body, 'deepseek-v4-pro');
    expect(out.messages[0]).toEqual({ role: 'system', content: 'be helpful' });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(out.max_tokens).toBe(100);
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.9);
    expect(out.stop).toEqual(['END']);
    expect(out.stream).toBe(false);
  });

  it('defaults max_tokens to 16384 and maps thinking budget to max_completion_tokens', () => {
    const plain = anthropicToOpenAI({ messages: [] }, 'm');
    expect(plain.max_tokens).toBe(16384);
    const thinking = anthropicToOpenAI(
      { messages: [], thinking: { type: 'enabled', budget_tokens: 32000 } },
      'deepseek-v4-pro',
    );
    expect(thinking.max_completion_tokens).toBe(32000);
  });

  it('converts images and text documents in system and content', () => {
    const body = {
      system: [
        { type: 'text', text: 'sys' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            {
              type: 'document',
              source: { type: 'base64', media_type: 'text/plain', data: Buffer.from('file text').toString('base64') },
            },
          ],
        },
      ],
    };
    const out = anthropicToOpenAI(body, 'm');
    expect(out.messages[0].content[0]).toEqual({ type: 'text', text: 'sys' });
    expect(out.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });
    const userMsg = out.messages[1];
    expect(userMsg.content[1]).toEqual({ type: 'text', text: 'file text' });
  });

  it('replays thinking blocks as reasoning_content and pads missing ones when thinking is on', () => {
    const body = {
      thinking: { type: 'enabled' },
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'because' }, { type: 'text', text: 'a' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      ],
    };
    const out = anthropicToOpenAI(body, 'deepseek-v4-pro');
    expect(out.messages[0].reasoning_content).toBe('because');
    expect(out.messages[1].reasoning_content).toBe(' ');
  });

  it('maps tool_use to tool_calls with stable ids and tool_result to tool role, results first', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling' },
            { type: 'tool_use', name: 'Read', input: { path: 'a.ts' } }, // no id
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_x', content: 'file body' },
            { type: 'text', text: 'next' },
          ],
        },
      ],
    };
    const out = anthropicToOpenAI(body, 'glm-5.3');
    const asst = out.messages[0];
    expect(asst.content).toBeNull();
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls[0].function.name).toBe('Read');
    expect(asst.tool_calls[0].function.arguments).toBe('{"path":"a.ts"}');
    expect(String(asst.tool_calls[0].id)).toMatch(/^toolu_Read_/);
    // tool result emitted BEFORE the containing user message.
    expect(out.messages[1]).toEqual({ role: 'tool', tool_call_id: 'toolu_x', content: 'file body' });
    expect(out.messages[2]).toEqual({ role: 'user', content: 'next' });
  });

  it('maps tools and tool_choice', () => {
    const body = {
      tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
      messages: [],
    };
    expect(anthropicToOpenAI(body, 'm').tool_choice).toBe('required');
    expect(
      anthropicToOpenAI({ ...body, tool_choice: { type: 'tool', name: 'Read' } }, 'm').tool_choice,
    ).toEqual({ type: 'function', function: { name: 'Read' } });
    expect(anthropicToOpenAI({ ...body, tool_choice: { type: 'auto' } }, 'm').tool_choice).toBe('auto');
  });
});

describe('applyChatExtras', () => {
  it('adds deepseek extras: thinking, effort, user_id, top_p, floors max_tokens', () => {
    const body: Record<string, any> = { max_tokens: 100 };
    const sent = applyChatExtras(body, 'deepseek-v4-pro', 'sess-1', 'high', 'enabled');
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
    expect(body.user_id).toMatch(/^[0-9a-f]{32}$/);
    expect(body.top_p).toBe(0.95);
    expect(body.max_tokens).toBe(65536);
    expect(sent).toEqual({ effortSent: 'high', thinkingSent: 'enabled' });
  });

  it('lets the client keep an explicit top_p and only raises max_tokens', () => {
    const body: Record<string, any> = { top_p: 0.5, max_tokens: 200000 };
    applyChatExtras(body, 'deepseek-v4-pro', 's', 'low', 'enabled');
    expect(body.top_p).toBe(0.5);
    expect(body.max_tokens).toBe(200000);
  });

  it('glm rejects an explicit disable', () => {
    expect(() => applyChatExtras({}, 'glm-5.3', 's', null, 'disabled')).toThrow(/cannot disable/);
  });

  it('no-ops for non-family models', () => {
    const body: Record<string, any> = {};
    const sent = applyChatExtras(body, 'kimi-k3', 's', 'high', 'enabled');
    expect(sent).toEqual({ effortSent: null, thinkingSent: null });
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('rejects required tool_choice with thinking on', () => {
    expect(() => applyChatExtras({ tool_choice: 'required' }, 'deepseek-v4-pro', 's', null, 'enabled')).toThrow(
      /rejects required\/named tool_choice/,
    );
    expect(() =>
      applyChatExtras({ tool_choice: { type: 'function', function: { name: 'x' } } }, 'glm-5.3', 's', null, null),
    ).toThrow(/rejects required\/named tool_choice/);
  });
});

describe('openAIToAnthropic', () => {
  it('maps reasoning, text, tool calls, stop reason and usage', () => {
    const resp = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            reasoning_content: 'thought',
            content: 'answer',
            tool_calls: [
              { id: 'call_1', function: { name: 'Read', arguments: '{"p":"a"}' } },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 30 },
        completion_tokens_details: { reasoning_tokens: 20 },
      },
    };
    const msg = openAIToAnthropic(resp, 'claude-x');
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content[0]).toEqual({ type: 'thinking', thinking: 'thought' });
    expect(msg.content[1]).toEqual({ type: 'text', text: 'answer' });
    expect(msg.content[2]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'Read', input: { p: 'a' } });
    expect(msg.usage.input_tokens).toBe(100);
    expect(msg.usage.output_tokens).toBe(50);
    expect(msg.usage.cache_read_input_tokens).toBe(30);
    expect(msg.usage.reasoning_tokens).toBe(20);
  });

  it('maps finish reasons to Anthropic stop reasons', () => {
    expect(openAIToAnthropic({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] }, 'm').stop_reason).toBe('end_turn');
    expect(openAIToAnthropic({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }, 'm').stop_reason).toBe('max_tokens');
    expect(openAIToAnthropic({ choices: [{ finish_reason: 'content_filter', message: { content: 'x' } }] }, 'm').stop_reason).toBe('content_filter');
  });

  it('throws on invalid tool arguments and hollow responses', () => {
    expect(() =>
      openAIToAnthropic({ choices: [{ message: { tool_calls: [{ function: { name: 'x', arguments: 'not json' } }] } }] }, 'm'),
    ).toThrow(/invalid function-call arguments/);
    expect(openAIToAnthropic({ choices: [{}] }, 'm').content).toEqual([{ type: 'text', text: '' }]);
  });

  it('parseToolArgs rejects arrays and non-objects', () => {
    expect(() => parseToolArgs('[1,2]')).toThrow(/not a JSON object/);
    expect(() => parseToolArgs('"str"')).toThrow(/not a JSON object/);
    expect(parseToolArgs('')).toEqual({});
  });
});

describe('estimateInputTokens', () => {
  it('estimates from system, tools and messages', () => {
    const body = {
      system: 'x'.repeat(300),
      tools: [{ name: 'T', description: 'd', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(300) }] }],
    };
    expect(estimateInputTokens(body)).toBeGreaterThan(150);
    expect(estimateInputTokens({})).toBe(1);
  });
});

describe('ChatStreamTranslator', () => {
  function pushChunks(translator: ChatStreamTranslator, chunks: unknown[]): string[] {
    const frames: string[] = [];
    for (const c of chunks) frames.push(...translator.push(`data: ${JSON.stringify(c)}\n\n`));
    return frames;
  }

  it('translates a plain text stream with usage and end_turn', () => {
    const t = new ChatStreamTranslator({ requestedModel: 'claude-x', estimatedInput: 42, messageId: 'msg_1' });
    const frames = pushChunks(t, [
      { choices: [{ delta: { content: 'he' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ]);
    frames.push(...t.finish());
    const evts = events(frames);
    expect(evts).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const start = eventData(frames, 'message_start')[0];
    expect(start.message.usage.input_tokens).toBe(42);
    const deltas = eventData(frames, 'content_block_delta').map((d) => d.delta.text).join('');
    expect(deltas).toBe('hello');
    const final = eventData(frames, 'message_delta')[0];
    expect(final.delta.stop_reason).toBe('end_turn');
    expect(final.usage.output_tokens).toBe(2);
    expect(final.usage.input_tokens).toBe(10);
  });

  it('orders a reasoning block before text and keeps stable indices', () => {
    const t = new ChatStreamTranslator({ requestedModel: 'm', messageId: 'msg_2' });
    const frames = pushChunks(t, [
      { choices: [{ delta: { reasoning_content: 'think' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'out' }, finish_reason: 'stop' }] },
    ]);
    frames.push(...t.finish());
    const starts = eventData(frames, 'content_block_start');
    expect(starts[0].content_block).toEqual({ type: 'thinking', thinking: '' });
    expect(starts[1].content_block).toEqual({ type: 'text', text: '' });
    const thinkingDeltas = eventData(frames, 'content_block_delta').filter((d) => d.delta.type === 'thinking_delta');
    expect(thinkingDeltas[0]).toMatchObject({ index: 0, delta: { thinking: 'think' } });
  });

  it('streams tool calls with input_json_delta and closes with tool_use', () => {
    const t = new ChatStreamTranslator({ requestedModel: 'm', messageId: 'msg_3' });
    const frames = pushChunks(t, [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Read', arguments: '{"p"' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]);
    frames.push(...t.finish());
    const start = eventData(frames, 'content_block_start')[0];
    expect(start.content_block).toMatchObject({ type: 'tool_use', id: 'call_a', name: 'Read' });
    const partial = eventData(frames, 'content_block_delta').map((d) => d.delta.partial_json).join('');
    expect(partial).toBe('{"p":"a"}');
    expect(eventData(frames, 'message_delta')[0].delta.stop_reason).toBe('tool_use');
    expect(events(frames)).toContain('message_stop');
  });

  it('supports multiple parallel tool calls on separate indices', () => {
    const t = new ChatStreamTranslator({ requestedModel: 'm', messageId: 'msg_4' });
    const frames = pushChunks(t, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'A', arguments: '{}' } },
                { index: 1, id: 'b', function: { name: 'B', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]);
    frames.push(...t.finish());
    const starts = eventData(frames, 'content_block_start');
    expect(starts.map((s) => s.index)).toEqual([0, 1]);
  });

  it('error-closes a length-truncated tool call without certifying it', () => {
    const t = new ChatStreamTranslator({ requestedModel: 'm', messageId: 'msg_5' });
    const frames = pushChunks(t, [
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call_z', function: { name: 'Read', arguments: '{"p":' } }] },
            finish_reason: 'length',
          },
        ],
      },
    ]);
    frames.push(...t.finish());
    expect(events(frames)).toContain('error');
    expect(eventData(frames, 'error')[0].error.message).toMatch(/cut off 1 tool call/);
    expect(events(frames)).not.toContain('message_delta');
    expect(events(frames)).not.toContain('message_stop');
  });

  it('emits a complete close even for an empty stream', () => {
    const t = new ChatStreamTranslator({ requestedModel: 'm', estimatedInput: 7, messageId: 'msg_6' });
    const frames = t.finish();
    expect(events(frames)).toEqual(['message_start', 'message_delta', 'message_stop']);
    expect(eventData(frames, 'message_delta')[0].usage.input_tokens).toBe(7);
  });

  it('fail() before start emits a lone error frame; after start closes cleanly', () => {
    const before = new ChatStreamTranslator({ requestedModel: 'm', messageId: 'msg_7' });
    expect(events(before.fail('boom'))).toEqual(['error']);

    const after = new ChatStreamTranslator({ requestedModel: 'm', messageId: 'msg_8' });
    pushChunks(after, [{ choices: [{ delta: { content: 'x' }, finish_reason: null }] }]);
    const frames = after.fail('boom');
    expect(events(frames)).toEqual(['content_block_stop', 'message_delta', 'message_stop']);
    expect(eventData(frames, 'message_delta')[0].delta.stop_reason).toBe('error');
  });

  it('combines cache read+creation into cache_read_input_tokens (reference parity)', () => {
    const t = new ChatStreamTranslator({ requestedModel: 'm', messageId: 'msg_9' });
    pushChunks(t, [
      {
        choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }],
      },
    ]);
    const frames = t.push(
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40, cache_creation: 10 } },
      })}\n\n`,
    );
    frames.push(...t.finish());
    const usage = eventData(frames, 'message_delta')[0].usage;
    expect(usage.cache_read_input_tokens).toBe(50);
  });

  it('tolerates chunk boundaries splitting SSE lines', () => {
    const t = new ChatStreamTranslator({ requestedModel: 'm', messageId: 'msg_10' });
    const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`;
    const frames = t.push(payload.slice(0, 20));
    frames.push(...t.push(payload.slice(20)));
    frames.push(...t.finish());
    expect(eventData(frames, 'content_block_delta')[0].delta.text).toBe('ok');
  });

  it('reports final usage through onFinalUsage on a clean close', () => {
    const seen: unknown[] = [];
    const t = new ChatStreamTranslator({
      requestedModel: 'm',
      messageId: 'msg_11',
      onFinalUsage: (u) => seen.push(u),
    });
    t.push(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
    t.push(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } })}\n\n`,
    );
    const frames = t.finish();
    expect(frames.some((f) => f.includes('message_stop'))).toBe(true);
    expect(seen).toEqual([
      { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheCreationTokens: 0, measured: true },
    ]);
  });

  it('drains an unterminated final usage line on finish (no trailing newline)', () => {
    const seen: unknown[] = [];
    const t = new ChatStreamTranslator({
      requestedModel: 'm',
      messageId: 'msg_14',
      onFinalUsage: (u) => seen.push(u),
    });
    t.push(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
    // Usage-only chunk at EOF without a trailing newline.
    t.push(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } })}`,
    );
    const frames = t.finish();
    expect(frames.some((f) => f.includes('message_stop'))).toBe(true);
    expect(seen).toEqual([
      { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheCreationTokens: 0, measured: true },
    ]);
  });

  it('reports null when the upstream gave no usage; fail() never reports', () => {
    const seen: unknown[] = [];
    const t = new ChatStreamTranslator({
      requestedModel: 'm',
      messageId: 'msg_12',
      onFinalUsage: (u) => seen.push(u),
    });
    t.push(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
    t.finish();
    expect(seen).toEqual([null]);
    t.fail('died');
    expect(seen).toEqual([null]);
  });

  it('a throwing onFinalUsage callback never breaks the stream', () => {
    const t = new ChatStreamTranslator({
      requestedModel: 'm',
      messageId: 'msg_13',
      onFinalUsage: () => {
        throw new Error('boom');
      },
    });
    t.push(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
    expect(() => t.finish()).not.toThrow();
  });
});
