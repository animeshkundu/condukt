/**
 * Self-contained in-process protocol bridge.
 *
 * Exposes an Anthropic-compatible HTTP surface (for Claude SDK via
 * ANTHROPIC_BASE_URL) and translates to any of the three OpenCode Go /
 * Zen upstream protocols, applying cache instrumentation:
 *
 *   - anthropic  → raw pass-through (cache_control preserved)
 *   - openai     → chat/completions translation (request + SSE)
 *   - responses  → OpenAI Responses translation (request + SSE)
 *
 * Routing is model-driven (see protocol-router.ts), session-stickiness
 * uses the `x-opencode-session` header, and prompt-cache keys are stamped
 * on chat/completions with a 400-downgrade fallback. Requests to OpenCode
 * hosts present the OpenCode client identity the Console expects (client
 * User-Agent, `x-opencode-client`, client-shaped session id). Binds 127.0.0.1.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DowngradeSet,
  cacheKeyExcluded,
  cacheKeyFor,
  isCacheFieldRejection,
  upstreamUsageFromAnthropic,
  upstreamUsageFromOpenAI,
  upstreamUsageFromResponses,
  type UpstreamTurnUsage,
} from './bridge-cache';
import {
  applySessionEpoch,
  bumpEpochOnCompaction,
  epochConstants,
  initialEpochState,
  noteTurn,
  type SessionEpochConstants,
  type SessionEpochState,
} from './session-epoch';
import { epochEntry, sharedEpochStore, writeEpochStore } from './epoch-store';
import {
  type ProtocolId,
  PROTOCOL_IDS,
  deriveEndpoints,
  deriveZenBase,
  resolveProtocol,
  resolveBase,
  blockedReason,
  recognizeBase,
  isOpencodeSessionId,
  mintOpencodeSessionId,
  sanitizeSessionValue,
} from './protocol-router';
import {
  ChatStreamTranslator,
  anthropicToOpenAI,
  applyChatExtras,
  estimateInputTokens,
  extractEffort,
  extractThinkingType,
  openAIToAnthropic,
} from './translate-chat';
import {
  ResponsesStreamTranslator,
  StreamTranslationError,
  anthropicToResponses,
  responsesToAnthropic,
} from './translate-responses';
import { createLineReader, parseDataLine } from './sse';

export interface BridgeConfig {
  readonly port: number;
  /** Upstream base URL (opencode base, /v1 base, or host base). */
  readonly upstreamBaseUrl: string;
  readonly upstreamApiKey?: string;
  readonly sessionId: string;
  readonly modelAliasMap?: Readonly<Record<string, string>>;
  /** Force a single upstream protocol for every model. */
  readonly protocol?: ProtocolId;
  /** Explicit per-model protocol overrides (win over docs tables). */
  readonly protocolMap?: Readonly<Record<string, ProtocolId>>;
  /** Explicit per-protocol endpoint overrides (win over derivation). */
  readonly endpoints?: Partial<Record<ProtocolId, string>>;
  /** Optional Console (Zen) base URL for gap-fill of Zen-only models. */
  readonly zenBaseUrl?: string;
  /** Explicit per-protocol Zen endpoint overrides (win over derivation). */
  readonly zenEndpoints?: Partial<Record<ProtocolId, string>>;
  readonly bridgeSecret?: string;
  readonly stateFile?: string;
  readonly maxBodyBytes?: number;
  readonly userAgent?: string;
  readonly maxAttempts?: number;
  readonly requestTimeoutMs?: number;
  readonly keepAliveMs?: number;
  readonly idleTimeoutMs?: number;
  /** Kill-switch for prompt-cache stamping (default on). */
  readonly cacheKeyEnabled?: boolean;
  /** Kill-switch for session compaction epochs (-eN / -rM, default on). */
  readonly epochEnabled?: boolean;
  /** Kill-switch for stagnation rotation (-rM, requires epochs, default on). */
  readonly epochRotateEnabled?: boolean;
  /** Epoch sidecar path, or false to disable persistence. */
  readonly epochStateFile?: string | false;
  /** Threshold overrides for the epoch/rotation triggers (tests). */
  readonly epochConstants?: Partial<SessionEpochConstants>;
}

export interface BridgeMetrics {
  readonly requestCount: number;
  readonly downgradeCount: number;
  readonly cacheStampedCount: number;
  readonly errorCount: number;
  /** Exact/heuristic compaction bumps observed (eras advanced). */
  readonly epochBumps: number;
  /** Stagnation rotations observed (-rM advances). */
  readonly epochRotations: number;
  /** Prompt-cache read tokens summed over measured turns. */
  readonly cacheReadTokens: number;
  /** Prompt-cache creation tokens summed over measured turns. */
  readonly cacheWriteTokens: number;
  readonly protocolCounts: Readonly<Record<ProtocolId, number>>;
}

export interface BridgeHandle {
  readonly port: number;
  readonly baseUrl: string;
  readonly endpoints: Readonly<Record<ProtocolId, string>>;
  readonly zenEndpoints: Readonly<Record<ProtocolId, string>>;
  readonly metrics: BridgeMetrics;
  /**
   * Exact compaction notification (the Claude SDK emits a compact
   * boundary): advances the session era immediately so the first
   * post-compaction request already carries the fresh identity.
   */
  notifyCompaction(): void;
  close(): Promise<void>;
}

/**
 * Per-session bridge configuration: everything from BridgeConfig except
 * the port (0 = ephemeral) and session id (fresh per session by default,
 * so prompt-cache keys stay isolated between sessions).
 */
