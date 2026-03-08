/**
 * Extensible tool formatting registry.
 *
 * Provides default formatters for common tool types (shell, file, search,
 * subagent, task, etc.) and allows consumers to register custom formatters
 * for domain-specific tools (Kusto, ICM, ADO, …).
 *
 * Adapted from VS Code Copilot Chat toolInvocationFormatter.ts +
 * copilotCLITools.ts (MIT). All VS Code specifics removed.
 */

import type { ToolCategory, ToolInvocation, ToolSpecificData, TerminalToolData, SimpleToolData, SubagentToolData, TodoToolData } from './types';
import { extractCdPrefix, parseExitCode, stripExitCodeTrailer, parseTodoMarkdown } from './format-utils';

// ── Formatter interface ──────────────────────────────────────────────────────

export interface ToolFormatter {
  friendlyName: string;
  category: ToolCategory;
  /** Human-readable message when tool starts. Receives raw tool args. */
  formatStart: (toolName: string, args: Record<string, unknown>) => string;
  /** Build tool-specific data when tool completes. Return undefined to skip. */
  formatComplete: (toolName: string, result: string, args: Record<string, unknown>) => ToolSpecificData | undefined;
}

export type ToolFormatterRegistry = Record<string, ToolFormatter>;

// ── Built-in formatters ──────────────────────────────────────────────────────

