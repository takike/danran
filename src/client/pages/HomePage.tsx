import { FamilyApiError } from '@client/api/family';
import { Card } from '@client/components/Card';
import { OAuthNotices } from '@client/components/OAuthNotices';
import { useSessionQuery } from '@client/features/auth/useSession';
import { useFamiliesQuery } from '@client/features/onboarding/useFamily';
import WeekPage from '@client/features/week/WeekPage';
import type { AuthUser } from '@shared/schemas/auth';
import { useQueryClient } from '@tanstack/react-query';
import { LogIn, RefreshCw, Shield } from 'lucide-react';
import type React from 'react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';

function PageFrame({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <main
      data-testid="home-screen"
      className="mx-auto flex min-h-screen w-full max-w-[var(--app-max-width)] flex-col justify-between bg-bg px-[var(--spacing-md)] py-[var(--spacing-lg)] text-ink"
    >
      <div>
        <header className="border-b border-line pb-[var(--spacing-md)]">
          <h1 className="m-0 text-2xl font-bold text-ink">Danran</h1>
          <p className="mt-[var(--spacing-sm)] mb-0 text-sm leading-relaxed text-muted">
            ルーティンは背景に、週末は前景に。家族の時間を守るカレンダー。
          </p>
        </header>
        <OAuthNotices />
        {children}
      </div>
      <footer className="mt-[var(--spacing-xl)] border-t border-line pt-[var(--spacing-md)] text-center">
        <Link
          to="/privacy"
          data-testid="privacy-link"
          className="inline-flex min-h-[var(--tap-target-min)] items-center justify-center rounded-[var(--radius-sm)] px-[var(--spacing-md)] py-[var(--spacing-xs)] text-xs text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          プライバシーポリシー
        </Link>
      </footer>
    </main>
  );
}

