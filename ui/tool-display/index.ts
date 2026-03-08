/**
 * condukt/ui/tool-display — structured agent output rendering.
 *
 * Typed response parts model inspired by VS Code Copilot Chat (MIT).
 * Replaces flat ANSI line lists with a stream of typed parts:
 * markdown, tool-group, thinking, status.
 */

// Core data types
export type {
  ToolCategory,
  ToolInvocation,
  ToolSpecificData,
  TerminalToolData,
  SimpleToolData,
  SubagentToolData,
  TodoToolData,
  TodoItem,
  TodoStatus,
} from './types';
export {
  isTerminalData,
  isSimpleData,
  isSubagentData,
  isTodoData,
} from './types';

// Agent debug event types
export type {
  AgentDebugEventCategory,
  IAgentDebugEvent,
  IDiscoveryEvent,
  IToolCallEvent,
  ILLMRequestEvent,
  IErrorEvent,
  ILoopControlEvent,
  AgentDebugEvent,
  IAgentDebugEventFilter,
  ISessionSummary,
  ToolCallStatus,
  ErrorType,
  LoopAction,
  DiscoveryResourceType,
  DiscoverySource,
} from './debug-types';

// View logic (pure functions)
export type { IEventTreeNode } from './view-logic';
export {
  buildEventTree,
  groupEventsBySession,
  filterEvents,
  sortEventsChronologically,
  getEventIcon,
  getEventStatusClass,
  formatEventDetail,
  computeSessionSummary,
  formatCategoryLabel,
  formatDuration,
  formatTimestamp,
} from './view-logic';

// Format utilities
export type { CdPrefix, ParsedTodo } from './format-utils';
export {
  extractToolResultContent,
  stripReminders,
  extractCdPrefix,
  parseExitCode,
  stripExitCodeTrailer,
  parseTodoMarkdown,
} from './format-utils';

// Tool formatting registry
export type { ToolFormatter, ToolFormatterRegistry } from './formatter';
export {
  createToolFormatterRegistry,
  resolveFormatter,
  classifyTool,
  createToolInvocation,
  completeToolInvocation,
} from './formatter';

// Response part model + builder
export type {
  ResponsePart,
  MarkdownPart,
  ToolGroupPart,
  ThinkingPart,
  StatusPart,
  ResponsePartBuilderOptions,
} from './response-parts';
export { ResponsePartBuilder } from './response-parts';

// React components
export { ToolGroupCard } from './ToolGroupCard';
export type { ToolGroupCardProps } from './ToolGroupCard';

export { ToolInvocationRow } from './ToolInvocationRow';
export type { ToolInvocationRowProps } from './ToolInvocationRow';

export { ThinkingBlock } from './ThinkingBlock';
export type { ThinkingBlockProps } from './ThinkingBlock';

export { StatusLine } from './StatusLine';
export type { StatusLineProps } from './StatusLine';

export { ResponsePartRenderer } from './ResponsePartRenderer';
export type { ResponsePartRendererProps } from './ResponsePartRenderer';
