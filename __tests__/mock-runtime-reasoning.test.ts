import { describe, it, expect } from 'vitest';
import { MockRuntime } from '../runtimes/mock/mock-runtime';

describe('MockRuntime reasoning', () => {
  it('emits reasoning events before text', async () => {
    const runtime = new MockRuntime({
      testNode: {
        reasoning: ['thinking step 1', 'thinking step 2'],
        text: ['output line'],
      },
    });

    const session = await runtime.createSession({
      model: 'mock',
      cwd: '/tmp/testNode',
      timeout: 10,
      heartbeatTimeout: 10,
    });

    const events: Array<{ event: string; data: string }> = [];

    session.on('reasoning', (text) => events.push({ event: 'reasoning', data: text }));
    session.on('text', (text) => events.push({ event: 'text', data: text }));
    session.on('idle', () => events.push({ event: 'idle', data: '' }));

    session.send('test prompt');

    // Wait for microtask
    await new Promise(resolve => queueMicrotask(resolve));

    expect(events).toEqual([
      { event: 'reasoning', data: 'thinking step 1' },
      { event: 'reasoning', data: 'thinking step 2' },
      { event: 'text', data: 'output line' },
      { event: 'idle', data: '' },
    ]);
  });

  it('emits reasoning events even without text', async () => {
    const runtime = new MockRuntime({
      testNode: {
        reasoning: ['just thinking'],
      },
    });

    const session = await runtime.createSession({
      model: 'mock',
      cwd: '/tmp/testNode',
      timeout: 10,
      heartbeatTimeout: 10,
    });

    const events: Array<{ event: string; data: string }> = [];

    session.on('reasoning', (text) => events.push({ event: 'reasoning', data: text }));
    session.on('text', (text) => events.push({ event: 'text', data: text }));
    session.on('idle', () => events.push({ event: 'idle', data: '' }));

    session.send('test');
    await new Promise(resolve => queueMicrotask(resolve));

    expect(events).toEqual([
      { event: 'reasoning', data: 'just thinking' },
      { event: 'idle', data: '' },
    ]);
  });

  it('works with no reasoning configured (backward compat)', async () => {
    const runtime = new MockRuntime({
      testNode: {
        text: ['hello'],
      },
    });

    const session = await runtime.createSession({
      model: 'mock',
      cwd: '/tmp/testNode',
      timeout: 10,
      heartbeatTimeout: 10,
    });

    const events: Array<{ event: string; data: string }> = [];

    session.on('reasoning', (text) => events.push({ event: 'reasoning', data: text }));
    session.on('text', (text) => events.push({ event: 'text', data: text }));
    session.on('idle', () => events.push({ event: 'idle', data: '' }));

    session.send('test');
    await new Promise(resolve => queueMicrotask(resolve));

    expect(events).toEqual([
      { event: 'text', data: 'hello' },
      { event: 'idle', data: '' },
    ]);
  });
});
