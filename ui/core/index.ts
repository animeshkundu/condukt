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
export { useAutoSelectNode } from '../hooks/useAutoSelectNode';
export { useNodeNavigation } from '../hooks/useNodeNavigation';

// ANSI terminal output utilities
export { ansiToHtml, stripAnsi, hasAnsi } from '../ansi';

// Utilities
export { cn } from '../utils';
export { formatElapsed, formatDuration } from './utils';
