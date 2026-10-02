import { FamilyApiError, extractInviteToken } from '@client/api/family';
import { Card } from '@client/components/Card';
import { MemberDot } from '@client/components/MemberDot';
import { SESSION_QUERY_KEY, useSessionQuery } from '@client/features/auth/useSession';
import {
  FAMILIES_QUERY_KEY,
  INVITE_INSPECT_QUERY_KEY,
  getColorCssVar,
  useInspectInviteQuery,
  useJoinFamilyMutation,
  useLoginWithInviteMutation,
} from '@client/features/onboarding/useFamily';
import type { FamilyPublic } from '@shared/schemas/family';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, CheckCircle2, LogIn, RefreshCw, Users } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function InviteJoinPage(): React.ReactElement {
  const location = useLocation();
  const queryClient = useQueryClient();

  // Extract and validate token strictly from location.hash or window.location.hash
  const [token, setToken] = useState<string | null>(() =>
    extractInviteToken(location.hash || window.location.hash),
  );

  useEffect(() => {
    const currentToken = extractInviteToken(location.hash || window.location.hash);
    setToken(currentToken);
  }, [location.hash]);

  useEffect(() => {
    const handleHashChange = () => {
      setToken(extractInviteToken(window.location.hash));
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const {
    data: user,
    isLoading: isUserLoading,
    isError: isUserError,
    refetch: refetchUser,
  } = useSessionQuery();

  // Synchronous guard for joined state to prevent rendering stale joined family across identity/token changes
  const [joinedState, setJoinedState] = useState<{
    userId: string;
    token: string;
    family: FamilyPublic;
  } | null>(null);

  // Synchronously compute current active joined family
  const joinedFamily =
    joinedState && user && joinedState.userId === user.id && joinedState.token === token
      ? joinedState.family
      : null;

  // Lifecycle generation and AbortController to prevent mutation completion races
  const generationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const joinFamilyMutation = useJoinFamilyMutation();
  const loginWithInviteMutation = useLoginWithInviteMutation();

  // Clear private join success state and abort pending requests on session change or token change
  const userId = user?.id;
  const prevIdentityRef = useRef({ userId, token, isUserError });
  useEffect(() => {
    if (
      prevIdentityRef.current.userId !== userId ||
      prevIdentityRef.current.token !== token ||
      prevIdentityRef.current.isUserError !== isUserError
    ) {
      prevIdentityRef.current = { userId, token, isUserError };
      generationRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = new AbortController();
      joinFamilyMutation.reset();
      loginWithInviteMutation.reset();
      setJoinedState(null);
    }
  }, [userId, token, isUserError, joinFamilyMutation.reset, loginWithInviteMutation.reset]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      abortControllerRef.current?.abort();
    };
  }, []);

  const isAuthenticated = !isUserLoading && !isUserError && !!user;
  const inspectQuery = useInspectInviteQuery(
    token,
    isAuthenticated ? user?.id : undefined,
    isAuthenticated && !joinedFamily && !!token,
  );

  const handleAuthRevocation = useCallback(async () => {
    generationRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    joinFamilyMutation.reset();
    loginWithInviteMutation.reset();

    await queryClient.cancelQueries({ queryKey: SESSION_QUERY_KEY });
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
    await queryClient.cancelQueries({ queryKey: INVITE_INSPECT_QUERY_KEY });
    queryClient.removeQueries({ queryKey: INVITE_INSPECT_QUERY_KEY });

    setJoinedState(null);
  }, [queryClient, joinFamilyMutation.reset, loginWithInviteMutation.reset]);

  // Inspect 401 handling
  useEffect(() => {
    if (inspectQuery.isError) {
      const err = inspectQuery.error;
      const is401 =
        err instanceof FamilyApiError
          ? err.status === 401 || err.code === 'UNAUTHORIZED'
          : (err as { status?: number; code?: string } | null)?.status === 401 ||
            (err as { status?: number; code?: string } | null)?.code === 'UNAUTHORIZED';
      if (is401) {
        handleAuthRevocation();
      }
    }
  }, [inspectQuery.isError, inspectQuery.error, handleAuthRevocation]);

  const handleLoginWithInvite = async () => {
    const currentGen = generationRef.current;
    const currentToken = token;
    if (!currentToken) return;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const authUrl = await loginWithInviteMutation.mutateAsync({
        inviteToken: currentToken,
        signal: controller.signal,
      });
      if (
        generationRef.current !== currentGen ||
        token !== currentToken ||
        controller.signal.aborted
      ) {
        return;
      }
      // Validated accounts.google.com URL
      window.location.assign(authUrl);
    } catch {
      if (
        generationRef.current !== currentGen ||
        token !== currentToken ||
        controller.signal.aborted
      ) {
        return;
      }
      // Handled by mutation error state
    }
  };

  const handleJoin = async () => {
    const currentGen = generationRef.current;
    const currentUserId = user?.id;
    const currentToken = token;
    if (!currentToken || !currentUserId) return;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const family = await joinFamilyMutation.mutateAsync({
        token: currentToken,
        signal: controller.signal,
      });
      if (
        generationRef.current !== currentGen ||
        user?.id !== currentUserId ||
        token !== currentToken ||
        controller.signal.aborted
      ) {
        return;
      }
      setJoinedState({
        userId: currentUserId,
        token: currentToken,
        family,
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: [...FAMILIES_QUERY_KEY, currentUserId],
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: [...INVITE_INSPECT_QUERY_KEY, currentToken, currentUserId],
          exact: true,
        }),
      ]);
    } catch (err: unknown) {
      if (
        generationRef.current !== currentGen ||
        user?.id !== currentUserId ||
        token !== currentToken ||
        controller.signal.aborted
      ) {
        return;
      }
      const errorObj = err as { status?: number; code?: string };
      if (errorObj?.status === 401 || errorObj?.code === 'UNAUTHORIZED') {
        await handleAuthRevocation();
      } else if (errorObj?.code === 'UNCERTAIN_MUTATION') {
        await queryClient.invalidateQueries({
          queryKey: [...INVITE_INSPECT_QUERY_KEY, currentToken, currentUserId],
          exact: true,
        });
      }
    }
  };

  return (
    <main
      data-testid="invite-screen"
      className="max-w-[390px] mx-auto min-h-screen px-[var(--spacing-md)] py-[var(--spacing-lg)] bg-bg text-ink box-border flex flex-col justify-between"
    >
      <div>
        <header className="border-b border-line pb-[var(--spacing-md)] flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold m-0 text-ink">家族への招待</h1>
            <p className="text-xs text-muted mt-[var(--spacing-xs)] mb-0">
              Danran 家族カレンダーへの参加
            </p>
          </div>
          <Link
            to="/"
            data-testid="back-to-home"
            className="inline-flex items-center justify-center min-w-[var(--tap-target-min)] min-h-[var(--tap-target-min)] text-muted hover:text-ink transition-colors rounded-[var(--radius-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            aria-label="ホームへ戻る"
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </Link>
        </header>

        {/* 1. Malformed / Missing Token: Fixed error and NO API calls */}
        {!token && (
          <section className="mt-[var(--spacing-xl)]">
            <div
              data-testid="invalid-token-error"
              role="alert"
              className="p-[var(--spacing-md)] bg-accent-tint text-accent rounded-[var(--radius-md)] text-xs flex items-start gap-[var(--spacing-sm)] border border-accent/20"
            >
              <AlertCircle
                size={18}
                className="shrink-0 mt-[var(--spacing-2xs)]"
                aria-hidden="true"
              />
              <div>
                <strong className="block font-semibold">無効な招待リンクです</strong>
                <span>無効な招待リンクです。URL を確認してください。</span>
              </div>
            </div>
          </section>
        )}

        {/* 2. Loading Session State */}
        {token && isUserLoading && (
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

        {/* 3. Session Error State */}
        {token && !isUserLoading && isUserError && (
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
                  認証情報の取得に失敗しました。しばらく経ってから再度お試しください。
                </p>
              </div>
            </div>
            <button
              type="button"
              data-testid="retry-button"
              onClick={() => refetchUser()}
              className="w-full mt-[var(--spacing-sm)] min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-sm font-medium hover:bg-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus cursor-pointer"
            >
              再試行
            </button>
          </section>
        )}

        {/* 4. Anonymous (Unauthenticated) with Valid Token */}
        {token && !isUserLoading && !isUserError && !user && (
          <section className="mt-[var(--spacing-xl)]">
            <Card className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)] space-y-[var(--spacing-md)]">
              <div>
                <h2 className="text-base font-semibold text-ink m-0 mb-[var(--spacing-xs)]">
                  家族カレンダーへの招待
                </h2>
                <p className="text-xs text-muted m-0 leading-relaxed">
                  Danran の家族カレンダーに参加するには、Google アカウントでログインしてください。
                </p>
              </div>

              {loginWithInviteMutation.isError && (
                <div
                  role="alert"
                  className="p-[var(--spacing-sm)] bg-accent-tint text-accent rounded-[var(--radius-sm)] text-xs flex items-center gap-[var(--spacing-xs)]"
                >
                  <AlertCircle size={16} aria-hidden="true" className="shrink-0" />
                  <span>
                    {loginWithInviteMutation.error.message || 'ログイン処理の開始に失敗しました。'}
                  </span>
                </div>
              )}

              <button
                type="button"
                data-testid="login-with-invite-button"
                disabled={loginWithInviteMutation.isPending}
                onClick={handleLoginWithInvite}
                className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-accent text-surface rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus flex items-center justify-center gap-[var(--spacing-sm)] text-center box-border cursor-pointer"
              >
                <LogIn size={18} aria-hidden="true" />
                <span>
                  {loginWithInviteMutation.isPending
                    ? 'ログイン準備中...'
                    : 'Google でログインして参加'}
                </span>
              </button>
            </Card>
          </section>
        )}

        {/* 5. Authenticated with Valid Token */}
        {token && !isUserLoading && !isUserError && user && (
          <section className="mt-[var(--spacing-xl)] space-y-[var(--spacing-md)]">
            {/* 5-A. Join Success View */}
            {joinedFamily ? (
              <Card
                data-testid="join-success-card"
                className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)] space-y-[var(--spacing-md)]"
              >
                <div className="flex items-center gap-[var(--spacing-sm)]">
                  <CheckCircle2
                    size={24}
                    className="text-[var(--member-green)] shrink-0"
                    aria-hidden="true"
                  />
                  <div>
                    <h2 className="text-base font-bold text-ink m-0">家族に参加しました！</h2>
                    <p
                      data-testid="joined-family-name"
                      className="text-sm font-medium text-ink mt-[var(--spacing-2xs)] m-0 break-words break-all [overflow-wrap:anywhere] min-w-0"
                    >
                      {joinedFamily.name}
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-semibold text-muted m-0 mb-[var(--spacing-xs)]">
                    家族メンバー
                  </h3>
                  <div
                    data-testid="family-members-list"
                    className="flex flex-wrap gap-[var(--spacing-sm)] pt-[var(--spacing-xs)]"
                  >
                    {joinedFamily.members.map((m) => (
                      <MemberDot key={m.id} name={m.name} color={getColorCssVar(m.color)} />
                    ))}
                  </div>
                </div>

                {/* Exact notification guide mandated by spec */}
                <div className="p-[var(--spacing-sm)] bg-chip rounded-[var(--radius-md)] border border-line">
                  <p
                    data-testid="notification-guide"
                    className="text-xs text-muted m-0 leading-relaxed"
                  >
                    Google から届く共有通知メールの『カレンダーを追加』を押すと、普段の Google
                    カレンダーにも表示されます
                  </p>
                </div>

                <Link
                  to="/"
                  data-testid="goto-home-link"
                  className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-accent text-surface rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus flex items-center justify-center gap-[var(--spacing-sm)] text-center box-border"
                >
                  ホームへ移動
                </Link>
              </Card>
            ) : (
              /* 5-B. Inspection & Explicit Confirmation */
              <>
                {inspectQuery.isLoading && (
                  <Card className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-lg)] text-center">
                    <RefreshCw
                      className="animate-spin text-accent mx-auto mb-[var(--spacing-xs)]"
                      size={24}
                      aria-hidden="true"
                    />
                    <p className="text-sm text-muted m-0">招待情報を確認中...</p>
                  </Card>
                )}

                {inspectQuery.isError &&
                  (() => {
                    const err = inspectQuery.error;
                    const isExpired =
                      err instanceof FamilyApiError
                        ? err.code === 'EXPIRED_INVITE' || err.status === 410
                        : (err as { code?: string; status?: number } | null)?.code ===
                            'EXPIRED_INVITE' ||
                          (err as { code?: string; status?: number } | null)?.status === 410;
                    return (
                      <div
                        data-testid="inspect-error-alert"
                        role="alert"
                        className="p-[var(--spacing-md)] bg-accent-tint text-accent rounded-[var(--radius-md)] text-xs flex items-start gap-[var(--spacing-sm)] border border-accent/20"
                      >
                        <AlertCircle
                          size={18}
                          className="shrink-0 mt-[var(--spacing-2xs)]"
                          aria-hidden="true"
                        />
                        <div>
                          <strong className="block font-semibold">
                            {isExpired ? '招待リンクの有効期限切れ' : '招待の確認に失敗しました'}
                          </strong>
                          <span data-testid={isExpired ? 'invite-error-expired' : undefined}>
                            {err.message || '招待情報の確認に失敗しました。'}
                          </span>
                        </div>
                      </div>
                    );
                  })()}

                {!inspectQuery.isError && inspectQuery.data && (
                  <Card className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)] space-y-[var(--spacing-md)]">
                    <div>
                      <h2 className="text-base font-semibold text-ink m-0 mb-[var(--spacing-xs)]">
                        家族への参加確認
                      </h2>
                      <p
                        data-testid="inspect-family-name"
                        className="text-base font-bold text-ink mt-[var(--spacing-xs)] mb-0 break-words break-all [overflow-wrap:anywhere] min-w-0"
                      >
                        {inspectQuery.data.familyName} に招待されています
                      </p>
                    </div>

                    {inspectQuery.data.alreadyMember && (
                      <div
                        data-testid="already-member-notice"
                        className="p-[var(--spacing-sm)] bg-chip rounded-[var(--radius-sm)] text-xs text-ink"
                      >
                        すでに家族に所属しています。別の家族には参加できません。
                      </div>
                    )}

                    {inspectQuery.data.status === 'used' && (
                      <div
                        data-testid="invite-error-used"
                        role="alert"
                        className="p-[var(--spacing-sm)] bg-accent-tint text-accent rounded-[var(--radius-sm)] text-xs"
                      >
                        この招待リンクは既に使用されています。
                      </div>
                    )}

                    {(inspectQuery.data.status === 'claiming' ||
                      inspectQuery.data.status === 'uncertain') && (
                      <div
                        data-testid="invite-status-notice"
                        className="p-[var(--spacing-sm)] bg-chip rounded-[var(--radius-sm)] text-xs text-ink space-y-[var(--spacing-2xs)]"
                      >
                        <p className="font-semibold text-accent m-0">参加処理が確認待ちです</p>
                        <p className="text-muted m-0 leading-relaxed">
                          参加処理が進行中または確認待ちです。オーナーにご確認いただくか、しばらく経ってから再度お試しください。
                        </p>
                      </div>
                    )}

                    {joinFamilyMutation.isError && (
                      <div
                        role="alert"
                        data-testid="join-family-error"
                        className="p-[var(--spacing-sm)] bg-accent-tint text-accent rounded-[var(--radius-sm)] text-xs flex items-center gap-[var(--spacing-xs)]"
                      >
                        <AlertCircle size={16} aria-hidden="true" className="shrink-0" />
                        <span>
                          {joinFamilyMutation.error.message || '家族への参加に失敗しました。'}
                        </span>
                      </div>
                    )}

                    {/* Confirmation Button */}
                    {!inspectQuery.data.alreadyMember &&
                      (inspectQuery.data.status === 'available' ? (
                        <button
                          type="button"
                          data-testid="join-family-button"
                          disabled={joinFamilyMutation.isPending}
                          onClick={handleJoin}
                          className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-accent text-surface rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus flex items-center justify-center gap-[var(--spacing-sm)] text-center box-border cursor-pointer"
                        >
                          <Users size={18} aria-hidden="true" />
                          <span>
                            {joinFamilyMutation.isPending ? '参加処理中...' : 'この家族に参加する'}
                          </span>
                        </button>
                      ) : inspectQuery.data.status === 'uncertain' ? (
                        <button
                          type="button"
                          data-testid="join-family-button"
                          disabled={joinFamilyMutation.isPending}
                          onClick={handleJoin}
                          className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-accent text-surface rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus flex items-center justify-center gap-[var(--spacing-sm)] text-center box-border cursor-pointer"
                        >
                          <span>
                            {joinFamilyMutation.isPending ? '確認中...' : '参加状態を確認する'}
                          </span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-testid="join-family-button"
                          disabled
                          className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-muted/40 text-muted rounded-[var(--radius-md)] text-sm font-medium cursor-not-allowed flex items-center justify-center gap-[var(--spacing-sm)] text-center box-border"
                        >
                          <span>
                            {inspectQuery.data.status === 'used'
                              ? '既に使用されています'
                              : '参加処理を確認中'}
                          </span>
                        </button>
                      ))}

                    {inspectQuery.data.alreadyMember && (
                      <Link
                        to="/"
                        className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-sm font-medium hover:bg-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus flex items-center justify-center gap-[var(--spacing-sm)] text-center box-border"
                      >
                        ホームへ移動
                      </Link>
                    )}
                  </Card>
                )}
              </>
            )}
          </section>
        )}
      </div>

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
