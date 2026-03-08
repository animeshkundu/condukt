// Core UI exports — no @xyflow/react dependency

// New UI primitives + pipeline components
export * from './components/index';

// Components (no graph components)
export { NodeDetailPanel } from '../components/NodeDetailPanel';
export { FlowStatusBar } from '../components/FlowStatusBar';

// MiniPipeline (ADR-004)
export { MiniPipeline } from '../components/MiniPipeline';
export type { MiniPipelineProps } from '../components/MiniPipeline';

// Compound NodePanel (ADR-003)
export { NodePanel } from '../components/node-panel/index';
export type { OutputRenderer } from '../components/node-panel/index';
export { STATUS_COLORS, sc } from '../components/node-panel/types';

// Hooks
export { useFlowExecution, useFlowExecutions } from '../hooks/useFlowExecution';
export type { FlowSSEStatus } from '../hooks/useFlowExecution';
export { useNodeOutput } from '../hooks/useNodeOutput';
export { useNodeArtifact } from '../hooks/useNodeArtifact';
export { useAutoSelectNode } from '../hooks/useAutoSelectNode';
export { useNodeNavigation } from '../hooks/useNodeNavigation';

// Markdown content renderer
export { MarkdownContent } from '../components/MarkdownContent';
export type { MarkdownContentProps } from '../components/MarkdownContent';

// ANSI terminal output utilities
export { ansiToHtml, stripAnsi, hasAnsi } from '../ansi';

// Tool display (response parts model — no graph dependency)
export { ResponsePartBuilder, ResponsePartRenderer } from '../tool-display/index';
export type { ResponsePart, ToolInvocation, ToolFormatter, ToolFormatterRegistry } from '../tool-display/index';

// Utilities
export { cn } from '../utils';
export { formatElapsed, formatDuration } from './utils';
