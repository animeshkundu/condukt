import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createBridge } from '../../../runtimes/claude/protocol-bridge';

describe('bridge non-stream + auth + body limit', () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let bridge: any;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'hello', tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"x":1}' } }] }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, () => resolve()));
    upstreamPort = (upstream.address() as any).port;
    bridge = await createBridge({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`, sessionId: 's', bridgeSecret: 'secret' });
  });

  afterAll(async () => {
    await bridge.close();
    upstream.close();
  });

  it('auth required', async () => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }) });
    expect(res.status).toBe(401);
  });

  it('non-stream translates tool calls', async () => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-condukt-bridge-secret': 'secret' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }) });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.content.some((c: any) => c.type === 'tool_use')).toBe(true);
    expect(data.content.some((c: any) => c.type === 'text' && c.text === 'hello')).toBe(true);
  });

  it('body size limit', async () => {
    const big = 'x'.repeat(100);
    const b = await createBridge({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`, sessionId: 's2', maxBodyBytes: 10 });
    const res = await fetch(`http://127.0.0.1:${b.port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: big }] }) });
    expect(res.status).toBe(413);
    await b.close();
  });
});
