/**
 * Reasoning E2E tests — full pipeline scenarios with reasoning events.
 *
 * Tests run agent nodes with MockRuntime reasoning through:
 * - Scheduler + StateRuntime + MemoryStorage
 * - Verifies reasoning events flow from MockRuntime → agent → emitOutput → StateRuntime
 * - Verifies reasoning persistence with prefix encoding in storage
 * - Verifies event ordering (reasoning before text)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../src/scheduler';
import { agent } from '../src/agent';
import { MockRuntime } from '../runtimes/mock/mock-runtime';
import { MemoryStorage } from '../state/storage-memory';
import { StateRuntime } from '../state/state-runtime';
import type { FlowGraph, RunOptions } from '../src/types';
import type { OutputEvent } from '../src/events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-e2e-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Reasoning E2E', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* */ }
  });

  it('MockRuntime reasoning flows through agent to StateRuntime and persists', async () => {
    const storage = new MemoryStorage();
    const outputEvents: OutputEvent[] = [];
    const stateRuntime = new StateRuntime(
      storage,
      undefined,
      (event) => { outputEvents.push(event); },
    );

    const runtime = new MockRuntime(
      {
        thinker: {
          reasoning: ['considering options', 'decided on approach'],
          text: ['final output'],
        },
      },
      { nodeResolver: () => 'thinker' },
    );

    const thinkerFn = agent({
      objective: 'think deeply',
      tools: [],
      model: 'mock',
      promptBuilder: () => 'think about this',
    });

    const graph: FlowGraph = {
      nodes: {
        thinker: {
          fn: thinkerFn,
          displayName: 'Thinker',
          nodeType: 'agent',
        },
      },
      edges: {},
      start: ['thinker'],
    };

    const opts: RunOptions = {
      executionId: 'exec-reasoning',
      dir: tmpDir,
      params: {},
      runtime,
      emitState: async (event) => { await stateRuntime.handleEvent(event); },
      emitOutput: (event) => { stateRuntime.handleOutput(event); },
      signal: new AbortController().signal,
    };

    const result = await run(graph, opts);
    expect(result.completed).toBe(true);

    // Verify reasoning events were captured via onOutput callback
    const reasoningEvents = outputEvents.filter(e => e.type === 'node:reasoning');
    expect(reasoningEvents).toHaveLength(2);
    expect(reasoningEvents[0].content).toBe('considering options');
    expect(reasoningEvents[1].content).toBe('decided on approach');

    // Verify text events also captured
    const textEvents = outputEvents.filter(e => e.type === 'node:output');
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    expect(textEvents[0].content).toBe('final output');

    // Verify reasoning persisted with prefix in storage
    const stored = stateRuntime.getNodeOutput('exec-reasoning', 'thinker');
    const reasoningLines = stored.lines.filter(l => l.startsWith('\x00reasoning\x00'));
    expect(reasoningLines).toHaveLength(2);
    expect(reasoningLines[0]).toBe('\x00reasoning\x00considering options');
    expect(reasoningLines[1]).toBe('\x00reasoning\x00decided on approach');

    // Verify regular output stored without prefix
    const regularLines = stored.lines.filter(l => !l.startsWith('\x00reasoning\x00'));
    expect(regularLines).toContain('final output');
  });

  it('reasoning events arrive before text events (ordering)', async () => {
    const outputEvents: OutputEvent[] = [];
    const storage = new MemoryStorage();
    const stateRuntime = new StateRuntime(
      storage,
      undefined,
      (event) => { outputEvents.push(event); },
    );

    const runtime = new MockRuntime(
      {
        ordered: {
          reasoning: ['thought A', 'thought B'],
          text: ['response X'],
        },
      },
      { nodeResolver: () => 'ordered' },
    );

    const orderedFn = agent({
      objective: 'ordered output',
      tools: [],
      model: 'mock',
      promptBuilder: () => 'test',
    });

    const graph: FlowGraph = {
      nodes: {
        ordered: {
          fn: orderedFn,
          displayName: 'Ordered',
          nodeType: 'agent',
        },
      },
      edges: {},
      start: ['ordered'],
    };

    const result = await run(graph, {
      executionId: 'exec-order',
      dir: tmpDir,
      params: {},
      runtime,
      emitState: async (event) => { await stateRuntime.handleEvent(event); },
      emitOutput: (event) => { stateRuntime.handleOutput(event); },
      signal: new AbortController().signal,
    });

    expect(result.completed).toBe(true);

    // All reasoning events should precede all text events
    const types = outputEvents
      .filter(e => e.type === 'node:reasoning' || e.type === 'node:output')
      .map(e => e.type);
    const lastReasoning = types.lastIndexOf('node:reasoning');
    const firstOutput = types.indexOf('node:output');
    expect(lastReasoning).toBeLessThan(firstOutput);
  });

  it('bridge output forwarding: handleOutput stores reasoning with prefix', () => {
    const storage = new MemoryStorage();
    const forwarded: OutputEvent[] = [];
    const stateRuntime = new StateRuntime(
      storage,
      undefined,
      (event) => { forwarded.push(event); },
    );

    // Simulate reasoning output events as the bridge would forward them
    const reasoningEvent: OutputEvent = {
      type: 'node:reasoning',
      executionId: 'exec-bridge',
      nodeId: 'nodeA',
      content: 'deep thought',
      ts: 1000,
    };
    const textEvent: OutputEvent = {
      type: 'node:output',
      executionId: 'exec-bridge',
      nodeId: 'nodeA',
      content: 'visible text',
      ts: 1001,
    };
    const toolEvent: OutputEvent = {
      type: 'node:tool',
      executionId: 'exec-bridge',
      nodeId: 'nodeA',
      tool: 'read_file',
      phase: 'start',
      summary: '/tmp/file.txt',
      ts: 1002,
    };

    stateRuntime.handleOutput(reasoningEvent);
    stateRuntime.handleOutput(textEvent);
    stateRuntime.handleOutput(toolEvent);

    // Verify forwarded to onOutput callback
    expect(forwarded).toHaveLength(3);
    expect(forwarded[0]).toBe(reasoningEvent);
    expect(forwarded[1]).toBe(textEvent);
    expect(forwarded[2]).toBe(toolEvent);

    // Verify storage: reasoning with prefix, text without prefix, tool with encoded prefix
    const stored = stateRuntime.getNodeOutput('exec-bridge', 'nodeA');
    expect(stored.lines).toHaveLength(3); // reasoning + text + tool (all persisted)
    expect(stored.lines[0]).toBe('\x00reasoning\x00deep thought');
    expect(stored.lines[1]).toBe('visible text');
    expect(stored.lines[2]).toBe('\x00tool:start\x00read_file\x00/tmp/file.txt');
  });

  it('reasoning-only node (no text output) persists correctly', async () => {
    const storage = new MemoryStorage();
    const outputEvents: OutputEvent[] = [];
    const stateRuntime = new StateRuntime(
      storage,
      undefined,
      (event) => { outputEvents.push(event); },
    );

    const runtime = new MockRuntime(
      {
        thinker: {
          reasoning: ['just thinking'],
          // No text output
        },
      },
      { nodeResolver: () => 'thinker' },
    );

    const thinkerFn = agent({
      objective: 'think only',
      tools: [],
      model: 'mock',
      promptBuilder: () => 'think',
    });

    const graph: FlowGraph = {
      nodes: {
        thinker: {
          fn: thinkerFn,
          displayName: 'Thinker',
          nodeType: 'agent',
        },
      },
      edges: {},
      start: ['thinker'],
    };

    const result = await run(graph, {
      executionId: 'exec-think-only',
      dir: tmpDir,
      params: {},
      runtime,
      emitState: async (event) => { await stateRuntime.handleEvent(event); },
      emitOutput: (event) => { stateRuntime.handleOutput(event); },
      signal: new AbortController().signal,
    });

    expect(result.completed).toBe(true);

    // Only reasoning events, no text events
    const reasoningEvents = outputEvents.filter(e => e.type === 'node:reasoning');
    const textEvents = outputEvents.filter(e => e.type === 'node:output');
    expect(reasoningEvents).toHaveLength(1);
    expect(reasoningEvents[0].content).toBe('just thinking');
    expect(textEvents).toHaveLength(0);

    // Storage should contain only the reasoning line
    const stored = stateRuntime.getNodeOutput('exec-think-only', 'thinker');
    expect(stored.lines).toHaveLength(1);
    expect(stored.lines[0]).toBe('\x00reasoning\x00just thinking');
  });
});
