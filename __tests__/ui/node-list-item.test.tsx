// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { NodeListItem } from '../../ui/core/components/NodeListItem';
import type { ProjectionNode } from '../../src/types';

afterEach(cleanup);

function makeNode(overrides: Partial<ProjectionNode> = {}): ProjectionNode {
  return {
    id: 'n1',
    displayName: 'Step 1',
    nodeType: 'agent',
    status: 'pending',
    attempt: 1,
    ...overrides,
  };
}

describe('NodeListItem', () => {
  it('renders display name and status', () => {
    const { getByText } = render(<NodeListItem node={makeNode()} />);
    expect(getByText('Step 1')).toBeTruthy();
    expect(getByText('pending')).toBeTruthy();
  });

  it('shows role=button with aria-label', () => {
    const { getByRole } = render(<NodeListItem node={makeNode()} />);
    const el = getByRole('button');
    expect(el.getAttribute('aria-label')).toBe('Step 1: pending');
  });

  it('applies selected state classes', () => {
    const { getByRole } = render(<NodeListItem node={makeNode()} selected />);
    const el = getByRole('button');
    expect(el.className).toContain('border-[#D97757]');
  });

  it('calls onClick on click', () => {
    const onClick = vi.fn();
    const { getByRole } = render(<NodeListItem node={makeNode()} onClick={onClick} />);
    fireEvent.click(getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('calls onClick on Enter key', () => {
    const onClick = vi.fn();
    const { getByRole } = render(<NodeListItem node={makeNode()} onClick={onClick} />);
    fireEvent.keyDown(getByRole('button'), { key: 'Enter' });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('calls onClick on Space key', () => {
    const onClick = vi.fn();
    const { getByRole } = render(<NodeListItem node={makeNode()} onClick={onClick} />);
    fireEvent.keyDown(getByRole('button'), { key: ' ' });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows actions slot when selected', () => {
    const { getByText } = render(<NodeListItem node={makeNode()} selected actions={<button>Retry</button>} />);
    const retryBtn = getByText('Retry');
    const wrapper = retryBtn.parentElement!;
    expect(wrapper.className).toContain('opacity-100');
  });

  it('hides actions slot by default (opacity-0)', () => {
    const { getByText } = render(<NodeListItem node={makeNode()} actions={<button>Retry</button>} />);
    const retryBtn = getByText('Retry');
    const wrapper = retryBtn.parentElement!;
    expect(wrapper.className).toContain('opacity-0');
  });

  it('shows error text when node has error', () => {
    const { getByText } = render(<NodeListItem node={makeNode({ error: 'Something went wrong' })} />);
    expect(getByText('Something went wrong')).toBeTruthy();
  });

  it('shows attempt badge when attempt > 1', () => {
    const { getByText } = render(<NodeListItem node={makeNode({ attempt: 3 })} />);
    expect(getByText('x3')).toBeTruthy();
  });

  it('shows model name when present', () => {
    const { getByText } = render(<NodeListItem node={makeNode({ model: 'opus' })} />);
    expect(getByText('opus')).toBeTruthy();
  });

  it('shows elapsed time when present', () => {
    const { getByText } = render(<NodeListItem node={makeNode({ elapsedMs: 5000 })} />);
    expect(getByText('5s')).toBeTruthy();
  });
});
