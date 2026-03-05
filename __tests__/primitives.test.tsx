/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { Badge } from '../ui/core/components/Badge';
import { Button } from '../ui/core/components/Button';
import { SectionLabel } from '../ui/core/components/SectionLabel';
import { Skeleton } from '../ui/core/components/Skeleton';
import { Toast } from '../ui/core/components/Toast';
import { ConfirmDialog } from '../ui/core/components/ConfirmDialog';

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------
describe('Badge', () => {
  it('renders status text', () => {
    render(<Badge status="running" />);
    expect(screen.getByText('running')).toBeTruthy();
  });

  it('applies status colors via inline style', () => {
    const { container } = render(<Badge status="completed" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.color).toBe('rgb(74, 222, 128)'); // #4ade80
  });

  it('falls back to pending colors for unknown status', () => {
    const { container } = render(<Badge status="unknown-xyz" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.color).toBe('rgb(136, 136, 136)'); // #888
  });
});

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------
describe('Button', () => {
  it('renders children', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeTruthy();
  });

  it('is disabled when disabled prop is set', () => {
    render(<Button disabled>No</Button>);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is disabled when loading', () => {
    render(<Button loading>Go</Button>);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });

  it('fires onClick', () => {
    const fn = vi.fn();
    render(<Button onClick={fn}>Go</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not fire onClick when disabled', () => {
    const fn = vi.fn();
    render(<Button disabled onClick={fn}>Go</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(fn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SectionLabel
// ---------------------------------------------------------------------------
describe('SectionLabel', () => {
  it('renders children', () => {
    render(<SectionLabel>Details</SectionLabel>);
    expect(screen.getByText('Details')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------
describe('Skeleton', () => {
  it('renders card variant', () => {
    const { container } = render(<Skeleton variant="card" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.height).toBe('120px');
  });

  it('renders row variant', () => {
    const { container } = render(<Skeleton variant="row" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.height).toBe('40px');
  });

  it('renders text variant with correct number of lines', () => {
    const { container } = render(<Skeleton variant="text" lines={5} />);
    expect(container.firstElementChild!.children).toHaveLength(5);
  });

  it('defaults to 3 lines for text variant', () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild!.children).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
describe('Toast', () => {
  it('renders message', () => {
    render(<Toast message="Done!" type="success" />);
    expect(screen.getByText('Done!')).toBeTruthy();
  });

  it('has correct accessibility attributes', () => {
    render(<Toast message="Error!" type="error" />);
    const el = screen.getByRole('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
  });

  it('auto-dismisses after 4 seconds', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Bye" type="success" onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4000);
    expect(onDismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialog
// ---------------------------------------------------------------------------
describe('ConfirmDialog', () => {
  it('renders title and message', () => {
    render(
      <ConfirmDialog
        title="Delete?"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Delete?')).toBeTruthy();
    expect(screen.getByText('This cannot be undone.')).toBeTruthy();
  });

  it('calls onCancel on Escape key', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Delete?"
        message="Sure?"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onConfirm when confirm button clicked', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Delete?"
        message="Sure?"
        confirmLabel="Yes"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Yes'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('uses custom labels', () => {
    render(
      <ConfirmDialog
        title="T"
        message="M"
        confirmLabel="Do it"
        cancelLabel="Nah"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Do it')).toBeTruthy();
    expect(screen.getByText('Nah')).toBeTruthy();
  });

  it('uses danger variant for confirm button', () => {
    render(
      <ConfirmDialog
        title="T"
        message="M"
        variant="danger"
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const btn = screen.getByText('Delete');
    expect(btn.className).toContain('bg-red-600');
  });
});
