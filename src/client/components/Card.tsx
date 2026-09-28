import type React from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  className?: string;
}

export function Card({ children, className = '', ...props }: CardProps) {
  return (
    <div
      className={`bg-surface text-ink border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)] ${className}`.trim()}
      {...props}
    >
      {children}
    </div>
  );
}