const BUILTIN_FORMATTERS: ToolFormatterRegistry = {
  // Shell tools
  Bash: {
    friendlyName: 'Shell',
    category: 'shell',
    formatStart: (_name, args) => {
      const cmd = String(args.command ?? args.description ?? '');
      const prefix = extractCdPrefix(cmd);
      return prefix?.command ?? cmd;
    },
    formatComplete: (_name, result, args): TerminalToolData => {
      const cmd = String(args.command ?? '');
      const prefix = extractCdPrefix(cmd);
      const exitCode = parseExitCode(result);
      const text = exitCode !== undefined ? stripExitCodeTrailer(result) : result;
      return {
        commandLine: { original: prefix?.command ?? cmd },
        language: 'bash',
        presentationOverrides: prefix ? { commandLine: prefix.command } : undefined,
        output: text ? { text: text.replace(/\n/g, '\r\n') } : undefined,
        state: exitCode !== undefined ? { exitCode } : undefined,
      };
    },
  },

  bash: { friendlyName: 'Shell', category: 'shell', formatStart: (...a) => BUILTIN_FORMATTERS.Bash.formatStart(...a), formatComplete: (...a) => BUILTIN_FORMATTERS.Bash.formatComplete(...a) },

  powershell: {
    friendlyName: 'Shell',
    category: 'shell',
    formatStart: (_name, args) => {
      const cmd = String(args.command ?? args.description ?? '');
      const prefix = extractCdPrefix(cmd, true);
      return prefix?.command ?? cmd;
    },
    formatComplete: (_name, result, args): TerminalToolData => {
      const cmd = String(args.command ?? '');
      const prefix = extractCdPrefix(cmd, true);
      const exitCode = parseExitCode(result);
      const text = exitCode !== undefined ? stripExitCodeTrailer(result) : result;
      return {
        commandLine: { original: prefix?.command ?? cmd },
        language: 'powershell',
        presentationOverrides: prefix ? { commandLine: prefix.command } : undefined,
        output: text ? { text: text.replace(/\n/g, '\r\n') } : undefined,
        state: exitCode !== undefined ? { exitCode } : undefined,
      };
    },
  },

  // File tools
  Read: {
    friendlyName: 'Read',
    category: 'file',
    formatStart: (_name, args) => `Read ${args.file_path ?? args.path ?? ''}`,
    formatComplete: (_name, result, args): SimpleToolData => ({
      input: String(args.file_path ?? args.path ?? ''),
      output: result,
    }),
  },

  view: {
    friendlyName: 'Read',
    category: 'file',
    formatStart: (_name, args) => {
      const path = String(args.path ?? '');
      const range = args.view_range as [number, number] | undefined;
      if (range && range[1] >= range[0] && range[0] >= 0) {
        return range[0] === range[1]
          ? `Read ${path}, line ${range[0]}`
          : `Read ${path}, lines ${range[0]}–${range[1]}`;
      }
      return `Read ${path}`;
    },
    formatComplete: (_name, result, args): SimpleToolData => ({
      input: String(args.path ?? ''),
      output: result,
    }),
  },

  show_file: {
    friendlyName: 'Show File',
    category: 'file',
    formatStart: (_name, args) => `Show ${args.path ?? ''}`,
    formatComplete: (_name, result, args): SimpleToolData => ({
      input: String(args.path ?? ''),
      output: result,
    }),
  },

  // Search tools
  Grep: {
    friendlyName: 'Search',
    category: 'search',
    formatStart: (_name, args) => `Searched for regex \`${args.pattern ?? ''}\``,
    formatComplete: (_name, result, args): SimpleToolData => ({
      input: String(args.pattern ?? ''),
      output: result,
    }),
  },

  grep: { friendlyName: 'Search', category: 'search', formatStart: (...a) => BUILTIN_FORMATTERS.Grep.formatStart(...a), formatComplete: (...a) => BUILTIN_FORMATTERS.Grep.formatComplete(...a) },
  rg: { friendlyName: 'Search', category: 'search', formatStart: (...a) => BUILTIN_FORMATTERS.Grep.formatStart(...a), formatComplete: (...a) => BUILTIN_FORMATTERS.Grep.formatComplete(...a) },

  Glob: {
    friendlyName: 'Search',
    category: 'search',
    formatStart: (_name, args) => `Searched for files matching \`${args.pattern ?? ''}\``,
    formatComplete: (_name, result, args): SimpleToolData => ({
      input: String(args.pattern ?? ''),
      output: result,
    }),
  },

  glob: { friendlyName: 'Search', category: 'search', formatStart: (...a) => BUILTIN_FORMATTERS.Glob.formatStart(...a), formatComplete: (...a) => BUILTIN_FORMATTERS.Glob.formatComplete(...a) },

  search: {
    friendlyName: 'Search',
    category: 'search',
    formatStart: (_name, args) => `Search: ${args.query ?? args.pattern ?? ''}`,
    formatComplete: (_name, result, args): SimpleToolData => ({
      input: String(args.query ?? args.pattern ?? ''),
      output: result,
    }),
  },

  semantic_code_search: { friendlyName: 'Search', category: 'search', formatStart: (...a) => BUILTIN_FORMATTERS.search.formatStart(...a), formatComplete: (...a) => BUILTIN_FORMATTERS.search.formatComplete(...a) },

  // Edit tools — typically suppressed in the tool group (they have own UI)
  Edit: { friendlyName: 'Edit', category: 'edit', formatStart: (_n, args) => `Editing ${args.file_path ?? args.path ?? 'file'}`, formatComplete: () => undefined },
  MultiEdit: { friendlyName: 'Edit', category: 'edit', formatStart: (_n, args) => `Editing ${args.file_path ?? args.path ?? 'file'}`, formatComplete: () => undefined },
  Write: { friendlyName: 'Write', category: 'edit', formatStart: (_n, args) => `Writing ${args.file_path ?? args.path ?? 'file'}`, formatComplete: () => undefined },
  NotebookEdit: { friendlyName: 'Edit Notebook', category: 'edit', formatStart: (_n, args) => `Editing ${args.notebook_path ?? 'notebook'}`, formatComplete: () => undefined },

  edit: { friendlyName: 'Edit', category: 'edit', formatStart: (_n, args) => `Editing ${args.path ?? 'file'}`, formatComplete: () => undefined },
  str_replace: { friendlyName: 'Edit', category: 'edit', formatStart: (_n, args) => `Editing ${args.path ?? 'file'}`, formatComplete: () => undefined },
  create: { friendlyName: 'Create', category: 'edit', formatStart: (_n, args) => `Creating ${args.path ?? 'file'}`, formatComplete: () => undefined },
  insert: { friendlyName: 'Edit', category: 'edit', formatStart: (_n, args) => `Inserting in ${args.path ?? 'file'}`, formatComplete: () => undefined },
  undo_edit: { friendlyName: 'Undo Edit', category: 'edit', formatStart: (_n, args) => `Undoing edit in ${args.path ?? 'file'}`, formatComplete: () => undefined },

  // Subagent/task tools
  Task: {
    friendlyName: 'Delegate Task',
    category: 'subagent',
    formatStart: (_name, args) => String(args.description ?? 'Delegated task'),
    formatComplete: (_name, result, args): SubagentToolData => ({
      description: String(args.description ?? ''),
      agentName: String(args.subagent_type ?? args.name ?? ''),
      prompt: String(args.prompt ?? ''),
      result,
    }),
  },

  task: { friendlyName: 'Delegate Task', category: 'subagent', formatStart: (...a) => BUILTIN_FORMATTERS.Task.formatStart(...a), formatComplete: (...a) => BUILTIN_FORMATTERS.Task.formatComplete(...a) },

  Agent: { friendlyName: 'Delegate Task', category: 'subagent', formatStart: (...a) => BUILTIN_FORMATTERS.Task.formatStart(...a), formatComplete: (...a) => BUILTIN_FORMATTERS.Task.formatComplete(...a) },

  // Task management
  TaskCreate: { friendlyName: 'Create Task', category: 'task', formatStart: (_n, args) => `Create task: ${args.subject ?? ''}`, formatComplete: () => undefined },
  TaskUpdate: { friendlyName: 'Update Task', category: 'task', formatStart: (_n, args) => `Update task ${args.taskId ?? ''}`, formatComplete: () => undefined },
  TaskList: { friendlyName: 'List Tasks', category: 'task', formatStart: () => 'Listing tasks', formatComplete: () => undefined },

  update_todo: {
    friendlyName: 'Update Todo',
    category: 'task',
    formatStart: (_name, args) => {
      const todos = String(args.todos ?? '');
      if (todos) {
        const parsed = parseTodoMarkdown(todos);
        return parsed.title;
      }
      return 'Updating todo list';
    },
    formatComplete: (_name, _result, args): TodoToolData | undefined => {
      const todos = String(args.todos ?? '');
      if (!todos) { return undefined; }
      const parsed = parseTodoMarkdown(todos);
      return { title: parsed.title, todoList: parsed.todoList };
    },
  },

  TodoWrite: { friendlyName: 'Update Todo', category: 'task', formatStart: (_n, args) => `Todo: ${args.subject ?? ''}`, formatComplete: () => undefined },

  // Meta tools — typically rendered as dim status lines
  report_intent: { friendlyName: 'Intent', category: 'default', formatStart: (_n, args) => String(args.intent ?? ''), formatComplete: () => undefined },
  think: { friendlyName: 'Thinking', category: 'default', formatStart: () => 'Thinking', formatComplete: () => undefined },
  report_progress: { friendlyName: 'Progress', category: 'default', formatStart: (_n, args) => String(args.prDescription ?? args.message ?? 'Progress update'), formatComplete: () => undefined },

  // Web tools
  WebFetch: { friendlyName: 'Fetch Web', category: 'mcp', formatStart: (_n, args) => `Fetching ${args.url ?? ''}`, formatComplete: (_n, result, args): SimpleToolData => ({ input: String(args.url ?? ''), output: result }) },
  WebSearch: { friendlyName: 'Web Search', category: 'mcp', formatStart: (_n, args) => `Searching: ${args.query ?? ''}`, formatComplete: (_n, result, args): SimpleToolData => ({ input: String(args.query ?? ''), output: result }) },
  web_fetch: { friendlyName: 'Fetch Web', category: 'mcp', formatStart: (...a) => BUILTIN_FORMATTERS.WebFetch.formatStart(...a), formatComplete: (...a) => BUILTIN_FORMATTERS.WebFetch.formatComplete(...a) },
  web_search: { friendlyName: 'Web Search', category: 'mcp', formatStart: (...a) => BUILTIN_FORMATTERS.WebSearch.formatStart(...a), formatComplete: (...a) => BUILTIN_FORMATTERS.WebSearch.formatComplete(...a) },

  // Plan mode
  ExitPlanMode: { friendlyName: 'Plan', category: 'default', formatStart: (_n, args) => String(args.plan ?? 'Plan'), formatComplete: () => undefined },
  exit_plan_mode: { friendlyName: 'Plan', category: 'default', formatStart: (_n, args) => String(args.plan ?? 'Plan'), formatComplete: () => undefined },

  // Other
  AskUserQuestion: { friendlyName: 'Ask User', category: 'default', formatStart: () => 'Asking user a question', formatComplete: () => undefined },
  ask_user: { friendlyName: 'Ask User', category: 'default', formatStart: () => 'Asking user a question', formatComplete: () => undefined },
  Skill: { friendlyName: 'Skill', category: 'default', formatStart: (_n, args) => `Skill: ${args.skill ?? ''}`, formatComplete: () => undefined },
  skill: { friendlyName: 'Skill', category: 'default', formatStart: (_n, args) => `Skill: ${args.skill ?? ''}`, formatComplete: () => undefined },
  SendMessage: { friendlyName: 'Message', category: 'default', formatStart: (_n, args) => `Message to ${args.recipient ?? 'teammate'}`, formatComplete: () => undefined },
  EnterPlanMode: { friendlyName: 'Plan Mode', category: 'default', formatStart: () => 'Entering plan mode', formatComplete: () => undefined },

  // Memory / misc
  store_memory: { friendlyName: 'Store Memory', category: 'default', formatStart: (_n, args) => `Storing: ${String(args.key ?? args.description ?? '')}`, formatComplete: () => undefined },
  sql: { friendlyName: 'SQL', category: 'mcp', formatStart: (_n, args) => `Execute SQL: ${String(args.query ?? '').slice(0, 80)}`, formatComplete: (_n, result, args): SimpleToolData => ({ input: String(args.query ?? ''), output: result }) },
  lsp: { friendlyName: 'Language Server', category: 'mcp', formatStart: (_n, args) => `LSP: ${args.method ?? args.action ?? ''}`, formatComplete: () => undefined },
};

