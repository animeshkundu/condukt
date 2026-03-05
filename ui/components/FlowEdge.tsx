'use client';

import { memo } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

const STATE_STYLES: Record<string, { stroke: string; strokeWidth: number; dashArray?: string }> = {
  default:   { stroke: 'hsl(0 0% 30%)', strokeWidth: 1.5 },
  taken:     { stroke: 'hsl(142 76% 36%)', strokeWidth: 2 },
  not_taken: { stroke: 'hsl(0 0% 25%)', strokeWidth: 1, dashArray: '4 4' },
};

function FlowEdgeInner(props: EdgeProps) {
  const { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, data } = props;
  const state = (data as { state?: string })?.state ?? 'default';
  const action = (data as { action?: string })?.action;
  const style = STATE_STYLES[state] ?? STATE_STYLES.default;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={{
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
          strokeDasharray: style.dashArray,
        }}
      />
      {action && action !== 'default' && (
        <foreignObject
          x={labelX - 20}
          y={labelY - 10}
          width={40}
          height={20}
          className="pointer-events-none"
        >
          <div className="flex items-center justify-center">
            <span className="text-[9px] px-1 py-0.5 rounded bg-background/80 text-muted-foreground border border-border/50">
              {action}
            </span>
          </div>
        </foreignObject>
      )}
    </>
  );
}

export const FlowEdge = memo(FlowEdgeInner);
