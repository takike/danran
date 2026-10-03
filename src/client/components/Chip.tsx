import type { LucideIcon } from 'lucide-react';
import type React from 'react';

export type ChipVariant = 'routine' | 'accent' | 'deadline' | 'tentative';

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: ChipVariant;
  icon?: LucideIcon;
  label?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

const variantStyles: Record<ChipVariant, string> = {
  routine: 'bg-chip text-ink border-transparent',
  accent: 'bg-accent-tint text-ink border-transparent',
  deadline: 'bg-deadline-tint text-deadline border-transparent',
  tentative: 'bg-surface text-muted border-line border-dashed',
};

export function Chip({
  variant = 'routine',
  icon: Icon,
  label,
  children,
  className = '',
  ...props
}: ChipProps) {
  const content = label ?? children;

  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-[var(--spacing-xs)] px-[var(--spacing-sm)] py-[var(--spacing-2xs)] text-xs font-medium rounded-[var(--radius-full)] border ${variantStyles[variant]} ${className}`.trim()}
      {...props}
    >
      {Icon && (
        <Icon
          className="w-[var(--icon-size-sm)] h-[var(--icon-size-sm)] shrink-0"
          aria-hidden="true"
          size={14}
        />
      )}
      {content !== undefined && content !== null && (
        <span className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">{content}</span>
      )}
    </span>
  );
}
