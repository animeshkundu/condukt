import { cn } from '../../utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
}

const variantStyles: Record<string, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-500 shadow-[0_1px_2px_rgba(0,0,0,0.3),0_0_12px_rgba(59,130,246,0.2)] hover:shadow-[0_1px_2px_rgba(0,0,0,0.3),0_0_20px_rgba(59,130,246,0.3)]',
  secondary: 'bg-[#2d2a26] border border-[#4a4742] text-[#d4cfc5] hover:bg-[#343230] hover:border-[#5a5650] hover:text-[#e8e6e3] shadow-[0_1px_2px_rgba(0,0,0,0.2)]',
  ghost: 'bg-transparent text-[#b1ada1] hover:bg-[#343230] hover:text-[#e8e6e3]',
  danger: 'bg-red-600 text-white hover:bg-red-500 shadow-[0_1px_2px_rgba(0,0,0,0.3),0_0_12px_rgba(239,68,68,0.2)]',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  ref,
  ...rest
}: ButtonProps & { ref?: React.Ref<HTMLButtonElement> }) {
  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      disabled={isDisabled}
      className={cn(
        'rounded-xl font-medium transition-all duration-200 active:scale-[0.97]',
        variantStyles[variant],
        size === 'sm' && 'text-xs px-3 py-1.5',
        size === 'md' && 'text-sm px-4 py-2',
        isDisabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
      style={{
        minHeight: size === 'sm' ? 32 : 36,
      }}
      {...rest}
    >
      {loading ? (
        <span
          className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full"
          style={{ animation: 'spin 0.6s linear infinite' }}
          aria-label="Loading"
        />
      ) : (
        children
      )}
    </button>
  );
}
