import { useCallback, useState } from 'react';

export interface ResourceLinkProps {
  uri: string;
  name: string;
  title?: string;
  mimeType?: string;
  className?: string;
}

export function ResourceLink({ uri, name, title, mimeType, className }: ResourceLinkProps) {
  const isHttp = uri.startsWith('http://') || uri.startsWith('https://');
  const label = title || name;
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(() => {
    if (isHttp) {
      window.open(uri, '_blank', 'noopener');
    } else {
      navigator.clipboard.writeText(uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [uri, isHttp]);

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
      title={mimeType ? `${uri} (${mimeType})` : uri}
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        cursor: 'pointer',
        fontSize: 13,
        color: copied ? '#4ade80' : '#D97757',
        transition: 'color 150ms',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 12 }}>{isHttp ? '\u2197' : '\u2398'}</span>
      <span style={{ textDecoration: 'none' }}>{copied ? 'Copied!' : label}</span>
    </span>
  );
}
