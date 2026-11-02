/**
 * Pure caching / id-stability predicates ported from the reference proxy.
 * No I/O, no global state. Downgrade/exclusion sets are managed by the caller.
 * (Session compaction epochs live in session-epoch.ts; usage notes feed them.)
 */

import { createHash } from 'node:crypto';

export const GLM_EXCLUDE_PATTERN = /glm|zhipu/i;

export function shouldStampRetention(model: string): boolean {
  return !GLM_EXCLUDE_PATTERN.test(model);
}

// ── Upstream prompt-cache key derivation (reference parity) ──────────
// Clean values (UUIDs and the like) pass verbatim; overlong-but-clean
// values keep a readable head plus a hash; anything outside the safe
// charset is hashed wholesale. Deterministic per session.
const CACHE_KEY_MAXLEN = 64;
const CACHE_KEY_SAFE = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split(''),
);

export function cacheKeyFor(session: string): string | null {
  const s = (session || '').trim();
  if (!s) return null;
  if ([...s].every((c) => CACHE_KEY_SAFE.has(c))) {
    if (s.length <= CACHE_KEY_MAXLEN) return s;
    return s.slice(0, 32) + createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);
  }
  return 'ck-' + createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);
}

/** Whole-segment exclusion (never substring false positives like "gilmour"). */
export function cacheKeyExcluded(model: string): boolean {
  const segs = (model || '')
    .toLowerCase()
    .replace(/[_/.:]/g, '-')
    .split('-');
  return segs.some((seg) => seg === 'glm' || seg === 'zhipu');
}

// ── Stable tool-call ids (reference parity) ──────────────────────────
// Content-derived ids keep identical turns byte-identical across
// retries/replays, so prefix caches stay warm and tool_use/tool_result
// pairing survives id-dropping clients.

function sha1Short(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex').slice(0, 8);
}

export function synthesizeToolId(name: string, index: number | string, args: unknown): string {
  const argStr =
    args && typeof args === 'object'
      ? stableJson(args)
      : String(args ?? '');
  const basis = `${name || ''}\u0000${argStr}`;
  return `toolu_${name}_${index}_${sha1Short(basis)}`;
}

