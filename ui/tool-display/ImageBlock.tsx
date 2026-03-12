import { useCallback } from 'react';

export interface ImageBlockProps {
  data: string;
  mimeType: string;
  alt?: string;
  className?: string;
}

export function ImageBlock({ data, mimeType, alt, className }: ImageBlockProps) {
  const src = `data:${mimeType};base64,${data}`;

  const handleClick = useCallback(() => {
    // Use createObjectURL to avoid URL length limits on large base64 images
    const byteString = atob(data);
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    // Revoke after a delay to allow the new tab to load
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, [data, mimeType]);

  return (
    <img
      src={src}
      alt={alt || `Tool result (${mimeType})`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
      className={className}
      style={{
        display: 'block',
        cursor: 'pointer',
        maxHeight: 400,
        objectFit: 'contain',
        borderRadius: 6,
        border: '1px solid #302e2b',
      }}
    />
  );
}
