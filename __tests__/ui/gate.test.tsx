// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { Gate } from '../../ui/components/node-panel/Gate';
import type { ProjectionNode } from '../../src/types';

afterEach(cleanup);

function makeNode(overrides: Partial<ProjectionNode> = {}): ProjectionNode {
  return {
    id: 'gate1',
    displayName: 'Gate',
    nodeType: 'gate',
    status: 'gated',
    attempt: 1,
    ...overrides,
  };
}

describe('Gate', () => {
  it('renders nothing when status is not gated', () => {
    const onResolve = vi.fn();
    const { container } = render(<Gate node={makeNode({ status: 'completed' })} onResolve={onResolve} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders "Awaiting Resolution" text when gated', () => {
    const onResolve = vi.fn();
    render(<Gate node={makeNode()} onResolve={onResolve} />);
    expect(screen.getByText('Awaiting Resolution')).toBeTruthy();
  });

  it('renders default approved/rejected buttons', () => {
    const onResolve = vi.fn();
    render(<Gate node={makeNode()} onResolve={onResolve} />);
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getByText('Rejected')).toBeTruthy();
  });

  it('renders custom resolutions from gateData', () => {
    const onResolve = vi.fn();
    const node = makeNode({
      gateData: { allowedResolutions: ['deploy', 'rollback', 'skip'] },
    });
    render(<Gate node={node} onResolve={onResolve} />);
    expect(screen.getByText('Deploy')).toBeTruthy();
    expect(screen.getByText('Rollback')).toBeTruthy();
    expect(screen.getByText('Skip')).toBeTruthy();
  });

  it('calls onResolve with resolution when button clicked', () => {
    const onResolve = vi.fn();
    render(<Gate node={makeNode()} onResolve={onResolve} />);
    fireEvent.click(screen.getByText('Approved'));
    expect(onResolve).toHaveBeenCalledWith('approved');
  });

  it('calls onResolve with correct custom resolution', () => {
    const onResolve = vi.fn();
    const node = makeNode({
      gateData: { allowedResolutions: ['deploy', 'rollback'] },
    });
    render(<Gate node={node} onResolve={onResolve} />);
    fireEvent.click(screen.getByText('Rollback'));
    expect(onResolve).toHaveBeenCalledWith('rollback');
  });

  it('falls back to default when allowedResolutions is not an array', () => {
    const onResolve = vi.fn();
    const node = makeNode({
      gateData: { allowedResolutions: 'not-an-array' },
    });
    render(<Gate node={node} onResolve={onResolve} />);
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getByText('Rejected')).toBeTruthy();
  });

  it('renders gate data (excluding allowedResolutions) as JSON', () => {
    const onResolve = vi.fn();
    const node = makeNode({
      gateData: {
        allowedResolutions: ['approved', 'rejected'],
        verdict: 'CONFIRMED',
        score: 85,
      },
    });
    const { container } = render(<Gate node={node} onResolve={onResolve} />);
    const pre = container.querySelector('pre');
    expect(pre).toBeTruthy();
    expect(pre!.textContent).toContain('verdict');
    expect(pre!.textContent).toContain('CONFIRMED');
    expect(pre!.textContent).toContain('85');
  });

  it('does not render gate data JSON when no extra fields', () => {
    const onResolve = vi.fn();
    const node = makeNode({ gateData: {} });
    const { container } = render(<Gate node={node} onResolve={onResolve} />);
    expect(container.querySelector('pre')).toBeNull();
  });

  it('uses correct colors for known resolution types', () => {
    const onResolve = vi.fn();
    const node = makeNode({
      gateData: { allowedResolutions: ['approved', 'rejected', 'skip'] },
    });
    const { container } = render(<Gate node={node} onResolve={onResolve} />);
    const buttons = container.querySelectorAll('button');
    // jsdom converts hex to rgb; check that each button has a color style set
    expect(buttons.length).toBe(3);
    // approved -> green (#22c55e)
    expect((buttons[0] as HTMLElement).style.color).toContain('34, 197, 94');
    // rejected -> red (#ef4444)
    expect((buttons[1] as HTMLElement).style.color).toContain('239, 68, 68');
    // skip -> gray (#888)
    expect((buttons[2] as HTMLElement).style.color).toContain('136, 136, 136');
  });
});
