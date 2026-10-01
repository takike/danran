import { Card } from '@client/components/Card';
import { useLogoutMutation, useSessionQuery } from '@client/features/auth/useSession';
import { AlertCircle, LogIn, LogOut, RefreshCw, Shield } from 'lucide-react';
import type React from 'react';
import { Link, useSearchParams } from 'react-router-dom';

/**
 * Main Home screen (Task 1-1).
 *
 * Invariants:
 * - Preserves main data-testid="home-screen" and h1 "Danran" for PWA regression.
 * - TanStack Query manages /api/auth/me query and /api/auth/logout mutation.
 * - All controls have tap targets >= 44px. No horizontal overflow at 390px.
 * - Privacy link is present in EVERY auth state (loading, error, logged out, logged in).
 * - Fixed callback error=access_denied handled as Japanese cancel notice; arbitrary query text is never echoed.
 * - Home shows only user's display name and logout button (no email).
 * - Logout pending prevents duplicate clicks; logout failure preserves user state and enables retry.
 * - Failed revalidation never renders stale cached data as valid.
 */
export default function HomePage(): React.ReactElement {
  const [searchParams] = useSearchParams();
  const rawError = searchParams.get('error');
  const isAccessDenied = rawError === 'access_denied';

  const { data: user, isLoading, isError, refetch } = useSessionQuery();
  const logoutMutation = useLogoutMutation();

  return (
    <main
      data-testid="home-screen"
      className="max-w-[390px] mx-auto min-h-screen px-[var(--spacing-md)] py-[var(--spacing-lg)] bg-bg text-ink box-border flex flex-col justify-between"
    >
      <div>
        <header className="border-b border-line pb-[var(--spacing-md)]">
          <h1 className="text-2xl font-bold m-0 text-ink">Danran</h1>
          <p className="text-sm text-muted mt-[var(--spacing-sm)] mb-0 leading-relaxed">
            ルーティンは背景に、週末は前景に。家族の時間を守るカレンダー。
          </p>
        </header>

        {/* 1. Loading State */}
        {isLoading && (
          <section
            aria-live="polite"
            className="mt-[var(--spacing-xl)] p-[var(--spacing-lg)] bg-surface rounded-[var(--radius-md)] border border-line text-center"
          >
            <div className="inline-flex items-center justify-center p-[var(--spacing-sm)] text-muted mb-[var(--spacing-xs)]">
              <RefreshCw className="animate-spin text-accent" size={24} aria-hidden="true" />
            </div>
            <p className="text-sm text-muted m-0">読み込み中...</p>
          </section>
        )}

        {/* 2. Error State (503 / Network failure / Schema invalid) */}
        {!isLoading && isError && (
          <section
            aria-live="assertive"
            className="mt-[var(--spacing-xl)] p-[var(--spacing-md)] bg-surface rounded-[var(--radius-md)] border border-line"
          >
            <div className="flex items-start gap-[var(--spacing-sm)] mb-[var(--spacing-sm)]">
              <AlertCircle
                size={20}
                className="text-accent shrink-0 mt-[var(--spacing-2xs)]"
                aria-hidden="true"
              />
              <div>
                <h2 className="text-sm font-semibold text-ink m-0">通信エラー</h2>
                <p className="text-xs text-muted mt-[var(--spacing-xs)] mb-0 leading-relaxed">
                  認証サービスに接続できませんでした。しばらく経ってから再度お試しください。
                </p>
              </div>
            </div>
            <button
              type="button"
              data-testid="retry-button"
              onClick={() => refetch()}
              className="w-full mt-[var(--spacing-sm)] min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-sm font-medium hover:bg-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus cursor-pointer"
            >
              再試行
            </button>
          </section>
        )}

        {/* 3. Logged-in State (Simplified to display name and logout button only) */}
        {!isLoading && !isError && user && (
          <section className="mt-[var(--spacing-xl)]">
            <Card className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)]">
              <h2 className="text-base font-semibold text-ink m-0">ログイン中</h2>
              <p
                data-testid="user-display-name"
                className="text-sm font-medium text-ink mt-[var(--spacing-sm)] mb-0 break-words break-all [overflow-wrap:anywhere]"
              >
                {user.displayName}
              </p>

              <div className="mt-[var(--spacing-md)]">
                <Link
                  to="/onboarding"
                  data-testid="onboarding-link"
                  className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-sm font-medium hover:bg-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus inline-flex items-center justify-center gap-[var(--spacing-xs)] text-center box-border"
                >
                  <span>家族の設定・オンボーディング</span>
                </Link>
              </div>

              {logoutMutation.isError && (
                <div
                  role="alert"
                  className="mt-[var(--spacing-sm)] p-[var(--spacing-sm)] bg-accent-tint text-accent rounded-[var(--radius-sm)] text-xs flex items-center gap-[var(--spacing-xs)]"
                >
                  <AlertCircle size={16} aria-hidden="true" className="shrink-0" />
                  <span>ログアウトに失敗しました。再度お試しください。</span>
                </div>
              )}

              <button
                type="button"
                data-testid="logout-button"
                disabled={logoutMutation.isPending}
                aria-busy={logoutMutation.isPending}
                onClick={() => logoutMutation.mutate()}
                className="w-full mt-[var(--spacing-md)] min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-sm font-medium hover:bg-chip disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus inline-flex items-center justify-center gap-[var(--spacing-xs)] cursor-pointer"
              >
                <LogOut size={18} aria-hidden="true" />
                <span>{logoutMutation.isPending ? 'ログアウト中...' : 'ログアウト'}</span>
              </button>
            </Card>
          </section>
        )}

        {/* 4. Logged-out State */}
        {!isLoading && !isError && !user && (
          <section className="mt-[var(--spacing-xl)] space-y-[var(--spacing-md)]">
            {isAccessDenied && (
              <output
                data-testid="access-denied-message"
                className="p-[var(--spacing-md)] bg-accent-tint text-accent rounded-[var(--radius-md)] text-xs flex items-start gap-[var(--spacing-sm)] border border-accent/20 block"
              >
                <AlertCircle
                  size={18}
                  className="shrink-0 mt-[var(--spacing-2xs)]"
                  aria-hidden="true"
                />
                <div>
                  <strong className="block font-semibold">ログインが中断されました</strong>
                  <span>Google ログインがキャンセルされました。</span>
                </div>
              </output>
            )}

            <Card className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)]">
              <h2 className="text-base font-semibold text-ink m-0 mb-[var(--spacing-xs)]">
                家族の予定をひとつに
              </h2>
              <p className="text-xs text-muted mb-[var(--spacing-md)] leading-relaxed">
                Google カレンダーと連携して、仕事や個人の予定を守りながら家族の時間を計画できます。
              </p>

              {/* Real button control triggering same-origin /api/auth/login navigation */}
              <button
                type="button"
                data-testid="login-button"
                onClick={() => window.location.assign('/api/auth/login')}
                className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-accent text-surface rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 flex items-center justify-center gap-[var(--spacing-sm)] text-center box-border cursor-pointer"
              >
                <LogIn size={18} aria-hidden="true" />
                <span>Google でログイン</span>
              </button>
            </Card>

            <Card className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)]">
              <div className="flex items-center gap-[var(--spacing-xs)] text-ink mb-[var(--spacing-xs)]">
                <Shield size={16} className="text-[var(--member-mama)]" aria-hidden="true" />
                <h3 className="text-xs font-semibold m-0">プライバシーを保護</h3>
              </div>
              <p className="text-xs text-muted m-0 leading-relaxed">
                個人の予定のタイトルや詳細は他の家族には見えません。予定が入っている時間帯だけを共有します。
              </p>
            </Card>
          </section>
        )}
      </div>

      {/* Footer: Privacy Policy link available in EVERY auth state */}
      <footer className="mt-[var(--spacing-xl)] pt-[var(--spacing-md)] border-t border-line text-center">
        <Link
          to="/privacy"
          data-testid="privacy-link"
          className="inline-flex items-center justify-center min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-xs)] text-xs text-muted hover:text-ink transition-colors rounded-[var(--radius-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          プライバシーポリシー
        </Link>
      </footer>
    </main>
  );
}
