/**
 * Bridge epoch wiring: era-labeled session identity (-eN / -rM) on the
 * upstream header + cache key, exact compaction notification, heuristic
 * compaction, stagnation rotation, kill switches and sidecar
 * persistence. Mock upstream only; thresholds are small and
 * deterministic (no live models, no spend).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, resolveEpochStateFile } from '../../../runtimes/claude/protocol-bridge';
import type { BridgeConfig, BridgeHandle } from '../../../runtimes/claude/protocol-bridge';
import { clearSharedEpochStores, readEpochStore } from '../../../runtimes/claude/epoch-store';
import { epochConstants } from '../../../runtimes/claude/session-epoch';

/** Small deterministic thresholds (loose parity with the reference fixture). */
const TEST_CONSTANTS = epochConstants({
  preFloor: 20,
  postFloor: 10,
  calm: 2,
  cooldown: 5,
  rotateBand: 2,
  rotateMinPin: 3,
  rotateMinGap: 4,
  rotateStreak: 2,
});

/** OpenCode 2.x client session id shape (12 hex + 14 base62). */
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const CLIENT_SHAPED_BASE = 'ses_0123456789abABCDEFGHIJKLMN';

interface Captured {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

interface ChatScriptEntry {
  prompt: number;
  cached: number;
  created?: number;
}

let upstream: http.Server;
let upstreamPort: number;
let captured: Captured[] = [];
let chatScript: ChatScriptEntry[] = [];

const bridges: BridgeHandle[] = [];
const tmpFiles: string[] = [];

async function makeGenericBridge(sessionId: string, extra: Partial<BridgeConfig> = {}): Promise<BridgeHandle> {
  const handle = await createBridge({
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    upstreamApiKey: 'upstream-key',
    sessionId,
    epochStateFile: false,
    epochConstants: TEST_CONSTANTS,
    maxAttempts: 1,
    ...extra,
  });
  bridges.push(handle);
  return handle;
}

async function makeOpencodeBridge(sessionId: string, extra: Partial<BridgeConfig> = {}): Promise<BridgeHandle> {
  const handle = await createBridge({
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/inference/go`,
    upstreamApiKey: 'upstream-key',
    sessionId,
    epochStateFile: false,
    epochConstants: TEST_CONSTANTS,
    maxAttempts: 1,
    modelAliasMap: { 'claude-opus-4-6': 'deepseek-v4-pro' },
    ...extra,
  });
  bridges.push(handle);
  return handle;
}

async function postMsg(
  bridge: BridgeHandle,
  opts: { model?: string; content: string; pad?: number; stream?: boolean },
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${bridge.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.model ?? 'llama-3-8b-instruct',
      max_tokens: 64,
      stream: opts.stream ?? false,
      messages: [{ role: 'user', content: `${opts.content} ` + 'word '.repeat(opts.pad ?? 0) }],
    }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function lastCall(pathSuffix: string): Captured {
  const found = [...captured].reverse().find((c) => c.path.endsWith(pathSuffix));
  if (!found) throw new Error(`no captured call for ${pathSuffix}`);
  return found;
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed: any = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = {};
      }
      captured.push({ path: req.url ?? '/', headers: req.headers, body: parsed });

      if (req.url === '/v1/chat/completions' || req.url === '/inference/go/openai/v1/chat/completions') {
        const scripted = chatScript.shift() ?? { prompt: 1, cached: 0 };
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
            usage: {
              prompt_tokens: scripted.prompt,
              completion_tokens: 5,
              cache_read_input_tokens: scripted.cached,
              ...(scripted.created !== undefined ? { cache_creation_input_tokens: scripted.created } : {}),
            },
          }),
        );
        return;
      }

      if (req.url === '/inference/go/anthropic/v1/messages') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'm1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'raw anthropic' }],
            model: parsed.model,
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 5,
              output_tokens: 3,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 1,
            },
          }),
        );
        return;
      }

      if (req.url === '/inference/go/openai/v1/responses') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses reply' }] }],
            usage: {
              input_tokens: 8,
              output_tokens: 1,
              input_tokens_details: { cached_tokens: 4 },
              cache_write_tokens: 2,
            },
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
});

afterAll(async () => {
  await Promise.all(bridges.splice(0).map((b) => b.close()));
  for (const f of tmpFiles.splice(0)) {
    try {
      fs.rmSync(path.dirname(f), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  captured = [];
  chatScript = [];
  clearSharedEpochStores();
});

describe('era identity (non-OpenCode bases)', () => {
  it('labels eras from birth on the header and the cache key', async () => {
    const bridge = await makeGenericBridge('sess-gen');
    const r = await postMsg(bridge, { content: 'a' });
    expect(r.status).toBe(200);
    const c = lastCall('/v1/chat/completions');
    expect(c.headers['x-opencode-session']).toBe('sess-gen-e0');
    expect(c.body.prompt_cache_key).toBe('sess-gen-e0');
    expect(c.body.prompt_cache_retention).toBe('24h');
  });

  it('heuristic compaction advances to -e1 exactly once (steady + shrink)', async () => {
    const bridge = await makeGenericBridge('sess-comp');
    for (const [tag, pad] of [
      ['g0', 100],
      ['g1', 110],
      ['g2', 120],
    ] as const) {
      await postMsg(bridge, { content: tag, pad });
      expect(lastCall('/v1/chat/completions').headers['x-opencode-session']).toBe('sess-comp-e0');
    }
    await postMsg(bridge, { content: 'compacted', pad: 20 });
    let c = lastCall('/v1/chat/completions');
    expect(c.headers['x-opencode-session']).toBe('sess-comp-e1');
    expect(c.body.prompt_cache_key).toBe('sess-comp-e1');
    // Same shrunken head again: no double bump.
    await postMsg(bridge, { content: 'compacted', pad: 20 });
    c = lastCall('/v1/chat/completions');
    expect(c.headers['x-opencode-session']).toBe('sess-comp-e1');
    expect(bridge.metrics.epochBumps).toBe(1);
  });

  it('exact compaction notification advances the era immediately', async () => {
    const bridge = await makeGenericBridge('sess-exact');
    await postMsg(bridge, { content: 'a' });
    expect(lastCall('/v1/chat/completions').headers['x-opencode-session']).toBe('sess-exact-e0');
    bridge.notifyCompaction();
    await postMsg(bridge, { content: 'b' });
    expect(lastCall('/v1/chat/completions').headers['x-opencode-session']).toBe('sess-exact-e1');
    expect(bridge.metrics.epochBumps).toBe(1);
  });

  it('stagnation rotation suffixes -r1 after the confirmed streak, holds in cooldown', async () => {
    const bridge = await makeGenericBridge('sess-rot');
    chatScript = [200, 210, 220, 230, 240].map((prompt) => ({ prompt, cached: 150 }));
    const pads = [100, 110, 120, 130, 140];
    const seen: string[] = [];
    for (let i = 0; i < pads.length; i += 1) {
      await postMsg(bridge, { content: `turn${i}`, pad: pads[i] });
      seen.push(String(lastCall('/v1/chat/completions').headers['x-opencode-session']));
    }
    expect(seen[0]).toBe('sess-rot-e0');
    expect(seen[1]).toBe('sess-rot-e0');
    expect(seen[2]).toBe('sess-rot-e0-r1');
    expect(seen[3]).toBe('sess-rot-e0-r1'); // cooldown holds
    expect(seen[4]).toBe('sess-rot-e0-r1');
    const c = lastCall('/v1/chat/completions');
    expect(c.body.prompt_cache_key).toBe('sess-rot-e0-r1');
    expect(bridge.metrics.epochRotations).toBe(1);
    expect(bridge.metrics.cacheReadTokens).toBe(750);
  });

  it('rotation kill switch tracks but never suffixes -r', async () => {
    const bridge = await makeGenericBridge('sess-norot', { epochRotateEnabled: false });
    chatScript = [200, 210, 220, 230, 240].map((prompt) => ({ prompt, cached: 150 }));
    const pads = [100, 110, 120, 130, 140];
    for (let i = 0; i < pads.length; i += 1) {
      await postMsg(bridge, { content: `turn${i}`, pad: pads[i] });
      expect(lastCall('/v1/chat/completions').headers['x-opencode-session']).toBe('sess-norot-e0');
    }
    expect(bridge.metrics.epochRotations).toBe(0);
  });

  it('epoch kill switch restores the verbatim session (tracking continues, no suffix)', async () => {
    const bridge = await makeGenericBridge('sess-noep', { epochEnabled: false });
    await postMsg(bridge, { content: 'a' });
    const c = lastCall('/v1/chat/completions');
    expect(c.headers['x-opencode-session']).toBe('sess-noep');
    expect(c.body.prompt_cache_key).toBe('sess-noep');
    expect(bridge.metrics.epochBumps).toBe(0);
  });

  it('CONDUKT_SESSION_EPOCH=false env brake wins over config (verbatim session)', async () => {
    process.env['CONDUKT_SESSION_EPOCH'] = 'false';
    try {
      const bridge = await makeGenericBridge('sess-envoff', { epochEnabled: true });
      await postMsg(bridge, { content: 'a' });
      const c = lastCall('/v1/chat/completions');
      expect(c.headers['x-opencode-session']).toBe('sess-envoff');
      expect(c.body.prompt_cache_key).toBe('sess-envoff');
    } finally {
      delete process.env['CONDUKT_SESSION_EPOCH'];
    }
  });

  it('CONDUKT_SESSION_ROTATE=false env brake suppresses -r suffixes', async () => {
    process.env['CONDUKT_SESSION_ROTATE'] = 'off';
    try {
      const bridge = await makeGenericBridge('sess-envrot', { epochRotateEnabled: true });
      chatScript = [200, 210, 220].map((prompt) => ({ prompt, cached: 150 }));
      const pads = [100, 110, 120];
      for (let i = 0; i < pads.length; i += 1) {
        await postMsg(bridge, { content: `turn${i}`, pad: pads[i] });
        expect(lastCall('/v1/chat/completions').headers['x-opencode-session']).toBe('sess-envrot-e0');
      }
      expect(bridge.metrics.epochRotations).toBe(0);
    } finally {
      delete process.env['CONDUKT_SESSION_ROTATE'];
    }
  });
});

describe('era identity (OpenCode bases)', () => {
  it('keeps a client-shaped base verbatim in era 0, mints a fresh id per later era', async () => {
    const bridge = await makeOpencodeBridge(CLIENT_SHAPED_BASE);
    await postMsg(bridge, { model: 'claude-opus-4-6', content: 'a' });
    const first = String(lastCall('/inference/go/openai/v1/chat/completions').headers['x-opencode-session']);
    expect(first).toBe(CLIENT_SHAPED_BASE);
    bridge.notifyCompaction();
    await postMsg(bridge, { model: 'claude-opus-4-6', content: 'b' });
    const second = String(lastCall('/inference/go/openai/v1/chat/completions').headers['x-opencode-session']);
    expect(second).toMatch(OPENCODE_SESSION_RE);
    expect(second).not.toBe(CLIENT_SHAPED_BASE);
    await postMsg(bridge, { model: 'claude-opus-4-6', content: 'c' });
    const third = String(lastCall('/inference/go/openai/v1/chat/completions').headers['x-opencode-session']);
    expect(third).toBe(second); // stable within the era
  });

  it('mints a client-shaped id for generic bases, fresh id after a bump', async () => {
    const bridge = await makeOpencodeBridge('sess-oc');
    await postMsg(bridge, { model: 'claude-opus-4-6', content: 'a' });
    const first = String(lastCall('/inference/go/openai/v1/chat/completions').headers['x-opencode-session']);
    expect(first).toMatch(OPENCODE_SESSION_RE);
    await postMsg(bridge, { model: 'claude-opus-4-6', content: 'b' });
    expect(String(lastCall('/inference/go/openai/v1/chat/completions').headers['x-opencode-session'])).toBe(first);
    bridge.notifyCompaction();
    await postMsg(bridge, { model: 'claude-opus-4-6', content: 'c' });
    const second = String(lastCall('/inference/go/openai/v1/chat/completions').headers['x-opencode-session']);
    expect(second).toMatch(OPENCODE_SESSION_RE);
    expect(second).not.toBe(first);
    // Cache key still carries the literal era suffix (Python parity).
    expect(lastCall('/inference/go/openai/v1/chat/completions').body.prompt_cache_key).toBe('sess-oc-e1');
  });

  it('era 0 keeps the OpenCode client shape on passthrough and responses paths', async () => {
    const bridge = await makeOpencodeBridge('sess-oc2', {
      modelAliasMap: {
        'claude-haiku-4-5': 'minimax-m3',
        'claude-sonnet-4-5': 'gpt-6-luna',
      },
    });
    await postMsg(bridge, { model: 'claude-haiku-4-5', content: 'a' });
    expect(String(lastCall('/inference/go/anthropic/v1/messages').headers['x-opencode-session'])).toMatch(
      OPENCODE_SESSION_RE,
    );
    await postMsg(bridge, { model: 'claude-sonnet-4-5', content: 'b' });
    expect(String(lastCall('/inference/go/openai/v1/responses').headers['x-opencode-session'])).toMatch(
      OPENCODE_SESSION_RE,
    );
  });
});

describe('persistence', () => {
  it('restores the era after a bridge restart via the sidecar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'condukt-bridge-epochs-'));
    const stateFile = path.join(dir, 'epochs.json');
    tmpFiles.push(stateFile);

    const first = await makeGenericBridge('sess-pers', { epochStateFile: stateFile });
    first.notifyCompaction();
    await postMsg(first, { content: 'a' });
    expect(lastCall('/v1/chat/completions').headers['x-opencode-session']).toBe('sess-pers-e1');
    await first.close();
    bridges.splice(bridges.indexOf(first), 1);

    // Simulated process restart: drop in-memory stores, reload from disk.
    clearSharedEpochStores();
    const onDisk = readEpochStore(stateFile, Date.now(), TEST_CONSTANTS);
    expect(onDisk['sess-pers']?.epoch).toBe(1);

    const second = await makeGenericBridge('sess-pers', { epochStateFile: stateFile });
    await postMsg(second, { content: 'b' });
    expect(lastCall('/v1/chat/completions').headers['x-opencode-session']).toBe('sess-pers-e1');
  });
});

describe('usage metrics', () => {
  it('sums cache read/write tokens across chat, anthropic and responses paths', async () => {
    const bridge = await makeOpencodeBridge('sess-metrics', {
      modelAliasMap: {
        'claude-opus-4-6': 'deepseek-v4-pro',
        'claude-haiku-4-5': 'minimax-m3',
        'claude-sonnet-4-5': 'gpt-6-luna',
      },
    });
    chatScript = [{ prompt: 10, cached: 2 }];
    await postMsg(bridge, { model: 'claude-opus-4-6', content: 'a' });
    await postMsg(bridge, { model: 'claude-haiku-4-5', content: 'b' });
    await postMsg(bridge, { model: 'claude-sonnet-4-5', content: 'c' });
    const m = bridge.metrics;
    expect(m.cacheReadTokens).toBe(2 + 3 + 4);
    expect(m.cacheWriteTokens).toBe(0 + 1 + 2);
  });
});

describe('review regression fixes', () => {
  /** Sidecar with one live entry (epoch 1) at a known baseline lastSeen. */
  function seedSidecar(dir: string, session: string, baseline: number): string {
    const stateFile = path.join(dir, 'epochs.json');
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        [session]: {
          epoch: 1,
          rot: 0,
          max: 5,
          calm: 0,
          seen: [],
          cooldown: 0,
          lastSeen: baseline,
          rebaseSize: 0,
          rebaseHits: 0,
          streak: 0,
          prevIn: null,
          prevCached: null,
          prevSize: null,
          streakHead: null,
        },
      }),
      'utf8',
    );
    return stateFile;
  }

  it('unusable-fingerprint requests never persist or extend the sidecar TTL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'condukt-bridge-junk-'));
    const baseline = Date.now() - 60_000;
    const stateFile = seedSidecar(dir, 'sess-junk', baseline);
    tmpFiles.push(stateFile);
    const bridge = await makeGenericBridge('sess-junk', { epochStateFile: stateFile });
    const before = fs.readFileSync(stateFile, 'utf8');
    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(`${bridge.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3-8b-instruct', max_tokens: 8, stream: false }),
      });
      await res.text();
    }
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(before);
    const stored = JSON.parse(before)['sess-junk'];
    expect(stored.lastSeen).toBe(baseline);
    expect(stored.epoch).toBe(1);
  });

  it('count_tokens requests never advance or touch epoch state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'condukt-bridge-ct-'));
    const baseline = Date.now() - 60_000;
    const stateFile = seedSidecar(dir, 'sess-ct', baseline);
    tmpFiles.push(stateFile);
    const bridge = await makeGenericBridge('sess-ct', { epochStateFile: stateFile });
    const before = fs.readFileSync(stateFile, 'utf8');
    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(`${bridge.baseUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3-8b-instruct', messages: [{ role: 'user', content: 'hello' }] }),
      });
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(bridge.metrics.epochBumps).toBe(0);
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(before);
  });

  it('chat user_id carries the era-suffixed session (reference parity)', async () => {
    const opts = { modelAliasMap: { 'claude-sonnet-4-5': 'deepseek-v4-pro' } };
    const on = await makeGenericBridge('sess-uid', opts);
    chatScript = [{ prompt: 10, cached: 0 }];
    await postMsg(on, { model: 'claude-sonnet-4-5', content: 'a' });
    const withEra = lastCall('/v1/chat/completions');
    expect(withEra.body.prompt_cache_key).toBe('sess-uid-e0');
    expect(typeof withEra.body.user_id).toBe('string');

    const off = await makeGenericBridge('sess-uid', { ...opts, epochEnabled: false });
    chatScript = [{ prompt: 10, cached: 0 }];
    await postMsg(off, { model: 'claude-sonnet-4-5', content: 'a' });
    const verbatim = lastCall('/v1/chat/completions');
    expect(verbatim.body.user_id).not.toBe(withEra.body.user_id);
  });

  it('two bridges sharing a sidecar do not clobber each other', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'condukt-bridge-shared-'));
    const stateFile = path.join(dir, 'epochs.json');
    tmpFiles.push(stateFile);
    const a = await makeGenericBridge('sess-a', { epochStateFile: stateFile });
    const b = await makeGenericBridge('sess-b', { epochStateFile: stateFile });
    a.notifyCompaction();
    b.notifyCompaction();
    await postMsg(a, { content: 'x' });
    await postMsg(b, { content: 'y' });
    expect(lastCall('/v1/chat/completions').headers['x-opencode-session']).toBe('sess-b-e1');
    clearSharedEpochStores();
    const onDisk = readEpochStore(stateFile, Date.now(), TEST_CONSTANTS);
    expect(onDisk['sess-a']?.epoch).toBe(1);
    expect(onDisk['sess-b']?.epoch).toBe(1);
  });

  it('retries with a fresh translator after a partially-consumed stream', async () => {
    let hits = 0;
    const flaky = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits += 1;
        if (hits === 1) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': '9999' });
          res.write('data: {"choices":[{"delta":{"content":"par');
          setTimeout(() => res.destroy(), 30);
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((r) => flaky.listen(0, () => r()));
    const flakyPort = (flaky.address() as AddressInfo).port;
    try {
      const bridge = await createBridge({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${flakyPort}/v1`,
        upstreamApiKey: 'upstream-key',
        sessionId: 'sess-retry',
        epochStateFile: false,
        epochConstants: TEST_CONSTANTS,
        maxAttempts: 2,
      });
      bridges.push(bridge);
      const r = await postMsg(bridge, { content: 'hi', stream: true });
      expect(r.status).toBe(200);
      expect(hits).toBe(2);
      expect(r.text).toContain('hello');
    } finally {
      await new Promise<void>((r) => flaky.close(() => r()));
    }
  });

  it('anthropic streaming usage tap drains the final unterminated line', async () => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
        );
        // Final usage line WITHOUT a trailing newline: only a drained
        // tap can see its cache counts.
        res.write(
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2,"cache_read_input_tokens":5}}',
        );
        res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, () => r()));
    const srvPort = (srv.address() as AddressInfo).port;
    try {
      const bridge = await createBridge({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${srvPort}/v1`,
        upstreamApiKey: 'upstream-key',
        sessionId: 'sess-tap',
        epochStateFile: false,
        epochConstants: TEST_CONSTANTS,
        maxAttempts: 1,
        modelAliasMap: { 'claude-haiku-4-5': 'minimax-m3' },
      });
      bridges.push(bridge);
      const r = await postMsg(bridge, { model: 'claude-haiku-4-5', content: 'a', stream: true });
      expect(r.status).toBe(200);
      expect(bridge.metrics.cacheReadTokens).toBe(5);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('responses streaming drains the final unterminated event at EOF', async () => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"hi"}\n\n',
        );
        // Final completing event WITHOUT a trailing newline.
        res.write(
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":9,"output_tokens":1,"input_tokens_details":{"cached_tokens":6}}}}',
        );
        res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, () => r()));
    const srvPort = (srv.address() as AddressInfo).port;
    try {
      const bridge = await createBridge({
        port: 0,
        upstreamBaseUrl: `http://127.0.0.1:${srvPort}/v1`,
        upstreamApiKey: 'upstream-key',
        sessionId: 'sess-tap2',
        epochStateFile: false,
        epochConstants: TEST_CONSTANTS,
        maxAttempts: 1,
        modelAliasMap: { 'claude-sonnet-4-5': 'gpt-6-luna' },
      });
      bridges.push(bridge);
      const r = await postMsg(bridge, { model: 'claude-sonnet-4-5', content: 'a', stream: true });
      expect(r.status).toBe(200);
      expect(r.text).toContain('message_stop');
      expect(bridge.metrics.cacheReadTokens).toBe(6);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('sidecar path resolution', () => {
  it('follows explicit > CONDUKT_EPOCH_PATH > stateFile sibling; false disables; runners skip the home default', () => {
    const cfg = (c: Record<string, unknown>) => c as unknown as BridgeConfig;
    expect(resolveEpochStateFile(cfg({ epochStateFile: false }))).toBeNull();
    expect(resolveEpochStateFile(cfg({ epochStateFile: '/custom/e.json' }))).toBe('/custom/e.json');
    process.env['CONDUKT_EPOCH_PATH'] = '/env/e.json';
    try {
      expect(resolveEpochStateFile(cfg({}))).toBe('/env/e.json');
      expect(resolveEpochStateFile(cfg({ stateFile: '/s/state.json' }))).toBe('/env/e.json');
    } finally {
      delete process.env['CONDUKT_EPOCH_PATH'];
    }
    expect(resolveEpochStateFile(cfg({ stateFile: '/s/state.json' }))).toBe('/s/state.json.epochs.json');
    // VITEST is set by the runner: the ~/.condukt default is skipped.
    expect(resolveEpochStateFile(cfg({}))).toBeNull();
  });
});
