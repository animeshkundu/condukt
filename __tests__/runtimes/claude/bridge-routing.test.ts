import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBridge } from '../../../runtimes/claude/protocol-bridge';
import type { BridgeHandle } from '../../../runtimes/claude/protocol-bridge';

interface Captured {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

/** OpenCode 2.x client session id shape (12 hex + 14 base62). */
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

describe('bridge routing (OpenCode Go parity)', () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let bridge: BridgeHandle;
  let genericBridge: BridgeHandle;
  let captured: Captured[] = [];
  let chatFailOnceWithCacheRejection = false;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed: any = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        captured.push({ path: req.url ?? '/', headers: req.headers, body: parsed });

        if (req.url === '/inference/go/anthropic/v1/messages') {
          if (parsed.stream) {
            res.setHeader('content-type', 'text/event-stream');
            res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 5 } } })}\n\n`);
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'raw' } })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            res.end();
          } else {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'raw anthropic' }], model: parsed.model, stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } }));
          }
          return;
        }

        if (req.url === '/inference/go/openai/v1/chat/completions') {
          if (parsed.model === 'missing-model') {
            res.statusCode = 404;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: { message: 'model not found' } }));
            return;
          }
          if (chatFailOnceWithCacheRejection) {
            chatFailOnceWithCacheRejection = false;
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: { message: 'Extra inputs are not permitted: prompt_cache_key' } }));
            return;
          }
          if (parsed.stream) {
            res.setHeader('content-type', 'text/event-stream');
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'rt' }, finish_reason: null }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                choices: [{ finish_reason: 'stop', message: { content: 'chat reply' } }],
                usage: { prompt_tokens: 10, completion_tokens: 2 },
              }),
            );
          }
          return;
        }

        if (req.url === '/inference/go/openai/v1/responses') {
          if (parsed.model === 'gpt-mid-fail') {
            res.setHeader('content-type', 'text/event-stream');
            const batch = [
              `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: {} })}\n\n`,
              `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'sent' })}\n\n`,
              `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'mid-chunk death' } } })}\n\n`,
            ].join('');
            res.write(batch); // single chunk: earlier frames must still reach the client
            res.end();
            return;
          }
          if (parsed.stream) {
            res.setHeader('content-type', 'text/event-stream');
            res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: {} })}\n\n`);
            res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'resp' })}\n\n`);
            res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 1 } } })}\n\n`);
            res.end();
          } else {
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                status: 'completed',
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses reply' }] }],
                usage: { input_tokens: 12, output_tokens: 4 },
              }),
            );
          }
          return;
        }

        if (req.url === '/inference/openai/v1/chat/completions') {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              choices: [{ finish_reason: 'stop', message: { content: 'zen reply' } }],
              usage: { prompt_tokens: 7, completion_tokens: 2 },
            }),
          );
          return;
        }

        if (req.url === '/v1/chat/completions') {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              choices: [{ finish_reason: 'stop', message: { content: 'generic reply' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          );
          return;
        }

        res.statusCode = 404;
        res.end('not found');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, () => resolve()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    bridge = await createBridge({
      port: 0,
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/inference/go`,
      upstreamApiKey: 'upstream-key',
      sessionId: 'session-abc',
      modelAliasMap: {
        'claude-sonnet-4-5': 'gpt-6-luna',
        'claude-opus-4-6': 'deepseek-v4-pro',
        'claude-haiku-4-5': 'minimax-m3',
        'claude-fail-4-5': 'gpt-mid-fail',
      },
      bridgeSecret: 'sekret',
      maxAttempts: 2,
    });

    genericBridge = await createBridge({
      port: 0,
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      upstreamApiKey: 'generic-key',
      sessionId: 'session-xyz',
      bridgeSecret: 'sekret',
    });
  });

  afterAll(async () => {
    await bridge.close();
    await genericBridge.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  beforeEach(() => {
    captured = [];
    chatFailOnceWithCacheRejection = false;
  });

  async function post(body: any): Promise<{ status: number; text: string; json: any }> {
    const res = await fetch(`${bridge.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-condukt-bridge-secret': 'sekret' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, text, json };
  }

  it('routes zen-only models to the derived Console base', async () => {
    const r = await post({
      model: 'space-bunny-free',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.status).toBe(200);
    expect(r.json.content).toEqual([{ type: 'text', text: 'zen reply' }]);
    const c = captured.find((x) => x.path === '/inference/openai/v1/chat/completions')!;
    expect(c).toBeTruthy();
    expect(c.body.model).toBe('space-bunny-free');
  });

  it('rejects unservable model ids without contacting upstream', async () => {
    const before = captured.length;
    const r = await post({
      model: 'gemini-4-argon',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/google-sdk-only/);
    expect(captured.length).toBe(before);
  });

  it('routes gpt-6-luna to the Responses endpoint and translates both ways', async () => {
    const r = await post({
      model: 'claude-sonnet-4-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(r.status).toBe(200);
    expect(r.json.content).toEqual([{ type: 'text', text: 'responses reply' }]);
    expect(r.json.stop_reason).toBe('end_turn');
    const c = captured.find((x) => x.path === '/inference/go/openai/v1/responses')!;
    expect(c).toBeTruthy();
    expect(c.body.model).toBe('gpt-6-luna');
    expect(c.body.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]);
    expect(c.headers['x-opencode-session']).toMatch(OPENCODE_SESSION_RE);
    expect(c.headers['authorization']).toBe('Bearer upstream-key');
    expect(c.headers['x-opencode-client']).toBe('cli');
    expect(String(c.headers['user-agent'])).toMatch(/^opencode\/latest\//);
  });

  it('routes deepseek to chat/completions with cache stamping and chat extras', async () => {
    const r = await post({
      model: 'claude-opus-4-6',
      max_tokens: 100,
      thinking: { type: 'enabled' },
      effort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.status).toBe(200);
    expect(r.json.content).toEqual([{ type: 'text', text: 'chat reply' }]);
    const c = captured.find((x) => x.path === '/inference/go/openai/v1/chat/completions')!;
    expect(c.body.prompt_cache_key).toBe('session-abc-e0');
    expect(c.body.prompt_cache_retention).toBe('24h');
    expect(c.body.reasoning_effort).toBe('high');
    expect(c.body.thinking).toEqual({ type: 'enabled' });
    expect(c.body.user_id).toMatch(/^[0-9a-f]{32}$/);
    expect(c.body.max_tokens).toBe(65536);
    expect(c.headers['x-opencode-session']).toMatch(OPENCODE_SESSION_RE);
  });

  it('passes minimax-m3 through the Anthropic protocol untouched (cache_control preserved)', async () => {
    const r = await post({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.status).toBe(200);
    expect(r.json.content).toEqual([{ type: 'text', text: 'raw anthropic' }]);
    const c = captured.find((x) => x.path === '/inference/go/anthropic/v1/messages')!;
    expect(c.body.model).toBe('minimax-m3');
    expect(c.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(c.headers['x-api-key']).toBe('upstream-key');
    expect(c.headers['anthropic-version']).toBe('2023-06-01');
    expect(c.headers['x-opencode-session']).toMatch(OPENCODE_SESSION_RE);
  });

  it('keeps a stable client-shaped session id across requests (OpenCode hosts)', async () => {
    await post({ model: 'claude-opus-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    const first = captured.at(-1)!.headers['x-opencode-session'];
    await post({ model: 'claude-opus-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'y' }] });
    const second = captured.at(-1)!.headers['x-opencode-session'];
    expect(String(first)).toMatch(OPENCODE_SESSION_RE);
    expect(second).toBe(first);
  });

  it('era-labels non-OpenCode bases (no client header, literal suffix)', async () => {
    const res = await fetch(`${genericBridge.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-condukt-bridge-secret': 'sekret' },
      body: JSON.stringify({ model: 'llama-3-8b-instruct', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const c = captured.find((x) => x.path === '/v1/chat/completions')!;
    expect(c).toBeTruthy();
    expect(c.body.model).toBe('llama-3-8b-instruct');
    expect(c.headers['x-opencode-session']).toBe('session-xyz-e0');
    expect(c.headers['x-opencode-client']).toBeUndefined();
    expect(String(c.headers['user-agent'])).toMatch(/condukt/);
  });

  it('streams chat with reasoning, text, tool calls and a clean close', async () => {
    const r = await fetch(`${bridge.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-condukt-bridge-secret': 'sekret' },
      body: JSON.stringify({ model: 'claude-opus-4-6', stream: true, messages: [{ role: 'user', content: 'go' }] }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    const text = await r.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('thinking_delta');
    expect(text).toContain('text_delta');
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('input_json_delta');
    expect(text).toContain('"stop_reason":"tool_use"');
    expect(text).toContain('event: message_stop');
  });

  it('streams responses protocol events back as Anthropic SSE', async () => {
    const r = await fetch(`${bridge.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-condukt-bridge-secret': 'sekret' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', stream: true, messages: [{ role: 'user', content: 'go' }] }),
    });
    const text = await r.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('"text_delta"');
    expect(text).toContain('"text":"resp"');
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain('event: message_stop');
  });

  it('preserves frames for events that arrived before a mid-chunk failure', async () => {
    const r = await fetch(`${bridge.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-condukt-bridge-secret': 'sekret' },
      body: JSON.stringify({ model: 'claude-fail-4-5', stream: true, messages: [{ role: 'user', content: 'go' }] }),
    });
    const text = await r.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('"text":"sent"');
    expect(text).toContain('event: error');
    expect(text).toContain('mid-chunk death');
  });

  it('downgrades cache fields on a signature 400 and retries bare', async () => {
    chatFailOnceWithCacheRejection = true;
    const r = await post({ model: 'claude-opus-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    expect(r.status).toBe(200);
    const chatCalls = captured.filter((x) => x.path === '/inference/go/openai/v1/chat/completions');
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[0].body.prompt_cache_key).toBeDefined();
    expect(chatCalls[1].body.prompt_cache_key).toBeUndefined();
    expect(bridge.metrics.downgradeCount).toBe(1);
    // Subsequent calls for the same model stay bare.
    const r2 = await post({ model: 'claude-opus-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'y' }] });
    expect(r2.status).toBe(200);
    const third = captured.filter((x) => x.path === '/inference/go/openai/v1/chat/completions')[2];
    expect(third.body.prompt_cache_key).toBeUndefined();
  });

  it('counts tokens and lists models', async () => {
    const ct = await fetch(`${bridge.baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-condukt-bridge-secret': 'sekret' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hello world' }] }),
    });
    expect(ct.status).toBe(200);
    const ctJson: any = await ct.json();
    expect(ctJson.input_tokens).toBeGreaterThan(0);

    const models = await fetch(`${bridge.baseUrl}/v1/models`, {
      headers: { 'x-condukt-bridge-secret': 'sekret' },
    });
    const modelsJson: any = await models.json();
    expect(modelsJson.data.map((m: any) => m.id).sort()).toEqual([
      'claude-fail-4-5',
      'claude-haiku-4-5',
      'claude-opus-4-6',
      'claude-sonnet-4-5',
    ]);
  });

  it('requires the bridge secret and reports per-protocol metrics', async () => {
    const denied = await fetch(`${bridge.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    });
    expect(denied.status).toBe(401);
    await post({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'x' }] });
    await post({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'x' }] });
    await post({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'x' }] });
    const m = bridge.metrics;
    expect(m.protocolCounts.responses).toBeGreaterThanOrEqual(1);
    expect(m.protocolCounts.openai).toBeGreaterThanOrEqual(1);
    expect(m.protocolCounts.anthropic).toBeGreaterThanOrEqual(1);
    expect(bridge.endpoints.responses).toContain('/openai/v1/responses');
  });

  it('reports upstream errors as Anthropic-shaped JSON', async () => {
    const r = await post({ model: 'missing-model', messages: [{ role: 'user', content: 'x' }] });
    expect(r.status).toBe(404);
    expect(r.json.type).toBe('error');
  });
});
