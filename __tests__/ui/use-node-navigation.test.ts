// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNodeNavigation } from '../../ui/hooks/useNodeNavigation';
import type { ProjectionNode } from '../../src/types';

function makeNode(id: string): ProjectionNode {
  return { id, displayName: id, nodeType: 'agent', status: 'completed', attempt: 1 };
}

function fireKey(key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true });
  document.dispatchEvent(event);
}

describe('useNodeNavigation', () => {
  const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];

  it('selects first node on j when nothing is selected', () => {
    const onSelect = vi.fn();
    renderHook(() => useNodeNavigation(nodes, null, onSelect));
    act(() => fireKey('j'));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('moves to next node on j', () => {
    const onSelect = vi.fn();
    renderHook(() => useNodeNavigation(nodes, 'a', onSelect));
    act(() => fireKey('j'));
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('moves to next node on ArrowDown', () => {
    const onSelect = vi.fn();
    renderHook(() => useNodeNavigation(nodes, 'a', onSelect));
    act(() => fireKey('ArrowDown'));
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('wraps around on j at last node', () => {
    const onSelect = vi.fn();
    renderHook(() => useNodeNavigation(nodes, 'c', onSelect));
    act(() => fireKey('j'));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('moves to previous node on k', () => {
    const onSelect = vi.fn();
    renderHook(() => useNodeNavigation(nodes, 'b', onSelect));
    act(() => fireKey('k'));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('moves to previous node on ArrowUp', () => {
    const onSelect = vi.fn();
    renderHook(() => useNodeNavigation(nodes, 'b', onSelect));
    act(() => fireKey('ArrowUp'));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('wraps around on k at first node', () => {
    const onSelect = vi.fn();
    renderHook(() => useNodeNavigation(nodes, 'a', onSelect));
    act(() => fireKey('k'));
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('deselects on Escape', () => {
    const onSelect = vi.fn();
    renderHook(() => useNodeNavigation(nodes, 'b', onSelect));
    act(() => fireKey('Escape'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('does nothing with empty nodes', () => {
    const onSelect = vi.fn();
    renderHook(() => useNodeNavigation([], null, onSelect));
    act(() => fireKey('j'));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
