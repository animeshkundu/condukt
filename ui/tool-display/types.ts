/**
 * Tool invocation data contracts for structured agent output rendering.
 *
 * Adapted from VS Code Copilot Chat (MIT). All VS Code specifics removed:
 * - MarkdownString -> string
 * - Uri -> string
 * - Classes -> plain interfaces
 */

// -- Terminal tool data (bash, powershell, etc.) ------------------------------

export interface TerminalToolData {
  commandLine: { original: string };
  language: string;
  presentationOverrides?: { commandLine: string };
  output?: { text: string };
  state?: { exitCode?: number; duration?: number };
}

// -- Simple input/output data (read, grep, glob, etc.) ------------------------

export interface SimpleToolData {
  input: string;
  output: string;
}

// -- Subagent data (task/agent delegation) ------------------------------------

export interface SubagentToolData {
  description?: string;
  agentName?: string;
  prompt?: string;
  result?: string;
}

// -- Todo list data -----------------------------------------------------------

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

// -- Image data (base64 encoded image from tool result) -----------------------

export interface ImageToolData {
  data: string;      // base64
  mimeType: string;
  alt?: string;
}

// -- Resource data (file/URI reference from tool result) ----------------------

export interface ResourceToolData {
  uri: string;
  name: string;
  title?: string;
  mimeType?: string;
  text?: string;     // inline text content
}

// -- Union of all tool-specific data shapes -----------------------------------

export type ToolSpecificData =
  | TerminalToolData
  | SimpleToolData
  | SubagentToolData
  | TodoToolData
  | ImageToolData
  | ResourceToolData;

// -- Tool categories ----------------------------------------------------------

export type ToolCategory =
  | 'shell'
  | 'file'
  | 'search'
  | 'edit'
  | 'subagent'
  | 'task'
  | 'mcp'
  | 'default';

// -- Tool invocation (the core display unit) ----------------------------------

export interface ToolInvocation {
  toolName: string;
  toolCallId: string;
  category: ToolCategory;
  /** Human-readable display name: "Shell", "Read", "Kusto Query" */
  friendlyName: string;
  /** Past-tense verb for completed state: "Ran", "Read", "Searched" */
  verb: string;
  /** MCP server name when tool is server-prefixed, e.g. "icm-mcp" */
  serverName?: string;
  /** Whether this tool should be absorbed into a thinking section. */
  isPinnable: boolean;
  /** Human-readable action: "Read src/app/page.tsx", "Searched for `pattern`" */
  invocationMessage: string;
  pastTenseMessage?: string;
  isComplete: boolean;
  isError: boolean;
  toolSpecificData?: ToolSpecificData;
  /** Partial result lines accumulated during streaming. */
  output: string[];
}

// -- Type guards --------------------------------------------------------------

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

export function isImageData(data: ToolSpecificData): data is ImageToolData {
  return 'data' in data && 'mimeType' in data;
}

export function isResourceData(data: ToolSpecificData): data is ResourceToolData {
  return 'uri' in data && 'name' in data && !('data' in data);
}
