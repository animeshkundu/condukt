import { cn } from '../../utils';

export interface SectionLabelProps {
  children: React.ReactNode;
  className?: string;
}

export function SectionLabel({ children, className }: SectionLabelProps) {
  return (
    <div
      className={cn(
        'text-[11px] font-medium uppercase tracking-[0.08em] text-[#6b6660] py-1.5 px-1',
        className,
      )}
    >
      {children}
    </div>
  );
}
