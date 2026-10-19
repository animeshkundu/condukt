/**
 * Protocol routing for the in-process bridge (OpenCode Go / Zen parity).
 *
 * OpenCode serves models over three wire protocols:
 *   - Anthropic messages        (…/anthropic/v1/messages)
 *   - OpenAI chat/completions   (…/openai/v1/chat/completions)
 *   - OpenAI Responses          (…/openai/v1/responses)
 *
 * This module decides, per model id, which upstream protocol to speak and
 * which endpoint to use, and exposes the per-family capability tables the
 * converters validate against. Pure functions (plus the session-id minting
 * helper, which uses the system RNG); no network or filesystem I/O.
 *
 * Sources: opencode.ai Go docs endpoint table; zen gap-fill families;
 * family fallbacks mirror the reference proxy's protocols.py classification.
 */

import { randomBytes } from 'node:crypto';

export type ProtocolId = 'anthropic' | 'openai' | 'responses';

export const PROTOCOL_IDS: readonly ProtocolId[] = ['anthropic', 'openai', 'responses'];

// ── Docs tables (OpenCode Go) ────────────────────────────────────────
// Exact model ids and the protocol their endpoint speaks. Go is the
// primary catalog; familia fallbacks below cover drift ids.
const GO_RESPONSES = [
  'grok-4.7',
  'grok-4.6',
  'gpt-6-luna',
  'gpt-5.6-luna',
  'muse-spark-1.3-contributor',
  'muse-spark-1.2-contributor',
] as const;

const GO_ANTHROPIC = [
  'claude-haiku-5-5',
  'minimax-m3',
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
] as const;

const GO_OPENAI = [
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'longcat-2.0',
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'mimo-v2.6-flash',
  'mimo-v2.6-pro',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'hy4-preview',
  'hy3',
  'space-bunny',
  'longcat-2.5-preview-free',
  'step-5-preview',
  'beam-free',
  'minimax-m2.5',
  'minimax-m2.7',
] as const;

/** Explicit docs entries. OpenAI is also the default, but listing keeps the
 *  table self-documenting and lets tests assert the docs surface exactly. */
export const EXACT_PROTOCOLS: ReadonlyMap<string, ProtocolId> = (() => {
  const m = new Map<string, ProtocolId>();
  for (const id of GO_OPENAI) m.set(id, 'openai');
  for (const id of GO_ANTHROPIC) m.set(id, 'anthropic');
  for (const id of GO_RESPONSES) m.set(id, 'responses');
  return m;
})();

// ── Console (Zen) surface ────────────────────────────────────────────
// Model ids that exist on the Console surface but not on Go. Used for
// base resolution (Go vs Zen gap-fill) only; protocol resolution for
// these still uses family fallback + the default, matching the reference.
// Source: live console model list (opencode.ai/inference/v1/models).
const ZEN_ONLY_IDS = [
  'big-pickle',
  'space-bunny-free',
  'glm-5.3-flash-free',
  'deepseek-v4.1-flash-free',
  'nemotron-3.5-lightning-free',
  'nemotron-3.5-super-vl-free',
  'mimo-v2.6-flash-free',
  'mistral-large-4',
  'muse-spark-1.3',
  'claude-opus-5-5-backup',
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-5.6-terra',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'grok-build-0.1',
  'gemini-3.1-pro',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-4-argon',
  'jev-1.13',
  'jev-1.13-free',
  'test',
] as const;

export const ZEN_ONLY: ReadonlySet<string> = new Set(ZEN_ONLY_IDS.map((s) => s.toLowerCase()));

const FAMILY_FALLBACK: ReadonlyArray<readonly [string, ProtocolId]> = [
  ['gpt-', 'responses'],
  ['grok-', 'responses'],
  ['muse-spark-', 'responses'],
  ['claude-', 'anthropic'],
];

export function familyOf(modelId: string): string | null {
  const low = (modelId || '').toLowerCase();
  for (const [prefix] of FAMILY_FALLBACK) {
    if (low.startsWith(prefix)) return prefix.replace(/-$/, '');
  }
  return null;
}

