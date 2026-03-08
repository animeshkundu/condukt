/**
 * Tool invocation data contracts for structured agent output rendering.
 *
 * Adapted from VS Code Copilot Chat (MIT). All VS Code specifics removed:
 * - MarkdownString → string
 * - Uri → string
 * - Classes → plain interfaces
 */

// ── Terminal tool data (bash, powershell, etc.) ──────────────────────────────

export interface TerminalToolData {
  commandLine: { original: string };
  language: string;
  presentationOverrides?: { commandLine: string };
  output?: { text: string };
  state?: { exitCode?: number; duration?: number };
}

// ── Simple input/output data (read, grep, glob, etc.) ────────────────────────

export interface SimpleToolData {
  input: string;
  output: string;
}

// ── Subagent data (task/agent delegation) ────────────────────────────────────

export interface SubagentToolData {
  description?: string;
  agentName?: string;
  prompt?: string;
  result?: string;
}

// ── Todo list data ───────────────────────────────────────────────────────────

export type TodoStatus = 'not-started' | 'in-progress' | 'completed';

export interface TodoItem {
  id: number;
  title: string;
  status: TodoStatus;
}

export interface TodoToolData {
  title: string;
  todoList: TodoItem[];
}

// ── Union of all tool-specific data shapes ───────────────────────────────────

export type ToolSpecificData =
  | TerminalToolData
  | SimpleToolData
  | SubagentToolData
  | TodoToolData;

// ── Tool categories ──────────────────────────────────────────────────────────

export type ToolCategory =
  | 'shell'
  | 'file'
  | 'search'
  | 'edit'
  | 'subagent'
  | 'task'
  | 'mcp'
  | 'default';

// ── Tool invocation (the core display unit) ──────────────────────────────────

export interface ToolInvocation {
  toolName: string;
  toolCallId: string;
  category: ToolCategory;
  /** Human-readable action: "Read src/app/page.tsx", "Searched for `pattern`" */
  invocationMessage: string;
  pastTenseMessage?: string;
  isComplete: boolean;
  isError: boolean;
  toolSpecificData?: ToolSpecificData;
  /** Partial result lines accumulated during streaming. */
  output: string[];
}

// ── Type guards ──────────────────────────────────────────────────────────────

export function isTerminalData(data: ToolSpecificData): data is TerminalToolData {
  return 'commandLine' in data && 'language' in data;
}

export function isSimpleData(data: ToolSpecificData): data is SimpleToolData {
  return 'input' in data && 'output' in data && !('commandLine' in data);
}

export function isSubagentData(data: ToolSpecificData): data is SubagentToolData {
  return ('agentName' in data || 'prompt' in data) && !('todoList' in data);
}

export function isTodoData(data: ToolSpecificData): data is TodoToolData {
  return 'todoList' in data;
}