export default function HomePage(): React.ReactElement {
  const session = useSessionQuery();
  const queryClient = useQueryClient();
  const user = session.data;
  const familiesQuery = useFamiliesQuery(session.isError ? undefined : user?.id);

  useEffect(() => {
    if (
      !user ||
      !(familiesQuery.error instanceof FamilyApiError) ||
      familiesQuery.error.status !== 401
    )
      return;
    void (async () => {
      if (queryClient.getQueryData<AuthUser | null>(['session'])?.id !== user.id) return;
      await queryClient.cancelQueries({ queryKey: ['session'] });
      if (queryClient.getQueryData<AuthUser | null>(['session'])?.id !== user.id) return;
      queryClient.setQueryData(['session'], null);
    })();
  }, [familiesQuery.error, queryClient, user]);

  if (session.isLoading) {
    return (
      <PageFrame>
        <section
          aria-live="polite"
          className="mt-[var(--spacing-xl)] rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-lg)] text-center"
        >
          <RefreshCw
            size={24}
            aria-hidden="true"
            className="mx-auto mb-[var(--spacing-sm)] animate-spin text-accent"
          />
          <p className="m-0 text-sm text-muted">読み込み中...</p>
        </section>
      </PageFrame>
    );
  }

  if (session.isError) {
    return (
      <PageFrame>
        <section
          role="alert"
          className="mt-[var(--spacing-xl)] rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-md)]"
        >
          <h2 className="m-0 text-sm font-semibold">通信エラー</h2>
          <p className="mt-[var(--spacing-xs)] mb-0 text-xs leading-relaxed text-muted">
            認証サービスに接続できませんでした。しばらく経ってから再度お試しください。
          </p>
          <button
            type="button"
            data-testid="retry-button"
            onClick={() => void session.refetch()}
            className="mt-[var(--spacing-sm)] min-h-[var(--tap-target-min)] w-full rounded-[var(--radius-md)] border border-line bg-surface px-[var(--spacing-md)] text-sm font-medium hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            再試行
          </button>
        </section>
      </PageFrame>
    );
  }

  if (!user) {
    return (
      <PageFrame>
        <section className="mt-[var(--spacing-xl)] space-y-[var(--spacing-md)]">
          <Card>
            <h2 className="m-0 mb-[var(--spacing-xs)] text-base font-semibold">
              家族の予定をひとつに
            </h2>
            <p className="mb-[var(--spacing-md)] text-xs leading-relaxed text-muted">
              Google カレンダーと連携して、仕事や個人の予定を守りながら家族の時間を計画できます。
            </p>
            <button
              type="button"
              data-testid="login-button"
              onClick={() => window.location.assign('/api/auth/login')}
              className="inline-flex min-h-[var(--tap-target-min)] w-full items-center justify-center gap-[var(--spacing-sm)] rounded-[var(--radius-md)] bg-accent px-[var(--spacing-md)] py-[var(--spacing-sm)] text-sm font-medium text-surface hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
            >
              <LogIn size={18} aria-hidden="true" />
              Google でログイン
            </button>
          </Card>
          <Card>
            <div className="mb-[var(--spacing-xs)] flex items-center gap-[var(--spacing-xs)] text-ink">
              <Shield size={16} className="text-[var(--member-green)]" aria-hidden="true" />
              <h2 className="m-0 text-xs font-semibold">プライバシーを保護</h2>
            </div>
            <p className="m-0 text-xs leading-relaxed text-muted">
              個人の予定のタイトルや詳細は他の家族には見えません。予定が入っている時間帯だけを共有します。
            </p>
          </Card>
        </section>
      </PageFrame>
    );
  }

  if (familiesQuery.isLoading) {
    return (
      <PageFrame>
        <section
          aria-live="polite"
          className="mt-[var(--spacing-xl)] rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-lg)] text-center"
        >
          <RefreshCw
            size={24}
            aria-hidden="true"
            className="mx-auto mb-[var(--spacing-sm)] animate-spin text-accent"
          />
          <p className="m-0 text-sm text-muted">家族を読み込み中...</p>
        </section>
      </PageFrame>
    );
  }

  if (familiesQuery.isError) {
    const requiresLogin =
      familiesQuery.error instanceof FamilyApiError && familiesQuery.error.status === 401;
    return (
      <PageFrame>
        <section
          role="alert"
          className="mt-[var(--spacing-xl)] rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-md)]"
        >
          <h2 className="m-0 text-sm font-semibold">
            {requiresLogin ? 'ログインが必要です' : '家族情報を取得できませんでした'}
          </h2>
          <p className="mt-[var(--spacing-xs)] mb-0 text-xs leading-relaxed text-muted">
            {requiresLogin
              ? 'Google で再度ログインしてください。'
              : '時間をおいて、もう一度お試しください。'}
          </p>
          {requiresLogin ? (
            <button
              type="button"
              onClick={() => window.location.assign('/api/auth/login')}
              className="mt-[var(--spacing-md)] min-h-[var(--tap-target-min)] w-full rounded-[var(--radius-md)] bg-accent px-[var(--spacing-md)] text-sm font-semibold text-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Google でログイン
            </button>
          ) : (
            <button
              type="button"
              data-testid="retry-button"
              onClick={() => void familiesQuery.refetch()}
              className="mt-[var(--spacing-md)] min-h-[var(--tap-target-min)] w-full rounded-[var(--radius-md)] border border-line bg-surface px-[var(--spacing-md)] text-sm font-medium hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              再試行
            </button>
          )}
        </section>
      </PageFrame>
    );
  }

  const family = (familiesQuery.data ?? []).find(
    (item) => item.creationStatus === 'ready' && item.familyCalendarId,
  );
  if (family) {
    return (
      <WeekPage
        key={`${user.id}:${family.id}`}
        userId={user.id}
        familyId={family.id}
        familyName={family.name}
      />
    );
  }

  return (
    <PageFrame>
      <section className="mt-[var(--spacing-xl)]">
        <Card>
          <h2 className="m-0 text-base font-semibold">家族の予定を始めましょう</h2>
          <p className="mt-[var(--spacing-sm)] mb-0 text-sm leading-relaxed text-muted">
            家族カレンダーを作成するか、招待リンクから参加してください。
          </p>
          <Link
            to="/onboarding"
            data-testid="onboarding-link"
            className="mt-[var(--spacing-md)] inline-flex min-h-[var(--tap-target-min)] w-full items-center justify-center rounded-[var(--radius-md)] bg-accent px-[var(--spacing-md)] text-sm font-semibold text-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            家族の設定・オンボーディング
          </Link>
          <Link
            to="/family"
            className="mt-[var(--spacing-sm)] inline-flex min-h-[var(--tap-target-min)] w-full items-center justify-center rounded-[var(--radius-md)] px-[var(--spacing-md)] text-sm text-muted underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            アカウント設定
          </Link>
        </Card>
      </section>
    </PageFrame>
  );
}