// ── Default (catch-all) formatter ────────────────────────────────────────────

const DEFAULT_FORMATTER: ToolFormatter = {
  friendlyName: 'Tool',
  category: 'default',
  formatStart: (toolName, args) => {
    // Try to classify by argument shape
    if (args.command) { return String(args.command); }
    if (args.file_path || args.path) { return `${toolName}: ${args.file_path ?? args.path}`; }
    if (args.pattern || args.query) { return `${toolName}: ${args.pattern ?? args.query}`; }
    return `Used tool: ${toolName}`;
  },
  formatComplete: (toolName, result, args): SimpleToolData => ({
    input: args ? JSON.stringify(args, null, 2) : '',
    output: result,
  }),
};

// ── Pinnable classification (matches VS Code shouldPinPart) ──────────────────

const PINNABLE_TOOLS = new Set([
  // Shell
  'Bash', 'bash', 'powershell',
  // File
  'Read', 'view', 'show_file',
  // Search
  'Grep', 'grep', 'rg', 'Glob', 'glob', 'search', 'semantic_code_search',
  // Edit
  'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'edit', 'str_replace', 'create', 'insert', 'undo_edit',
]);

/**
 * Returns true if a tool should be absorbed into the active thinking section
 * (pinned), matching VS Code's `shouldPinPart()` logic.
 *
 * Pinnable: file, search, edit, shell tools.
 * NOT pinnable: MCP tools, subagent/task tools, ask_user, Skill, meta tools.
 */
