// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';
import { formatTokens } from '../../ui/core/utils';
import { ImageBlock } from '../../ui/tool-display/ImageBlock';
import { ResourceLink } from '../../ui/tool-display/ResourceLink';
import { CostBadge } from '../../ui/core/components/CostBadge';
import { ElapsedTime } from '../../ui/core/components/ElapsedTime';

afterEach(cleanup);

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------
describe('formatTokens', () => {
  it('returns raw number for values under 1000', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(999)).toBe('999');
  });

  it('returns K suffix for thousands', () => {
    expect(formatTokens(1000)).toBe('1K');
    expect(formatTokens(5500)).toBe('6K');
    expect(formatTokens(999_999)).toBe('1000K');
  });

  it('returns M suffix for millions', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(12_345_678)).toBe('12.3M');
  });
});

// ---------------------------------------------------------------------------
// ImageBlock
// ---------------------------------------------------------------------------
describe('ImageBlock', () => {
  // Minimal 1x1 red PNG as base64
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

  it('renders an img element', () => {
    render(<ImageBlock data={PNG_B64} mimeType="image/png" />);
    const img = screen.getByRole('button') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
  });

  it('sets the correct data URI src', () => {
    render(<ImageBlock data={PNG_B64} mimeType="image/png" />);
    const img = screen.getByRole('button') as HTMLImageElement;
    expect(img.src).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('uses provided alt text', () => {
    render(<ImageBlock data={PNG_B64} mimeType="image/png" alt="Screenshot" />);
    expect(screen.getByAltText('Screenshot')).toBeTruthy();
  });

  it('falls back to default alt text', () => {
    render(<ImageBlock data={PNG_B64} mimeType="image/png" />);
    expect(screen.getByAltText('Tool result (image/png)')).toBeTruthy();
  });

  it('has role=button and tabIndex for accessibility', () => {
    render(<ImageBlock data={PNG_B64} mimeType="image/png" />);
    const img = screen.getByRole('button');
    expect(img.getAttribute('tabindex')).toBe('0');
  });

  it('opens blob URL on click', () => {
    const mockOpen = vi.fn();
    const origOpen = window.open;
    window.open = mockOpen;
    const mockCreateObjectURL = vi.fn(() => 'blob:test');
    const mockRevokeObjectURL = vi.fn();
    URL.createObjectURL = mockCreateObjectURL;
    URL.revokeObjectURL = mockRevokeObjectURL;

    render(<ImageBlock data={PNG_B64} mimeType="image/png" />);
    fireEvent.click(screen.getByRole('button'));

    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    expect(mockOpen).toHaveBeenCalledWith('blob:test', '_blank');

    window.open = origOpen;
  });

  it('opens blob URL on Enter keypress', () => {
    const mockOpen = vi.fn();
    const origOpen = window.open;
    window.open = mockOpen;
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();

    render(<ImageBlock data={PNG_B64} mimeType="image/png" />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });

    expect(mockOpen).toHaveBeenCalledWith('blob:test', '_blank');

    window.open = origOpen;
  });
});

// ---------------------------------------------------------------------------
// ResourceLink
// ---------------------------------------------------------------------------
describe('ResourceLink', () => {
  it('renders the label text', () => {
    render(<ResourceLink uri="https://example.com" name="Example" />);
    expect(screen.getByText('Example')).toBeTruthy();
  });

  it('uses title as label when provided', () => {
    render(<ResourceLink uri="https://example.com" name="example" title="Example Site" />);
    expect(screen.getByText('Example Site')).toBeTruthy();
  });

  it('opens HTTP links in new tab', () => {
    const mockOpen = vi.fn();
    const origOpen = window.open;
    window.open = mockOpen;

    render(<ResourceLink uri="https://example.com/path" name="Link" />);
    fireEvent.click(screen.getByRole('button'));

    expect(mockOpen).toHaveBeenCalledWith('https://example.com/path', '_blank', 'noopener');

    window.open = origOpen;
  });

  it('copies non-HTTP URIs to clipboard and shows Copied!', () => {
    const mockWrite = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: mockWrite } });

    render(<ResourceLink uri="file:///local/path.txt" name="Local File" />);
    fireEvent.click(screen.getByRole('button'));

    expect(mockWrite).toHaveBeenCalledWith('file:///local/path.txt');
    expect(screen.getByText('Copied!')).toBeTruthy();
  });

  it('shows arrow icon for HTTP links', () => {
    render(<ResourceLink uri="https://example.com" name="Link" />);
    const icon = screen.getByRole('button').querySelector('[aria-hidden="true"]');
    expect(icon?.textContent).toBe('\u2197');
  });

  it('shows copy icon for non-HTTP links', () => {
    render(<ResourceLink uri="file:///path" name="File" />);
    const icon = screen.getByRole('button').querySelector('[aria-hidden="true"]');
    expect(icon?.textContent).toBe('\u2398');
  });

  it('includes mimeType in title when provided', () => {
    render(<ResourceLink uri="https://example.com" name="Doc" mimeType="text/html" />);
    expect(screen.getByRole('button').getAttribute('title')).toBe('https://example.com (text/html)');
  });

  it('is keyboard accessible', () => {
    const mockOpen = vi.fn();
    const origOpen = window.open;
    window.open = mockOpen;

    render(<ResourceLink uri="https://example.com" name="Link" />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });

    expect(mockOpen).toHaveBeenCalled();

    window.open = origOpen;
  });
});

