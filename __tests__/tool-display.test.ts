import { describe, it, expect } from 'vitest';

import {
  extractToolResultContent,
  stripReminders,
  extractCdPrefix,
  parseExitCode,
  stripExitCodeTrailer,
  parseTodoMarkdown,
} from '../ui/tool-display/format-utils';

import {
  buildEventTree,
  groupEventsBySession,
  filterEvents,
  computeSessionSummary,
  formatDuration,
  getEventStatusClass,
  formatEventDetail,
} from '../ui/tool-display/view-logic';

import type { IAgentDebugEvent, IToolCallEvent, ILLMRequestEvent, IErrorEvent } from '../ui/tool-display/debug-types';

import {
  createToolFormatterRegistry,
  resolveFormatter,
  classifyTool,
  createToolInvocation,
  completeToolInvocation as completeInvocation,
} from '../ui/tool-display/formatter';

import {
  ResponsePartBuilder,
} from '../ui/tool-display/response-parts';

import type { ToolInvocation } from '../ui/tool-display/types';
import { isTerminalData, isSimpleData, isSubagentData, isTodoData } from '../ui/tool-display/types';


// ── format-utils ─────────────────────────────────────────────────────────────

describe('extractToolResultContent', () => {
  it('returns empty string for undefined', () => {
    expect(extractToolResultContent(undefined)).toBe('');
  });

  it('returns string as-is', () => {
    expect(extractToolResultContent('hello')).toBe('hello');
  });

  it('extracts text from content blocks', () => {
    const blocks = [
      { type: 'text', text: 'line 1' },
      { type: 'image' },
      { type: 'text', text: 'line 2' },
    ];
    expect(extractToolResultContent(blocks)).toBe('line 1\nline 2');
  });
});

describe('stripReminders', () => {
  it('strips <reminder> blocks', () => {
    expect(stripReminders('before <reminder>stuff</reminder> after')).toBe('before after');
  });

  it('strips <system-reminder> blocks', () => {
    expect(stripReminders('text <system-reminder>internal</system-reminder> more')).toBe('text more');
  });

  it('strips <context> blocks', () => {
    expect(stripReminders('text <context>ctx</context> more')).toBe('text more');
  });

  it('strips <current_datetime> blocks', () => {
    expect(stripReminders('text <current_datetime>2024</current_datetime> more')).toBe('text more');
  });

  it('strips self-closing tags', () => {
    expect(stripReminders('text <pr_metadata uri="x"/> more')).toBe('text more');
  });
});

describe('extractCdPrefix', () => {
  it('extracts bash cd prefix', () => {
    const result = extractCdPrefix('cd /home/user && npm test');
    expect(result).toEqual({ directory: '/home/user', command: 'npm test' });
  });

  it('extracts quoted directory', () => {
    const result = extractCdPrefix('cd "/path with spaces" && ls');
    expect(result).toEqual({ directory: '/path with spaces', command: 'ls' });
  });

  it('returns undefined for no cd prefix', () => {
    expect(extractCdPrefix('npm test')).toBeUndefined();
  });

  it('handles powershell Set-Location', () => {
    const result = extractCdPrefix('Set-Location -Path C:\\Users; dir', true);
    expect(result).toEqual({ directory: 'C:\\Users', command: 'dir' });
  });
});

describe('parseExitCode', () => {
  it('parses "exit code: 0"', () => {
    expect(parseExitCode('output\nexit code: 0')).toBe(0);
  });

  it('parses "exited with exit code 127"', () => {
    expect(parseExitCode('some output\nexited with exit code 127')).toBe(127);
  });

  it('returns undefined for no exit code', () => {
    expect(parseExitCode('normal output')).toBeUndefined();
  });
});

describe('stripExitCodeTrailer', () => {
  it('removes <exited with exit code N> trailer', () => {
    expect(stripExitCodeTrailer('output\n<exited with exit code 0>')).toBe('output');
  });

  it('preserves output without trailer', () => {
    expect(stripExitCodeTrailer('clean output')).toBe('clean output');
  });
});