export type BaseKind = 'opencode' | 'anthropic' | 'openai' | 'other';

/** Classify an upstream base URL so routing can prefer the right protocol. */
export function recognizeBase(baseUrl: string): BaseKind {
  const low = (baseUrl || '').toLowerCase();
  if (/(^|\.)opencode\.ai\//.test(low) || low.includes('/zen/') || low.includes('/inference')) return 'opencode';
  if (low.includes('anthropic')) return 'anthropic';
  if (low.includes('openai')) return 'openai';
  return 'other';
}

// ── Blocked models ────────────────────────────────────────────────────
// Ids the bridge cannot speak (google SDK shape, systemone shape, or
// unclassified catalog ids). Returns a human-readable reason or null.
export function blockedReason(modelId: string): string | null {
  const low = (modelId || '').toLowerCase().trim();
  if (!low) return null;
  if (low.startsWith('gemini-')) return 'google-sdk-only (proxy serves OpenAI/Anthropic protocols)';
  if (low.startsWith('jev-')) return 'systemone API (different request shape)';
  if (low === 'omen-alpha') return 'unclassified catalog id, not servable by this proxy';
  if (low === 'test') return 'non-model catalog entry';
  return null;
}

// ── Base resolution (Go vs Zen gap-fill) ─────────────────────────────
export type ModelBase = 'go' | 'zen';

export function resolveBase(modelId: string): ModelBase {
  const low = (modelId || '').toLowerCase().trim();
  if (EXACT_PROTOCOLS.has(low)) return 'go';
  if (ZEN_ONLY.has(low)) return 'zen';
  return 'go';
}

/** Derive the Console (Zen) base URL from a Go base URL, or null when
 *  no sensible counterpart exists. */
export function deriveZenBase(goBaseUrl: string): string | null {
  const base = (goBaseUrl || '').replace(/\/+$/, '');
  if (!base) return null;
  let m = base.match(/^(.*\/inference)\/go(\/v1)?$/i);
  if (m) return `${m[1]}${m[2] ?? ''}`;
  m = base.match(/^(.*\/zen)\/go(\/v1)?$/i);
  if (m) return `${m[1]}${m[2] ?? ''}`;
  return null;
}

export interface ResolveProtocolOptions {
  /** Upstream base URL (used to gate OpenCode-specific family fallbacks). */
  readonly baseUrl?: string;
  /** Explicit per-model overrides; always win. */
  readonly protocolMap?: Readonly<Record<string, ProtocolId>>;
  /** Force a protocol for every model (single-protocol upstreams). */
  readonly protocol?: ProtocolId;
}

/**
 * Decide the upstream protocol for a model id.
 *
 * Precedence:
 *   1. explicit `protocol` (config force)
 *   2. explicit `protocolMap[model]`
 *   3. docs table exact match (opencode ids)
 *   4. family fallback when the base is an OpenCode base (drift ids)
 *   5. anthropic host → anthropic when the id looks anthropic-native
 *   6. openai (chat/completions) — the compatible default
 */
export function resolveProtocol(modelId: string, opts: ResolveProtocolOptions = {}): ProtocolId {
  const low = (modelId || '').toLowerCase().trim();
  if (opts.protocol) return opts.protocol;
  const mapped = opts.protocolMap?.[modelId] ?? opts.protocolMap?.[low];
  if (mapped) return mapped;
  const exact = EXACT_PROTOCOLS.get(low);
  if (exact) return exact;
  const kind = recognizeBase(opts.baseUrl ?? '');
  if (kind === 'opencode') {
    for (const [prefix, protocol] of FAMILY_FALLBACK) {
      if (low.startsWith(prefix)) return protocol;
    }
    return 'openai';
  }
  if (kind === 'anthropic') return 'anthropic';
  // Generic OpenAI-compatible upstream (LM Studio, vLLM, gateways…):
  // chat/completions is the safe default.
  return 'openai';
}

// ── Endpoint derivation ──────────────────────────────────────────────

export interface DerivedEndpoints {
  readonly anthropic: string;
  readonly openai: string;
  readonly responses: string;
}

/**
 * Derive the three protocol endpoints from one base URL.
 *
 * Recognized shapes:
 *   - `https://opencode.ai/inference/go`   → /anthropic/v1/messages, /openai/v1/…
 *   - `https://opencode.ai/zen/go`         → same as above
 *   - `https://opencode.ai/zen/go/v1`      → /messages, /chat/completions, /responses
 *   - `http://host/v1`                     → /messages, /chat/completions, /responses
 *   - `https://api.example.com`            → /v1/messages, /v1/chat/completions, …
 */
export function deriveEndpoints(baseUrl: string): DerivedEndpoints {
  const base = (baseUrl || '').replace(/\/+$/, '');
  if (!base) {
    throw new Error('upstreamBaseUrl must be a non-empty URL');
  }
  // OpenCode inference family (Go + Console): docs shape {base}/{protocol}/v1/...
  if (/\/(inference)(\/go)?$/i.test(base)) {
    return {
      anthropic: `${base}/anthropic/v1/messages`,
      openai: `${base}/openai/v1/chat/completions`,
      responses: `${base}/openai/v1/responses`,
    };
  }
  // OpenCode zen family: conventional {base}/v1/...
  if (/\/(zen)(\/go)?$/i.test(base)) {
    const v1 = /\/v1$/i.test(base) ? base : `${base}/v1`;
    return {
      anthropic: `${v1}/messages`,
      openai: `${v1}/chat/completions`,
      responses: `${v1}/responses`,
    };
  }
  if (/\/v1$/i.test(base)) {
    return {
      anthropic: `${base}/messages`,
      openai: `${base}/chat/completions`,
      responses: `${base}/responses`,
    };
  }
  return {
    anthropic: `${base}/v1/messages`,
    openai: `${base}/v1/chat/completions`,
    responses: `${base}/v1/responses`,
  };
}

// ── Responses capability tables (docs-sourced) ───────────────────────

export interface FamilyCaps {
  readonly toolChoice: ReadonlySet<'auto' | 'named'>;
  readonly reasoningEffort: ReadonlySet<string>;
}

const FAMILY_CAPS: Readonly<Record<string, FamilyCaps>> = {
  'muse-spark': {
    toolChoice: new Set(['auto']),
    reasoningEffort: new Set(['minimal', 'low', 'medium', 'high', 'xhigh']),
  },
  gpt: {
    toolChoice: new Set(['auto', 'named']),
    reasoningEffort: new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  },
  grok: {
    toolChoice: new Set(['auto', 'named']),
    reasoningEffort: new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  },
  claude: {
    toolChoice: new Set(),
    reasoningEffort: new Set(),
  },
};

const DEFAULT_CAPS: FamilyCaps = {
  toolChoice: new Set(['auto', 'named']),
  reasoningEffort: new Set(['low']),
};

const RESPONSES_NO_MINIMAL = new Set(['gpt-6.1-sol']);
const RESPONSES_NO_MAX = new Set(['muse-spark-1.3-contributor', 'muse-spark-1.3-contributor-free']);

export function familyCaps(modelId: string): FamilyCaps {
  const fam = familyOf(modelId);
  return (fam && FAMILY_CAPS[fam]) || DEFAULT_CAPS;
}

export function supportsToolChoice(modelId: string, choice: unknown): boolean {
  const caps = familyCaps(modelId);
  if (choice && typeof choice === 'object') {
    const t = (choice as { type?: unknown }).type;
    if (t === 'tool' || t === 'function') return caps.toolChoice.has('named');
    if (t === 'auto') return caps.toolChoice.has('auto');
    return false;
  }
  if (choice === 'auto') return caps.toolChoice.has('auto');
  return false;
}

/**
 * Map a client effort to the Responses wire value.
 * Verbatim where the family accepts it; contributor max→xhigh (explicit
 * rewrite, callers may record source); throws loudly otherwise.
 */
export function mapResponsesEffort(modelId: string, effort: unknown): string | null {
  if (effort === null || effort === undefined || effort === '' || effort === 'none') return null;
  const e = String(effort);
  const low = (modelId || '').toLowerCase();
  if (e === 'max' && RESPONSES_NO_MAX.has(low)) return 'xhigh';
  const caps = familyCaps(modelId).reasoningEffort;
  if (RESPONSES_NO_MINIMAL.has(low) && e === 'minimal') {
    throw new Error(
      `model ${modelId} does not accept reasoning effort ${JSON.stringify(effort)} ` +
        `(valid: ${JSON.stringify([...caps].filter((x) => x !== 'minimal').sort())})`,
    );
  }
  if (caps.has(e)) return e;
  throw new Error(
    `model ${modelId} does not accept reasoning effort ${JSON.stringify(effort)} ` +
      `(valid: ${JSON.stringify([...caps].sort()) || 'none — reasoning n/a'})`,
  );
}

// ── Chat-family reasoning (DeepSeek / GLM) ───────────────────────────

export type ChatFamily = 'deepseek' | 'glm';

export interface ChatReasoningCaps {
  readonly thinking: ReadonlySet<'enabled' | 'disabled'>;
  readonly reasoningEffort: ReadonlySet<string>;
  readonly canDisable: boolean;
}

const CHAT_REASONING_CAPS: Readonly<Record<ChatFamily, ChatReasoningCaps>> = {
  deepseek: {
    thinking: new Set(['enabled', 'disabled']),
    reasoningEffort: new Set(['low', 'high', 'max']),
    canDisable: true,
  },
  glm: {
    thinking: new Set(['enabled']),
    reasoningEffort: new Set(['low', 'high', 'max']),
    canDisable: false,
  },
};

const CHAT_FAMILY_PREFIXES: ReadonlyArray<readonly [string, ChatFamily]> = [
  ['deepseek-', 'deepseek'],
  ['glm-', 'glm'],
];

export function chatFamilyOf(modelId: string): ChatFamily | null {
  const low = (modelId || '').toLowerCase();
  for (const [prefix, fam] of CHAT_FAMILY_PREFIXES) {
    if (low.startsWith(prefix)) return fam;
  }
  return null;
}

export function chatReasoningCaps(modelId: string): ChatReasoningCaps {
  const fam = chatFamilyOf(modelId);
  if (!fam) {
    return { thinking: new Set(), reasoningEffort: new Set(), canDisable: false };
  }
  return CHAT_REASONING_CAPS[fam];
}

/**
 * Map a client effort to a chat wire value (demotion-only).
 * Returns the wire string or null when the field must be omitted.
 * Throws for values that have no valid mapping.
 */
export function mapChatEffort(modelId: string, effort: unknown): string | null {
  if (effort === null || effort === undefined || effort === '' || effort === 'none') return null;
  // Extras are family-gated: non-family chat models never receive the
  // field (silent drop, mirroring the reference's WARN-only handling).
  if (!chatFamilyOf(modelId)) return null;
  const e = String(effort);
  const caps = chatReasoningCaps(modelId).reasoningEffort;
  if (caps.has(e)) return e;
  if (e === 'minimal') {
    if (chatFamilyOf(modelId) === 'deepseek' && caps.has('low')) return 'low';
    throw new Error(
      `model ${modelId} does not accept reasoning effort ${JSON.stringify(effort)} ` +
        `(valid: ${JSON.stringify([...caps].sort()) || 'none — reasoning n/a'})`,
    );
  }
  if (e === 'medium' || e === 'xhigh') {
    if (caps.has('high')) return 'high';
    throw new Error(
      `model ${modelId} does not accept reasoning effort ${JSON.stringify(effort)} ` +
        `(valid: ${JSON.stringify([...caps].sort()) || 'none — reasoning n/a'})`,
    );
  }
  throw new Error(
    `model ${modelId} does not accept reasoning effort ${JSON.stringify(effort)} ` +
      `(valid: ${JSON.stringify([...caps].sort()) || 'none — reasoning n/a'})`,
  );
}

/**
 * Map a client thinking type to the chat wire toggle.
 * Returns "enabled" | "disabled" | null (omit).
 */
export function mapChatThinking(modelId: string, thinkingType: unknown): 'enabled' | 'disabled' | null {
  const fam = chatFamilyOf(modelId);
  if (!fam) return null;
  const t = thinkingType === null || thinkingType === undefined ? 'none' : String(thinkingType);
  if (fam === 'deepseek') {
    if (t === 'enabled' || t === 'adaptive') return 'enabled';
    if (t === 'disabled') return 'disabled';
    if (t === 'none' || t === '') return null;
    return 'enabled';
  }
  // GLM: reasoning cannot be disabled; an explicit disable is a loud error.
  if (t === 'disabled') {
    throw new Error(`model ${modelId} cannot disable thinking (reasoning is always-on; omit instead)`);
  }
  return 'enabled';
}

// ── Request intent extraction (Claude/Anthropic body shapes) ─────────

/** Client effort from any of the accepted Anthropic-adjacent shapes. */
export function extractEffort(body: Record<string, unknown>): string | null {
  const direct = body['effort'];
  if (typeof direct === 'string' && direct) return direct;
  const oc = body['output_config'];
  if (oc && typeof oc === 'object' && typeof (oc as Record<string, unknown>)['effort'] === 'string') {
    return (oc as Record<string, unknown>)['effort'] as string;
  }
  const th = body['thinking'];
  if (th && typeof th === 'object' && typeof (th as Record<string, unknown>)['effort'] === 'string') {
    return (th as Record<string, unknown>)['effort'] as string;
  }
  return null;
}

export function extractThinkingType(body: Record<string, unknown>): string | null {
  const th = body['thinking'];
  if (th && typeof th === 'object' && typeof (th as Record<string, unknown>)['type'] === 'string') {
    return (th as Record<string, unknown>)['type'] as string;
  }
  return null;
}

export function thinkingEnabled(body: Record<string, unknown>): boolean {
  const t = extractThinkingType(body);
  return t === 'enabled' || t === 'adaptive';
}

// ── Session header handling ──────────────────────────────────────────

/**
 * Sanitize a value for `x-opencode-session` (routing + prompt caching).
 * Returns null when the value is empty or malformed (control bytes or
 * overlong); callers then omit the header rather than send junk.
 */
export function sanitizeSessionValue(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return null;
  if (s.length > 200) return null;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return null;
  }
  return s;
}