export function isPinnable(toolName: string): boolean {
  return PINNABLE_TOOLS.has(toolName);
}

// ── Verb computation ─────────────────────────────────────────────────────────

const VERB_MAP: Record<string, string> = {
  shell: 'Ran',
  file: 'Read',
  search: 'Searched',
  edit: 'Edited',
  subagent: 'Delegated',
  task: 'Updated',
  mcp: 'Ran',
  default: 'Used',
};

function computeVerb(category: ToolCategory): string {
  return VERB_MAP[category] ?? 'Used';
}

// ── Server name extraction ────────────────────────────────────────────────────

/**
 * Extract MCP server name from a prefixed tool name.
 * E.g. `kusto-mcp-server-executeQuery` → `kusto-mcp-server`
 * Returns undefined if no server prefix detected.
 */
function extractServerName(toolName: string, registry: ToolFormatterRegistry): string | undefined {
  // If the tool has a direct formatter, it's not MCP-prefixed
  if (registry[toolName]) { return undefined; }
  const lastDash = toolName.lastIndexOf('-');
  if (lastDash > 0) {
    const suffix = toolName.slice(lastDash + 1);
    if (registry[suffix]) {
      return toolName.slice(0, lastDash);
    }
  }
  return undefined;
}

// ── Registry factory ─────────────────────────────────────────────────────────

