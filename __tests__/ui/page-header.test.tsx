// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from '../../ui/core/components/PageHeader';

describe('PageHeader', () => {
  it('renders title', () => {
    render(<PageHeader title="My Flow" />);
    expect(screen.getByText('My Flow')).toBeTruthy();
  });

  it('renders as a header element', () => {
    const { container } = render(<PageHeader title="Test" />);
    expect(container.querySelector('header')).toBeTruthy();
  });

  it('renders back link when backHref provided', () => {
    render(<PageHeader title="Detail" backHref="/" />);
    const link = screen.getByLabelText('Back');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/');
  });

  it('uses custom backLabel for aria-label', () => {
    render(<PageHeader title="Detail" backHref="/" backLabel="Go home" />);
    expect(screen.getByLabelText('Go home')).toBeTruthy();
  });

  it('renders badge next to title', () => {
    render(<PageHeader title="Flow" badge={<span data-testid="badge">running</span>} />);
    expect(screen.getByTestId('badge')).toBeTruthy();
  });

  it('renders actions slot', () => {
    render(<PageHeader title="Flow" actions={<button>Stop</button>} />);
    expect(screen.getByText('Stop')).toBeTruthy();
  });

  it('does not render back link when backHref is omitted', () => {
    const { container } = render(<PageHeader title="No Back" />);
    expect(container.querySelector('a')).toBeNull();
  });
});