describe('parseTodoMarkdown', () => {
  it('parses a simple checklist', () => {
    const md = `# Tasks\n- [x] Done item\n- [ ] Todo item\n- [>] In progress`;
    const result = parseTodoMarkdown(md);
    expect(result.title).toBe('Tasks');
    expect(result.todoList).toHaveLength(3);
    expect(result.todoList[0]).toEqual({ id: 1, title: 'Done item', status: 'completed' });
    expect(result.todoList[1]).toEqual({ id: 2, title: 'Todo item', status: 'not-started' });
    expect(result.todoList[2]).toEqual({ id: 3, title: 'In progress', status: 'in-progress' });
  });

  it('ignores items inside code fences', () => {
    const md = "```\n- [x] Not a todo\n```\n- [ ] Real todo";
    const result = parseTodoMarkdown(md);
    expect(result.todoList).toHaveLength(1);
    expect(result.todoList[0].title).toBe('Real todo');
  });

  it('handles ordered lists', () => {
    const md = '1. [x] First\n2. [ ] Second';
    const result = parseTodoMarkdown(md);
    expect(result.todoList).toHaveLength(2);
  });

  it('handles continuation lines', () => {
    const md = '- [ ] First line\n  continuation';
    const result = parseTodoMarkdown(md);
    expect(result.todoList[0].title).toBe('First line continuation');
  });
});


// ── view-logic ───────────────────────────────────────────────────────────────

describe('buildEventTree', () => {
  it('creates flat list for events without parents', () => {
    const events: IAgentDebugEvent[] = [
      { id: '1', timestamp: 100, category: 'toolCall', sessionId: 's1', summary: 'a', details: {} },
      { id: '2', timestamp: 200, category: 'toolCall', sessionId: 's1', summary: 'b', details: {} },
    ];
    const tree = buildEventTree(events);
    expect(tree).toHaveLength(2);
    expect(tree[0].children).toHaveLength(0);
  });

  it('nests child events under parent', () => {
    const events: IAgentDebugEvent[] = [
      { id: 'p', timestamp: 100, category: 'toolCall', sessionId: 's1', summary: 'parent', details: {} },
      { id: 'c', timestamp: 200, category: 'toolCall', sessionId: 's1', summary: 'child', details: {}, parentEventId: 'p' },
    ];
    const tree = buildEventTree(events);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].event.id).toBe('c');
  });
});

describe('groupEventsBySession', () => {
  it('groups events by sessionId', () => {
    const events: IAgentDebugEvent[] = [
      { id: '1', timestamp: 100, category: 'toolCall', sessionId: 's1', summary: '', details: {} },
      { id: '2', timestamp: 200, category: 'toolCall', sessionId: 's2', summary: '', details: {} },
      { id: '3', timestamp: 300, category: 'toolCall', sessionId: 's1', summary: '', details: {} },
    ];
    const groups = groupEventsBySession(events);
    expect(groups.get('s1')).toHaveLength(2);
    expect(groups.get('s2')).toHaveLength(1);
  });
});

describe('filterEvents', () => {
  it('filters by category', () => {
    const events: IAgentDebugEvent[] = [
      { id: '1', timestamp: 100, category: 'toolCall', sessionId: 's1', summary: '', details: {} },
      { id: '2', timestamp: 200, category: 'error', sessionId: 's1', summary: '', details: {} },
    ];
    const filtered = filterEvents(events, { categories: ['toolCall'] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].category).toBe('toolCall');
  });
});

describe('computeSessionSummary', () => {
  it('aggregates tool count, tokens, and errors', () => {
    const events: IAgentDebugEvent[] = [
      { id: '1', timestamp: 100, category: 'toolCall', sessionId: 's1', summary: '', details: {} } as IToolCallEvent,
      { id: '2', timestamp: 200, category: 'llmRequest', sessionId: 's1', summary: '', details: {}, requestName: 'r', durationMs: 100, promptTokens: 50, completionTokens: 30, cachedTokens: 10, totalTokens: 80, status: 'success' } as ILLMRequestEvent,
      { id: '3', timestamp: 300, category: 'error', sessionId: 's1', summary: '', details: {}, errorType: 'timeout' } as IErrorEvent,
    ];
    const summary = computeSessionSummary(events);
    expect(summary.toolCount).toBe(1);
    expect(summary.totalTokens).toBe(80);
    expect(summary.errorCount).toBe(1);
    expect(summary.durationMs).toBe(200);
    expect(summary.cachedTokenRatio).toBeCloseTo(0.125);
  });
});

describe('formatDuration', () => {
  it('formats ms', () => { expect(formatDuration(500)).toBe('500ms'); });
  it('formats seconds', () => { expect(formatDuration(2500)).toBe('2.5s'); });
  it('formats minutes', () => { expect(formatDuration(90_000)).toBe('1:30'); });
});

describe('getEventStatusClass', () => {
  it('returns error for error events', () => {
    const event = { id: '1', timestamp: 0, category: 'error' as const, sessionId: 's', summary: '', details: {}, errorType: 'timeout' } as IErrorEvent;
    expect(getEventStatusClass(event)).toBe('status-error');
  });

  it('returns success for completed tool calls', () => {
    const event = { id: '1', timestamp: 0, category: 'toolCall' as const, sessionId: 's', summary: '', details: {}, toolName: 'bash', argsSummary: '', status: 'success' } as IToolCallEvent;
    expect(getEventStatusClass(event)).toBe('status-success');
  });
});


