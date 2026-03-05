// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ErrorBar } from '../../ui/components/node-panel/ErrorBar';

afterEach(cleanup);

describe('ErrorBar', () => {
  it('renders error text', () => {
    render(<ErrorBar error="Something went wrong" />);
    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });

  it('renders with red text color', () => {
    const { container } = render(<ErrorBar error="fail" />);
    const div = container.firstElementChild as HTMLElement;
    expect(div.style.color).toBe('rgb(248, 113, 113)');
  });

  it('renders with left border accent', () => {
    const { container } = render(<ErrorBar error="fail" />);
    const div = container.firstElementChild as HTMLElement;
    expect(div.style.borderLeft).toContain('3px solid');
  });

  it('renders long error messages', () => {
    const longError = 'A very long error message that spans many characters';
    render(<ErrorBar error={longError} />);
    expect(screen.getByText(longError)).toBeTruthy();
  });

  it('renders error with special characters', () => {
    render(<ErrorBar error="Error: <script>alert('xss')</script>" />);
    // React escapes HTML by default, so the text should be rendered as-is
    expect(screen.getByText("Error: <script>alert('xss')</script>")).toBeTruthy();
  });
});
