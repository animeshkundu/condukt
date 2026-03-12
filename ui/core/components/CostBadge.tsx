import { formatTokens } from '../utils';

export interface CostBadgeProps {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  duration?: number;
  model?: string;
  className?: string;
}

export function CostBadge({ inputTokens, outputTokens, cost, duration, model, className }: CostBadgeProps) {
  const parts: string[] = [];

  if (inputTokens != null && outputTokens != null) {
    parts.push(`${formatTokens(inputTokens)} in / ${formatTokens(outputTokens)} out`);
  } else if (inputTokens != null) {
    parts.push(`${formatTokens(inputTokens)} in`);
  } else if (outputTokens != null) {
    parts.push(`${formatTokens(outputTokens)} out`);
  }

  if (cost != null) {
    parts.push(`$${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`);
  }

  if (duration != null) {
    parts.push(duration >= 60 ? `${(duration / 60).toFixed(1)}m` : `${duration.toFixed(1)}s`);
  }

  if (parts.length === 0) return null;

  const label = parts.join(' \u00b7 ');
  const tooltip = model ? `Model: ${model}` : undefined;

  return (
    <span
      title={tooltip}
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 500,
        color: '#8a8578',
        background: '#302e2b',
      }}
    >
      <span style={{ color: '#b1ada1' }}>{label}</span>
    </span>
  );
}
