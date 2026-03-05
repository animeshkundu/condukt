'use client';

import type { ProjectionNode } from '../../../src/types';
import { cn } from '../../utils';
import { sc } from '../../components/node-panel/types';
import { formatElapsed } from '../utils';

export interface NodeListItemProps {
  node: ProjectionNode;
  selected?: boolean;
  onClick?: () => void;
  actions?: React.ReactNode;
  className?: string;
}

export function NodeListItem({ node, selected, onClick, actions, className }: NodeListItemProps) {
  const colors = sc(node.status);
  const isActive = node.status === 'running' || node.status === 'gated' || node.status === 'retrying';

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.();
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${node.displayName}: ${node.status}`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'group rounded-xl border border-[#252320] px-4 py-3 cursor-pointer transition-all duration-200 hover:bg-[#2b2a27] hover:border-[#3d3a36]',
        selected && 'border-[#D97757] bg-[#D9775715] shadow-[inset_3px_0_0_#D97757,0_0_16px_rgba(217,119,87,0.12)]',
        className,
      )}
      style={
        isActive && !selected
          ? { borderColor: colors.dot, backgroundColor: colors.bg }
          : undefined
      }
    >
      {/* Two-column layout: info left, actions right */}
      <div className="flex justify-between gap-3">
        {/* Left: name, model, status */}
        <div className="min-w-0 flex-1">
          {/* Row 1: name */}
          <div className="flex items-center gap-2">
            <span
              className="shrink-0 rounded-full"
              style={{
                width: 8,
                height: 8,
                backgroundColor: colors.dot,
                boxShadow: isActive ? `0 0 8px ${colors.dot}, 0 0 16px ${colors.dot}44` : undefined,
              }}
            />
            <span className="font-medium text-sm truncate">{node.displayName}</span>
          </div>
          {/* Row 2: model + elapsed */}
          <div className="mt-1 ml-[18px] flex items-center gap-2 text-[11px]" style={{ color: '#8a8578' }}>
            {node.model && <span className="truncate">{node.model}</span>}
            {node.elapsedMs != null && <span className="shrink-0">{formatElapsed(node.elapsedMs)}</span>}
            {node.attempt > 1 && (
              <span className="px-1 py-0.5 rounded text-[10px] bg-[#3d3a36] shrink-0">
                x{node.attempt}
              </span>
            )}
          </div>
          {/* Row 3: status */}
          <div className="mt-0.5 ml-[18px] text-[11px]">
            <span style={{ color: colors.text }}>{node.status}</span>
          </div>
          {/* Error text */}
          {node.error && (
            <div className="mt-0.5 ml-[18px] text-[11px] truncate" style={{ color: '#f87171' }} title={node.error}>
              {node.error}
            </div>
          )}
        </div>

        {/* Right: actions */}
        {actions && (
          <div
            className={cn(
              'shrink-0 flex flex-col gap-1 transition-opacity duration-150',
              selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
          >
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
