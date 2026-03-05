import { cn } from '../../utils';

export interface SkeletonProps {
  variant?: 'card' | 'row' | 'text';
  lines?: number;
  className?: string;
}

const shimmerStyle: React.CSSProperties = {
  backgroundImage: 'linear-gradient(to right, #201d18, #343230, #201d18)',
  backgroundSize: '200% 100%',
  animation: 'shimmer 1.5s ease-in-out infinite',
};

export function Skeleton({ variant = 'text', lines = 3, className }: SkeletonProps) {
  if (variant === 'card') {
    return (
      <div
        className={cn('w-full rounded-lg', className)}
        style={{ ...shimmerStyle, height: 120, border: '1px solid #302e2b' }}
      />
    );
  }

  if (variant === 'row') {
    return (
      <div
        className={cn('w-full rounded-md', className)}
        style={{ ...shimmerStyle, height: 40, border: '1px solid #302e2b' }}
      />
    );
  }

  // text variant
  const widths = ['100%', '80%', '60%'];
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="rounded"
          style={{
            ...shimmerStyle,
            height: 12,
            width: widths[i % widths.length],
          }}
        />
      ))}
    </div>
  );
}
