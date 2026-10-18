import { describe, it, expect } from 'vitest';
import {
  EXACT_PROTOCOLS,
  chatFamilyOf,
  blockedReason,
  deriveEndpoints,
  deriveZenBase,
  extractEffort,
  extractThinkingType,
  familyOf,
  mapChatEffort,
  mapChatThinking,
  mapResponsesEffort,
  recognizeBase,
  resolveBase,
  resolveProtocol,
  sanitizeSessionValue,
  isOpencodeSessionId,
  mintOpencodeSessionId,
  supportsToolChoice,
} from '../../../runtimes/claude/protocol-router';

describe('protocol-router: classification', () => {
  it('maps the OpenCode Go docs table to protocols', () => {
    expect(resolveProtocol('grok-4.7', { baseUrl: 'https://opencode.ai/inference/go' })).toBe('responses');
    expect(resolveProtocol('gpt-6-luna', { baseUrl: 'https://opencode.ai/inference/go' })).toBe('responses');
    expect(resolveProtocol('claude-haiku-5-5', { baseUrl: 'https://opencode.ai/inference/go' })).toBe('anthropic');
    expect(resolveProtocol('minimax-m3', { baseUrl: 'https://opencode.ai/inference/go' })).toBe('anthropic');
    expect(resolveProtocol('qwen3.8-max', { baseUrl: 'https://opencode.ai/inference/go' })).toBe('anthropic');
    expect(resolveProtocol('deepseek-v4.1-flash', { baseUrl: 'https://opencode.ai/inference/go' })).toBe('openai');
    expect(resolveProtocol('glm-5.3', { baseUrl: 'https://opencode.ai/inference/go' })).toBe('openai');
    expect(resolveProtocol('beam-free', { baseUrl: 'https://opencode.ai/inference/go' })).toBe('openai');
    expect(EXACT_PROTOCOLS.size).toBeGreaterThanOrEqual(25);
  });

  it('applies family fallback only for OpenCode bases (drift ids)', () => {
    expect(resolveProtocol('gpt-7-future', { baseUrl: 'https://opencode.ai/zen/go' })).toBe('responses');
    expect(resolveProtocol('muse-spark-9', { baseUrl: 'https://opencode.ai/inference/go' })).toBe('responses');
    expect(resolveProtocol('claude-sonnet-4-5', { baseUrl: 'https://opencode.ai/zen/go/v1' })).toBe('anthropic');
    // Generic base: chat/completions is the safe default even for gpt-*.
    expect(resolveProtocol('gpt-4o', { baseUrl: 'http://127.0.0.1:1234/v1' })).toBe('openai');
  });

  it('honors explicit protocolMap and forced protocol', () => {
    expect(resolveProtocol('gpt-6-luna', { baseUrl: 'https://opencode.ai/inference/go', protocolMap: { 'gpt-6-luna': 'openai' } })).toBe('openai');
    expect(resolveProtocol('mystery-model', { baseUrl: 'http://x', protocol: 'responses' })).toBe('responses');
  });

  it('classifies bases', () => {
    expect(recognizeBase('https://opencode.ai/zen/go/v1')).toBe('opencode');
    expect(recognizeBase('https://opencode.ai/inference/go')).toBe('opencode');
    expect(recognizeBase('https://api.anthropic.com/v1')).toBe('anthropic');
    expect(recognizeBase('https://api.openai.com/v1')).toBe('openai');
    expect(recognizeBase('http://127.0.0.1:8080/v1')).toBe('other');
  });

  it('familyOf detects prefix families', () => {
    expect(familyOf('gpt-6-luna')).toBe('gpt');
    expect(familyOf('claude-haiku-5-5')).toBe('claude');
    expect(familyOf('deepseek-v4-pro')).toBeNull();
  });
});

