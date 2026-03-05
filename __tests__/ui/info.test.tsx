// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Info } from '../../ui/components/node-panel/Info';
import type { ProjectionNode } from '../../src/types';

afterEach(cleanup);

function makeNode(overrides: Partial<ProjectionNode> = {}): ProjectionNode {
  return {
    id: 'n1',
    displayName: 'Step 1',
    nodeType: 'agent',
    status: 'completed',
    attempt: 1,
    ...overrides,
  };
}

describe('Info', () => {
  it('renders status', () => {
    render(<Info node={makeNode({ status: 'running' })} />);
    expect(screen.getByText('running')).toBeTruthy();
  });

  it('renders model when present', () => {
    render(<Info node={makeNode({ model: 'opus' })} />);
    expect(screen.getByText('Model: opus')).toBeTruthy();
  });

  it('does not render model when absent', () => {
    const { container } = render(<Info node={makeNode()} />);
    expect(container.textContent).not.toContain('Model:');
  });

  it('renders duration when elapsedMs is provided', () => {
    render(<Info node={makeNode({ elapsedMs: 5000 })} />);
    expect(screen.getByText('Duration: 5s')).toBeTruthy();
  });

  it('renders duration in minutes for longer times', () => {
    render(<Info node={makeNode({ elapsedMs: 125000 })} />);
    expect(screen.getByText('Duration: 2m 5s')).toBeTruthy();
  });

  it('renders duration in ms for short times', () => {
    render(<Info node={makeNode({ elapsedMs: 500 })} />);
    expect(screen.getByText('Duration: 500ms')).toBeTruthy();
  });

  it('does not render duration when elapsedMs is absent', () => {
    const { container } = render(<Info node={makeNode()} />);
    expect(container.textContent).not.toContain('Duration:');
  });

  it('renders attempt count when > 1', () => {
    render(<Info node={makeNode({ attempt: 3 })} />);
    expect(screen.getByText('Attempt: 3')).toBeTruthy();
  });

  it('does not render attempt when attempt is 1', () => {
    const { container } = render(<Info node={makeNode({ attempt: 1 })} />);
    expect(container.textContent).not.toContain('Attempt:');
  });

  it('renders all fields together', () => {
    const { container } = render(
      <Info node={makeNode({ status: 'failed', model: 'sonnet', elapsedMs: 90000, attempt: 2 })} />,
    );
    expect(container.textContent).toContain('failed');
    expect(container.textContent).toContain('Model: sonnet');
    expect(container.textContent).toContain('Duration: 1m 30s');
    expect(container.textContent).toContain('Attempt: 2');
  });
});
