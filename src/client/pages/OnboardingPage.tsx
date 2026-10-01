import { Card } from '@client/components/Card';
import { MemberDot } from '@client/components/MemberDot';
import { SESSION_QUERY_KEY, useSessionQuery } from '@client/features/auth/useSession';
import {
  FAMILIES_QUERY_KEY,
  MEMBER_COLOR_OPTIONS,
  getColorCssVar,
  useCreateFamilyMutation,
  useFamiliesQuery,
  useIssueInviteMutation,
  useUpdateChildrenMutation,
} from '@client/features/onboarding/useFamily';
import type { MemberColor } from '@shared/schemas/family';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Copy,
  LogIn,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

interface ChildDraft {
  id: string;
  name: string;
  color: MemberColor;
}

export default function OnboardingPage(): React.ReactElement {
  const [searchParams] = useSearchParams();
  const aclParam = searchParams.get('acl');
  const errorParam = searchParams.get('error');

  const queryClient = useQueryClient();

  const {
    data: user,
    isLoading: isUserLoading,
    isError: isUserError,
    refetch: refetchUser,
  } = useSessionQuery();
  const {
    data: families,
    isLoading: isFamiliesLoading,
    isError: isFamiliesError,
    refetch: refetchFamilies,
  } = useFamiliesQuery(user?.id);

  const createFamilyMutation = useCreateFamilyMutation();
  const updateChildrenMutation = useUpdateChildrenMutation();
  const issueInviteMutation = useIssueInviteMutation();

  // Lifecycle generation and AbortController to prevent mutation completion races
  const generationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Local private state
  const [newFamilyName, setNewFamilyName] = useState('');
  const [children, setChildren] = useState<ChildDraft[]>([]);
  const [hasInitializedChildren, setHasInitializedChildren] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [saveChildrenSuccess, setSaveChildrenSuccess] = useState(false);
  const [childFormError, setChildFormError] = useState<string | null>(null);

  const handleAuthRevocation = useCallback(async () => {
    generationRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    createFamilyMutation.reset();
    updateChildrenMutation.reset();
    issueInviteMutation.reset();

    await queryClient.cancelQueries({ queryKey: SESSION_QUERY_KEY });
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
    await queryClient.cancelQueries({ queryKey: FAMILIES_QUERY_KEY });
    queryClient.setQueryData(FAMILIES_QUERY_KEY, []);

    setInviteUrl(null);
    setCopied(false);
    setCopyFailed(false);
    setSaveChildrenSuccess(false);
    setHasInitializedChildren(false);
    setNewFamilyName('');
    setChildren([]);
    setChildFormError(null);
  }, [
    queryClient,
    createFamilyMutation.reset,
    updateChildrenMutation.reset,
    issueInviteMutation.reset,
  ]);

  // Clear private data and abort in-flight requests on session change or auth error
  const userId = user?.id;
  const prevIdentityRef = useRef({ userId, isUserError });
  useEffect(() => {
    if (
      prevIdentityRef.current.userId !== userId ||
      prevIdentityRef.current.isUserError !== isUserError
    ) {
      prevIdentityRef.current = { userId, isUserError };
      generationRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = new AbortController();

      createFamilyMutation.reset();
      updateChildrenMutation.reset();
      issueInviteMutation.reset();

      setInviteUrl(null);
      setCopied(false);
      setCopyFailed(false);
      setSaveChildrenSuccess(false);
      setHasInitializedChildren(false);
      setChildFormError(null);
      setNewFamilyName('');
      setChildren([]);
    }
  }, [
    userId,
    isUserError,
    createFamilyMutation.reset,
    updateChildrenMutation.reset,
    issueInviteMutation.reset,
  ]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      abortControllerRef.current?.abort();
    };
  }, []);

  const family = families && families.length > 0 ? families[0] : null;

  // Initialize children state when ready family loads
  useEffect(() => {
    if (family && family.creationStatus === 'ready' && !hasInitializedChildren) {
      const childMembers: ChildDraft[] = family.members
        .filter((m) => m.kind === 'child')
        .map((m) => ({ id: m.id, name: m.name, color: m.color }));
      setChildren(childMembers);
      setHasInitializedChildren(true);
    }
  }, [family, hasInitializedChildren]);

  // Form submit for family creation
  const handleCreateFamily = async (e: React.FormEvent) => {
    e.preventDefault();
    const currentGen = generationRef.current;
    const currentUserId = user?.id;
    if (!currentUserId || !newFamilyName.trim()) return;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      await createFamilyMutation.mutateAsync({
        input: {
          name: newFamilyName.trim(),
          children: [],
        },
        signal: controller.signal,
      });
      if (
        generationRef.current !== currentGen ||
        user?.id !== currentUserId ||
        controller.signal.aborted
      ) {
        return;
      }
      setNewFamilyName('');
    } catch (err: unknown) {
      if (
        generationRef.current !== currentGen ||
        user?.id !== currentUserId ||
        controller.signal.aborted
      ) {
        return;
      }
      const errorObj = err as { status?: number; code?: string };
      if (errorObj?.status === 401 || errorObj?.code === 'UNAUTHORIZED') {
        await handleAuthRevocation();
      }
    }
  };

  // Add child
  const handleAddChild = () => {
    if (children.length >= 10) return;
    const defaultColor: MemberColor = children.length % 2 === 0 ? 'daughter' : 'son';
    const newDraft: ChildDraft = {
      id: crypto.randomUUID ? crypto.randomUUID() : `draft-${Date.now()}-${Math.random()}`,
      name: '',
      color: defaultColor,
    };
    setChildren((prev) => [...prev, newDraft]);
    setSaveChildrenSuccess(false);
    setChildFormError(null);
  };

  // Remove child
  const handleRemoveChild = (id: string) => {
    setChildren((prev) => prev.filter((c) => c.id !== id));
    setSaveChildrenSuccess(false);
    setChildFormError(null);
  };

  // Update child field
  const handleUpdateChild = (id: string, field: 'name' | 'color', value: string) => {
    setChildren((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
    setSaveChildrenSuccess(false);
    setChildFormError(null);
  };

  // Save children
  const handleSaveChildren = async () => {
    const currentGen = generationRef.current;
    const currentUserId = user?.id;
    if (!currentUserId || !family) return;

    for (const c of children) {
      if (!c.name.trim()) {
        setChildFormError('お子様のお名前を入力してください。');
        return;
      }
    }
    setChildFormError(null);

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      await updateChildrenMutation.mutateAsync({
        familyId: family.id,
        children: children.map((c) => ({ name: c.name.trim(), color: c.color })),
        signal: controller.signal,
      });
      if (
        generationRef.current !== currentGen ||
        user?.id !== currentUserId ||
        controller.signal.aborted
      ) {
        return;
      }
      setSaveChildrenSuccess(true);
    } catch (err: unknown) {
      if (
        generationRef.current !== currentGen ||
        user?.id !== currentUserId ||
        controller.signal.aborted
      ) {
        return;
      }
      const errorObj = err as { status?: number; code?: string };
      if (errorObj?.status === 401 || errorObj?.code === 'UNAUTHORIZED') {
        await handleAuthRevocation();
      }
    }
  };

  // Issue invite link
  const handleIssueInvite = async () => {
    const currentGen = generationRef.current;
    const currentUserId = user?.id;
    if (!currentUserId || !family) return;

    setInviteUrl(null);
    setCopied(false);
    setCopyFailed(false);

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await issueInviteMutation.mutateAsync({
        familyId: family.id,
        signal: controller.signal,
      });
      if (
        generationRef.current !== currentGen ||
        user?.id !== currentUserId ||
        controller.signal.aborted
      ) {
        return;
      }

      if (res.authorizationRequired) {
        window.location.assign(res.authorizationUrl);
      } else {
        setInviteUrl(res.inviteUrl);
      }
    } catch (err: unknown) {
      if (
        generationRef.current !== currentGen ||
        user?.id !== currentUserId ||
        controller.signal.aborted
      ) {
        return;
      }
      const errorObj = err as { status?: number; code?: string };
      if (errorObj?.status === 401 || errorObj?.code === 'UNAUTHORIZED') {
        await handleAuthRevocation();
      }
    }
  };

  // Copy invite link
  const handleCopyInvite = async () => {
    if (!inviteUrl) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteUrl);
        setCopied(true);
        setCopyFailed(false);
        return;
      }
      throw new Error('Clipboard API unavailable');
    } catch {
      // Fallback for environments where clipboard writeText throws
      try {
        const input = document.getElementById('invite-url') as HTMLInputElement | null;
        if (input) {
          input.select();
          const ok = document.execCommand('copy');
          if (ok) {
            setCopied(true);
            setCopyFailed(false);
            return;
          }
        }
      } catch {
        // Fallback failed
      }
      setCopyFailed(true);
      setCopied(false);
    }
  };

  const isAuthenticated = !isUserLoading && !isUserError && !!user;
  const isFamiliesReady = isAuthenticated && !isFamiliesLoading && !isFamiliesError;

  return (
    <main
      data-testid="onboarding-screen"
      className="max-w-[390px] mx-auto min-h-screen px-[var(--spacing-md)] py-[var(--spacing-lg)] bg-bg text-ink box-border flex flex-col justify-between"
    >
      <div className="min-w-0">
        <header className="border-b border-line pb-[var(--spacing-md)] flex items-center justify-between">
          <div className="min-w-0 pr-[var(--spacing-sm)]">
            <h1 className="text-xl font-bold m-0 text-ink break-words">家族の設定</h1>
            <p className="text-xs text-muted mt-[var(--spacing-xs)] mb-0">
              家族カレンダーの作成と共有メンバーの管理
            </p>
          </div>
          <Link
            to="/"
            data-testid="back-to-home"
            className="inline-flex items-center justify-center min-w-[var(--tap-target-min)] min-h-[var(--tap-target-min)] text-muted hover:text-ink transition-colors rounded-[var(--radius-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus shrink-0"
            aria-label="ホームへ戻る"
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </Link>
        </header>

        {/* ACL consent return notice */}
        {aclParam === 'granted' && (
          <output
            data-testid="acl-granted-message"
            className="block mt-[var(--spacing-md)] p-[var(--spacing-md)] bg-chip text-ink rounded-[var(--radius-md)] text-xs border border-line"
          >
            <div className="flex items-start gap-[var(--spacing-sm)]">
              <Check
                size={18}
                className="text-[var(--member-mama)] shrink-0 mt-[var(--spacing-2xs)]"
                aria-hidden="true"
              />
              <div>
                <strong className="block font-semibold">
                  Google カレンダー共有権限が承認されました
                </strong>
                <span>『招待リンクを発行する』ボタンを押して招待リンクを発行してください。</span>
              </div>
            </div>
          </output>
        )}

        {(errorParam === 'acl_denied' || errorParam === 'acl_failed') && (
          <div
            data-testid="acl-error-message"
            role="alert"
            className="mt-[var(--spacing-md)] p-[var(--spacing-md)] bg-accent-tint text-accent rounded-[var(--radius-md)] text-xs flex items-start gap-[var(--spacing-sm)] border border-accent/20"
          >
            <AlertCircle
              size={18}
              className="shrink-0 mt-[var(--spacing-2xs)]"
              aria-hidden="true"
            />
            <div>
              <strong className="block font-semibold">共有権限の追加がキャンセルされました</strong>
              <span>
                Google
                カレンダー共有権限の追加がキャンセルまたは失敗しました。招待リンクを発行するには共有管理権限の許可が必要です。
              </span>
            </div>
          </div>
        )}

        {/* 1. Loading State */}
        {(isUserLoading || (isAuthenticated && isFamiliesLoading)) && (
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

        {/* 2. Error State */}
        {!isUserLoading && (isUserError || (isAuthenticated && isFamiliesError)) && (
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
                  家族情報の取得に失敗しました。しばらく経ってから再度お試しください。
                </p>
              </div>
            </div>
            <button
              type="button"
              data-testid="retry-button"
              onClick={() => {
                refetchUser();
                refetchFamilies();
              }}
              className="w-full mt-[var(--spacing-sm)] min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-sm font-medium hover:bg-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus cursor-pointer"
            >
              再試行
            </button>
          </section>
        )}

        {/* 3. Anonymous (Unauthenticated) State */}
        {!isUserLoading && !isUserError && !user && (
          <section className="mt-[var(--spacing-xl)]">
            <Card className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)]">
              <h2 className="text-base font-semibold text-ink m-0 mb-[var(--spacing-xs)]">
                ログインが必要です
              </h2>
              <p className="text-xs text-muted mb-[var(--spacing-md)] leading-relaxed">
                家族カレンダーを作成・管理するには、Google アカウントでログインしてください。
              </p>
              <button
                type="button"
                data-testid="login-button"
                onClick={() => window.location.assign('/api/auth/login')}
                className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-accent text-surface rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus flex items-center justify-center gap-[var(--spacing-sm)] text-center box-border cursor-pointer"
              >
                <LogIn size={18} aria-hidden="true" />
                <span>Google でログイン</span>
              </button>
            </Card>
          </section>
        )}

        {/* 4. Authenticated: No Family yet -> Create Form */}
        {isFamiliesReady && !family && (
          <section className="mt-[var(--spacing-xl)]">
            <Card className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)]">
              <h2 className="text-base font-semibold text-ink m-0 mb-[var(--spacing-xs)]">
                新しい家族カレンダーの作成
              </h2>
              <p className="text-xs text-muted mb-[var(--spacing-md)] leading-relaxed">
                家族共有の Google カレンダーを作成し、家族の予定を管理します。
              </p>

              <form onSubmit={handleCreateFamily} className="space-y-[var(--spacing-md)]">
                <div>
                  <label
                    htmlFor="family-name"
                    className="block text-xs font-semibold text-ink mb-[var(--spacing-xs)]"
                  >
                    家族名（最大80文字）
                  </label>
                  <input
                    id="family-name"
                    data-testid="family-name-input"
                    type="text"
                    maxLength={80}
                    value={newFamilyName}
                    onChange={(e) => setNewFamilyName(e.target.value)}
                    placeholder="例: たなか家"
                    required
                    className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-xs)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus box-border"
                  />
                </div>

                {createFamilyMutation.isError && (
                  <div
                    role="alert"
                    data-testid="create-family-error"
                    className="p-[var(--spacing-sm)] bg-accent-tint text-accent rounded-[var(--radius-sm)] text-xs flex items-center gap-[var(--spacing-xs)]"
                  >
                    <AlertCircle size={16} aria-hidden="true" className="shrink-0" />
                    <span>
                      {createFamilyMutation.error.message || '家族カレンダーの作成に失敗しました。'}
                    </span>
                  </div>
                )}

                <button
                  type="submit"
                  data-testid="create-family-button"
                  disabled={createFamilyMutation.isPending || !newFamilyName.trim()}
                  className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-accent text-surface rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus flex items-center justify-center gap-[var(--spacing-sm)] text-center box-border cursor-pointer"
                >
                  <Users size={18} aria-hidden="true" />
                  <span>{createFamilyMutation.isPending ? '作成中...' : '家族を作成する'}</span>
                </button>
              </form>
            </Card>
          </section>
        )}

        {/* 5. Authenticated: Family exists */}
        {isFamiliesReady && family && (
          <div className="mt-[var(--spacing-xl)] space-y-[var(--spacing-lg)]">
            {/* Status Check (creating / uncertain / failed) */}
            {family.creationStatus === 'creating' && (
              <output
                data-testid="family-status-notice"
                className="block p-[var(--spacing-md)] bg-chip text-ink rounded-[var(--radius-md)] text-xs border border-line space-y-[var(--spacing-sm)]"
              >
                <div className="flex items-center gap-[var(--spacing-xs)] font-semibold">
                  <RefreshCw className="animate-spin text-accent" size={16} aria-hidden="true" />
                  <span>カレンダーを作成中です</span>
                </div>
                <p className="m-0 leading-relaxed text-muted">
                  Google カレンダーを作成中です。Google
                  側の反映をお待ちください。重複作成を防ぐため、しばらく待ってから再読み込みしてください。
                </p>
                <button
                  type="button"
                  onClick={() => refetchFamilies()}
                  className="min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-xs)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-xs font-medium hover:bg-chip cursor-pointer"
                >
                  状態を再確認
                </button>
              </output>
            )}

            {family.creationStatus === 'uncertain' && (
              <output
                data-testid="family-status-notice"
                className="block p-[var(--spacing-md)] bg-chip text-ink rounded-[var(--radius-md)] text-xs border border-line space-y-[var(--spacing-sm)]"
              >
                <div className="flex items-center gap-[var(--spacing-xs)] font-semibold text-accent">
                  <AlertCircle size={16} aria-hidden="true" />
                  <span>作成状態を確認中です</span>
                </div>
                <p className="m-0 leading-relaxed text-muted">
                  処理結果を確認できませんでした。二重作成を防ぐため再試行は行わず、Google
                  カレンダーで同名カレンダーの有無を確認し手動で整理してください。
                </p>
                <button
                  type="button"
                  onClick={() => refetchFamilies()}
                  className="min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-xs)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-xs font-medium hover:bg-chip cursor-pointer"
                >
                  状態を再確認
                </button>
              </output>
            )}

            {family.creationStatus === 'failed' && (
              <div
                data-testid="family-status-notice"
                role="alert"
                className="p-[var(--spacing-md)] bg-accent-tint text-accent rounded-[var(--radius-md)] text-xs border border-accent/20 space-y-[var(--spacing-sm)]"
              >
                <div className="flex items-center gap-[var(--spacing-xs)] font-semibold">
                  <AlertCircle size={16} aria-hidden="true" />
                  <span>家族カレンダーの作成に失敗しました</span>
                </div>
                <p className="m-0 leading-relaxed">
                  Google カレンダーの作成に失敗しました。時間をおいて再試行してください。
                </p>
              </div>
            )}

            {/* Ready state */}
            {family.creationStatus === 'ready' && (
              <>
                {/* Family Info Card */}
                <Card className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)]">
                  <div className="flex items-center justify-between mb-[var(--spacing-xs)] min-w-0">
                    <h2
                      data-testid="family-name"
                      className="text-base font-bold text-ink m-0 break-words break-all [overflow-wrap:anywhere] min-w-0 pr-[var(--spacing-sm)]"
                    >
                      {family.name}
                    </h2>
                    <span
                      data-testid="family-status"
                      className="px-[var(--spacing-sm)] py-[var(--spacing-2xs)] bg-chip text-muted text-xs rounded-[var(--radius-sm)] font-medium shrink-0"
                    >
                      準備完了
                    </span>
                  </div>

                  <div className="mt-[var(--spacing-md)]">
                    <h3 className="text-xs font-semibold text-muted m-0 mb-[var(--spacing-xs)]">
                      現在のメンバー
                    </h3>
                    <div
                      data-testid="member-legend"
                      className="flex flex-wrap gap-[var(--spacing-sm)] pt-[var(--spacing-xs)]"
                    >
                      {family.members.map((m) => (
                        <MemberDot
                          key={m.id}
                          name={m.name}
                          color={getColorCssVar(m.color)}
                          className="break-words break-all [overflow-wrap:anywhere]"
                        />
                      ))}
                    </div>
                  </div>
                </Card>

                {/* Child Editor Card - ONLY SHOWN TO OWNER */}
                {family.ownerUserId === user.id && (
                  <Card className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)] space-y-[var(--spacing-md)]">
                    <div>
                      <h3 className="text-sm font-semibold text-ink m-0 mb-[var(--spacing-xs)]">
                        子どもの登録
                      </h3>
                      <p className="text-xs text-muted m-0 leading-relaxed">
                        Google
                        アカウントを持たないお子様を登録できます（最大10人）。未登録（0人）のままでも進めます。
                      </p>
                    </div>

                    {children.length > 0 && (
                      <div className="space-y-[var(--spacing-sm)]">
                        {children.map((child, index) => (
                          <div
                            key={child.id}
                            className="p-[var(--spacing-sm)] border border-line rounded-[var(--radius-md)] bg-bg/50 space-y-[var(--spacing-xs)]"
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-muted">
                                子ども {index + 1}
                              </span>
                              <button
                                type="button"
                                data-testid={`remove-child-${index}`}
                                aria-label={`子ども ${index + 1} を削除`}
                                onClick={() => handleRemoveChild(child.id)}
                                className="min-w-[var(--tap-target-min)] min-h-[var(--tap-target-min)] p-[var(--spacing-xs)] text-muted hover:text-accent rounded-[var(--radius-sm)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus inline-flex items-center justify-center cursor-pointer"
                              >
                                <Trash2 size={16} aria-hidden="true" />
                              </button>
                            </div>

                            <div className="space-y-[var(--spacing-xs)]">
                              <div>
                                <label
                                  htmlFor={`child-name-${child.id}`}
                                  className="block text-xs text-muted mb-[var(--spacing-2xs)]"
                                >
                                  お名前
                                </label>
                                <input
                                  id={`child-name-${child.id}`}
                                  data-testid={`child-name-${index}`}
                                  type="text"
                                  maxLength={80}
                                  value={child.name}
                                  onChange={(e) =>
                                    handleUpdateChild(child.id, 'name', e.target.value)
                                  }
                                  placeholder="例: はな"
                                  className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-xs)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus box-border"
                                />
                              </div>

                              <div>
                                <label
                                  htmlFor={`child-color-${child.id}`}
                                  className="block text-xs text-muted mb-[var(--spacing-2xs)]"
                                >
                                  表示色
                                </label>
                                <select
                                  id={`child-color-${child.id}`}
                                  data-testid={`child-color-${index}`}
                                  value={child.color}
                                  onChange={(e) =>
                                    handleUpdateChild(
                                      child.id,
                                      'color',
                                      e.target.value as MemberColor,
                                    )
                                  }
                                  className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-xs)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus box-border"
                                >
                                  {MEMBER_COLOR_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                      {opt.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex flex-col gap-[var(--spacing-sm)]">
                      <button
                        type="button"
                        data-testid="add-child-button"
                        disabled={children.length >= 10}
                        onClick={handleAddChild}
                        className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-sm font-medium hover:bg-chip disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus inline-flex items-center justify-center gap-[var(--spacing-xs)] cursor-pointer"
                      >
                        <Plus size={18} aria-hidden="true" />
                        <span>子どもを追加（最大10人）</span>
                      </button>

                      {childFormError && (
                        <p
                          role="alert"
                          data-testid="child-form-error"
                          className="text-xs text-accent m-0 font-medium text-center"
                        >
                          {childFormError}
                        </p>
                      )}

                      {saveChildrenSuccess && (
                        <p
                          data-testid="save-children-success"
                          className="text-xs text-[var(--member-mama)] m-0 font-medium text-center"
                        >
                          子ども情報を保存しました
                        </p>
                      )}

                      {updateChildrenMutation.isError && (
                        <p role="alert" className="text-xs text-accent m-0 font-medium text-center">
                          {updateChildrenMutation.error.message || '保存に失敗しました。'}
                        </p>
                      )}

                      <button
                        type="button"
                        data-testid="save-children-button"
                        disabled={updateChildrenMutation.isPending}
                        onClick={handleSaveChildren}
                        className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-accent text-surface rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus flex items-center justify-center gap-[var(--spacing-sm)] cursor-pointer"
                      >
                        <span>
                          {updateChildrenMutation.isPending ? '保存中...' : '子ども情報を保存する'}
                        </span>
                      </button>
                    </div>
                  </Card>
                )}

                {/* Invite Section */}
                <Card className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)] space-y-[var(--spacing-md)]">
                  <h3 className="text-sm font-semibold text-ink m-0">大人のメンバーを招待</h3>

                  {family.ownerUserId === user.id ? (
                    <div className="space-y-[var(--spacing-md)]" data-testid="owner-invite-section">
                      <p className="text-xs text-muted m-0 leading-relaxed">
                        他の大人のメンバーを招待するには、Google
                        カレンダーの共有管理権限が必要です。
                      </p>

                      <button
                        type="button"
                        data-testid="issue-invite-button"
                        disabled={issueInviteMutation.isPending}
                        onClick={handleIssueInvite}
                        className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-accent text-surface rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus flex items-center justify-center gap-[var(--spacing-sm)] cursor-pointer"
                      >
                        <span>
                          {issueInviteMutation.isPending ? '発行中...' : '招待リンクを発行する'}
                        </span>
                      </button>

                      {issueInviteMutation.isError && (
                        <p
                          role="alert"
                          data-testid="issue-invite-error"
                          className="text-xs text-accent m-0 font-medium"
                        >
                          {issueInviteMutation.error.message || '招待リンクの発行に失敗しました。'}
                        </p>
                      )}

                      {inviteUrl && (
                        <div
                          data-testid="invite-url-container"
                          className="p-[var(--spacing-sm)] border border-line rounded-[var(--radius-md)] bg-bg/50 space-y-[var(--spacing-xs)]"
                        >
                          <label
                            htmlFor="invite-url"
                            className="block text-xs font-semibold text-ink"
                          >
                            発行された招待リンク
                          </label>
                          <input
                            id="invite-url"
                            data-testid="invite-url-input"
                            type="text"
                            readOnly
                            value={inviteUrl}
                            className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-xs)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus box-border"
                          />

                          <button
                            type="button"
                            data-testid="copy-invite-button"
                            onClick={handleCopyInvite}
                            className="w-full min-h-[var(--tap-target-min)] px-[var(--spacing-md)] py-[var(--spacing-sm)] bg-surface text-ink border border-line rounded-[var(--radius-md)] text-sm font-medium hover:bg-chip transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus inline-flex items-center justify-center gap-[var(--spacing-xs)] cursor-pointer"
                          >
                            <Copy size={16} aria-hidden="true" />
                            <span>リンクをコピー</span>
                          </button>

                          {copied && (
                            <p
                              data-testid="copy-status"
                              className="text-xs text-[var(--member-mama)] m-0 font-medium text-center"
                            >
                              リンクをコピーしました
                            </p>
                          )}

                          {copyFailed && (
                            <p className="text-xs text-muted m-0 text-center leading-relaxed">
                              お使いの環境では自動コピーができません。上の枠から手動でコピーしてください。
                            </p>
                          )}

                          <p
                            data-testid="invite-expiry-text"
                            className="text-xs text-muted m-0 text-center"
                          >
                            招待リンクは7日間有効です
                          </p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div
                      data-testid="non-owner-notice"
                      className="p-[var(--spacing-sm)] bg-chip rounded-[var(--radius-sm)] text-xs text-muted"
                    >
                      招待リンクの発行は家族カレンダーの作成者（オーナー）のみ行えます。
                    </div>
                  )}
                </Card>
              </>
            )}
          </div>
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