// ── OpenCode session ids ─────────────────────────────────────────────

/**
 * The OpenCode 2.x client mints session ids as `ses_` + 12 lowercase hex
 * (bit-inverted timestamp + counter, so ids sort descending) + 14 base62
 * random chars (packages/schema/src/identifier.ts).
 *
 * The Console free tier rejects `x-opencode-session` values that are not in
 * this shape (verified live: a freshly minted client-shaped id passes, while
 * arbitrary `ses_`-prefixed ids get `403 FreeTierError`). The bridge mints
 * client-shaped ids for its own sessions when talking to OpenCode hosts.
 */
const SESSION_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

let lastSessionTimestamp = 0;
let sessionCounter = 0;

export function isOpencodeSessionId(value: string): boolean {
  return OPENCODE_SESSION_RE.test(value);
}

/** Mint a client-shaped session id (`ses_` + descending time + random). */
export function mintOpencodeSessionId(timestamp = Date.now()): string {
  if (timestamp !== lastSessionTimestamp) {
    lastSessionTimestamp = timestamp;
    sessionCounter = 0;
  }
  sessionCounter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(sessionCounter);
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
  const bytes = randomBytes(14);
  const random = Array.from(bytes, (byte) => SESSION_ALPHABET[byte % 62]).join('');
  return `ses_${time}${random}`;
}
