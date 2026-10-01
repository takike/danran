import type React from 'react';

export interface MemberDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  name: string;
  color: string;
  className?: string;
}

export function MemberDot({ name, color, className = '', ...props }: MemberDotProps) {
  return (
    <span
      className={`inline-flex items-center gap-[var(--spacing-xs)] text-xs font-medium text-ink min-w-0 ${className}`.trim()}
      {...props}
    >
      <span
        className="w-[var(--member-dot-size)] h-[var(--member-dot-size)] rounded-[var(--radius-full)] shrink-0"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <span className="break-words break-all [overflow-wrap:anywhere] min-w-0">{name}</span>
    </span>
  );
}
