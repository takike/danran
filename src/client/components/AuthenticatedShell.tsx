import { TabBar, type TabId } from '@client/components/TabBar';
import type React from 'react';

interface AuthenticatedShellProps {
  children: React.ReactNode;
  activeTab: TabId;
  onCapture: () => void;
  className?: string;
  mainTestId?: string;
}

/** Shared mobile canvas and fixed navigation for authenticated screens. */
export function AuthenticatedShell({
  children,
  activeTab,
  onCapture,
  className = '',
  mainTestId,
}: AuthenticatedShellProps): React.ReactElement {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <main
        data-testid={mainTestId}
        className={`mx-auto min-h-screen w-full max-w-[var(--app-max-width)] px-[var(--spacing-md)] pt-[var(--spacing-lg)] pb-[var(--tab-bar-clearance)] ${className}`.trim()}
      >
        {children}
      </main>
      <TabBar
        activeTab={activeTab}
        onCapture={onCapture}
        showPreparingLabels
        links={{
          week: '/',
          routines: '/routines',
          tasks: '/tasks',
          family: '/family',
        }}
        className="fixed inset-x-0 bottom-0 z-20 border-t border-line shadow-[var(--nav-shadow)]"
      />
    </div>
  );
}
