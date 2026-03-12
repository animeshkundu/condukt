import { useEffect, useState } from 'react';

export interface ElapsedTimeProps {
  startedAt?: number;
  finishedAt?: number;
  className?: string;
}

/** Self-contained elapsed time display. Manages its own 1s timer to avoid re-rendering the parent tree. */
export function ElapsedTime({ startedAt, finishedAt, className }: ElapsedTimeProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!startedAt || finishedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt, finishedAt]);

  if (!startedAt) return null;
  const elapsed = ((finishedAt ?? now) - startedAt) / 1000;
  const label = finishedAt ? `${elapsed.toFixed(0)}s total` : `${elapsed.toFixed(0)}s elapsed`;
  return <span className={className}>{label}</span>;
}