// ── formatter ────────────────────────────────────────────────────────────────

describe('createToolFormatterRegistry', () => {
  it('includes builtin formatters', () => {
    const registry = createToolFormatterRegistry();
    expect(registry['Bash']).toBeDefined();
    expect(registry['Read']).toBeDefined();
    expect(registry['Grep']).toBeDefined();
  });

  it('merges custom formatters', () => {
    const custom = {
      'kusto-query': {
        friendlyName: 'Kusto',
        category: 'mcp' as const,
        formatStart: () => 'Kusto query',
        formatComplete: () => undefined,
      },
    };
    const registry = createToolFormatterRegistry(custom);
    expect(registry['kusto-query']).toBeDefined();
    expect(registry['Bash']).toBeDefined();
  });
});

describe('resolveFormatter', () => {
  it('falls back to default for unknown tools', () => {
    const registry = createToolFormatterRegistry();
    const fmt = resolveFormatter(registry, 'unknown-tool-xyz');
    expect(fmt.friendlyName).toBe('Tool');
  });
});

describe('classifyTool', () => {
  it('classifies known tools', () => {
    const registry = createToolFormatterRegistry();
    expect(classifyTool(registry, 'Bash')).toBe('shell');
    expect(classifyTool(registry, 'Read')).toBe('file');
    expect(classifyTool(registry, 'Grep')).toBe('search');
    expect(classifyTool(registry, 'Task')).toBe('subagent');
  });

  it('classifies unknown tools by args', () => {
    const registry = createToolFormatterRegistry();
    expect(classifyTool(registry, 'custom', { command: 'ls' })).toBe('shell');
    expect(classifyTool(registry, 'custom', { file_path: '/a' })).toBe('file');
    expect(classifyTool(registry, 'custom', { pattern: '*.ts' })).toBe('search');
  });
});

describe('createToolInvocation + completeToolInvocation', () => {
  it('creates and completes a bash invocation', () => {
    const registry = createToolFormatterRegistry();
    const inv = createToolInvocation(registry, 'Bash', 'tc-1', { command: 'npm test' });
    expect(inv.category).toBe('shell');
    expect(inv.invocationMessage).toBe('npm test');
    expect(inv.isComplete).toBe(false);

    completeInvocation(registry, inv, 'all tests passed\nexit code: 0', { command: 'npm test' });
    expect(inv.isComplete).toBe(true);
    expect(inv.toolSpecificData).toBeDefined();
    expect(isTerminalData(inv.toolSpecificData!)).toBe(true);
  });

  it('creates and completes a read invocation', () => {
    const registry = createToolFormatterRegistry();
    const inv = createToolInvocation(registry, 'Read', 'tc-2', { file_path: 'src/app.ts' });
    expect(inv.category).toBe('file');
    expect(inv.invocationMessage).toContain('src/app.ts');

    completeInvocation(registry, inv, 'file contents here', { file_path: 'src/app.ts' });
    expect(inv.isComplete).toBe(true);
    expect(isSimpleData(inv.toolSpecificData!)).toBe(true);
  });

  it('creates and completes a task/subagent invocation', () => {
    const registry = createToolFormatterRegistry();
    const inv = createToolInvocation(registry, 'Task', 'tc-3', { description: 'Find bugs', subagent_type: 'reviewer', prompt: 'Review code' });
    expect(inv.category).toBe('subagent');

    completeInvocation(registry, inv, 'Found 2 issues', { description: 'Find bugs', subagent_type: 'reviewer', prompt: 'Review code' });
    expect(isSubagentData(inv.toolSpecificData!)).toBe(true);
  });
});


// ── type guards ──────────────────────────────────────────────────────────────

describe('type guards', () => {
  it('isTerminalData', () => {
    expect(isTerminalData({ commandLine: { original: 'ls' }, language: 'bash' })).toBe(true);
    expect(isTerminalData({ input: 'x', output: 'y' })).toBe(false);
  });

  it('isSimpleData', () => {
    expect(isSimpleData({ input: 'x', output: 'y' })).toBe(true);
    expect(isSimpleData({ commandLine: { original: 'ls' }, language: 'bash' })).toBe(false);
  });

  it('isSubagentData', () => {
    expect(isSubagentData({ agentName: 'test', prompt: 'do stuff' })).toBe(true);
    expect(isSubagentData({ todoList: [] })).toBe(false);
  });

  it('isTodoData', () => {
    expect(isTodoData({ title: 'test', todoList: [] })).toBe(true);
    expect(isTodoData({ input: 'x', output: 'y' })).toBe(false);
  });
});


