import { describe, it, expect } from 'vitest';
import {
  cacheKeyExcluded,
  cacheKeyFor,
  shouldStampRetention,
  synthesizeToolId,
  normalizeToolCallId,
  DowngradeSet,
  isCacheFieldError,
  isCacheFieldRejection,
  extractCacheCreationTokens,
  extractCacheReadTokens,
  upstreamUsageFromAnthropic,
  upstreamUsageFromOpenAI,
  upstreamUsageFromResponses,
} from '../../../runtimes/claude/bridge-cache';

describe('bridge-cache', () => {
  it('stamps retention except GLM', () => {
    expect(shouldStampRetention('gpt-4o')).toBe(true);
    expect(shouldStampRetention('glm-4')).toBe(false);
    expect(shouldStampRetention('zhipu-foo')).toBe(false);
  });

  it('cache keys: verbatim when clean and short, deterministic hash otherwise', () => {
    expect(cacheKeyFor('session-abc')).toBe('session-abc');
    expect(cacheKeyFor('')).toBeNull();
    expect(cacheKeyFor('   ')).toBeNull();
    const long = 'a'.repeat(80);
    expect(cacheKeyFor(long)!.length).toBeLessThanOrEqual(64);
    expect(cacheKeyFor(long)).toBe(cacheKeyFor(long));
    expect(cacheKeyFor('bad value!')).toMatch(/^ck-[0-9a-f]{32}$/);
  });

  it('cacheKeyExcluded matches whole model segments only', () => {
    expect(cacheKeyExcluded('glm-4.6')).toBe(true);
    expect(cacheKeyExcluded('zhipu/glm')).toBe(true);
    expect(cacheKeyExcluded('gilmour-1')).toBe(false);
  });

  it('tool id stability', () => {
    const id = synthesizeToolId('Read', 0, { x: 1 });
    expect(id).toBe(synthesizeToolId('Read', 0, { x: 1 }));
    expect(normalizeToolCallId(null, 'Read', 0, { x: 1 })).toBe(id);
    expect(normalizeToolCallId('existing', 'Read', 0, { x: 1 })).toBe('existing');
  });

  it('downgrade set', () => {
    const d = new DowngradeSet();
    d.add('m1');
    expect(d.has('m1')).toBe(true);
    expect(d.size()).toBe(1);
  });

  it('isCacheFieldError requires a rejection phrase anchored on a cache field', () => {
    expect(isCacheFieldError(400, 'Extra inputs are not permitted: prompt_cache_key')).toBe(true);
    expect(isCacheFieldError(400, 'unknown parameter "prompt_cache_retention"')).toBe(true);
    // Bare field mention or bare permission phrase alone is not enough.
    expect(isCacheFieldError(400, 'bad prompt_cache_key')).toBe(false);
    expect(isCacheFieldError(400, 'Tool use not permitted')).toBe(false);
    expect(isCacheFieldError(400, 'other')).toBe(false);
    expect(isCacheFieldError(500, 'prompt_cache_key not permitted')).toBe(false);
    expect(isCacheFieldRejection(400, 'unsupported field prompt-cache-key')).toBe(true);
  });
});

describe('upstream usage normalization', () => {
  it('OpenAI chat usage: prompt/completion + cache extras', () => {
    const u = upstreamUsageFromOpenAI({
      prompt_tokens: 10,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 6 },
      cache_creation_input_tokens: 2,
    });
    expect(u).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheCreationTokens: 2,
      measured: true,
    });
    expect(upstreamUsageFromOpenAI(null)).toBeNull();
    expect(upstreamUsageFromOpenAI({})).toBeNull();
    expect(upstreamUsageFromOpenAI('junk')).toBeNull();
  });

  it('Responses usage: input_tokens_details.cached_tokens + cache_write_tokens', () => {
    const u = upstreamUsageFromResponses({
      input_tokens: 8,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 4 },
      cache_write_tokens: 2,
    });
    expect(u).toEqual({
      inputTokens: 8,
      outputTokens: 1,
      cacheReadTokens: 4,
      cacheCreationTokens: 2,
      measured: true,
    });
    expect(upstreamUsageFromResponses(undefined)).toBeNull();
  });

  it('Anthropic usage: input/output + cache read/creation', () => {
    const u = upstreamUsageFromAnthropic({
      input_tokens: 5,
      output_tokens: 3,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 1,
    });
    expect(u).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      cacheReadTokens: 7,
      cacheCreationTokens: 1,
      measured: true,
    });
    expect(upstreamUsageFromAnthropic(null)).toBeNull();
  });

  it('extractors stay permissive about numeric strings and missing details', () => {
    expect(extractCacheReadTokens({ cached_tokens: '12' })).toBe(12);
    expect(extractCacheReadTokens({})).toBe(0);
    expect(extractCacheCreationTokens({ prompt_tokens_details: { cache_creation: 9 } })).toBe(9);
  });
});
