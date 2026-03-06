'use client';

import { memo } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

const STATE_STYLES: Record<string, { stroke: string; strokeWidth: number; dashArray?: string }> = {
  default:   { stroke: 'hsl(0 0% 30%)', strokeWidth: 1.5 },
  taken:     { stroke: 'hsl(142 76% 36%)', strokeWidth: 2 },
  not_taken: { stroke: 'hsl(0 0% 25%)', strokeWidth: 1, dashArray: '4 4' },
};

/** Build a custom SVG arc path that curves above the graph for back-edges. */
function buildBackEdgePath(
  sourceX: number, sourceY: number,
  targetX: number, targetY: number,
): { path: string; labelX: number; labelY: number } {
  // Arc goes upward — control points above both endpoints
  const midX = (sourceX + targetX) / 2;
  const dx = Math.abs(targetX - sourceX);
  const arcHeight = Math.max(80, dx * 0.4);
  const cy = Math.min(sourceY, targetY) - arcHeight;

  const path = `M ${sourceX},${sourceY} C ${sourceX},${cy} ${targetX},${cy} ${targetX},${targetY}`;
  return { path, labelX: midX, labelY: cy + arcHeight * 0.3 };
}

function FlowEdgeInner(props: EdgeProps) {
  const { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, data } = props;
  const state = (data as { state?: string })?.state ?? 'default';
  const action = (data as { action?: string })?.action;
  const isBackEdge = (data as { isBackEdge?: boolean })?.isBackEdge === true;
  const style = STATE_STYLES[state] ?? STATE_STYLES.default;

  let edgePath: string;
  let labelX: number;
  let labelY: number;

  if (isBackEdge) {
    const arc = buildBackEdgePath(sourceX, sourceY, targetX, targetY);
    edgePath = arc.path;
    labelX = arc.labelX;
    labelY = arc.labelY;
  } else {
    [edgePath, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
  }

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={{
          stroke: isBackEdge ? 'hsl(0 0% 40%)' : style.stroke,
          strokeWidth: isBackEdge ? 1.5 : style.strokeWidth,
          strokeDasharray: isBackEdge ? '6 4' : style.dashArray,
        }}
      />
      {/* Back-edge loop arrow indicator */}
      {isBackEdge && (
        <foreignObject
          x={labelX - 8}
          y={labelY - 8}
          width={16}
          height={16}
          className="pointer-events-none"
        >
          <div className="flex items-center justify-center">
            <span className="text-[10px] text-muted-foreground">&#x21ba;</span>
          </div>
        </foreignObject>
      )}
      {action && action !== 'default' && (
        <foreignObject
          x={labelX - 20}
          y={(isBackEdge ? labelY + 6 : labelY) - 10}
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
