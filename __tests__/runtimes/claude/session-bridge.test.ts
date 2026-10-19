import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ClaudeAgentSession } from '../../../runtimes/claude/claude-session';
import { ClaudeAgentRuntime } from '../../../runtimes/claude/claude-runtime';
import { buildBridgeEnv } from '../../../runtimes/claude/protocol-bridge';
import type { SessionConfig } from '../../../src/types';

function baseConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    model: 'claude-sonnet-4-5',
    cwd: process.cwd(),
    addDirs: [],
    timeout: 30,
    heartbeatTimeout: 30,
    ...overrides,
  } as SessionConfig;
}

describe('session bridge wiring', () => {
  it('buildBridgeEnv points the CLI at the bridge with fake creds and optional secret header', async () => {
    const handle = { baseUrl: 'http://127.0.0.1:9999' } as any;
    expect(buildBridgeEnv(handle)).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
      ANTHROPIC_API_KEY: 'condukt-bridge-key',
      ANTHROPIC_AUTH_TOKEN: 'condukt-bridge-key',
    });
    const withSecret = buildBridgeEnv(handle, { bridgeSecret: 's3' });
    expect(withSecret['ANTHROPIC_CUSTOM_HEADERS']).toBe('x-condukt-bridge-secret: s3');
  });

  it('ensureBridge is null without configuration and starts/closes with configuration', async () => {
    const upstream = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [], usage: {} }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, () => resolve()));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const plain = new ClaudeAgentSession(baseConfig());
    expect(await plain.ensureBridge()).toBeNull();

    const session = new ClaudeAgentSession(baseConfig(), undefined, {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      sessionId: 'sess-bridge-test',
      bridgeSecret: 'sek',
    });
    const handle = await session.ensureBridge();
    expect(handle).not.toBeNull();
    expect(handle!.port).toBeGreaterThan(0);

    // Second call returns the same handle (no duplicate listeners).
    expect(await session.ensureBridge()).toBe(handle);

    // Bridge is live and enforcing the inbound secret.
    const denied = await fetch(`${handle!.baseUrl}/v1/models`);
    expect(denied.status).toBe(401);
    const ok = await fetch(`${handle!.baseUrl}/v1/models`, {
      headers: { 'x-condukt-bridge-secret': 'sek' },
    });
    expect(ok.status).toBe(200);

    await session.abort();
    // After abort the listener is closed.
    await expect(fetch(`${handle!.baseUrl}/v1/models`)).rejects.toThrow();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('runtime options pass the bridge config through to sessions', async () => {
    const runtime = new ClaudeAgentRuntime({
      bridge: { upstreamBaseUrl: 'https://opencode.ai/inference/go', sessionId: 'sess-runtime' },
    });
    const session = (await runtime.createSession(baseConfig())) as ClaudeAgentSession;
    const handle = await session.ensureBridge();
    expect(handle!.endpoints.responses).toBe('https://opencode.ai/inference/go/openai/v1/responses');
    await session.abort();
  });

  it('session-level claude.epoch config wins over bridge defaults (observable upstream)', async () => {
    const captured: string[] = [];
    const upstream = http.createServer((req, res) => {
      captured.push(String(req.headers['x-opencode-session'] ?? ''));
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, () => resolve()));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const post = (baseUrl: string) =>
      fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3-8b-instruct',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

    // Session config disables epochs: verbatim session id upstream.
    const epochOff = new ClaudeAgentSession(
      baseConfig({ claude: { epoch: { enabled: false } } }),
      undefined,
      {
        upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        sessionId: 'sess-lvl',
        epochEnabled: true,
        epochStateFile: false,
      },
    );
    const offHandle = await epochOff.ensureBridge();
    expect((await post(offHandle!.baseUrl)).status).toBe(200);
    expect(captured.at(-1)).toBe('sess-lvl');
    await epochOff.abort();

    // Default: era-labeled from birth.
    const epochOn = new ClaudeAgentSession(baseConfig(), undefined, {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      sessionId: 'sess-lvl',
      epochStateFile: false,
    });
    const onHandle = await epochOn.ensureBridge();
    expect((await post(onHandle!.baseUrl)).status).toBe(200);
    expect(captured.at(-1)).toBe('sess-lvl-e0');
    await epochOn.abort();

    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('session compaction events call bridge.notifyCompaction() on complete only', () => {
    const session = new ClaudeAgentSession(baseConfig());
    const calls: string[] = [];
    (session as any).bridgeHandle = { notifyCompaction: () => calls.push('bump') };
    const emitter = (session as any).buildEmitter();
    emitter.compaction('start', undefined);
    expect(calls).toEqual([]);
    emitter.compaction('complete', 'summary');
    expect(calls).toEqual(['bump']);
  });
});