describe('protocol-router: endpoints', () => {
  it('derives opencode /inference/go endpoint shape (protocol-segment)', () => {
    const base = 'https://opencode.ai/inference/go';
    expect(deriveEndpoints(base)).toEqual({
      anthropic: `${base}/anthropic/v1/messages`,
      openai: `${base}/openai/v1/chat/completions`,
      responses: `${base}/openai/v1/responses`,
    });
  });

  it('derives opencode /zen/go endpoint shape (conventional /v1)', () => {
    const base = 'https://opencode.ai/zen/go';
    expect(deriveEndpoints(base)).toEqual({
      anthropic: `${base}/v1/messages`,
      openai: `${base}/v1/chat/completions`,
      responses: `${base}/v1/responses`,
    });
  });

  it('derives opencode /inference (console) endpoint shape (protocol-segment)', () => {
    const base = 'https://opencode.ai/inference';
    expect(deriveEndpoints(base)).toEqual({
      anthropic: `${base}/anthropic/v1/messages`,
      openai: `${base}/openai/v1/chat/completions`,
      responses: `${base}/openai/v1/responses`,
    });
  });

  it('derives opencode /zen (console) endpoint shape (conventional /v1)', () => {
    const base = 'https://opencode.ai/zen';
    expect(deriveEndpoints(base)).toEqual({
      anthropic: `${base}/v1/messages`,
      openai: `${base}/v1/chat/completions`,
      responses: `${base}/v1/responses`,
    });
  });

  it('deriveZenBase maps go bases to console bases', () => {
    expect(deriveZenBase('https://opencode.ai/inference/go')).toBe('https://opencode.ai/inference');
    expect(deriveZenBase('https://opencode.ai/inference/go/v1')).toBe('https://opencode.ai/inference/v1');
    expect(deriveZenBase('https://opencode.ai/zen/go')).toBe('https://opencode.ai/zen');
    expect(deriveZenBase('https://opencode.ai/zen/go/v1')).toBe('https://opencode.ai/zen/v1');
    expect(deriveZenBase('https://api.example.com/v1')).toBeNull();
  });

  it('resolveBase marks zen-only ids as zen', () => {
    expect(resolveBase('gpt-6-luna')).toBe('go');
    expect(resolveBase('space-bunny-free')).toBe('zen');
    expect(resolveBase('gpt-6-astra')).toBe('zen');
    expect(resolveBase('unknown-drift')).toBe('go');
  });

  it('blockedReason flags unservable ids', () => {
    expect(blockedReason('gemini-4-argon')).toMatch(/google/);
    expect(blockedReason('jev-1.13')).toMatch(/systemone/);
    expect(blockedReason('omen-alpha')).toMatch(/unclassified/);
    expect(blockedReason('longcat-2.5-preview-free')).toBeNull();
  });

  it('derives /v1 and host base shapes', () => {
    expect(deriveEndpoints('https://opencode.ai/zen/go/v1')).toEqual({
      anthropic: 'https://opencode.ai/zen/go/v1/messages',
      openai: 'https://opencode.ai/zen/go/v1/chat/completions',
      responses: 'https://opencode.ai/zen/go/v1/responses',
    });
    expect(deriveEndpoints('http://127.0.0.1:9999/v1/')).toEqual({
      anthropic: 'http://127.0.0.1:9999/v1/messages',
      openai: 'http://127.0.0.1:9999/v1/chat/completions',
      responses: 'http://127.0.0.1:9999/v1/responses',
    });
    expect(deriveEndpoints('https://api.example.com').anthropic).toBe('https://api.example.com/v1/messages');
  });
});

describe('protocol-router: responses caps', () => {
  it('maps effort per family with documented rewrites and loud rejects', () => {
    expect(mapResponsesEffort('gpt-6-luna', 'high')).toBe('high');
    expect(mapResponsesEffort('gpt-6-luna', 'minimal')).toBe('minimal');
    expect(mapResponsesEffort('gpt-6-luna', 'max')).toBe('max');
    expect(mapResponsesEffort('muse-spark-1.3-contributor', 'max')).toBe('xhigh');
    expect(mapResponsesEffort('muse-spark-1.3-contributor', 'minimal')).toBe('minimal');
    expect(mapResponsesEffort('grok-4.7', 'none')).toBeNull();
    expect(() => mapResponsesEffort('gpt-6.1-sol', 'minimal')).toThrow(/does not accept/);
    expect(() => mapResponsesEffort('claude-haiku-5-5', 'high')).toThrow(/does not accept/);
    expect(mapResponsesEffort('unknown-model', 'low')).toBe('low');
    expect(() => mapResponsesEffort('unknown-model', 'high')).toThrow(/does not accept/);
  });

  it('gates named tool_choice by family', () => {
    expect(supportsToolChoice('gpt-6-luna', { type: 'function', name: 'x' })).toBe(true);
    expect(supportsToolChoice('muse-spark-1.3-contributor', { type: 'function', name: 'x' })).toBe(false);
    expect(supportsToolChoice('muse-spark-1.3-contributor', 'auto')).toBe(true);
  });
});