/** Deterministic JSON with sorted keys (reference `sort_keys` parity). */
export function stableJson(value: unknown): string {
  try {
    return JSON.stringify(sortValue(value));
  } catch {
    return String(value);
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function normalizeToolCallId(existing: unknown, name: string, index: number | string, args: unknown): string {
  if (typeof existing === 'string' && existing.length > 0) return existing;
  return synthesizeToolId(name, index, args);
}

export class DowngradeSet {
  private readonly set = new Set<string>();
  has(model: string): boolean { return this.set.has(model); }
  add(model: string): void { this.set.add(model); }
  clear(): void { this.set.clear(); }
  size(): number { return this.set.size; }
  list(): string[] { return [...this.set]; }
}

// ── Cache-field 400 signature (reference parity) ─────────────────────
// The downgrade must trigger on "extra/unknown/not-permitted" style
// rejections ANCHORED on a cache field name — a bare "not permitted"
// phrase ("Tool use not permitted") must not poison the exclusion set.
const CACHE_KEY_REJECT_SIGNS = [
  'extra input',
  'not permitted',
  'unknown field',
  'unknown parameter',
  'unexpected field',
  'unexpected parameter',
  'unrecognized field',
  'unrecognized parameter',
  'unsupported field',
  'unsupported parameter',
];

const CACHE_KEY_FIELD_HINTS = ['prompt_cache_key', 'prompt_cache_retention', 'promptcache'];

function normalizeForHint(text: string): string {
  // Underscores/hyphens/spaces equivalent so "prompt-cache-key" matches.
  return text.toLowerCase().replace(/[-_\s]/g, '');
}

export function isCacheFieldRejection(status: number, body: string): boolean {
  if (status !== 400) return false;
  const b = (body || '').toLowerCase();
  const hasSign = CACHE_KEY_REJECT_SIGNS.some((s) => b.includes(s));
  if (!hasSign) return false;
  const normalized = normalizeForHint(b);
  return CACHE_KEY_FIELD_HINTS.some((h) => normalized.includes(normalizeForHint(h)));
}

/** Backwards-compatible alias used by older call sites/tests. */
export function isCacheFieldError(status: number, body: string): boolean {
  return isCacheFieldRejection(status, body);
}

// ── Usage normalization (reference parity) ───────────────────────────

/** Total output tokens as upstream reports them (inclusive of reasoning). */
export function getOutputTokens(usage: unknown): number {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>;
  const n = u['completion_tokens'] ?? u['output_tokens'];
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** Cache read tokens from the several upstream field names. */
export function extractCacheReadTokens(usage: unknown): number {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>;
  const details = (u['prompt_tokens_details'] ?? {}) as Record<string, unknown>;
  const read = details['cached_tokens'] ?? u['cached_tokens'] ?? u['cache_read_input_tokens'];
  return numeric(read) ?? 0;
}

/** Cache creation (write) tokens from the several upstream field names. */
export function extractCacheCreationTokens(usage: unknown): number {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>;
  const details = (u['prompt_tokens_details'] ?? {}) as Record<string, unknown>;
  const creation = details['cache_creation'] ?? u['cache_creation_input_tokens'];
  return numeric(creation) ?? 0;
}

/** Token facts one completed upstream request contributes to epoch notes. */
export interface UpstreamTurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly measured: boolean;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

/**
 * Normalize an OpenAI chat/completions usage object. Returns null when
 * no upstream usage is present (an observation gap, never a 0-turn).
 */
export function upstreamUsageFromOpenAI(usage: unknown): UpstreamTurnUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const inTok = numeric(u['prompt_tokens'] ?? u['input_tokens']);
  const outTok = numeric(u['completion_tokens'] ?? u['output_tokens']);
  if (inTok === null && outTok === null) return null;
  return {
    inputTokens: inTok ?? 0,
    outputTokens: outTok ?? 0,
    cacheReadTokens: extractCacheReadTokens(u),
    cacheCreationTokens: extractCacheCreationTokens(u),
    measured: true,
  };
}

/** Normalize an OpenAI Responses usage object (input_tokens_details shape). */
export function upstreamUsageFromResponses(usage: unknown): UpstreamTurnUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const inTok = numeric(u['input_tokens']);
  const outTok = numeric(u['output_tokens']);
  if (inTok === null && outTok === null) return null;
  const details = u['input_tokens_details'];
  const detailCache =
    details && typeof details === 'object' ? numeric((details as Record<string, unknown>)['cached_tokens']) : null;
  const cacheRead = detailCache ?? extractCacheReadTokens(u);
  const cacheCreate = numeric(u['cache_write_tokens']) ?? extractCacheCreationTokens(u);
  return {
    inputTokens: inTok ?? 0,
    outputTokens: outTok ?? 0,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreate,
    measured: true,
  };
}

/** Normalize an Anthropic usage object (message_start / message_delta / non-stream). */
export function upstreamUsageFromAnthropic(usage: unknown): UpstreamTurnUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const inTok = numeric(u['input_tokens']);
  const outTok = numeric(u['output_tokens']);
  if (inTok === null && outTok === null) return null;
  return {
    inputTokens: inTok ?? 0,
    outputTokens: outTok ?? 0,
    cacheReadTokens: numeric(u['cache_read_input_tokens']) ?? 0,
    cacheCreationTokens: numeric(u['cache_creation_input_tokens']) ?? 0,
    measured: true,
  };
}

/**
 * Reasoning-token split from either upstream usage shape
 * (output_tokens_details / completion_tokens_details). The split is a
 * SUBSET of the reported total — display it, never add it.
 */
export function upstreamReasoningTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const u = usage as Record<string, unknown>;
  for (const container of ['output_tokens_details', 'completion_tokens_details']) {
    const det = u[container];
    if (!det || typeof det !== 'object') continue;
    const raw = (det as Record<string, unknown>)['reasoning_tokens'];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return parseInt(raw.trim(), 10);
  }
  return 0;
}

export function withReasoningSplit(
  base: Record<string, unknown>,
  usage: unknown,
): Record<string, unknown> {
  const n = upstreamReasoningTokens(usage);
  if (!n) return base;
  return { ...base, reasoning_tokens: n };
}

/** Rough token estimate (chars/3), used for message_start and count_tokens. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.floor((text || '').length / 3));
}
