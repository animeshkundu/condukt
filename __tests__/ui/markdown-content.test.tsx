/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { MarkdownContent } from '../../ui/components/MarkdownContent';

describe('MarkdownContent', () => {
  // -- Headings --
  it('renders ## headings as h3 elements', () => {
    const content = '## Introduction\nHello world\n\n## Details\nMore content';
    const { container } = render(<MarkdownContent content={content} />);
    const headings = container.querySelectorAll('h3');
    expect(headings).toHaveLength(2);
    expect(headings[0].textContent).toBe('Introduction');
    expect(headings[1].textContent).toBe('Details');
  });

  // -- Code blocks --
  it('renders fenced code blocks with code element', () => {
    const content = '## Code\n```typescript\nconst x = 1;\n```';
    const { container } = render(<MarkdownContent content={content} />);
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toContain('const x = 1;');
  });

  // -- Blockquotes --
  it('renders blockquotes', () => {
    const content = '## Quote\n> Important note\n> Second line';
    const { container } = render(<MarkdownContent content={content} />);
    const bq = container.querySelector('blockquote');
    expect(bq).not.toBeNull();
    expect(bq!.textContent).toContain('Important note');
  });

  // -- XSS prevention --
  it('strips script tags (XSS prevention)', () => {
    const content = '## Malicious\n<script>alert(1)</script>';
    const { container } = render(<MarkdownContent content={content} />);
    expect(container.querySelector('script')).toBeNull();
  });

  it('strips img onerror (XSS prevention)', () => {
    const content = '## Images\n<img onerror="alert(1)" src="x">';
    const { container } = render(<MarkdownContent content={content} />);
    // react-markdown strips raw HTML by default
    expect(container.querySelector('img')).toBeNull();
  });

  // -- Props --
  it('accepts custom className', () => {
    const { container } = render(<MarkdownContent content="## Test\nHello" className="custom-class" />);
    expect(container.firstElementChild?.className).toContain('custom-class');
  });

  it('renders empty content gracefully', () => {
    const { container } = render(<MarkdownContent content="" />);
    expect(container.firstElementChild).not.toBeNull();
  });

  // -- Inline formatting (new) --
  it('renders inline bold as <strong>', () => {
    const content = 'This is **bold text** here';
    const { container } = render(<MarkdownContent content={content} />);
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe('bold text');
  });

  it('renders inline italic as <em>', () => {
    const content = 'This is *italic text* here';
    const { container } = render(<MarkdownContent content={content} />);
    const em = container.querySelector('em');
    expect(em).not.toBeNull();
    expect(em!.textContent).toBe('italic text');
  });

  it('renders inline code with styling', () => {
    const content = 'Use the `getArtifact()` method';
    const { container } = render(<MarkdownContent content={content} />);
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe('getArtifact()');
  });

  it('renders links as <a> with target="_blank"', () => {
    const content = 'See [the docs](https://example.com) for details';
    const { container } = render(<MarkdownContent content={content} />);
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe('the docs');
    expect(link!.getAttribute('href')).toBe('https://example.com');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toContain('noopener');
  });

  // -- GFM tables --
  it('renders tables as <table> with proper structure', () => {
    const content = '| Name | Value |\n|------|-------|\n| foo | 42 |\n| bar | 99 |';
    const { container } = render(<MarkdownContent content={content} />);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    const headers = container.querySelectorAll('th');
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toBe('Name');
    const cells = container.querySelectorAll('td');
    expect(cells).toHaveLength(4);
    expect(cells[0].textContent).toBe('foo');
    expect(cells[1].textContent).toBe('42');
  });

  // -- Lists --
  it('renders unordered lists', () => {
    const content = '- item one\n- item two\n- item three';
    const { container } = render(<MarkdownContent content={content} />);
    const ul = container.querySelector('ul');
    expect(ul).not.toBeNull();
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(3);
  });

  it('renders ordered lists', () => {
    const content = '1. first\n2. second\n3. third';
    const { container } = render(<MarkdownContent content={content} />);
    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(3);
  });

  // -- Horizontal rule --
  it('renders horizontal rules', () => {
    const content = 'Above\n\n---\n\nBelow';
    const { container } = render(<MarkdownContent content={content} />);
    const hr = container.querySelector('hr');
    expect(hr).not.toBeNull();
  });
});
