'use client';

import { useEffect } from 'react';
import { cn } from '../../utils';

export interface ToastProps {
  message: string;
  type: 'success' | 'error';
  onDismiss?: () => void;
}

const typeStyles: Record<string, { bg: string; text: string }> = {
  success: { bg: 'rgba(34, 197, 94, 0.15)', text: '#4ade80' },
  error: { bg: 'rgba(239, 68, 68, 0.15)', text: '#f87171' },
};

export function Toast({ message, type, onDismiss }: ToastProps) {
  useEffect(() => {
    if (!onDismiss) return;
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const colors = typeStyles[type];

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('px-4 py-3 rounded-lg border text-sm font-medium')}
      style={{
        backgroundColor: colors.bg,
        color: colors.text,
        borderColor: colors.text + '22',
        boxShadow: `0 4px 12px rgba(0,0,0,0.3), 0 0 16px ${colors.text}11`,
        animation: 'slideUp 200ms ease, fadeIn 200ms ease',
      }}
    >
      {message}
    </div>
  );
}
