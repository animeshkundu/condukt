import { cn } from '../../utils';
import { sc } from '../../components/node-panel/types';

export interface ExecutionCardProps {
  href: string;
  title: string;
  subtitle?: string;
  status: string;
  metadata?: string;
  progress?: number;
  children?: React.ReactNode;
  className?: string;
}

export function ExecutionCard({ href, title, subtitle, status, metadata, progress, children, className }: ExecutionCardProps) {
  const colors = sc(status);

  return (
    <a
      href={href}
      className={cn(
        'block rounded-2xl border border-[#302e2b] p-6 no-underline',
        'shadow-[0_1px_3px_rgba(0,0,0,0.2),0_4px_12px_rgba(0,0,0,0.15)]',
        'hover:border-[#4a4742] hover:-translate-y-1 hover:shadow-[0_2px_8px_rgba(0,0,0,0.2),0_12px_28px_rgba(0,0,0,0.18)] transition-all duration-200',
        'active:translate-y-0 active:shadow-card',
        'relative overflow-hidden group/card',
        className,
      )}
      style={{ background: 'linear-gradient(to bottom, #2b2a27, #1e1b17)' }}
    >
      <div className="absolute top-0 left-0 right-0 h-px" style={{ background: 'linear-gradient(to right, transparent, rgba(255,255,255,0.06), transparent)' }} />
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-[15px] tracking-[-0.01em] truncate">{title}</span>
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold shrink-0"
          style={{ backgroundColor: colors.bg, color: colors.text }}
        >
          {status}
        </span>
      </div>

      {/* Subtitle */}
      {subtitle && (
        <div className="mt-1 text-[12px]" style={{ color: '#8a8578' }}>{subtitle}</div>
      )}

      {/* Metadata */}
      {metadata && (
        <div className="mt-1 text-[12px]" style={{ color: '#8a8578' }}>{metadata}</div>
      )}

      {/* Children slot (e.g. MiniPipeline) */}
      {children && <div className="mt-3">{children}</div>}

      {/* Progress bar */}
      {progress != null && progress > 0 && (
        <div
          className="absolute bottom-0 left-0 h-[3px]"
          style={{
            width: `${Math.min(100, Math.max(0, progress))}%`,
            backgroundColor: colors.dot,
            transition: 'width 0.3s',
          }}
        />
      )}
    </a>
  );
}