export interface BridgeRuntimeConfig extends Omit<BridgeConfig, 'port' | 'sessionId'> {
  readonly port?: number;
  /** Force a fixed session id (tests / deliberate cache clustering). */
  readonly sessionId?: string;
}

/**
 * Environment for pointing the Claude CLI at the in-process bridge.
 * The reference deployments use a fake key on both variables; the bridge
 * itself authenticates upstream with `upstreamApiKey`.
 */
export function buildBridgeEnv(
  handle: BridgeHandle,
  opts: { readonly bridgeSecret?: string; readonly apiKey?: string } = {},
): Record<string, string> {
  const key = opts.apiKey ?? 'condukt-bridge-key';
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: handle.baseUrl,
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_AUTH_TOKEN: key,
  };
  if (opts.bridgeSecret) {
    env['ANTHROPIC_CUSTOM_HEADERS'] = `x-condukt-bridge-secret: ${opts.bridgeSecret}`;
  }
  return env;
}

const DEFAULT_USER_AGENT = 'condukt-claude-bridge/0.1';
/**
 * OpenCode 2.x client User-Agent shape (`opencode/<channel>/<version>/<name>`,
 * packages/core/src/app.ts). The Console reads it to recognise the client, so
 * bridge requests to OpenCode hosts present it by default; `config.userAgent`
 * still overrides.
 */
export const OPENCODE_CLIENT_USER_AGENT = 'opencode/latest/2.0.32/cli';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_KEEP_ALIVE_MS = 45_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Abort signal that fires after `ms`, optionally chained to a parent
 * signal. `clear()` releases the timer so long fetches do not leak.
 */
