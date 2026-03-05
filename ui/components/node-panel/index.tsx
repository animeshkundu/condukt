'use client';

/**
 * NodePanel — compound component for node detail views (ADR-003).
 *
 * Usage (zero-config convenience):
 * ```tsx
 * import { NodeDetailPanel } from '@anthropic/flow-framework/ui';
 * <NodeDetailPanel projection={p} nodeId={id} onClose={close} onAction={act} />
 * ```
 *
 * Usage (compound composition):
 * ```tsx
 * import { NodePanel } from '@anthropic/flow-framework/ui';
 * <NodePanel>
 *   <NodePanel.Header node={node} onClose={close} />
 *   <NodePanel.Info node={node} />
 *   {node.status === 'gated' && <MyCustomGateUI />}
 *   <NodePanel.Controls node={node} onRetry={retry} onSkip={skip} />
 *   <NodePanel.Output lines={lines} total={total} renderer="ansi" />
 * </NodePanel>
 * ```
 */

import { Header } from './Header';
import { Info } from './Info';
import { ErrorBar } from './ErrorBar';
import { Gate } from './Gate';
import { Controls } from './Controls';
import { Output } from './Output';
import type { OutputRenderer } from './Output';

interface NodePanelProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
}

/**
 * Shell container for the node detail panel.
 * Provides the flex column layout. Children are the compound sub-components.
 */
function NodePanelRoot({ children, style }: NodePanelProps) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: '#1a1815', color: '#e8e6e3',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      ...style,
    }}>
      {children}
    </div>
  );
}

// Attach sub-components as static properties (dot notation pattern)
export const NodePanel = Object.assign(NodePanelRoot, {
  Header,
  Info,
  Error: ErrorBar,
  Gate,
  Controls,
  Output,
});

export type { OutputRenderer };
