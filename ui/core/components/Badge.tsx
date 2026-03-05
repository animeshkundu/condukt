import { cn } from '../../utils';
import { sc } from '../../components/node-panel/types';

export interface BadgeProps {
  status: string;
  className?: string;
}

export function Badge({ status, className }: BadgeProps) {
  const colors = sc(status);
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-[3px] rounded-full text-[10px] font-semibold uppercase tracking-wide',
        className,
      )}
      style={{ backgroundColor: colors.bg, color: colors.text, border: `1px solid ${colors.dot}44`, boxShadow: `0 0 12px ${colors.dot}44` }}
    >
      {status}
    </span>
  );
}
