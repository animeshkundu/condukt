/**
 * condukt/ui/tool-display — structured agent output rendering.
 *
 * VS Code Copilot Chat-inspired "pin to thinking" model:
 * - Pinnable tools absorbed into collapsible thinking sections
 * - Standalone tools as flat progress lines
 * - Agent speech as full-size markdown between sections
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
  shortenPath,
  shortenToolMessage,
} from './format-utils';

// Tool formatting registry
export type { ToolFormatter, ToolFormatterRegistry } from './formatter';
export {
  createToolFormatterRegistry,
  resolveFormatter,
  classifyTool,
  createToolInvocation,
  completeToolInvocation,
  isPinnable,
} from './formatter';

// Response part model + builder
export type {
  ResponsePart,
  MarkdownPart,
  ToolProgressPart,
  ThinkingSectionPart,
  StatusPart,
  ThinkingSectionItem,
  ThinkingTextItem,
  PinnedToolItem,
  ResponsePartBuilderOptions,
} from './response-parts';
export { ResponsePartBuilder } from './response-parts';

// React components
export { ToolProgressLine } from './ToolProgressLine';
export type { ToolProgressLineProps } from './ToolProgressLine';

export { ThinkingSection, ensureAnimations } from './ThinkingSection';
export type { ThinkingSectionProps } from './ThinkingSection';

export { StatusLine } from './StatusLine';
export type { StatusLineProps } from './StatusLine';

export { ResponsePartRenderer } from './ResponsePartRenderer';
export type { ResponsePartRendererProps } from './ResponsePartRenderer';
