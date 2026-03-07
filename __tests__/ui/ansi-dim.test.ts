import { describe, it, expect } from 'vitest';
import { ansiToHtml, hasAnsi } from '../../ui/ansi';

describe('ANSI dim rendering (SGR 2)', () => {
  it('renders dim text with opacity 0.6', () => {
    const input = '\x1b[2mdim text\x1b[0m';
    expect(hasAnsi(input)).toBe(true);
    const html = ansiToHtml(input);
    expect(html).toContain('opacity:0.6');
    expect(html).toContain('dim text');
  });

  it('renders thinking prefix with dim styling', () => {
    const input = '\x1b[2m[thinking] deep thought about architecture\x1b[0m';
    const html = ansiToHtml(input);
    expect(html).toContain('opacity:0.6');
    expect(html).toContain('[thinking]');
    expect(html).toContain('deep thought about architecture');
  });

  it('renders dim + color combination', () => {
    const input = '\x1b[2;33mdim yellow\x1b[0m';
    const html = ansiToHtml(input);
    expect(html).toContain('opacity:0.6');
  });

  it('unbolds/undims with SGR 22', () => {
    const input = '\x1b[2mdim\x1b[22mnormal';
    const html = ansiToHtml(input);
    // After SGR 22, dim should be off — no opacity in the second span
    expect(html).toContain('dim');
    expect(html).toContain('normal');
  });
});
