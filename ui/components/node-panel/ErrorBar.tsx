'use client';

interface Props {
  error: string;
}

export function ErrorBar({ error }: Props) {
  return (
    <div style={{
      padding: '12px 24px', fontSize: 11,
      color: '#f87171', background: '#3a1a1a44',
      borderBottom: '1px solid #302e2b',
      borderLeft: '3px solid #f8717144',
    }}>
      {error}
    </div>
  );
}
