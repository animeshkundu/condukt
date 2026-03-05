// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { Output } from '../../ui/components/node-panel/Output';

afterEach(cleanup);

// Mock clipboard API
beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe('Output', () => {
  // -------------------------------------------------------------------------
  // Render modes
  // -------------------------------------------------------------------------

  it('renders lines in plain mode by default', () => {
    const { container } = render(<Output lines={['hello', 'world']} total={2} />);
    expect(container.textContent).toContain('hello');
    expect(container.textContent).toContain('world');
    // No dangerouslySetInnerHTML in plain mode
    const divs = container.querySelectorAll('[style*="pre-wrap"]');
    for (const div of divs) {
      expect(div.getAttribute('dangerouslysetinnerhtml')).toBeNull();
    }
  });

  it('renders lines in ansi mode with colored spans', () => {
    const { container } = render(
      <Output lines={['\x1b[32mgreen text\x1b[0m']} total={1} renderer="ansi" />,
    );
    const html = container.innerHTML;
    expect(html).toContain('color:#22c55e');
    expect(html).toContain('green text');
  });

  it('renders plain lines without dangerouslySetInnerHTML in ansi mode', () => {
    // Lines without ANSI codes should use the fast-path (no innerHTML)
    const { container } = render(
      <Output lines={['plain line']} total={1} renderer="ansi" />,
    );
    const divs = container.querySelectorAll('[style*="pre-wrap"]');
    expect(divs.length).toBeGreaterThan(0);
    expect(divs[0].textContent).toBe('plain line');
  });

  it('renders lines using custom function renderer', () => {
    const customRenderer = (line: string, index: number) => (
      <span data-testid={`line-${index}`}>{line.toUpperCase()}</span>
    );
    render(<Output lines={['test']} total={1} renderer={customRenderer} />);
    expect(screen.getByTestId('line-0').textContent).toBe('TEST');
  });

  // -------------------------------------------------------------------------
  // Line count display
  // -------------------------------------------------------------------------

  it('shows total lines when all loaded', () => {
    const { container } = render(<Output lines={['a', 'b', 'c']} total={3} />);
    expect(container.textContent).toContain('3 lines');
  });

  it('shows partial count when lines < total', () => {
    const { container } = render(<Output lines={['a', 'b']} total={10} />);
    expect(container.textContent).toContain('2 of 10 lines');
  });

  it('shows loading indicator', () => {
    const { container } = render(<Output lines={['a']} total={5} loading />);
    expect(container.textContent).toContain('(loading...)');
  });

  // -------------------------------------------------------------------------
  // Line cap
  // -------------------------------------------------------------------------

  it('caps lines at maxLines, keeping newest', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`);
    const { container } = render(<Output lines={lines} total={200} maxLines={100} />);
    // Should show capped count
    expect(container.textContent).toContain('100 of 200 lines');
    // First visible line should be line-100
    expect(container.textContent).toContain('line-100');
    expect(container.textContent).not.toContain('line-0');
  });

  it('does not cap when under limit', () => {
    const lines = ['a', 'b', 'c'];
    const { container } = render(<Output lines={lines} total={3} maxLines={50000} />);
    expect(container.textContent).toContain('3 lines');
  });

  // -------------------------------------------------------------------------
  // Copy button
  // -------------------------------------------------------------------------

  it('copy button calls clipboard.writeText with stripped ANSI', async () => {
    render(<Output lines={['\x1b[31mred\x1b[0m', 'plain']} total={2} />);
    const copyBtn = screen.getByText('Copy');
    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('red\nplain');
  });

  it('shows Copied! feedback after copy', async () => {
    render(<Output lines={['text']} total={1} />);
    fireEvent.click(screen.getByText('Copy'));
    // clipboard.writeText is async; wait for the promise to resolve
    await vi.waitFor(() => {
      expect(screen.getByText('Copied!')).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Auto-scroll toggle
  // -------------------------------------------------------------------------

  it('shows auto-scroll button defaulting to ON', () => {
    render(<Output lines={['a']} total={1} />);
    expect(screen.getByText('Auto-scroll ON')).toBeTruthy();
  });

  it('toggles auto-scroll on click', () => {
    render(<Output lines={['a']} total={1} />);
    fireEvent.click(screen.getByText('Auto-scroll ON'));
    expect(screen.getByText('Auto-scroll OFF')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Empty states
  // -------------------------------------------------------------------------

  it('shows "Waiting for output..." when running with no lines', () => {
    render(<Output lines={[]} total={0} isRunning />);
    expect(screen.getByText('Waiting for output...')).toBeTruthy();
  });

  it('shows "No output" when not running with no lines', () => {
    render(<Output lines={[]} total={0} />);
    expect(screen.getByText('No output')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Running cursor
  // -------------------------------------------------------------------------

  it('shows blinking cursor when isRunning', () => {
    const { container } = render(<Output lines={['a']} total={1} isRunning />);
    const cursor = container.querySelector('[style*="animation"]');
    expect(cursor).toBeTruthy();
  });

  it('does not show cursor when not running', () => {
    const { container } = render(<Output lines={['a']} total={1} />);
    const cursor = container.querySelector('[style*="flow-blink"]');
    expect(cursor).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Empty line rendering (NBSP)
  // -------------------------------------------------------------------------

  it('renders empty lines as non-breaking space', () => {
    const { container } = render(<Output lines={['']} total={1} />);
    const lineDiv = container.querySelector('[style*="pre-wrap"]');
    expect(lineDiv).toBeTruthy();
    expect(lineDiv!.textContent).toBe('\u00A0');
  });
});
