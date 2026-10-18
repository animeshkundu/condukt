import { describe, it, expect, vi } from 'vitest';
import { mapSdkMessage, createMapState } from '../../../runtimes/claude/message-mapper';

function makeEmitter() {
  const calls: { event: string; args: unknown[] }[] = [];
  const emitter: any = {};
  for (const e of ['text','reasoning','toolStart','toolComplete','toolOutput','idle','error','usage','compaction','subagentStart','subagentEnd','permission']) {
    emitter[e] = (...args: unknown[]) => calls.push({ event: e, args });
  }
  return { emitter, calls };
}

describe('message-mapper', () => {
  it('maps assistant text/reasoning/tool_use', () => {
    const { emitter, calls } = makeEmitter();
    const state = createMapState();
    mapSdkMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 'c1', name: 'Read', input: { x: 1 } }], usage: { input_tokens: 5 } }, session_id: 's' } as any, emitter, state, { includePartialMessages: false });
    expect(calls.map(c=>c.event)).toEqual(['text','reasoning','toolStart','usage']);
  });

  it('streams deltas when partial', () => {
    const { emitter, calls } = makeEmitter();
    const state = createMapState();
    mapSdkMessage({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'he' } }, session_id: 's' } as any, emitter, state, { includePartialMessages: true });
    mapSdkMessage({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'llo' } }, session_id: 's' } as any, emitter, state, { includePartialMessages: true });
    // assistant echo suppressed
    mapSdkMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] }, session_id: 's' } as any, emitter, state, { includePartialMessages: true });
    const texts = calls.filter(c=>c.event==='text').map(c=>c.args[0]);
    expect(texts).toEqual(['he','llo']);
  });

  it('maps result success to idle + usage', () => {
    const { emitter, calls } = makeEmitter();
    const state = createMapState();
    const r = mapSdkMessage({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.01, session_id: 's' } as any, emitter, state, { includePartialMessages: false });
    expect(r).toBe(true);
    expect(calls.map(c=>c.event)).toContain('usage');
    expect(calls.map(c=>c.event)).toContain('idle');
  });

  it('maps result error to error', () => {
    const { emitter, calls } = makeEmitter();
    const state = createMapState();
    mapSdkMessage({ type: 'result', subtype: 'error', errors: ['boom'], session_id: 's' } as any, emitter, state, { includePartialMessages: false });
    expect(calls.some(c=>c.event==='error')).toBe(true);
  });

  it('maps compaction boundary', () => {
    const { emitter, calls } = makeEmitter();
    const state = createMapState();
    mapSdkMessage({ type: 'system', subtype: 'compact_boundary', session_id: 's' } as any, emitter, state, { includePartialMessages: false });
    expect(calls).toEqual([{ event: 'compaction', args: ['complete'] }]);
  });

  it('maps tool_result user message', () => {
    const { emitter, calls } = makeEmitter();
    const state = createMapState();
    mapSdkMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'out' }] }, session_id: 's' } as any, emitter, state, { includePartialMessages: false });
    expect(calls).toEqual([{ event: 'toolComplete', args: ['', 'out', 'c1'] }]);
  });
});
