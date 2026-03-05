'use client';

import type { ProjectionNode } from '../../../src/types';

interface Props {
  node: ProjectionNode;
  onResolve: (resolution: string) => void;
}

/** Capitalize first letter of each word. */
function titleCase(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

const RESOLUTION_COLORS: Record<string, string> = {
  approved: '#22c55e',
  rejected: '#ef4444',
  deploy: '#3b82f6',
  rollback: '#ef4444',
  skip: '#888',
};

function resolveColor(resolution: string): string {
  return RESOLUTION_COLORS[resolution.toLowerCase()] ?? '#3b82f6';
}

/**
 * Data-driven gate section (ADR-002).
 * Reads allowedResolutions from gateData. Default: ['approved', 'rejected'].
 * Renders one button per allowed resolution.
 */
export function Gate({ node, onResolve }: Props) {
  if (node.status !== 'gated') return null;

  const gateData = node.gateData ?? {};
  const resolutions: string[] =
    (Array.isArray(gateData.allowedResolutions) ? gateData.allowedResolutions : null) ??
    ['approved', 'rejected'];

  return (
    <div style={{ padding: '12px 24px', borderBottom: '1px solid #302e2b', background: '#352a1533', borderLeft: '3px solid #fbbf2444' }}>
      <div style={{ fontWeight: 600, color: '#fbbf24', fontSize: 12, marginBottom: 6 }}>
        Awaiting Resolution
      </div>
      {/* Show gate data if present (excluding allowedResolutions) */}
      {Object.keys(gateData).filter(k => k !== 'allowedResolutions').length > 0 && (
        <pre style={{ margin: '0 0 8px', color: '#8a8578', fontSize: 11, maxHeight: 80, overflow: 'auto', background: '#343230', padding: 8, borderRadius: 6 }}>
          {JSON.stringify(
            Object.fromEntries(Object.entries(gateData).filter(([k]) => k !== 'allowedResolutions')),
            null, 2,
          )}
        </pre>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        {resolutions.map(resolution => {
          const color = resolveColor(resolution);
          return (
            <button
              key={resolution}
              onClick={() => onResolve(resolution)}
              style={{
                background: color + '18', color, border: `1px solid ${color}33`,
                borderRadius: 6, padding: '4px 12px', fontSize: 11,
                cursor: 'pointer', fontWeight: 500,
              }}
            >
              {titleCase(resolution)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
