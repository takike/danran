import {
  getPwaUpdateSnapshot,
  reloadToApplyPwaUpdate,
  subscribePwaUpdate,
} from '@client/features/pwa/updateManager';
import { useSyncExternalStore } from 'react';
import type React from 'react';

export function PwaUpdateBanner(): React.ReactElement | null {
  const { updateAvailable, manualReloadBlocked } = useSyncExternalStore(
    subscribePwaUpdate,
    getPwaUpdateSnapshot,
    getPwaUpdateSnapshot,
  );

  if (!updateAvailable) return null;

  return (
    <output
      data-testid="pwa-update-banner"
      aria-live="polite"
      className="sticky top-0 z-50 mx-auto flex w-full max-w-[var(--app-max-width)] flex-wrap items-center justify-between gap-[var(--spacing-sm)] border-b border-line bg-surface px-[var(--spacing-sm)] pt-[calc(env(safe-area-inset-top,0px)+var(--spacing-sm))] pb-[var(--spacing-sm)] text-ink shadow-[var(--week-card-shadow)]"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">新しいバージョンがあります</span>
        <span className="block text-xs text-muted">更新すると入力中の内容は消去されます。</span>
      </span>
      <button
        type="button"
        disabled={manualReloadBlocked}
        onClick={reloadToApplyPwaUpdate}
        className="min-h-[var(--tap-target-min)] shrink-0 rounded-[var(--radius-sm)] bg-accent px-[var(--spacing-md)] text-sm font-semibold text-surface disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        更新
      </button>
    </output>
  );
}
