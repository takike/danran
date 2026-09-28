import type { LucideIcon } from 'lucide-react';
import type React from 'react';

export type IconButtonVariant = 'default' | 'accent' | 'ghost' | 'outline';
export type IconButtonSize = 'default' | 'capture';

export type IconButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  /** Required non-empty label for accessibility, mapped to aria-label */
  label: string;
  icon: LucideIcon;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  className?: string;
};

const variantStyles: Record<IconButtonVariant, string> = {
  default: 'bg-surface text-ink border border-line hover:bg-chip',
  accent: 'bg-accent text-surface border border-accent hover:opacity-90',
  ghost: 'bg-transparent text-ink border border-transparent hover:bg-chip',
  outline: 'bg-transparent text-ink border border-line hover:bg-chip',
};

const sizeStyles: Record<IconButtonSize, string> = {
  default:
    'min-h-[var(--tap-target-min)] min-w-[var(--tap-target-min)] w-[var(--tap-target-min)] h-[var(--tap-target-min)] p-[var(--spacing-sm)] rounded-[var(--radius-md)]',
  capture:
    'min-h-[var(--capture-button-size)] min-w-[var(--capture-button-size)] w-[var(--capture-button-size)] h-[var(--capture-button-size)] p-[var(--spacing-sm)] rounded-[var(--radius-full)]',
};

export function IconButton({
  label,
  icon: Icon,
  variant = 'default',
  size = 'default',
  type = 'button',
  disabled = false,
  className = '',
  ...props
}: IconButtonProps) {
  if (!label || label.trim() === '') {
    throw new Error('IconButton requires a non-empty label prop for accessibility.');
  }

  const iconPixelSize = size === 'capture' ? 24 : 20;

  return (
    <button
      type={type}
      disabled={disabled}
      className={`inline-flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-[var(--focus-offset)] focus-visible:ring-offset-surface disabled:opacity-40 disabled:cursor-not-allowed ${variantStyles[variant]} ${sizeStyles[size]} ${className}`.trim()}
      {...props}
      aria-label={label}
    >
      <Icon
        className={
          size === 'capture'
            ? 'w-[var(--icon-size-lg)] h-[var(--icon-size-lg)] shrink-0'
            : 'w-[var(--icon-size-md)] h-[var(--icon-size-md)] shrink-0'
        }
        size={iconPixelSize}
        aria-hidden="true"
      />
    </button>
  );
}
