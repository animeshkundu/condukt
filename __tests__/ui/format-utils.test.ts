import { describe, it, expect } from 'vitest';
import { formatElapsed, formatDuration } from '../../ui/core/utils';

describe('formatElapsed', () => {
  it('returns empty string for undefined', () => {
    expect(formatElapsed(undefined)).toBe('');
  });

  it('returns empty string for 0', () => {
    expect(formatElapsed(0)).toBe('');
  });

  it('returns milliseconds for sub-second values', () => {
    expect(formatElapsed(500)).toBe('500ms');
    expect(formatElapsed(1)).toBe('1ms');
    expect(formatElapsed(999)).toBe('999ms');
  });

  it('returns seconds for values under 60s', () => {
    expect(formatElapsed(1000)).toBe('1s');
    expect(formatElapsed(5000)).toBe('5s');
    expect(formatElapsed(59000)).toBe('59s');
  });

  it('returns minutes and seconds for values >= 60s', () => {
    expect(formatElapsed(60000)).toBe('1m 0s');
    expect(formatElapsed(90000)).toBe('1m 30s');
    expect(formatElapsed(125000)).toBe('2m 5s');
    expect(formatElapsed(3600000)).toBe('60m 0s');
  });
});

describe('formatDuration', () => {
  it('returns seconds for values under 60', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(1)).toBe('1s');
    expect(formatDuration(59)).toBe('59s');
  });

  it('returns minutes for values under 3600', () => {
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(120)).toBe('2m');
    expect(formatDuration(3599)).toBe('59m');
  });

  it('returns hours for larger values', () => {
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(7200)).toBe('2h');
  });

  it('returns hours and minutes', () => {
    expect(formatDuration(3660)).toBe('1h 1m');
    expect(formatDuration(5400)).toBe('1h 30m');
    expect(formatDuration(7260)).toBe('2h 1m');
  });

  it('omits remaining minutes when exactly on the hour', () => {
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(7200)).toBe('2h');
  });
});
