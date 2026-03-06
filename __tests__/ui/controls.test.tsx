// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { Controls } from '../../ui/components/node-panel/Controls';
import type { ProjectionNode } from '../../src/types';

afterEach(cleanup);

function makeNode(overrides: Partial<ProjectionNode> = {}): ProjectionNode {
  return {
    id: 'n1',
    displayName: 'Step 1',
    nodeType: 'agent',
    status: 'completed',
    attempt: 1,
    iteration: 0,
    ...overrides,
  };
}

describe('Controls', () => {
  it('renders nothing when executionRunning is true', () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    const { container } = render(
      <Controls node={makeNode({ status: 'failed' })} onRetry={onRetry} onSkip={onSkip} executionRunning />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows Retry and Skip for failed status', () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    render(
      <Controls node={makeNode({ status: 'failed' })} onRetry={onRetry} onSkip={onSkip} />,
    );
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.getByText('Skip')).toBeTruthy();
  });

  it('shows Retry and Skip for killed status', () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    render(
      <Controls node={makeNode({ status: 'killed' })} onRetry={onRetry} onSkip={onSkip} />,
    );
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.getByText('Skip')).toBeTruthy();
  });

  it('shows Redo for completed status', () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    render(
      <Controls node={makeNode({ status: 'completed' })} onRetry={onRetry} onSkip={onSkip} />,
    );
    expect(screen.getByText('Redo')).toBeTruthy();
    expect(screen.queryByText('Skip')).toBeNull();
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it('shows only Skip for pending status', () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    render(
      <Controls node={makeNode({ status: 'pending' })} onRetry={onRetry} onSkip={onSkip} />,
    );
    expect(screen.getByText('Skip')).toBeTruthy();
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.queryByText('Redo')).toBeNull();
  });

  it('renders nothing for running status (without executionRunning flag)', () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    const { container } = render(
      <Controls node={makeNode({ status: 'running' })} onRetry={onRetry} onSkip={onSkip} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for gated status', () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    const { container } = render(
      <Controls node={makeNode({ status: 'gated' })} onRetry={onRetry} onSkip={onSkip} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('calls onRetry when Retry clicked', () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    render(
      <Controls node={makeNode({ status: 'failed' })} onRetry={onRetry} onSkip={onSkip} />,
    );
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('calls onRetry when Redo clicked', () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    render(
      <Controls node={makeNode({ status: 'completed' })} onRetry={onRetry} onSkip={onSkip} />,
    );
    fireEvent.click(screen.getByText('Redo'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('calls onSkip when Skip clicked', () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    render(
      <Controls node={makeNode({ status: 'failed' })} onRetry={onRetry} onSkip={onSkip} />,
    );
    fireEvent.click(screen.getByText('Skip'));
    expect(onSkip).toHaveBeenCalledOnce();
  });
});
