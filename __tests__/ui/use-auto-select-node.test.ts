// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoSelectNode } from '../../ui/hooks/useAutoSelectNode';
import type { ProjectionNode } from '../../src/types';

function makeNode(id: string, status: string): ProjectionNode {
  return { id, displayName: id, nodeType: 'agent', status, attempt: 1 };
}

describe('useAutoSelectNode', () => {
  it('returns null for empty array', () => {
    const { result } = renderHook(() => useAutoSelectNode([]));
    expect(result.current).toBeNull();
  });

  it('selects running node over others', () => {
    const nodes = [makeNode('a', 'completed'), makeNode('b', 'running'), makeNode('c', 'failed')];
    const { result } = renderHook(() => useAutoSelectNode(nodes));
    expect(result.current).toBe('b');
  });

  it('selects retrying over gated and failed', () => {
    const nodes = [makeNode('a', 'gated'), makeNode('b', 'retrying'), makeNode('c', 'failed')];
    const { result } = renderHook(() => useAutoSelectNode(nodes));
    expect(result.current).toBe('b');
  });

  it('selects gated over failed', () => {
    const nodes = [makeNode('a', 'failed'), makeNode('b', 'gated')];
    const { result } = renderHook(() => useAutoSelectNode(nodes));
    expect(result.current).toBe('b');
  });

  it('selects failed when no active nodes', () => {
    const nodes = [makeNode('a', 'completed'), makeNode('b', 'failed'), makeNode('c', 'pending')];
    const { result } = renderHook(() => useAutoSelectNode(nodes));
    expect(result.current).toBe('b');
  });

  it('falls back to last completed node', () => {
    const nodes = [makeNode('a', 'completed'), makeNode('b', 'completed'), makeNode('c', 'pending')];
    const { result } = renderHook(() => useAutoSelectNode(nodes));
    expect(result.current).toBe('b');
  });

  it('returns null when all nodes are pending', () => {
    const nodes = [makeNode('a', 'pending'), makeNode('b', 'pending')];
    const { result } = renderHook(() => useAutoSelectNode(nodes));
    expect(result.current).toBeNull();
  });

  it('handles single running node', () => {
    const { result } = renderHook(() => useAutoSelectNode([makeNode('x', 'running')]));
    expect(result.current).toBe('x');
  });
});
