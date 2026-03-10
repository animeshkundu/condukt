import { describe, it, expect } from 'vitest';

import { classifyLine } from '../../ui/tool-display/DiffBlock';

describe('classifyLine', () => {
  it('classifies "--- a/file" and "+++ b/file" as header', () => {
    expect(classifyLine('--- a/src/old.ts')).toBe('header');
    expect(classifyLine('+++ b/src/new.ts')).toBe('header');
  });

  it('classifies "@@ -10,5 +10,7 @@" as header', () => {
    expect(classifyLine('@@ -10,5 +10,7 @@')).toBe('header');
  });

  it('classifies "+const x = 1;" as add', () => {
    expect(classifyLine('+const x = 1;')).toBe('add');
  });

  it('classifies "-const x = 1;" as remove', () => {
    expect(classifyLine('-const x = 1;')).toBe('remove');
  });

  it('classifies " context line" and "plain text" as context', () => {
    expect(classifyLine(' context line')).toBe('context');
    expect(classifyLine('plain text')).toBe('context');
  });
});
