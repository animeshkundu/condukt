// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExecutionCard } from '../../ui/core/components/ExecutionCard';

describe('ExecutionCard', () => {
  it('renders as a link with href', () => {
    render(<ExecutionCard href="/flow/abc" title="Investigation" status="running" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/flow/abc');
  });

  it('renders title and status badge', () => {
    render(<ExecutionCard href="/x" title="My Flow" status="completed" />);
    expect(screen.getByText('My Flow')).toBeTruthy();
    expect(screen.getByText('completed')).toBeTruthy();
  });

  it('renders subtitle when provided', () => {
    render(<ExecutionCard href="/x" title="T" status="running" subtitle="Sub text" />);
    expect(screen.getByText('Sub text')).toBeTruthy();
  });

  it('renders metadata when provided', () => {
    render(<ExecutionCard href="/x" title="T" status="running" metadata="inv-abc · 2h" />);
    expect(screen.getByText('inv-abc · 2h')).toBeTruthy();
  });

  it('renders children slot', () => {
    render(
      <ExecutionCard href="/x" title="T" status="running">
        <div data-testid="mini">dots</div>
      </ExecutionCard>,
    );
    expect(screen.getByTestId('mini')).toBeTruthy();
  });

  it('renders progress bar when progress > 0', () => {
    const { container } = render(
      <ExecutionCard href="/x" title="T" status="running" progress={60} />,
    );
    const bar = container.querySelector('.h-\\[3px\\]');
    expect(bar).toBeTruthy();
    expect((bar as HTMLElement).style.width).toBe('60%');
  });

  it('does not render progress bar when progress is 0', () => {
    const { container } = render(
      <ExecutionCard href="/x" title="T" status="running" progress={0} />,
    );
    const bar = container.querySelector('.h-\\[3px\\]');
    expect(bar).toBeNull();
  });
});
