import { cn } from '../../utils';

export interface StatProps {
  label: string;
  value: number;
  color: string;
  className?: string;
}

export function Stat({ label, value, color, className }: StatProps) {
  return (
    <div className={cn('border border-[#3d3a36] rounded-2xl px-4 py-3 min-w-[80px] md:px-5 md:py-4 md:min-w-[100px] shadow-[0_1px_3px_rgba(0,0,0,0.2),0_4px_12px_rgba(0,0,0,0.15)] transition-all duration-200 hover:border-[#4a4742] hover:shadow-[0_2px_8px_rgba(0,0,0,0.25)]', className)} style={{ background: 'linear-gradient(to bottom, #363330, #252220)' }}>
      <div style={{ fontSize: 28, fontWeight: 600, color, letterSpacing: '-0.02em', textShadow: '0 0 24px currentColor', lineHeight: 1.1 }}>{value}</div>
      <div className="text-[12px] mt-2 uppercase tracking-[0.08em] font-medium" style={{ color: '#8a8578' }}>{label}</div>
    </div>
  );
}