/**
 * Create a tool formatter registry by merging builtins with optional custom formatters.
 * Custom formatters override builtins for the same tool name.
 */
export function createToolFormatterRegistry(customFormatters?: ToolFormatterRegistry): ToolFormatterRegistry {
  return { ...BUILTIN_FORMATTERS, ...(customFormatters ?? {}) };
}

/**
 * Resolve a formatter for a given tool name.
 * Falls back to default formatter if no specific one is registered.
 *
 * Also handles MCP server tool names (e.g. `kusto-mcp-server-executeQuery`)
 * by checking for both the full name and the base name after stripping the
 * server prefix.
 */
export function resolveFormatter(registry: ToolFormatterRegistry, toolName: string): ToolFormatter {
  // Direct match
  if (registry[toolName]) { return registry[toolName]; }

  // MCP-style: try stripping server prefix (e.g. `server-name-toolName` → `toolName`)
  const lastDash = toolName.lastIndexOf('-');
  if (lastDash > 0) {
    const suffix = toolName.slice(lastDash + 1);
    if (registry[suffix]) { return registry[suffix]; }
  }

  return DEFAULT_FORMATTER;
}

/**
 * Classify a tool name into a category using the formatter registry.
 * Falls back to arg-based heuristic classification when no formatter is found.
 */
export function classifyTool(registry: ToolFormatterRegistry, toolName: string, args?: Record<string, unknown>): ToolCategory {
  const fmt = registry[toolName];
  if (fmt) { return fmt.category; }

  // Arg-based heuristic
  if (args) {
    if ('command' in args) { return 'shell'; }
    if ('file_path' in args || 'path' in args) { return 'file'; }
    if ('pattern' in args || 'query' in args) { return 'search'; }
    if ('prompt' in args && ('description' in args || 'subagent_type' in args)) { return 'subagent'; }
  }

  return 'default';
}

// ── Convenience: create a ToolInvocation from raw data ───────────────────────

/**
 * Create a ToolInvocation for a tool start event.
 */
export function createToolInvocation(
  registry: ToolFormatterRegistry,
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
): ToolInvocation {
  const fmt = resolveFormatter(registry, toolName);
  const category = fmt.category;
  let msg = fmt.formatStart(toolName, args);
  // If message is essentially empty after the verb, fall back to friendlyName + toolName
  const stripped = msg.replace(/^(Read|Searched|Search|Editing|Writing|Creating|Show|Inserting|Undoing)\s*/i, '').trim();
  if (!stripped || stripped === '``' || stripped === "for regex ``" || stripped === "for files matching ``") {
    msg = fmt.friendlyName !== 'Tool' ? fmt.friendlyName : toolName;
  }
  return {
    toolName,
    toolCallId,
    category,
    friendlyName: fmt.friendlyName,
    verb: computeVerb(category),
    serverName: extractServerName(toolName, registry),
    isPinnable: isPinnable(toolName),
    invocationMessage: msg,
    isComplete: false,
    isError: false,
    output: [],
  };
}

/**
 * Complete a ToolInvocation with result data.
 * Mutates the invocation in-place for streaming compatibility.
 */
export function completeToolInvocation(
  registry: ToolFormatterRegistry,
  invocation: ToolInvocation,
  result: string,
  args: Record<string, unknown>,
  isError = false,
): void {
  const fmt = resolveFormatter(registry, invocation.toolName);
  invocation.isComplete = true;
  invocation.isError = isError;
  invocation.toolSpecificData = fmt.formatComplete(invocation.toolName, result, args);
  // Generate past-tense message using the verb + stripped present-tense prefix
  const stripped = invocation.invocationMessage.replace(
    /^(Reading|Searching|Editing|Writing|Creating|Fetching|Executing|Inserting|Undoing|Delegating|Updating|Listing|Showing)\s+/i, ''
  );
  invocation.pastTenseMessage = stripped !== invocation.invocationMessage
    ? invocation.verb + ' ' + stripped
    : invocation.invocationMessage;
}
