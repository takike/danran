import { FamilyApiError } from '@client/api/family';
import { AuthenticatedShell } from '@client/components/AuthenticatedShell';
import { OAuthNotices } from '@client/components/OAuthNotices';
import { useLogoutMutation, useSessionQuery } from '@client/features/auth/useSession';
import { useFamiliesQuery } from '@client/features/onboarding/useFamily';
import { FamilySettings } from '@client/features/settings/FamilySettings';
import { AlertCircle, LogIn, LogOut, RefreshCw } from 'lucide-react';
import type React from 'react';
import { Link, useNavigate } from 'react-router-dom';

function PrivacyLink(): React.ReactElement {
  return (
    <Link
      to="/privacy"
      data-testid="privacy-link"
      className="inline-flex min-h-[var(--tap-target-min)] items-center justify-center rounded-[var(--radius-sm)] px-[var(--spacing-md)] py-[var(--spacing-xs)] text-xs text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      プライバシーポリシー
    </Link>
  );
}

function FamilyGate({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[var(--app-max-width)] flex-col justify-between bg-bg px-[var(--spacing-md)] py-[var(--spacing-lg)] text-ink">
      <div>
        <OAuthNotices />
        {children}
      </div>
      <footer className="mt-[var(--spacing-xl)] border-t border-line pt-[var(--spacing-md)] text-center">
        <PrivacyLink />
      </footer>
    </main>
  );
}

export default function FamilyPage(): React.ReactElement {
  const session = useSessionQuery();
  const logoutMutation = useLogoutMutation();
  const navigate = useNavigate();
  const user = session.data;
  const familiesQuery = useFamiliesQuery(user?.id);
  const familyAccessDenied =
    familiesQuery.error instanceof FamilyApiError &&
    (familiesQuery.error.status === 401 ||
      familiesQuery.error.status === 403 ||
      familiesQuery.error.status === 404 ||
      familiesQuery.error.code === 'UNAUTHORIZED' ||
      familiesQuery.error.code === 'FORBIDDEN' ||
      familiesQuery.error.code === 'NOT_FOUND');

  if (session.isLoading) {
    return (
      <FamilyGate>
        <h1 className="m-0 text-2xl font-bold">家族</h1>
        <p aria-live="polite" className="mt-[var(--spacing-lg)] text-sm text-muted">
          読み込み中...
        </p>
      </FamilyGate>
    );
  }

  if (session.isError) {
    return (
      <FamilyGate>
        <h1 className="m-0 text-2xl font-bold">家族</h1>
        <section
          role="alert"
          className="mt-[var(--spacing-lg)] rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-md)]"
        >
          <h2 className="m-0 text-sm font-semibold">通信エラー</h2>
          <p className="mt-[var(--spacing-xs)] mb-0 text-xs leading-relaxed text-muted">
            認証サービスに接続できませんでした。しばらく経ってから再度お試しください。
          </p>
          <button
            type="button"
            data-testid="retry-button"
            onClick={() => void session.refetch()}
            className="mt-[var(--spacing-md)] inline-flex min-h-[var(--tap-target-min)] w-full items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] border border-line bg-surface px-[var(--spacing-md)] text-sm font-medium hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <RefreshCw size={16} aria-hidden="true" />
            再試行
          </button>
        </section>
      </FamilyGate>
    );
  }

  if (!user) {
    return (
      <FamilyGate>
        <h1 className="m-0 text-2xl font-bold">家族</h1>
        <p className="mt-[var(--spacing-md)] text-sm text-muted">
          続けるには Google でログインしてください。
        </p>
        <button
          type="button"
          data-testid="login-button"
          onClick={() => window.location.assign('/api/auth/login')}
          className="mt-[var(--spacing-md)] inline-flex min-h-[var(--tap-target-min)] w-full items-center justify-center gap-[var(--spacing-sm)] rounded-[var(--radius-md)] bg-accent px-[var(--spacing-md)] py-[var(--spacing-sm)] text-sm font-semibold text-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <LogIn size={18} aria-hidden="true" />
          Google でログイン
        </button>
      </FamilyGate>
    );
  }

  const family = familiesQuery.data?.[0];

  return (
    <AuthenticatedShell activeTab="family" onCapture={() => navigate('/import')}>
      <OAuthNotices />
      <header className="mb-[var(--spacing-lg)]">
        <p className="m-0 text-sm text-muted">設定・メンバー管理</p>
        <h1 className="mt-[var(--spacing-xs)] mb-0 text-2xl font-bold">家族</h1>
      </header>
      {familiesQuery.isLoading && !familiesQuery.data ? (
        <p aria-live="polite" className="mb-0 text-sm text-muted">
          家族情報を読み込み中...
        </p>
      ) : familiesQuery.isError && (!familiesQuery.data || familyAccessDenied) ? (
        <section
          role="alert"
          className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]"
        >
          <p className="m-0 text-sm">家族情報を読み込めませんでした。</p>
          <button
            type="button"
            data-testid="retry-family-settings"
            onClick={() => void familiesQuery.refetch()}
            className="mt-[var(--spacing-sm)] inline-flex min-h-[var(--tap-target-min)] w-full items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] border border-line px-[var(--spacing-md)] text-sm font-medium hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <RefreshCw size={16} aria-hidden="true" />
            再試行
          </button>
        </section>
      ) : family ? (
        <>
          {familiesQuery.isError && !familyAccessDenied && (
            <p role="alert" className="mb-0 text-sm text-accent">
              家族情報を更新できませんでした。表示中の入力は保持されています。
            </p>
          )}
          <FamilySettings key={`${user.id}:${family.id}`} userId={user.id} family={family} />
        </>
      ) : (
        <section className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]">
          <p className="m-0 text-sm">家族がまだ設定されていません。</p>
          <Link
            to="/onboarding"
            data-testid="onboarding-link"
            className="mt-[var(--spacing-md)] inline-flex min-h-[var(--tap-target-min)] w-full items-center justify-center rounded-[var(--radius-md)] border border-line px-[var(--spacing-md)] text-sm font-medium text-ink hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            家族の設定
          </Link>
        </section>
      )}
      <section className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]">
        <h2 className="m-0 text-base font-semibold">アカウント</h2>
        <p
          data-testid="user-display-name"
          className="mt-[var(--spacing-sm)] mb-0 break-words text-sm font-medium [overflow-wrap:anywhere]"
        >
          {user.displayName}
        </p>
        {logoutMutation.isError && (
          <p role="alert" className="mt-[var(--spacing-sm)] mb-0 text-xs text-accent">
            ログアウトに失敗しました。再度お試しください。
          </p>
        )}
        <button
          type="button"
          data-testid="logout-button"
          disabled={logoutMutation.isPending}
          aria-busy={logoutMutation.isPending}
          onClick={() => logoutMutation.mutate()}
          className="mt-[var(--spacing-md)] inline-flex min-h-[var(--tap-target-min)] w-full items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] border border-line px-[var(--spacing-md)] text-sm font-medium hover:bg-chip disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <LogOut size={18} aria-hidden="true" />
          {logoutMutation.isPending ? 'ログアウト中...' : 'ログアウト'}
        </button>
      </section>
      <footer className="mt-[var(--spacing-xl)] border-t border-line pt-[var(--spacing-md)] text-center">
        <PrivacyLink />
      </footer>
    </AuthenticatedShell>
  );
}