describe('protocol-router: chat reasoning', () => {
  it('detects chat families', () => {
    expect(chatFamilyOf('deepseek-v4-pro')).toBe('deepseek');
    expect(chatFamilyOf('glm-5.3')).toBe('glm');
    expect(chatFamilyOf('kimi-k3')).toBeNull();
  });

  it('demotes effort for chat families', () => {
    expect(mapChatEffort('deepseek-v4-pro', 'high')).toBe('high');
    expect(mapChatEffort('deepseek-v4-pro', 'minimal')).toBe('low');
    expect(mapChatEffort('deepseek-v4-pro', 'medium')).toBe('high');
    expect(mapChatEffort('deepseek-v4-pro', 'xhigh')).toBe('high');
    expect(mapChatEffort('deepseek-v4-pro', 'max')).toBe('max');
    expect(() => mapChatEffort('glm-5.3', 'minimal')).toThrow(/does not accept/);
    expect(mapChatEffort('kimi-k3', 'max')).toBeNull();
  });

  it('maps thinking toggle per family', () => {
    expect(mapChatThinking('deepseek-v4-pro', 'enabled')).toBe('enabled');
    expect(mapChatThinking('deepseek-v4-pro', 'disabled')).toBe('disabled');
    expect(mapChatThinking('deepseek-v4-pro', 'none')).toBeNull();
    expect(mapChatThinking('glm-5.3', 'enabled')).toBe('enabled');
    expect(() => mapChatThinking('glm-5.3', 'disabled')).toThrow(/cannot disable/);
    expect(mapChatThinking('kimi-k3', 'enabled')).toBeNull();
  });
});

describe('protocol-router: request intent extraction', () => {
  it('extracts effort from all accepted shapes', () => {
    expect(extractEffort({ effort: 'high' })).toBe('high');
    expect(extractEffort({ output_config: { effort: 'low' } })).toBe('low');
    expect(extractEffort({ thinking: { type: 'enabled', effort: 'max' } })).toBe('max');
    expect(extractEffort({ thinking: { type: 'enabled' } })).toBeNull();
  });

  it('extracts thinking type', () => {
    expect(extractThinkingType({ thinking: { type: 'enabled' } })).toBe('enabled');
    expect(extractThinkingType({})).toBeNull();
  });
});

describe('protocol-router: session header sanitization', () => {
  it('accepts clean values and rejects junk', () => {
    expect(sanitizeSessionValue('session-1')).toBe('session-1');
    expect(sanitizeSessionValue('')).toBeNull();
    expect(sanitizeSessionValue('  ')).toBeNull();
    expect(sanitizeSessionValue('a\nb')).toBeNull();
    expect(sanitizeSessionValue('x'.repeat(201))).toBeNull();
    expect(sanitizeSessionValue(undefined)).toBeNull();
  });
});

describe('protocol-router: OpenCode session ids', () => {
  it('recognizes client-shaped ids and rejects others', () => {
    expect(isOpencodeSessionId('ses_eafd1121affe9zeUr0GX9KgcLK')).toBe(true);
    // 22 lowercase hex — the shape the Console free tier rejects live
    expect(isOpencodeSessionId('ses_0123456789abcdef012345')).toBe(false);
    expect(isOpencodeSessionId('condukt-1a2b3c4d')).toBe(false);
    expect(isOpencodeSessionId('ses_short')).toBe(false);
    expect(isOpencodeSessionId('ses_' + 'g'.repeat(12) + 'a'.repeat(14))).toBe(false);
  });

  it('mints unique client-shaped descending ids', () => {
    const a = mintOpencodeSessionId(1_700_000_000_000);
    const b = mintOpencodeSessionId(1_700_000_000_000);
    expect(isOpencodeSessionId(a)).toBe(true);
    expect(isOpencodeSessionId(b)).toBe(true);
    expect(a).not.toBe(b);
    // Later timestamps encode to smaller hex, so ids sort descending.
    const later = mintOpencodeSessionId(1_700_000_000_500);
    expect(later.slice(4, 16) < a.slice(4, 16)).toBe(true);
  });
});
