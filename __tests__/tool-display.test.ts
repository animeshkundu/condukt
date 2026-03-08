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
  isPinnable,
} from '../ui/tool-display/formatter';

import {
  ResponsePartBuilder,
} from '../ui/tool-display/response-parts';

import type { ResponsePart, ThinkingSectionPart, ToolProgressPart, MarkdownPart, StatusPart } from '../ui/tool-display/response-parts';
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

describe('isPinnable', () => {
  it('marks file/search/edit/shell tools as pinnable', () => {
    expect(isPinnable('Bash')).toBe(true);
    expect(isPinnable('Read')).toBe(true);
    expect(isPinnable('Grep')).toBe(true);
    expect(isPinnable('Glob')).toBe(true);
    expect(isPinnable('Edit')).toBe(true);
    expect(isPinnable('Write')).toBe(true);
    expect(isPinnable('view')).toBe(true);
    expect(isPinnable('create')).toBe(true);
    expect(isPinnable('str_replace')).toBe(true);
  });

  it('marks MCP/subagent/meta tools as not pinnable', () => {
    expect(isPinnable('kusto-mcp-server-executeQuery')).toBe(false);
    expect(isPinnable('Task')).toBe(false);
    expect(isPinnable('Agent')).toBe(false);
    expect(isPinnable('AskUserQuestion')).toBe(false);
    expect(isPinnable('Skill')).toBe(false);
    expect(isPinnable('WebFetch')).toBe(false);
    expect(isPinnable('WebSearch')).toBe(false);
  });
});

describe('createToolInvocation + completeToolInvocation', () => {
  it('creates and completes a bash invocation', () => {
    const registry = createToolFormatterRegistry();
    const inv = createToolInvocation(registry, 'Bash', 'tc-1', { command: 'npm test' });
    expect(inv.category).toBe('shell');
    expect(inv.friendlyName).toBe('Shell');
    expect(inv.verb).toBe('Ran');
    expect(inv.isPinnable).toBe(true);
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
    expect(inv.friendlyName).toBe('Read');
    expect(inv.verb).toBe('Read');
    expect(inv.isPinnable).toBe(true);
    expect(inv.invocationMessage).toContain('src/app.ts');

    completeInvocation(registry, inv, 'file contents here', { file_path: 'src/app.ts' });
    expect(inv.isComplete).toBe(true);
    expect(isSimpleData(inv.toolSpecificData!)).toBe(true);
  });

  it('creates and completes a task/subagent invocation', () => {
    const registry = createToolFormatterRegistry();
    const inv = createToolInvocation(registry, 'Task', 'tc-3', { description: 'Find bugs', subagent_type: 'reviewer', prompt: 'Review code' });
    expect(inv.category).toBe('subagent');
    expect(inv.isPinnable).toBe(false);

    completeInvocation(registry, inv, 'Found 2 issues', { description: 'Find bugs', subagent_type: 'reviewer', prompt: 'Review code' });
    expect(isSubagentData(inv.toolSpecificData!)).toBe(true);
  });

  it('creates an MCP tool invocation with server name', () => {
    const custom = {
      'executeQuery': {
        friendlyName: 'Kusto',
        category: 'mcp' as const,
        formatStart: () => 'Kusto query',
        formatComplete: () => undefined,
      },
    };
    const registry = createToolFormatterRegistry(custom);
    const inv = createToolInvocation(registry, 'kusto-mcp-server-executeQuery', 'tc-4', {});
    expect(inv.category).toBe('mcp');
    expect(inv.friendlyName).toBe('Kusto');
    expect(inv.verb).toBe('Ran');
    expect(inv.isPinnable).toBe(false);
    expect(inv.serverName).toBe('kusto-mcp-server');
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
    expect(isSubagentData({ title: 'test', todoList: [] })).toBe(false);
  });

  it('isTodoData', () => {
    expect(isTodoData({ title: 'test', todoList: [] })).toBe(true);
    expect(isTodoData({ input: 'x', output: 'y' })).toBe(false);
  });
});


// ── ResponsePartBuilder (pin-to-thinking model) ──────────────────────────────

