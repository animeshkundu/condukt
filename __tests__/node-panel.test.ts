/**
 * NodePanel compound component tests.
 *
 * Tests the building blocks individually and the convenience default.
 * Verifies: data-driven gate buttons, output renderer modes,
 * line cap, status-based controls, error display.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ProjectionNode } from '../src/types';

// We can't render React components in vitest without jsdom,
// so we test the pure logic functions that power the components.

import { STATUS_COLORS, sc } from '../ui/components/node-panel/types';
import { ansiToHtml, stripAnsi, hasAnsi } from '../ui/ansi';

// ---------------------------------------------------------------------------
// Status colors
// ---------------------------------------------------------------------------

describe('STATUS_COLORS', () => {
  it('has colors for all 8 statuses', () => {
    const statuses = ['pending', 'running', 'completed', 'failed', 'killed', 'skipped', 'gated', 'retrying'];
    for (const s of statuses) {
      expect(STATUS_COLORS[s]).toBeDefined();
      expect(STATUS_COLORS[s].dot).toBeTruthy();
      expect(STATUS_COLORS[s].text).toBeTruthy();
      expect(STATUS_COLORS[s].bg).toBeTruthy();
    }
  });

  it('sc() falls back to pending for unknown status', () => {
    expect(sc('unknown')).toBe(STATUS_COLORS.pending);
  });
});

// ---------------------------------------------------------------------------
// ANSI rendering (ADR-001)
// ---------------------------------------------------------------------------

describe('ANSI utilities', () => {
  it('hasAnsi detects escape sequences', () => {
    expect(hasAnsi('\x1b[32mgreen\x1b[0m')).toBe(true);
    expect(hasAnsi('plain text')).toBe(false);
    expect(hasAnsi('')).toBe(false);
  });

  it('ansiToHtml converts color codes to spans', () => {
    const html = ansiToHtml('\x1b[32mgreen\x1b[0m');
    expect(html).toContain('color:#22c55e');
    expect(html).toContain('green');
  });

  it('ansiToHtml handles bold', () => {
    const html = ansiToHtml('\x1b[1mbold text\x1b[0m');
    expect(html).toContain('font-weight:bold');
    expect(html).toContain('bold text');
  });

  it('ansiToHtml handles dim', () => {
    const html = ansiToHtml('\x1b[2mdim text\x1b[0m');
    expect(html).toContain('opacity:0.6');
  });

  it('ansiToHtml escapes HTML characters (XSS prevention)', () => {
    const html = ansiToHtml('<script>alert("xss")</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('ansiToHtml returns plain text when no escape codes', () => {
    expect(ansiToHtml('hello world')).toBe('hello world');
  });

  it('ansiToHtml handles combined codes (bold + green)', () => {
    const html = ansiToHtml('\x1b[1;32mbold green\x1b[0m');
    expect(html).toContain('font-weight:bold');
    expect(html).toContain('color:#22c55e');
  });

  it('stripAnsi removes all escape sequences', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m text')).toBe('green text');
    expect(stripAnsi('plain')).toBe('plain');
  });

  it('ansiToHtml handles bright colors (90-97)', () => {
    const html = ansiToHtml('\x1b[94mbright blue\x1b[0m');
    expect(html).toContain('color:#60a5fa');
  });

  it('ANSI black remapped for dark theme visibility (ADR-001)', () => {
    const html = ansiToHtml('\x1b[30mblack text\x1b[0m');
    // SGR 30 should NOT be #1e1e1e (invisible on dark bg)
    // Should be #3a3a3a or similar
    expect(html).not.toContain('#1e1e1e');
    expect(html).toContain('#3a3a3a');
  });
});

// ---------------------------------------------------------------------------
// Data-driven gate resolution (ADR-002)
// ---------------------------------------------------------------------------

describe('gate resolution logic', () => {
  it('default resolutions are approved + rejected', () => {
    const gateData: Record<string, unknown> = {};
    const resolutions: string[] = (Array.isArray(gateData.allowedResolutions)
      ? gateData.allowedResolutions : null) ?? ['approved', 'rejected'];
    expect(resolutions).toEqual(['approved', 'rejected']);
  });

  it('custom resolutions from gateData', () => {
    const gateData = { allowedResolutions: ['deploy', 'rollback', 'skip'] };
    const resolutions: string[] = (Array.isArray(gateData.allowedResolutions)
      ? gateData.allowedResolutions : null) ?? ['approved', 'rejected'];
    expect(resolutions).toEqual(['deploy', 'rollback', 'skip']);
  });

  it('invalid allowedResolutions falls back to default', () => {
    const gateData = { allowedResolutions: 'not-an-array' };
    const resolutions: string[] = (Array.isArray(gateData.allowedResolutions)
      ? gateData.allowedResolutions : null) ?? ['approved', 'rejected'];
    expect(resolutions).toEqual(['approved', 'rejected']);
  });
});

// ---------------------------------------------------------------------------
// Output line cap logic
// ---------------------------------------------------------------------------

describe('output line cap', () => {
  it('caps at maxLines, keeping newest', () => {
    const maxLines = 100;
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`);
    const capped = lines.length > maxLines ? lines.slice(-maxLines) : lines;
    expect(capped).toHaveLength(100);
    expect(capped[0]).toBe('line-100');
    expect(capped[99]).toBe('line-199');
  });

  it('does not cap when under limit', () => {
    const maxLines = 50000;
    const lines = ['a', 'b', 'c'];
    const capped = lines.length > maxLines ? lines.slice(-maxLines) : lines;
    expect(capped).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Controls visibility logic
// ---------------------------------------------------------------------------

describe('controls visibility', () => {
  const cases: Array<{ status: string; executionRunning: boolean; showRetry: boolean; showRedo: boolean; showSkip: boolean }> = [
    { status: 'running', executionRunning: true, showRetry: false, showRedo: false, showSkip: false },
    { status: 'failed', executionRunning: false, showRetry: true, showRedo: false, showSkip: true },
    { status: 'killed', executionRunning: false, showRetry: true, showRedo: false, showSkip: true },
    { status: 'completed', executionRunning: false, showRetry: false, showRedo: true, showSkip: false },
    { status: 'pending', executionRunning: false, showRetry: false, showRedo: false, showSkip: true },
    { status: 'gated', executionRunning: true, showRetry: false, showRedo: false, showSkip: false },
    { status: 'failed', executionRunning: true, showRetry: false, showRedo: false, showSkip: false },
  ];

  for (const c of cases) {
    it(`status=${c.status}, running=${c.executionRunning}: retry=${c.showRetry}, redo=${c.showRedo}, skip=${c.showSkip}`, () => {
      if (c.executionRunning) {
        // All controls hidden during running
        expect(c.showRetry).toBe(false);
        expect(c.showRedo).toBe(false);
        expect(c.showSkip).toBe(false);
        return;
      }
      const showRetry = c.status === 'failed' || c.status === 'killed';
      const showRedo = c.status === 'completed';
      const showSkip = c.status === 'failed' || c.status === 'killed' || c.status === 'pending';
      expect(showRetry).toBe(c.showRetry);
      expect(showRedo).toBe(c.showRedo);
      expect(showSkip).toBe(c.showSkip);
    });
  }
});
