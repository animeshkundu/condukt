import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createBridge } from '../../../runtimes/claude/protocol-bridge';

describe('protocol-bridge', () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let bridge: any;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'text/event-stream');
        res.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, () => resolve()));
    upstreamPort = (upstream.address() as any).port;

    bridge = await createBridge({
      port: 0,
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      sessionId: 'sess1',
      modelAliasMap: { 'claude-sonnet-4-5': 'gpt-4o' },
    });
    // wait for listen
    await new Promise((r) => setTimeout(r, 100));
    // bridge port may be 0? server.listen(0) -> actual. But createBridge used port 0 and didn't expose. Re-create with fixed port.
  });

  afterAll(async () => {
    await bridge.close();
    upstream.close();
  });

  it('translates request and streams SSE', async () => {
    // Re-create bridge on a fixed port for test
    await bridge.close();
    const port = 18923;
    bridge = await createBridge({
      port,
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      sessionId: 'sess1',
      modelAliasMap: { 'claude-sonnet-4-5': 'gpt-4o' },
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('content_block_delta');
    expect(text).toContain('hi');
    expect(bridge.metrics.requestCount).toBeGreaterThanOrEqual(1);
    expect(bridge.metrics.cacheStampedCount).toBeGreaterThanOrEqual(1);
  });
});