describe('ResponsePartBuilder', () => {
  it('accumulates markdown parts', () => {
    const builder = new ResponsePartBuilder();
    builder.onOutput('Hello ');
    builder.onOutput('world');
    expect(builder.parts).toHaveLength(1);
    expect(builder.parts[0].kind).toBe('markdown');
    expect((builder.parts[0] as MarkdownPart).content).toBe('Hello world');
  });

  it('pins reasoning into thinking section', () => {
    const builder = new ResponsePartBuilder();
    builder.onReasoning('Step 1');
    builder.onReasoning('Step 2');
    expect(builder.parts).toHaveLength(1);
    expect(builder.parts[0].kind).toBe('thinking-section');
    const section = builder.parts[0] as ThinkingSectionPart;
    expect(section.active).toBe(true);
    expect(section.items).toHaveLength(1);
    expect(section.items[0].kind).toBe('thinking-text');
    expect((section.items[0] as { content: string }).content).toBe('Step 1\nStep 2');
  });

  it('pins pinnable tools (Read, Bash) into thinking section', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onReasoning('Let me check the file...');
    builder.onToolStart('Read', 'tc-1', { file_path: 'src/app.ts' });
    builder.onToolStart('Grep', 'tc-2', { pattern: 'import' });
    expect(builder.parts).toHaveLength(1);
    expect(builder.parts[0].kind).toBe('thinking-section');
    const section = builder.parts[0] as ThinkingSectionPart;
    expect(section.items).toHaveLength(3); // thinking-text + 2 pinned-tool
    expect(section.items[0].kind).toBe('thinking-text');
    expect(section.items[1].kind).toBe('pinned-tool');
    expect(section.items[2].kind).toBe('pinned-tool');
  });

  it('renders standalone tools (MCP) as tool-progress lines', () => {
    const custom = {
      'kusto-executeQuery': {
        friendlyName: 'Kusto',
        category: 'mcp' as const,
        formatStart: () => 'Kusto query',
        formatComplete: () => undefined,
      },
    };
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry(custom) });
    builder.onToolStart('kusto-executeQuery', 'tc-1', {});
    expect(builder.parts).toHaveLength(1);
    expect(builder.parts[0].kind).toBe('tool-progress');
    const progress = builder.parts[0] as ToolProgressPart;
    expect(progress.tool.friendlyName).toBe('Kusto');
  });

  it('finalizes thinking section when output arrives', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onReasoning('Thinking...');
    builder.onToolStart('Read', 'tc-1', { file_path: 'a.ts' });
    builder.onToolComplete('tc-1', 'contents');
    builder.onOutput('Here is my analysis');
    expect(builder.parts).toHaveLength(2);
    expect(builder.parts[0].kind).toBe('thinking-section');
    const section = builder.parts[0] as ThinkingSectionPart;
    expect(section.active).toBe(false);
    expect(section.collapsed).toBe(true);
    expect(builder.parts[1].kind).toBe('markdown');
  });

  it('creates new thinking section after finalization', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onReasoning('First thought');
    builder.onOutput('Response 1');
    builder.onReasoning('Second thought');
    expect(builder.parts).toHaveLength(3);
    expect(builder.parts[0].kind).toBe('thinking-section');
    expect(builder.parts[1].kind).toBe('markdown');
    expect(builder.parts[2].kind).toBe('thinking-section');
  });

  it('handles metadata tools as status lines', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onToolStart('report_intent', 'tc-1', { intent: 'Analyzing code' });
    expect(builder.parts).toHaveLength(1);
    expect(builder.parts[0].kind).toBe('status');
    expect((builder.parts[0] as StatusPart).text).toBe('Analyzing code');
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
    const section = builder.parts[0] as ThinkingSectionPart;
    const pinnedTool = section.items[0] as { kind: string; tool: ToolInvocation };
    expect(pinnedTool.tool.output).toEqual(['line 1', 'line 2']);
  });

  it('reset clears all state', () => {
    const builder = new ResponsePartBuilder();
    builder.onOutput('text');
    builder.onReasoning('think');
    builder.reset();
    expect(builder.parts).toHaveLength(0);
    expect(builder.pendingToolCount).toBe(0);
  });

  it('generates summary title when thinking section finalizes', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onToolStart('Read', 'tc-1', { file_path: 'src/app.ts' });
    builder.onToolComplete('tc-1', 'contents');
    builder.onOutput('Done');
    const section = builder.parts[0] as ThinkingSectionPart;
    expect(section.title).toContain('src/app.ts');
    expect(section.verb).toBe('Read');
  });

  it('mixes standalone and pinned tools correctly', () => {
    const custom = {
      'kusto-executeQuery': {
        friendlyName: 'Kusto',
        category: 'mcp' as const,
        formatStart: () => 'Kusto query',
        formatComplete: () => undefined,
      },
    };
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry(custom) });

    // Reasoning → creates thinking section
    builder.onReasoning('Let me investigate');
    // Pinnable tool → pins to thinking section
    builder.onToolStart('Read', 'tc-1', { file_path: 'a.ts' });
    builder.onToolComplete('tc-1', 'contents');

    // Standalone MCP tool → finalizes thinking, emits progress line
    builder.onToolStart('kusto-executeQuery', 'tc-2', {});
    builder.onToolComplete('tc-2', 'results');

    // More output
    builder.onOutput('Analysis complete');

    expect(builder.parts).toHaveLength(3);
    expect(builder.parts[0].kind).toBe('thinking-section');
    expect(builder.parts[1].kind).toBe('tool-progress');
    expect(builder.parts[2].kind).toBe('markdown');
  });

  it('pins markdown inside thinking section when tools are still running', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onToolStart('Bash', 'tc-1', { command: 'npm test' });
    builder.onOutput('Processing...');
    // Tool still pending → markdown should be pinned inside thinking
    expect(builder.parts).toHaveLength(1);
    expect(builder.parts[0].kind).toBe('thinking-section');
    const section = builder.parts[0] as ThinkingSectionPart;
    expect(section.items).toHaveLength(2); // pinned-tool + pinned-markdown
    expect(section.items[1].kind).toBe('pinned-markdown');
  });

  it('thinking-only section gets first-line title', () => {
    const builder = new ResponsePartBuilder();
    builder.onReasoning('I need to analyze the error logs for patterns');
    builder.onOutput('Found the issue');
    const section = builder.parts[0] as ThinkingSectionPart;
    expect(section.title).toBe('I need to analyze the error logs for patterns');
    expect(section.verb).toBe('Thought about');
  });

  // ── I1: standalone tool complete does not finalize thinking-only section ──

  it('standalone tool complete does not finalize thinking-only section (I1)', () => {
    const custom = {
      'kusto-query': {
        friendlyName: 'Kusto',
        category: 'mcp' as const,
        formatStart: () => 'Kusto query',
        formatComplete: () => undefined,
      },
    };
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry(custom) });

    // Read → complete → standalone MCP → reasoning → MCP complete
    builder.onToolStart('Read', 'tc-1', { file_path: 'a.ts' });
    builder.onToolComplete('tc-1', 'contents');
    // Section finalizes because all pinned tools done

    builder.onToolStart('kusto-query', 'tc-2', {}); // standalone
    builder.onReasoning('Let me think about this...');
    // Now we have thinking section 2 (active, thinking-only)

    builder.onToolComplete('tc-2', 'results');
    // tc-2 is NOT pinnable → should NOT finalize section 2

    const thinkingSections = builder.parts.filter(p => p.kind === 'thinking-section');
    expect(thinkingSections).toHaveLength(2);
    // Section 2 should still be active (not prematurely finalized)
    const section2 = thinkingSections[1] as ThinkingSectionPart;
    expect(section2.active).toBe(true);
  });

  // ── I3: standalone tool start doesn't finalize when pinned tools pending ──

  it('standalone tool start does not finalize section with pending pinned tools (I3)', () => {
    const custom = {
      'kusto-query': {
        friendlyName: 'Kusto',
        category: 'mcp' as const,
        formatStart: () => 'Kusto query',
        formatComplete: () => undefined,
      },
    };
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry(custom) });

    builder.onToolStart('Read', 'tc-1', { file_path: 'a.ts' }); // pinned, pending
    builder.onToolStart('kusto-query', 'tc-2', {}); // standalone — should NOT finalize

    // Read is still pending → thinking section should still be active
    const section = builder.parts[0] as ThinkingSectionPart;
    expect(section.active).toBe(true);
    expect(section.collapsed).toBe(false);

    // Standalone tool rendered after the thinking section
    expect(builder.parts[1].kind).toBe('tool-progress');
  });

  // ── I2: flush() finalizes open thinking section ──

  it('flush() finalizes open thinking section (I2)', () => {
    const builder = new ResponsePartBuilder({ formatters: createToolFormatterRegistry() });
    builder.onReasoning('Analyzing...');
    builder.onToolStart('Read', 'tc-1', { file_path: 'a.ts' });
    builder.onToolComplete('tc-1', 'contents');

    // Section has all pinned tools complete but no output arrived yet
    // to trigger finalization — flush() should do it
    const sectionBefore = builder.parts[0] as ThinkingSectionPart;
    // Actually, all pinned tools completing triggers finalization already.
    // Test the case where only reasoning exists:
    builder.reset();
    builder.onReasoning('Still thinking...');

    expect((builder.parts[0] as ThinkingSectionPart).active).toBe(true);
    builder.flush();
    expect((builder.parts[0] as ThinkingSectionPart).active).toBe(false);
    expect((builder.parts[0] as ThinkingSectionPart).collapsed).toBe(true);
  });

  it('flush() is a no-op when no active thinking section', () => {
    const builder = new ResponsePartBuilder();
    builder.onOutput('Hello');
    builder.flush();
    expect(builder.parts).toHaveLength(1);
    expect(builder.parts[0].kind).toBe('markdown');
  });
});
