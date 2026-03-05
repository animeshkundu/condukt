// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Stat } from '../../ui/core/components/Stat';

describe('Stat', () => {
  it('renders value and label', () => {
    render(<Stat label="Completed" value={7} color="#4ade80" />);
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
  });

  it('applies color as inline style on value', () => {
    render(<Stat label="Failed" value={3} color="#f87171" />);
    const valueEl = screen.getByText('3');
    expect(valueEl.style.color).toBe('rgb(248, 113, 113)');
  });

  it('renders with zero value', () => {
    render(<Stat label="Pending" value={0} color="#888" />);
    expect(screen.getByText('0')).toBeTruthy();
  });
});
