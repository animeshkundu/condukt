// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { Header } from '../../ui/components/node-panel/Header';
import type { ProjectionNode } from '../../src/types';

afterEach(cleanup);

function makeNode(overrides: Partial<ProjectionNode> = {}): ProjectionNode {
  return {
    id: 'n1',
    displayName: 'Investigate',
    nodeType: 'agent',
    status: 'running',
    attempt: 1,
    ...overrides,
  };
}

describe('Header', () => {
  it('renders node display name', () => {
    const onClose = vi.fn();
    render(<Header node={makeNode()} onClose={onClose} />);
    expect(screen.getByText('Investigate')).toBeTruthy();
  });

  it('renders node type badge', () => {
    const onClose = vi.fn();
    render(<Header node={makeNode({ nodeType: 'deterministic' })} onClose={onClose} />);
    expect(screen.getByText('deterministic')).toBeTruthy();
  });

  it('renders close button with aria-label', () => {
    const onClose = vi.fn();
    render(<Header node={makeNode()} onClose={onClose} />);
    const closeBtn = screen.getByLabelText('Close panel');
    expect(closeBtn).toBeTruthy();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(<Header node={makeNode()} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close panel'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders actions slot when provided', () => {
    const onClose = vi.fn();
    render(
      <Header node={makeNode()} onClose={onClose} actions={<button>Retry</button>} />,
    );
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('does not render actions when not provided', () => {
    const onClose = vi.fn();
    const { container } = render(<Header node={makeNode()} onClose={onClose} />);
    // Only the close button should exist
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1);
  });

  it('shows active glow for running status', () => {
    const onClose = vi.fn();
    const { container } = render(<Header node={makeNode({ status: 'running' })} onClose={onClose} />);
    const dot = container.querySelector('[style*="border-radius"]');
    expect(dot).toBeTruthy();
    expect((dot as HTMLElement).style.boxShadow).not.toBe('none');
  });

  it('shows active glow for gated status', () => {
    const onClose = vi.fn();
    const { container } = render(<Header node={makeNode({ status: 'gated' })} onClose={onClose} />);
    const dot = container.querySelector('[style*="border-radius"]');
    expect(dot).toBeTruthy();
    expect((dot as HTMLElement).style.boxShadow).not.toBe('none');
  });

  it('no glow for completed status', () => {
    const onClose = vi.fn();
    const { container } = render(<Header node={makeNode({ status: 'completed' })} onClose={onClose} />);
    const dot = container.querySelector('[style*="border-radius"]');
    expect(dot).toBeTruthy();
    expect((dot as HTMLElement).style.boxShadow).toBe('none');
  });
});
