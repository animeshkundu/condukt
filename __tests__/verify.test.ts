import { describe, it, expect, vi } from 'vitest';
import { verify, property } from '../src/verify';
import type { NodeFn, NodeInput, NodeOutput, ExecutionContext } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockInput(overrides?: Partial<NodeInput>): NodeInput {
  return {
    dir: '/tmp/test',
    params: {},
    artifactPaths: {},
    ...overrides,
  };
}

function mockCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    executionId: 'test-exec',
    nodeId: 'test-node',
    runtime: {
      name: 'mock',
      createSession: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
    },
    emitOutput: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// property() tests
// ---------------------------------------------------------------------------

describe('property', () => {
  it('returns passed when predicate is true', async () => {
    const check = property('has-title', (c) => c.includes('# Title'), 'Missing title');
    const result = await check.fn('/tmp', '# Title\nContent here');
    expect(result.passed).toBe(true);
  });

  it('returns failed with message when predicate is false', async () => {
    const check = property('has-title', (c) => c.includes('# Title'), 'Missing title');
    const result = await check.fn('/tmp', 'No title here');
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('Missing title');
  });

  it('fails on empty/undefined content', async () => {
    const check = property('has-title', (c) => c.includes('# Title'), 'Missing title');
    const result = await check.fn('/tmp', undefined);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('No artifact content');
  });
});

// ---------------------------------------------------------------------------
// verify() tests
// ---------------------------------------------------------------------------

describe('verify', () => {
  it('passes on first try when all checks pass', async () => {
    const producer: NodeFn = vi.fn().mockResolvedValue({
      action: 'default',
      artifact: 'Good content with # Title',
    });

    const verified = verify(producer, {
      checks: [
        property('has-title', (c) => c.includes('# Title'), 'Missing title'),
      ],
    });

    const result = await verified(mockInput(), mockCtx());
    expect(result.action).toBe('default');
    expect(result.artifact).toBe('Good content with # Title');
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('retries when checks fail then passes', async () => {
    const producer: NodeFn = vi.fn()
      .mockResolvedValueOnce({ action: 'default', artifact: 'Bad content' })
      .mockResolvedValueOnce({ action: 'default', artifact: '# Title\nGood content' });

    const verified = verify(producer, {
      checks: [
        property('has-title', (c) => c.includes('# Title'), 'Missing title'),
      ],
      maxIterations: 3,
    });

    const result = await verified(mockInput(), mockCtx());
    expect(result.action).toBe('default');
    expect(result.artifact).toContain('# Title');
    expect(producer).toHaveBeenCalledTimes(2);

    // Second call should have retryContext
    const secondCallInput = (producer as ReturnType<typeof vi.fn>).mock.calls[1][0] as NodeInput;
    expect(secondCallInput.retryContext).toBeDefined();
    expect(secondCallInput.retryContext!.priorOutput).toBe('Bad content');
    expect(secondCallInput.retryContext!.feedback).toContain('Missing title');
  });

  it('returns fail after max iterations', async () => {
    const producer: NodeFn = vi.fn().mockResolvedValue({
      action: 'default',
      artifact: 'Always bad',
    });

    const verified = verify(producer, {
      checks: [
        property('has-title', (c) => c.includes('# Title'), 'Missing title'),
      ],
      maxIterations: 2,
    });

    const result = await verified(mockInput(), mockCtx());
    expect(result.action).toBe('fail');
    expect(producer).toHaveBeenCalledTimes(2);
  });

  it('includes verify metadata in output', async () => {
    const producer: NodeFn = vi.fn().mockResolvedValue({
      action: 'default',
      artifact: '# Title here',
    });

    const verified = verify(producer, {
      checks: [
        property('has-title', (c) => c.includes('# Title'), 'Missing title'),
      ],
    });

    const result = await verified(mockInput(), mockCtx());
    expect(result.metadata).toBeDefined();
    expect(result.metadata!._verifyIteration).toBe(1);
    expect(result.metadata!._verifyChecks).toHaveLength(1);
    expect((result.metadata!._verifyChecks as Array<{ passed: boolean }>)[0].passed).toBe(true);
  });

  it('handles check errors gracefully', async () => {
    const producer: NodeFn = vi.fn()
      .mockResolvedValueOnce({ action: 'default', artifact: 'content' })
      .mockResolvedValueOnce({ action: 'default', artifact: 'content' });

    const errorCheck = {
      name: 'broken-check',
      fn: vi.fn().mockRejectedValue(new Error('check crashed')),
    };

    const verified = verify(producer, {
      checks: [errorCheck],
      maxIterations: 2,
    });

    const result = await verified(mockInput(), mockCtx());
    // Should fail because the erroring check counts as not passed
    expect(result.action).toBe('fail');
    expect(producer).toHaveBeenCalledTimes(2);
  });

  it('preserves producer metadata alongside verify metadata', async () => {
    const producer: NodeFn = vi.fn().mockResolvedValue({
      action: 'default',
      artifact: '# Title',
      metadata: { customKey: 'customValue' },
    });

    const verified = verify(producer, {
      checks: [
        property('has-title', (c) => c.includes('# Title'), 'Missing title'),
      ],
    });

    const result = await verified(mockInput(), mockCtx());
    expect(result.metadata!.customKey).toBe('customValue');
    expect(result.metadata!._verifyIteration).toBe(1);
  });
});