// ---------------------------------------------------------------------------
// CostBadge
// ---------------------------------------------------------------------------
describe('CostBadge', () => {
  it('renders formatted input and output tokens', () => {
    render(<CostBadge inputTokens={5500} outputTokens={1200} />);
    expect(screen.getByText('6K in / 1K out')).toBeTruthy();
  });

  it('renders input tokens only', () => {
    render(<CostBadge inputTokens={500} />);
    expect(screen.getByText('500 in')).toBeTruthy();
  });

  it('renders output tokens only', () => {
    render(<CostBadge outputTokens={2_000_000} />);
    expect(screen.getByText('2.0M out')).toBeTruthy();
  });

  it('renders cost with appropriate precision', () => {
    render(<CostBadge cost={0.005} />);
    expect(screen.getByText('$0.005')).toBeTruthy();
  });

  it('renders cost >= $0.01 with 2 decimal places', () => {
    render(<CostBadge cost={1.5} />);
    expect(screen.getByText('$1.50')).toBeTruthy();
  });

  it('renders duration in seconds', () => {
    render(<CostBadge duration={42.3} />);
    expect(screen.getByText('42.3s')).toBeTruthy();
  });

  it('renders duration in minutes when >= 60', () => {
    render(<CostBadge duration={90} />);
    expect(screen.getByText('1.5m')).toBeTruthy();
  });

  it('joins multiple parts with middle dot', () => {
    render(<CostBadge inputTokens={1000} outputTokens={500} cost={0.05} duration={10} />);
    expect(screen.getByText('1K in / 500 out \u00b7 $0.05 \u00b7 10.0s')).toBeTruthy();
  });

  it('returns null when no data provided', () => {
    const { container } = render(<CostBadge />);
    expect(container.innerHTML).toBe('');
  });

  it('shows model in tooltip when provided', () => {
    render(<CostBadge inputTokens={100} model="gpt-4" />);
    const badge = screen.getByText('100 in').closest('span[title]');
    expect(badge?.getAttribute('title')).toBe('Model: gpt-4');
  });
});

// ---------------------------------------------------------------------------
// ElapsedTime
// ---------------------------------------------------------------------------
describe('ElapsedTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when no startedAt provided', () => {
    const { container } = render(<ElapsedTime />);
    expect(container.innerHTML).toBe('');
  });

  it('renders total time when finishedAt is set', () => {
    const start = 1000;
    const finish = 6000; // 5 seconds later
    render(<ElapsedTime startedAt={start} finishedAt={finish} />);
    expect(screen.getByText('5s total')).toBeTruthy();
  });

  it('renders elapsed time when still running', () => {
    const start = Date.now() - 3000; // 3 seconds ago
    render(<ElapsedTime startedAt={start} />);
    expect(screen.getByText('3s elapsed')).toBeTruthy();
  });

  it('updates elapsed time on timer tick', () => {
    const start = Date.now();
    render(<ElapsedTime startedAt={start} />);
    expect(screen.getByText('0s elapsed')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('2s elapsed')).toBeTruthy();
  });

  it('stops updating when finishedAt is provided', () => {
    const start = Date.now();
    const { rerender } = render(<ElapsedTime startedAt={start} />);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText('3s elapsed')).toBeTruthy();

    // Now provide finishedAt
    rerender(<ElapsedTime startedAt={start} finishedAt={start + 3000} />);
    expect(screen.getByText('3s total')).toBeTruthy();

    // Advance time further - should not change
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('3s total')).toBeTruthy();
  });
});