// ── ResponsePartBuilder ──────────────────────────────────────────────────────

describe('ResponsePartBuilder', () => {
  it('accumulates markdown parts', () => {
    const builder = new ResponsePartBuilder();
    builder.onOutput('Hello ');
    builder.onOutput('world');
    expect(builder.parts).toHaveLength(1);
    expect(builder.parts[0].kind).toBe('markdown');
    expect((builder.parts[0] as { content: string }).content).toBe('Hello world');
  });

  it('creates new markdown part after tool group', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onOutput('Before');
    builder.onToolStart('Bash', 'tc-1', { command: 'ls' });
    builder.onToolComplete('tc-1', 'file.txt');
    builder.onOutput('After');
    expect(builder.parts).toHaveLength(3);
    expect(builder.parts[0].kind).toBe('markdown');
    expect(builder.parts[1].kind).toBe('tool-group');
    expect(builder.parts[2].kind).toBe('markdown');
  });

  it('groups consecutive tools', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onToolStart('Read', 'tc-1', { file_path: 'a.ts' });
    builder.onToolStart('Read', 'tc-2', { file_path: 'b.ts' });
    builder.onToolComplete('tc-1', 'content a');
    builder.onToolComplete('tc-2', 'content b');
    expect(builder.parts).toHaveLength(1);
    expect(builder.parts[0].kind).toBe('tool-group');
    const group = builder.parts[0] as { tools: ToolInvocation[] };
    expect(group.tools).toHaveLength(2);
  });

  it('tracks group status', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onToolStart('Bash', 'tc-1', { command: 'echo hi' });

    const group = builder.parts[0] as { status: string; tools: ToolInvocation[] };
    expect(group.status).toBe('running');

    builder.onToolComplete('tc-1', 'hi');
    expect(group.status).toBe('complete');
  });

  it('marks group error when tool errors', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onToolStart('Bash', 'tc-1', { command: 'false' });
    builder.onToolComplete('tc-1', 'error', true);
    const group = builder.parts[0] as { status: string };
    expect(group.status).toBe('error');
  });

  it('accumulates reasoning', () => {
    const builder = new ResponsePartBuilder();
    builder.onReasoning('Step 1');
    builder.onReasoning('Step 2');
    expect(builder.parts).toHaveLength(1);
    expect(builder.parts[0].kind).toBe('thinking');
    expect((builder.parts[0] as { content: string }).content).toBe('Step 1\nStep 2');
  });

  it('closes reasoning on output', () => {
    const builder = new ResponsePartBuilder();
    builder.onReasoning('Thinking...');
    builder.onOutput('Result');
    builder.onReasoning('More thinking');
    expect(builder.parts).toHaveLength(3);
    expect(builder.parts[0].kind).toBe('thinking');
    expect(builder.parts[1].kind).toBe('markdown');
    expect(builder.parts[2].kind).toBe('thinking');
  });

  it('handles metadata tools as status lines', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onToolStart('report_intent', 'tc-1', { intent: 'Analyzing code' });
    expect(builder.parts).toHaveLength(1);
    expect(builder.parts[0].kind).toBe('status');
    expect((builder.parts[0] as { text: string }).text).toBe('Analyzing code');
  });

  it('tracks pending tool count', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    expect(builder.pendingToolCount).toBe(0);
    builder.onToolStart('Bash', 'tc-1', { command: 'ls' });
    expect(builder.pendingToolCount).toBe(1);
    builder.onToolStart('Read', 'tc-2', { file_path: 'a.ts' });
    expect(builder.pendingToolCount).toBe(2);
    builder.onToolComplete('tc-1', 'done');
    expect(builder.pendingToolCount).toBe(1);
  });

  it('appends streaming output to pending tools', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onToolStart('Bash', 'tc-1', { command: 'long-cmd' });
    builder.onToolOutput('tc-1', 'line 1');
    builder.onToolOutput('tc-1', 'line 2');
    const group = builder.parts[0] as { tools: ToolInvocation[] };
    expect(group.tools[0].output).toEqual(['line 1', 'line 2']);
  });

  it('reset clears all state', () => {
    const builder = new ResponsePartBuilder();
    builder.onOutput('text');
    builder.onReasoning('think');
    builder.reset();
    expect(builder.parts).toHaveLength(0);
    expect(builder.pendingToolCount).toBe(0);
  });
});
