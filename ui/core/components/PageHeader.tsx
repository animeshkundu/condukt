import { cn } from '../../utils';

export interface PageHeaderProps {
  title: string;
  badge?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, badge, backHref, backLabel = 'Back', actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex items-center justify-between px-6 py-4 border-b border-[#302e2b]', className)} style={{ background: 'linear-gradient(to bottom, #201d18, #1a1815)' }}>
      <div className="flex items-center gap-3">
        {backHref && (
          <a
            href={backHref}
            aria-label={backLabel}
            className="flex items-center justify-center rounded-md hover:bg-[#343230] transition-colors"
            style={{ minWidth: 44, minHeight: 44 }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 12L6 8L10 4" />
            </svg>
          </a>
        )}
        <span className="font-semibold text-base tracking-[-0.02em]">{title}</span>
        {badge}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