export function timeoutSignal(ms: number, parent?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`request timed out after ${ms}ms`)), ms);
  const onParentAbort = () => ac.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) ac.abort(parent.reason);
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }
  return {
    signal: ac.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function anthropicErrorPayload(type: 'invalid_request_error' | 'api_error', message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

const EPOCH_SAVE_EVERY = 16;

/** Parse a boolean-ish env flag; null when unset/unrecognized. */
function envFlag(name: string): boolean | null {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  return null;
}

/** Opt-in stderr diagnostics (`CONDUKT_EPOCH_DEBUG=1`), parity with the reference logs. */
function epochDebug(message: string): void {
  const flag = process.env['CONDUKT_EPOCH_DEBUG'];
  if (flag === '1' || flag === 'true') {
    try {
      console.error(`[condukt-bridge] ${message}`);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Epoch sidecar resolution: explicit config → `CONDUKT_EPOCH_PATH` →
 * sibling of `stateFile` → default user path. `false` disables
 * persistence. The home default is skipped under test runners
 * (NODE_ENV=test / VITEST) so unit tests never write to a developer's
 * home directory.
 */
export function resolveEpochStateFile(config: BridgeConfig): string | null {
  if (config.epochStateFile === false) return null;
  if (typeof config.epochStateFile === 'string' && config.epochStateFile.trim()) {
    return config.epochStateFile;
  }
  const envPath = (process.env['CONDUKT_EPOCH_PATH'] ?? '').trim();
  if (envPath) return envPath;
  if (config.stateFile) return `${config.stateFile}.epochs.json`;
  if (process.env['NODE_ENV'] === 'test' || process.env['VITEST']) return null;
  const home = os.homedir();
  return home ? path.join(home, '.condukt', 'claude-session-epochs.json') : null;
}

export function createBridge(config: BridgeConfig): Promise<BridgeHandle> {
  try {
    return createBridgeUnsafe(config);
  } catch (e) {
    return Promise.reject(e);
  }
}

function createBridgeUnsafe(config: BridgeConfig): Promise<BridgeHandle> {
  if (!/^https?:\/\//i.test(config.upstreamBaseUrl)) {
    throw new Error('upstreamBaseUrl must start with http:// or https://');
  }
  const derived = deriveEndpoints(config.upstreamBaseUrl);
  const endpoints: Record<ProtocolId, string> = { ...derived, ...(config.endpoints ?? {}) };
  for (const id of PROTOCOL_IDS) {
    if (!/^https?:\/\//i.test(endpoints[id])) {
      throw new Error(`endpoint for protocol '${id}' must start with http:// or https://`);
    }
  }
  const zenBase =
    config.zenBaseUrl ??
    (recognizeBase(config.upstreamBaseUrl) === 'opencode' ? deriveZenBase(config.upstreamBaseUrl) : null);
  const zenDerived = zenBase ? deriveEndpoints(zenBase) : derived;
  const zenEndpoints: Record<ProtocolId, string> = { ...zenDerived, ...(config.zenEndpoints ?? {}) };
  for (const id of PROTOCOL_IDS) {
    if (!/^https?:\/\//i.test(zenEndpoints[id])) {
      throw new Error(`zen endpoint for protocol '${id}' must start with http:// or https://`);
    }
  }
  const maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const keepAliveMs = config.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const cacheKeyEnabled = config.cacheKeyEnabled ?? true;
  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  const opencodeBase = recognizeBase(config.upstreamBaseUrl) === 'opencode';
  const opencodeUserAgent = config.userAgent ?? OPENCODE_CLIENT_USER_AGENT;
  // Epoch kill switches: `CONDUKT_SESSION_EPOCH=false` /
  // `CONDUKT_SESSION_ROTATE=false` force the corresponding feature off
  // even when config enables it (operator brake); `true` only supplies
  // the default. Config (session-level beats runtime-level, see
  // claude-session ensureBridge) wins over the env default.
  const epochEnv = envFlag('CONDUKT_SESSION_EPOCH');
  const rotateEnv = envFlag('CONDUKT_SESSION_ROTATE');
  const epochEnabled = epochEnv === false ? false : (config.epochEnabled ?? epochEnv ?? true);
  const epochRotateEnabled = rotateEnv === false ? false : (config.epochRotateEnabled ?? rotateEnv ?? true);
  const epochConst = epochConstants(config.epochConstants);
  const epochStateFile = resolveEpochStateFile(config);

  return new Promise<BridgeHandle>((resolve, reject) => {
    const downgrade = new DowngradeSet();
    const metrics = {
      requestCount: 0,
      downgradeCount: 0,
      cacheStampedCount: 0,
      errorCount: 0,
      epochBumps: 0,
      epochRotations: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      protocolCounts: { anthropic: 0, openai: 0, responses: 0 } as Record<ProtocolId, number>,
    };
    if (config.stateFile) {
      try {
        const raw = fs.readFileSync(config.stateFile, 'utf8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) for (const m of arr) downgrade.add(String(m));
      } catch {
        /* missing/corrupt state starts empty */
      }
    }
    const persist = () => {
      if (!config.stateFile) return;
      try {
        fs.writeFileSync(config.stateFile, JSON.stringify(downgrade.list()), 'utf8');
      } catch {
        /* ignore */
      }
    };

    // ── Session compaction epochs (-eN / -rM identity) ───────────────
    // One bridge serves one configured session; the tracked key is the
    // sanitized base id (pre-suffix, stable across eras). Persistence
    // shares one in-process store per resolved path so several bridges
    // in one process cannot clobber each other's keys.
    const baseSession = sanitizeSessionValue(config.sessionId);
    const epochStore = epochStateFile && baseSession ? sharedEpochStore(epochStateFile, Date.now(), epochConst) : null;
    const epochState: SessionEpochState | null = baseSession
      ? epochStore
        ? epochEntry(epochStore, baseSession, Date.now())
        : initialEpochState()
      : null;
    let epochSaveCalls = 0;

    function saveEpochState(sync: boolean): void {
      if (!epochStore || !epochStateFile || !epochState || !baseSession) return;
      if (sync) {
        // Bump/rotate/compaction: persist immediately (Python
        // `_epoch_save_now`), refreshing lastSeen on the exact event.
        epochState.lastSeen = Date.now();
      } else {
        // Throttled cadence (Python `_epoch_save`: every 16th call,
        // counted on the throttled path only).
        epochSaveCalls += 1;
        if (epochSaveCalls % EPOCH_SAVE_EVERY !== 0) return;
      }
      // Re-assert ownership: another bridge's write may have TTL-GC'd a
      // stale-looking key while this bridge was idle; this request proves
      // the session is alive, so keep its era attached.
      epochStore[baseSession] = epochState;
      writeEpochStore(epochStateFile, epochStore, Date.now(), epochConst);
    }

    /** Per-request verdict: effective (era-suffixed) session id + era flag. */
    function resolveEpochVerdict(body: Record<string, unknown>): { effective: string; advanced: boolean } {
      if (!baseSession || !epochState) return { effective: '', advanced: false };
      try {
        const verdict = applySessionEpoch(baseSession, epochState, body, {
          enabled: epochEnabled,
          rotate: epochRotateEnabled,
          constants: epochConst,
        });
        if (verdict.fired) {
          metrics.epochBumps += 1;
          saveEpochState(true);
          epochDebug(
            `epoch bump → ${verdict.effectiveSession} (max ${verdict.firedDetail?.prevMax ?? 0} → ${verdict.firedDetail?.size ?? 0} est tokens)`,
          );
        } else if (verdict.rotated) {
          metrics.epochRotations += 1;
          saveEpochState(true);
          epochDebug(
            `stagnation rotation → ${verdict.effectiveSession} (cached ${verdict.rotatedDetail?.prevCached ?? 0}, gap ${verdict.rotatedDetail?.gap ?? 0}, streak ${verdict.rotatedDetail?.prevStreak ?? 0})`,
          );
        } else if (verdict.observed) {
          // Read-only (unusable fingerprint) requests neither persist nor
          // extend the TTL (reference parity).
          saveEpochState(false);
        }
        return {
          effective: verdict.effectiveSession,
          advanced: verdict.fired || verdict.rotated || epochState.epoch > 0 || epochState.rot > 0,
        };
      } catch {
        return { effective: baseSession, advanced: false };
      }
    }

    /** Post-response usage note feeding the stagnation detector. */
    function noteEpochUsage(body: Record<string, unknown>, usage: UpstreamTurnUsage | null): void {
      if (!usage || !usage.measured) return;
      metrics.cacheReadTokens += usage.cacheReadTokens;
      metrics.cacheWriteTokens += usage.cacheCreationTokens;
      if (!epochState) return;
      try {
        // Note even a reported zero (reference parity): a 0-input turn is
        // an observation that resets a continuing streak, not a gap.
        const noted = noteTurn(
          epochState,
          body,
          usage.inputTokens,
          usage.cacheReadTokens + usage.cacheCreationTokens,
          true,
          epochConst,
          Date.now(),
        );
        if (noted) saveEpochState(false);
      } catch {
        /* observability only: usage notes never fail a request */
      }
    }

    /** Exact compaction observed on the SDK stream: advance immediately. */
    function notifyCompaction(): void {
      if (!epochEnabled || !epochState) return;
      try {
        bumpEpochOnCompaction(epochState, epochConst, Date.now());
        metrics.epochBumps += 1;
        saveEpochState(true);
        epochDebug(`exact compaction observed → epoch ${epochState.epoch}`);
      } catch {
        /* never fail a session on the epoch sidecar */
      }
    }

    // ── helpers ──────────────────────────────────────────────────────

    function headerValue(headers: http.IncomingHttpHeaders, name: string): string | null {
      const raw = headers[name];
      if (Array.isArray(raw)) return raw[0] ?? null;
      return typeof raw === 'string' ? raw : null;
    }

    function checkAuth(headers: http.IncomingHttpHeaders): boolean {
      if (!config.bridgeSecret) return true;
      return headerValue(headers, 'x-condukt-bridge-secret') === config.bridgeSecret;
    }

    // The Console free tier requires a client-shaped `x-opencode-session`;
    // mint one per configured session id so affinity stays stable.
    const opencodeSessions = new Map<string, string>();
    function opencodeSessionValue(session: string): string {
      if (isOpencodeSessionId(session)) return session;
      let minted = opencodeSessions.get(session);
      if (!minted) {
        minted = mintOpencodeSessionId();
        opencodeSessions.set(session, minted);
      }
      return minted;
    }

    function buildUpstreamHeaders(
      clientHeaders: http.IncomingHttpHeaders,
      protocol: ProtocolId,
      effectiveSession: string,
      eraAdvanced: boolean,
    ): Record<string, string> {
      const h: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': opencodeBase ? opencodeUserAgent : userAgent,
      };
      if (protocol === 'anthropic') {
        if (config.upstreamApiKey) h['x-api-key'] = config.upstreamApiKey;
        h['anthropic-version'] = headerValue(clientHeaders, 'anthropic-version') ?? '2023-06-01';
        const beta = headerValue(clientHeaders, 'anthropic-beta');
        if (beta) h['anthropic-beta'] = beta;
      } else if (config.upstreamApiKey) {
        h['authorization'] = `Bearer ${config.upstreamApiKey}`;
      }
      if (baseSession) {
        if (opencodeBase) {
          // Era 0 keeps the configured base verbatim (client-shaped ids
          // pass through, as before); post-bump eras mint a fresh
          // client-shaped id per era value so affinity rotates with the
          // cache namespace.
          h['x-opencode-session'] = opencodeSessionValue(eraAdvanced ? effectiveSession : baseSession);
        } else {
          // Non-OpenCode hosts get the literal era suffix from birth
          // (verbatim again under the epoch kill-switch).
          h['x-opencode-session'] = effectiveSession;
        }
      }
      if (opencodeBase) h['x-opencode-client'] = 'cli';
      return h;
    }

    function resolveForModel(requested: string): { protocol: ProtocolId; upstreamModel: string; endpoint: string; blocked: string | null } {
      const upstreamModel = config.modelAliasMap?.[requested] ?? requested;
      const blocked = blockedReason(upstreamModel);
      const protocol =
        config.protocol ??
        resolveProtocol(upstreamModel, { baseUrl: config.upstreamBaseUrl, protocolMap: config.protocolMap });
      // Zen gap-fill: Zen-only models use the Console base when available.
      const base = recognizeBase(config.upstreamBaseUrl) === 'opencode' ? resolveBase(upstreamModel) : 'go';
      const epSet = base === 'zen' ? zenEndpoints : endpoints;
      return { protocol, upstreamModel, endpoint: epSet[protocol], blocked };
    }

    function stripCacheFields(body: Record<string, unknown>): Record<string, unknown> {
      const copy = { ...body };
      delete copy['prompt_cache_key'];
      delete copy['prompt_cache_retention'];
      return copy;
    }

    function stampCacheKey(
      body: Record<string, unknown>,
      upstreamModel: string,
      effectiveSession: string,
    ): Record<string, unknown> {
      if (!cacheKeyEnabled) return body;
      if (cacheKeyExcluded(upstreamModel) || downgrade.has(upstreamModel)) {
        return stripCacheFields(body);
      }
      const key = cacheKeyFor(effectiveSession || baseSession || config.sessionId);
      if (!key) return body;
      metrics.cacheStampedCount += 1;
      return { ...body, prompt_cache_key: key, prompt_cache_retention: '24h' };
    }

    async function readBody(req: http.IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; tooLarge: boolean }> {
      const chunks: Buffer[] = [];
      let total = 0;
      let tooLarge = false;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxBodyBytes) {
          tooLarge = true;
          break;
        }
        chunks.push(buf);
      }
      if (tooLarge) {
        req.resume(); // drain so keep-alive connections do not stall
        return { ok: false, tooLarge: true };
      }
      return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
    }

    function sendJson(res: http.ServerResponse, status: number, payload: string): void {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(payload);
    }

    function sendError(res: http.ServerResponse, status: number, message: string): void {
      const type = status >= 400 && status < 500 ? 'invalid_request_error' : 'api_error';
      sendJson(res, status, anthropicErrorPayload(type, message));
    }

    /**
     * Read an upstream body with keepalive pings and idle detection.
     * `emit` receives decoded text chunks and may throw (translators do,
     * on fail-closed conditions); the error propagates to the caller.
     */
    async function pump(
      res: http.ServerResponse,
      reader: ReadableStreamDefaultReader<Uint8Array>,
      emit: (text: string) => void,
    ): Promise<void> {
      const decoder = new TextDecoder();
      let pending: Promise<ReadableStreamReadResult<Uint8Array>> = reader.read();
      let lastData = Date.now();
      while (true) {
        const state: {
          settled: boolean;
          result: ReadableStreamReadResult<Uint8Array> | null;
          error: unknown;
        } = { settled: false, result: null, error: null };
        await new Promise<void>((resolveRace) => {
          const timer = setTimeout(() => resolveRace(), keepAliveMs);
          pending.then(
            (r) => {
              clearTimeout(timer);
              state.settled = true;
              state.result = r;
              resolveRace();
            },
            (err) => {
              clearTimeout(timer);
              state.settled = true;
              state.error = err;
              resolveRace();
            },
          );
        });
        if (!state.settled) {
          if (Date.now() - lastData > idleTimeoutMs) throw new Error('upstream idle timeout');
          if (!res.writableEnded) res.write(': ping\n\n');
          continue;
        }
        if (state.error) throw state.error;
        const result = state.result;
        if (!result || result.done) return;
        lastData = Date.now();
        if (result.value && result.value.length > 0) {
          emit(decoder.decode(result.value, { stream: true }));
        }
        pending = reader.read();
      }
    }

    // ── request routing ──────────────────────────────────────────────

    async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      const method = req.method ?? 'GET';
      let pathname = '/';
      try {
        pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';
      } catch {
        sendError(res, 400, 'invalid request URL');
        return;
      }

      if (!checkAuth(req.headers)) {
        sendError(res, 401, 'unauthorized');
        return;
      }

      if (method === 'GET' && pathname === '/v1/models') {
        const ids = Object.keys(config.modelAliasMap ?? {});
        const now = new Date().toISOString();
        const data = ids.map((id) => ({ type: 'model', id, display_name: id, created_at: now }));
        sendJson(
          res,
          200,
          JSON.stringify({
            data,
            has_more: false,
            first_id: data[0]?.id ?? null,
            last_id: data[data.length - 1]?.id ?? null,
          }),
        );
        return;
      }

      if (method !== 'POST' || (pathname !== '/v1/messages' && pathname !== '/v1/messages/count_tokens')) {
        sendError(res, 404, 'not found');
        return;
      }

      const bodyResult = await readBody(req);
      if (!bodyResult.ok) {
        sendError(res, 413, 'request too large');
        return;
      }
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(bodyResult.text || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        body = parsed as Record<string, unknown>;
      } catch {
        sendError(res, 400, 'invalid JSON request body');
        return;
      }

      metrics.requestCount += 1;

      if (pathname === '/v1/messages/count_tokens') {
        sendJson(res, 200, JSON.stringify({ input_tokens: estimateInputTokens(body) }));
        return;
      }

      const requested = typeof body['model'] === 'string' ? body['model'] : '';
      if (!requested) {
        sendError(res, 400, 'model is required');
        return;
      }
      const { protocol, upstreamModel, endpoint, blocked } = resolveForModel(requested);
      if (blocked) {
        metrics.errorCount += 1;
        sendError(res, 400, `model ${requested} is not servable: ${blocked}`);
        return;
      }
      metrics.protocolCounts[protocol] += 1;
      const epochVerdict = resolveEpochVerdict(body);
      const upstreamHeaders = buildUpstreamHeaders(req.headers, protocol, epochVerdict.effective, epochVerdict.advanced);

      if (protocol === 'anthropic') {
        await handleAnthropicPassthrough(res, body, upstreamModel, endpoint, upstreamHeaders);
        return;
      }
      if (protocol === 'openai') {
        await handleChat(res, body, requested, upstreamModel, endpoint, upstreamHeaders, epochVerdict.effective);
        return;
      }
      await handleResponses(res, body, requested, upstreamModel, endpoint, upstreamHeaders, epochVerdict.effective);
    }

    // ── Anthropic pass-through ───────────────────────────────────────

    async function handleAnthropicPassthrough(
      res: http.ServerResponse,
      body: Record<string, unknown>,
      upstreamModel: string,
      endpoint: string,
      headers: Record<string, string>,
    ): Promise<void> {
      const stream = !!body['stream'];
      const payload = JSON.stringify({ ...body, model: upstreamModel });
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const ts = timeoutSignal(requestTimeoutMs);
        let upstream: Response;
        try {
          upstream = await fetch(endpoint, {
            method: 'POST',
            headers: { ...headers, accept: stream ? 'text/event-stream' : 'application/json' },
            body: payload,
            signal: ts.signal,
          });
        } catch (e) {
          ts.clear();
          if (attempt < maxAttempts && !res.headersSent) {
            await sleep(150 * attempt);
            continue;
          }
          metrics.errorCount += 1;
          sendError(res, 502, `upstream request failed: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        ts.clear();
        if (!upstream.ok) {
          const text = await upstream.text().catch(() => '');
          if (isRetryableStatus(upstream.status) && attempt < maxAttempts && !res.headersSent) {
            await sleep(150 * attempt);
            continue;
          }
          metrics.errorCount += 1;
          sendError(res, upstream.status || 502, `HTTP ${upstream.status}: ${text.slice(0, 1000)}`);
          return;
        }
        if (!stream) {
          const buf = Buffer.from(await upstream.arrayBuffer());
          try {
            const parsed = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
            noteEpochUsage(body, upstreamUsageFromAnthropic(parsed['usage']));
          } catch {
            /* non-JSON relay: no usage to note */
          }
          res.statusCode = 200;
          res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
          res.end(buf);
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');
        if (!upstream.body) {
          res.end();
          return;
        }
        // Raw relay with a passive usage tap: message_start carries the
        // input/cache counts, message_delta the output count. Bytes are
        // forwarded untouched; the tap only reads.
        const usageReader = createLineReader();
        let anthropicUsage: Record<string, unknown> = {};
        const tapUsage = (lines: readonly string[]) => {
          for (const line of lines) {
            const data = parseDataLine(line);
            if (!data) continue;
            try {
              const ev = JSON.parse(data) as Record<string, unknown>;
              if (ev['type'] === 'message_start') {
                const u = (ev['message'] as Record<string, unknown> | undefined)?.['usage'];
                if (u && typeof u === 'object') {
                  anthropicUsage = { ...anthropicUsage, ...(u as Record<string, unknown>) };
                }
              } else if (ev['type'] === 'message_delta' && ev['usage'] && typeof ev['usage'] === 'object') {
                anthropicUsage = { ...anthropicUsage, ...(ev['usage'] as Record<string, unknown>) };
              }
            } catch {
              /* non-JSON SSE payload */
            }
          }
        };
        try {
          await pump(res, upstream.body.getReader(), (text) => {
            if (!res.writableEnded) res.write(text);
            tapUsage(usageReader.push(text));
          });
          // Drain an unterminated trailing line (usage-only event at EOF).
          tapUsage(usageReader.flush());
          noteEpochUsage(
            body,
            upstreamUsageFromAnthropic(Object.keys(anthropicUsage).length > 0 ? anthropicUsage : null),
          );
        } catch (e) {
          metrics.errorCount += 1;
          if (!res.writableEnded) {
            res.write(
              `event: error\ndata: ${anthropicErrorPayload('api_error', e instanceof Error ? e.message : String(e))}\n\n`,
            );
          }
        } finally {
          res.end();
        }
        return;
      }
      if (!res.writableEnded) sendError(res, 502, 'upstream request failed after retries');
    }

    // ── shared post-with-retry (non-stream and stream fetches) ───────

    interface PostOutcome {
      readonly resp: Response | null;
      readonly error: Error | null;
    }

    /**
     * POST `payload` with retries. Returns the first successful response
     * (body not yet read) or an error carrying the last upstream failure.
     * Cache-field 400s downgrade the model once (stripping cache fields)
     * and retry.
     */
    async function postWithRetry(
      payload: Record<string, unknown>,
      endpoint: string,
      headers: Record<string, string>,
      upstreamModel: string,
      allowCacheDowngrade: boolean,
      streaming: boolean,
    ): Promise<PostOutcome> {
      let current = payload;
      let stripped = false;
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const ts = streaming ? timeoutSignal(requestTimeoutMs) : null; // stream: headers-only timeout
        let resp: Response;
        try {
          resp = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(current),
            signal: streaming ? ts?.signal : AbortSignal.timeout(requestTimeoutMs),
          });
        } catch (e) {
          ts?.clear();
          lastError = e instanceof Error ? e : new Error(String(e));
          if (attempt < maxAttempts) {
            await sleep(150 * attempt);
            continue;
          }
          return { resp: null, error: lastError };
        }
        ts?.clear();
        if (resp.ok) return { resp, error: null };
        const text = await resp.text().catch(() => '');
        if (resp.status === 400 && allowCacheDowngrade && !stripped && isCacheFieldRejection(400, text)) {
          downgrade.add(upstreamModel);
          metrics.downgradeCount += 1;
          persist();
          current = stripCacheFields(current);
          stripped = true;
          continue; // bounded by maxAttempts
        }
        if (isRetryableStatus(resp.status) && attempt < maxAttempts) {
          await sleep(150 * attempt);
          continue;
        }
        return { resp, error: new Error(`HTTP ${resp.status}: ${text.slice(0, 1000)}`) };
      }
      return { resp: null, error: lastError ?? new Error('upstream request failed') };
    }

    async function readJson(resp: Response): Promise<Record<string, unknown> | null> {
      try {
        const data = await resp.json();
        return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }

    // ── OpenAI chat/completions translation ──────────────────────────

    async function handleChat(
      res: http.ServerResponse,
      body: Record<string, unknown>,
      requested: string,
      upstreamModel: string,
      endpoint: string,
      headers: Record<string, string>,
      effectiveSession: string,
    ): Promise<void> {
      const stream = !!body['stream'];
      const oaiBody = anthropicToOpenAI(body, upstreamModel);
      try {
        // user_id carries the POST-epoch session (reference passes the
        // era-suffixed id), so KV-cache isolation follows the same
        // namespace separation the routing header/cache key do.
        applyChatExtras(
          oaiBody,
          upstreamModel,
          effectiveSession || config.sessionId,
          extractEffort(body),
          extractThinkingType(body),
        );
      } catch (e) {
        metrics.errorCount += 1;
        sendError(res, 400, e instanceof Error ? e.message : String(e));
        return;
      }
      const payload = stampCacheKey(oaiBody, upstreamModel, effectiveSession);
      // The OpenCode client always streams chat with usage reporting enabled;
      // mirror that for OpenCode hosts (Console gates read the request shape).
      if (stream && opencodeBase && payload['stream_options'] === undefined) {
        payload['stream_options'] = { include_usage: true };
      }
      const estimatedInput = estimateInputTokens(body);

      if (!stream) {
        const outcome = await postWithRetry(payload, endpoint, headers, upstreamModel, true, false);
        if (outcome.resp === null) {
          metrics.errorCount += 1;
          sendError(res, 502, outcome.error?.message ?? 'upstream request failed');
          return;
        }
        if (!outcome.resp.ok) {
          metrics.errorCount += 1;
          const text = await outcome.resp.text().catch(() => '');
          sendError(res, outcome.resp.status || 502, `HTTP ${outcome.resp.status}: ${text.slice(0, 1000)}`);
          return;
        }
        const data = await readJson(outcome.resp);
        if (!data) {
          metrics.errorCount += 1;
          sendError(res, 502, 'upstream returned a non-JSON body');
          return;
        }
        let converted: string;
        try {
          converted = JSON.stringify(openAIToAnthropic(data, requested));
        } catch (e) {
          metrics.errorCount += 1;
          sendError(res, 502, e instanceof Error ? e.message : String(e));
          return;
        }
        // Note usage only after successful conversion (reference parity:
        // a poisoned turn is an observation gap, not a streak event).
        noteEpochUsage(body, upstreamUsageFromOpenAI(data['usage']));
        sendJson(res, 200, converted);
        return;
      }

      // Streaming: fetch before sending SSE headers so pre-stream
      // failures produce a clean JSON error the SDK understands.
      let headersSent = false;
      let clientStarted = false;
      const makeTranslator = () =>
        new ChatStreamTranslator({
          requestedModel: requested,
          estimatedInput,
          onFinalUsage: (u) => noteEpochUsage(body, u),
        });
      let translator = makeTranslator();
      const writeFrames = (frames: readonly string[]) => {
        for (const f of frames) {
          if (res.writableEnded) return;
          res.write(f);
          clientStarted = true;
        }
      };
      const extraHeaders = { ...headers, accept: 'text/event-stream' };
      let currentPayload = payload;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        // Fresh translator per attempt: a failed attempt may have consumed
        // partial stream bytes (line buffer, usage-only chunk) without
        // emitting client frames, and that state must not leak into the
        // retry's stream.
        translator = makeTranslator();
        const ts = timeoutSignal(requestTimeoutMs);
        let upstream: Response;
        try {
          upstream = await fetch(endpoint, {
            method: 'POST',
            headers: extraHeaders,
            body: JSON.stringify(currentPayload),
            signal: ts.signal,
          });
        } catch (e) {
          ts.clear();
          if (!clientStarted && attempt < maxAttempts) {
            await sleep(150 * attempt);
            continue;
          }
          metrics.errorCount += 1;
          if (!headersSent) {
            sendError(res, 502, e instanceof Error ? e.message : String(e));
            return;
          }
          writeFrames(translator.fail(e instanceof Error ? e.message : String(e)));
          res.end();
          return;
        }
        ts.clear();
        if (!upstream.ok) {
          const text = await upstream.text().catch(() => '');
          if (
            upstream.status === 400 &&
            !downgrade.has(upstreamModel) &&
            isCacheFieldRejection(400, text)
          ) {
            downgrade.add(upstreamModel);
            metrics.downgradeCount += 1;
            persist();
            currentPayload = stripCacheFields(currentPayload);
            continue; // bounded by maxAttempts
          }
          if (isRetryableStatus(upstream.status) && !clientStarted && attempt < maxAttempts) {
            await sleep(150 * attempt);
            continue;
          }
          metrics.errorCount += 1;
          if (!headersSent) {
            sendError(res, upstream.status || 502, `HTTP ${upstream.status}: ${text.slice(0, 1000)}`);
            return;
          }
          writeFrames(translator.fail(`HTTP ${upstream.status}: ${text.slice(0, 300)}`));
          res.end();
          return;
        }
        if (!headersSent) {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/event-stream');
          res.setHeader('cache-control', 'no-cache');
          headersSent = true;
        }
        if (!upstream.body) {
          writeFrames(translator.finish());
          res.end();
          return;
        }
        try {
          await pump(res, upstream.body.getReader(), (text) => writeFrames(translator.push(text)));
          writeFrames(translator.finish());
          res.end();
          return;
        } catch (e) {
          if (!clientStarted && attempt < maxAttempts) continue;
          metrics.errorCount += 1;
          writeFrames(translator.fail(e instanceof Error ? e.message : String(e)));
          res.end();
          return;
        }
      }
      if (!res.writableEnded) {
        metrics.errorCount += 1;
        writeFrames(translator.fail('upstream request failed after retries'));
        res.end();
      }
    }

    // ── OpenAI Responses translation ─────────────────────────────────

    async function handleResponses(
      res: http.ServerResponse,
      body: Record<string, unknown>,
      requested: string,
      upstreamModel: string,
      endpoint: string,
      headers: Record<string, string>,
      _effectiveSession: string,
    ): Promise<void> {
      const stream = !!body['stream'];
      let rBody: Record<string, unknown>;
      try {
        rBody = anthropicToResponses(body, upstreamModel);
      } catch (e) {
        metrics.errorCount += 1;
        sendError(res, 400, e instanceof Error ? e.message : String(e));
        return;
      }
      const estimatedInput = estimateInputTokens(body);

      if (!stream) {
        const outcome = await postWithRetry(rBody, endpoint, headers, upstreamModel, false, false);
        if (outcome.resp === null) {
          metrics.errorCount += 1;
          sendError(res, 502, outcome.error?.message ?? 'upstream request failed');
          return;
        }
        if (!outcome.resp.ok) {
          metrics.errorCount += 1;
          const text = await outcome.resp.text().catch(() => '');
          sendError(res, outcome.resp.status || 502, `HTTP ${outcome.resp.status}: ${text.slice(0, 1000)}`);
          return;
        }
        const data = await readJson(outcome.resp);
        if (!data) {
          metrics.errorCount += 1;
          sendError(res, 502, 'upstream returned a non-JSON body');
          return;
        }
        let converted: string;
        try {
          converted = JSON.stringify(responsesToAnthropic(data, requested));
        } catch (e) {
          metrics.errorCount += 1;
          sendError(res, 502, e instanceof Error ? e.message : String(e));
          return;
        }
        // Note usage only after successful conversion (reference parity).
        noteEpochUsage(body, upstreamUsageFromResponses(data['usage']));
        sendJson(res, 200, converted);
        return;
      }

      let headersSent = false;
      let clientStarted = false;
      const makeTranslator = () =>
        new ResponsesStreamTranslator({
          requestedModel: requested,
          estimatedInput,
          onFinalUsage: (u) => noteEpochUsage(body, u),
        });
      let translator = makeTranslator();
      const writeFrames = (frames: readonly string[]) => {
        for (const f of frames) {
          if (res.writableEnded) return;
          res.write(f);
          clientStarted = true;
        }
      };
      const extraHeaders = { ...headers, accept: 'text/event-stream' };

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        // Fresh translator per attempt (see the chat handler note).
        translator = makeTranslator();
        const ts = timeoutSignal(requestTimeoutMs);
        let upstream: Response;
        try {
          upstream = await fetch(endpoint, {
            method: 'POST',
            headers: extraHeaders,
            body: JSON.stringify(rBody),
            signal: ts.signal,
          });
        } catch (e) {
          ts.clear();
          if (!clientStarted && attempt < maxAttempts) {
            await sleep(150 * attempt);
            continue;
          }
          metrics.errorCount += 1;
          if (!headersSent) {
            sendError(res, 502, e instanceof Error ? e.message : String(e));
            return;
          }
          writeFrames(translator.fail(e instanceof Error ? e.message : String(e)));
          res.end();
          return;
        }
        ts.clear();
        if (!upstream.ok) {
          const text = await upstream.text().catch(() => '');
          if (isRetryableStatus(upstream.status) && !clientStarted && attempt < maxAttempts) {
            await sleep(150 * attempt);
            continue;
          }
          metrics.errorCount += 1;
          if (!headersSent) {
            sendError(res, upstream.status || 502, `HTTP ${upstream.status}: ${text.slice(0, 1000)}`);
            return;
          }
          writeFrames(translator.fail(`HTTP ${upstream.status}: ${text.slice(0, 300)}`));
          res.end();
          return;
        }
        if (!headersSent) {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/event-stream');
          res.setHeader('cache-control', 'no-cache');
          headersSent = true;
        }
        if (!upstream.body) {
          writeFrames(translator.endOfStream());
          res.end();
          return;
        }
        const lineReader = createLineReader();
        const feedLines = (lines: readonly string[]) => {
          for (const line of lines) {
            const data = parseDataLine(line);
            if (!data) continue;
            let event: Record<string, unknown>;
            try {
              const parsed = JSON.parse(data);
              if (!parsed || typeof parsed !== 'object') continue;
              event = parsed as Record<string, unknown>;
            } catch {
              continue;
            }
            if (typeof event['type'] !== 'string') continue;
            writeFrames(translator.push(event));
            if (translator.isTerminal) break;
          }
        };
        try {
          await pump(res, upstream.body.getReader(), (text) => {
            // Write per event so a fail-closed throw mid-chunk cannot
            // discard frames already produced for earlier events.
            feedLines(lineReader.push(text));
          });
          // Drain an unterminated trailing line before finishing.
          if (!translator.isTerminal) feedLines(lineReader.flush());
          if (!translator.isTerminal) writeFrames(translator.endOfStream());
          res.end();
          return;
        } catch (e) {
          if (!clientStarted && attempt < maxAttempts) continue;
          metrics.errorCount += 1;
          if (e instanceof StreamTranslationError) writeFrames(e.frames);
          writeFrames(translator.fail(e instanceof Error ? e.message : String(e)));
          res.end();
          return;
        }
      }
      if (!res.writableEnded) {
        metrics.errorCount += 1;
        writeFrames(translator.fail('upstream request failed after retries'));
        res.end();
      }
    }

    // ── server / handle ──────────────────────────────────────────────

    const server = http.createServer((req, res) => {
      void handleRequest(req, res).catch((e) => {
        metrics.errorCount += 1;
        if (!res.headersSent) {
          sendError(res, 500, e instanceof Error ? e.message : String(e));
        } else {
          try {
            res.end();
          } catch {
            /* ignore */
          }
        }
      });
    });

    let actualPort = config.port;
    const handle: BridgeHandle = {
      get port() {
        return actualPort;
      },
      get baseUrl() {
        return `http://127.0.0.1:${actualPort}`;
      },
      endpoints,
      zenEndpoints,
      get metrics(): BridgeMetrics {
        return {
          requestCount: metrics.requestCount,
          downgradeCount: metrics.downgradeCount,
          cacheStampedCount: metrics.cacheStampedCount,
          errorCount: metrics.errorCount,
          epochBumps: metrics.epochBumps,
          epochRotations: metrics.epochRotations,
          cacheReadTokens: metrics.cacheReadTokens,
          cacheWriteTokens: metrics.cacheWriteTokens,
          protocolCounts: { ...metrics.protocolCounts },
        };
      },
      notifyCompaction: () => notifyCompaction(),
      close: () =>
        new Promise<void>((resolveClose) => {
          try {
            if (epochStore && epochStateFile && baseSession && epochState) {
              writeEpochStore(epochStateFile, epochStore, Date.now(), epochConst);
            }
          } catch {
            /* persistence is best effort */
          }
          try {
            server.closeAllConnections();
          } catch {
            /* older runtimes */
          }
          server.close(() => resolveClose());
        }),
    };

    server.on('error', (err) => {
      reject(err);
    });
    server.listen(config.port, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (addr && typeof addr === 'object') actualPort = addr.port;
      resolve(handle);
    });
  });
}
