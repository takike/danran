import { FamilyApiError } from '@client/api/family';
import {
  ImportApiError,
  deleteImport,
  fetchImportAttachment,
  fetchImports,
  uploadImport,
} from '@client/api/imports';
import { AuthenticatedShell } from '@client/components/AuthenticatedShell';
import { OAuthNotices } from '@client/components/OAuthNotices';
import { useLogoutMutation, useSessionQuery } from '@client/features/auth/useSession';
import { ImageResizeError, resizeImageFile } from '@client/features/import/resizeImage';
import { useFamiliesQuery } from '@client/features/onboarding/useFamily';
import { useReloadProtection } from '@client/features/pwa/useReloadProtection';
import type { ImportJob } from '@shared/schemas/imports';
import { toTokyoIsoString } from '@shared/time/date';
import { formatTokyoDateTimeSeconds } from '@shared/time/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, RefreshCw, Trash2, Upload } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

const IMPORTS_QUERY_KEY = ['imports'] as const;
const EMPTY_IMPORTS: ImportJob[] = [];
const buttonClass =
  'inline-flex min-h-[var(--tap-target-min)] items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] px-[var(--spacing-md)] text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50';

interface Draft {
  requestId: string;
  previewUrl: string;
  blob?: Blob;
  width?: number;
  height?: number;
  status: 'converting' | 'ready' | 'uploading' | 'error';
  error?: string;
}

function fixedUploadError(error: unknown): string {
  if (error instanceof ImageResizeError) {
    return error.kind === 'too-large'
      ? '写真のサイズを小さくできませんでした。別の写真を選んでください。'
      : '画像を読み込めませんでした。別の写真を選んでください。';
  }
  if (error instanceof ImportApiError) return error.message;
  return '写真を保存できませんでした。時間をおいてもう一度お試しください。';
}

function fixedDeleteError(error: unknown): string {
  if (error instanceof ImportApiError && error.code && error.code !== 'INTERNAL_ERROR') {
    return error.message;
  }
  return '写真を削除できませんでした。時間をおいてもう一度お試しください。';
}

function PageFrame({ children }: { children: React.ReactNode }): React.ReactElement {
  const navigate = useNavigate();
  return (
    <AuthenticatedShell onCapture={() => navigate('/import')} mainTestId="import-screen">
      <OAuthNotices />
      {children}
    </AuthenticatedShell>
  );
}

function LoginPrompt({ retry }: { retry?: () => void }): React.ReactElement {
  const [navigating, setNavigating] = useState(false);
  return (
    <main className="mx-auto min-h-screen w-full max-w-[var(--app-max-width)] bg-bg px-[var(--spacing-md)] py-[var(--spacing-lg)] text-ink">
      <OAuthNotices />
      <h1 className="m-0 text-2xl font-bold">プリントを取り込む</h1>
      <p className="mt-[var(--spacing-md)] text-sm text-muted">
        続けるには Google でログインしてください。
      </p>
      {retry ? (
        <button
          type="button"
          onClick={retry}
          className={`${buttonClass} mt-[var(--spacing-sm)] w-full border border-line`}
        >
          再試行
        </button>
      ) : (
        <button
          type="button"
          disabled={navigating}
          onClick={() => {
            setNavigating(true);
            window.location.assign('/api/auth/login');
          }}
          className={`${buttonClass} mt-[var(--spacing-sm)] w-full bg-accent text-surface`}
        >
          {navigating ? '移動しています…' : 'Google でログイン'}
        </button>
      )}
    </main>
  );
}

function ImportWorkspace({
  userId,
  familyId,
}: { userId: string; familyId: string }): React.ReactElement {
  const queryClient = useQueryClient();
  const logoutMutation = useLogoutMutation();
  const identity = `${userId}:${familyId}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const mountedRef = useRef(false);
  const operationGenerationRef = useRef(0);
  const operationControllerRef = useRef<AbortController | null>(null);
  const uploadLockedRef = useRef(false);
  const objectUrlsRef = useRef(new Map<string, string>());
  const uploadPreviewUrlsRef = useRef(new Set<string>());
  const currentDraftUrlRef = useRef<string | null>(null);
  const fileCameraRef = useRef<HTMLInputElement>(null);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const deleteControllerRef = useRef<AbortController | null>(null);
  const deletingIdsRef = useRef(new Set<string>());
  const viewerCloseRef = useRef<HTMLButtonElement>(null);
  const viewerDialogRef = useRef<HTMLDialogElement>(null);
  const viewerReturnFocusRef = useRef<HTMLElement | null>(null);
  const viewerWasOpenRef = useRef(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [uploading, setUploading] = useState(false);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [viewedImportId, setViewedImportId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [privateAccessRevoked, setPrivateAccessRevoked] = useState(false);
  const privateAccessRevokedRef = useRef(false);

  const importsQuery = useQuery({
    queryKey: [...IMPORTS_QUERY_KEY, userId, familyId] as const,
    queryFn: ({ signal }) => fetchImports(familyId, signal),
    enabled: !privateAccessRevoked,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
  });
  const jobs = importsQuery.data ?? EMPTY_IMPORTS;
  const importErrorCode =
    importsQuery.error instanceof ImportApiError
      ? (importsQuery.error.code ??
        (importsQuery.error.status === 401
          ? 'UNAUTHORIZED'
          : importsQuery.error.status === 403
            ? 'FORBIDDEN'
            : importsQuery.error.status === 404
              ? 'NOT_FOUND'
              : undefined))
      : undefined;
  const importAccessLost = ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'FAMILY_NOT_READY'].includes(
    importErrorCode ?? '',
  );
  const visibleJobs = importAccessLost || privateAccessRevoked ? EMPTY_IMPORTS : jobs;
  const photoActionsDisabled = importAccessLost || privateAccessRevoked;
  const photoActionsDisabledRef = useRef(photoActionsDisabled);
  photoActionsDisabledRef.current = photoActionsDisabled;
  const viewedJob = visibleJobs.find((job) => job.id === viewedImportId);

  useReloadProtection(Boolean(draft), uploading);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationGenerationRef.current += 1;
      operationControllerRef.current?.abort();
      deleteControllerRef.current?.abort();
      for (const url of objectUrlsRef.current.values()) URL.revokeObjectURL(url);
      for (const url of uploadPreviewUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
      uploadPreviewUrlsRef.current.clear();
      currentDraftUrlRef.current = null;
    };
  }, []);

  const handleAccessError = useCallback(
    (error: unknown) => {
      if (!(error instanceof ImportApiError)) return false;
      const code =
        error.code ??
        (error.status === 401
          ? 'UNAUTHORIZED'
          : error.status === 403
            ? 'FORBIDDEN'
            : error.status === 404
              ? 'NOT_FOUND'
              : undefined);
      if (!['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'FAMILY_NOT_READY'].includes(code ?? '')) {
        return false;
      }
      if (privateAccessRevokedRef.current) return true;
      if (!mountedRef.current) return true;
      privateAccessRevokedRef.current = true;
      operationGenerationRef.current += 1;
      operationControllerRef.current?.abort();
      deleteControllerRef.current?.abort();
      for (const url of objectUrlsRef.current.values()) URL.revokeObjectURL(url);
      for (const url of uploadPreviewUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
      uploadPreviewUrlsRef.current.clear();
      currentDraftUrlRef.current = null;
      deletingIdsRef.current.clear();
      setPhotoUrls({});
      setDraft(null);
      setViewedImportId(null);
      setConfirmingDeleteId(null);
      setDeleteErrors({});
      setPrivateAccessRevoked(true);
      uploadLockedRef.current = false;
      setUploading(false);
      void queryClient.invalidateQueries({ queryKey: ['families', userId] });
      void (async () => {
        const key = [...IMPORTS_QUERY_KEY, userId, familyId] as const;
        await queryClient.cancelQueries({ queryKey: key });
        queryClient.removeQueries({ queryKey: key });
      })();
      if (code === 'UNAUTHORIZED') {
        void logoutMutation.mutateAsync().catch(() => undefined);
      }
      return true;
    },
    [familyId, logoutMutation.mutateAsync, queryClient, userId],
  );

  useEffect(() => {
    if (importAccessLost) return;
    const liveIds = new Set(visibleJobs.map((job) => job.id));
    for (const [jobId, url] of objectUrlsRef.current) {
      if (!liveIds.has(jobId)) {
        URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(jobId);
      }
    }
    setPhotoUrls((current) => {
      const next: Record<string, string> = {};
      for (const [jobId, url] of Object.entries(current)) {
        if (liveIds.has(jobId)) next[jobId] = url;
      }
      return next;
    });

    const controller = new AbortController();
    let cancelled = false;
    void Promise.all(
      visibleJobs.map(async (job) => {
        if (objectUrlsRef.current.has(job.id)) return;
        try {
          const blob = await fetchImportAttachment(familyId, job.attachment.id, controller.signal);
          if (
            cancelled ||
            controller.signal.aborted ||
            !mountedRef.current ||
            identityRef.current !== identity
          )
            return;
          const url = URL.createObjectURL(blob);
          objectUrlsRef.current.set(job.id, url);
          setPhotoUrls((current) => ({ ...current, [job.id]: url }));
        } catch (error: unknown) {
          if (
            cancelled ||
            controller.signal.aborted ||
            !mountedRef.current ||
            identityRef.current !== identity
          )
            return;
          handleAccessError(error);
          // A later list refresh retries failed thumbnail requests.
        }
      }),
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [familyId, handleAccessError, identity, importAccessLost, visibleJobs]);

  useEffect(() => {
    if (viewedImportId && viewedJob && photoUrls[viewedJob.id]) {
      if (viewerDialogRef.current && !viewerDialogRef.current.open) {
        viewerDialogRef.current.showModal();
      }
      viewerWasOpenRef.current = true;
      viewerCloseRef.current?.focus();
    } else if (viewerWasOpenRef.current) {
      if (viewerDialogRef.current?.open) viewerDialogRef.current.close();
      viewerWasOpenRef.current = false;
      viewerReturnFocusRef.current?.focus();
      viewerReturnFocusRef.current = null;
    }
  }, [photoUrls, viewedImportId, viewedJob]);

  const sendDraft = useCallback(
    async (activeDraft: Draft, generation: number) => {
      if (
        !activeDraft.blob ||
        uploadLockedRef.current ||
        privateAccessRevokedRef.current ||
        photoActionsDisabledRef.current ||
        activeDraft.status === 'converting'
      )
        return;
      uploadLockedRef.current = true;
      setUploading(true);
      setDraft({ ...activeDraft, status: 'uploading', error: undefined });
      const controller = new AbortController();
      operationControllerRef.current?.abort();
      operationControllerRef.current = controller;
      try {
        await uploadImport(familyId, activeDraft.blob, activeDraft.requestId, controller.signal);
        if (
          !mountedRef.current ||
          generation !== operationGenerationRef.current ||
          identityRef.current !== identity
        )
          return;
        setDraft(null);
        URL.revokeObjectURL(activeDraft.previewUrl);
        uploadPreviewUrlsRef.current.delete(activeDraft.previewUrl);
        currentDraftUrlRef.current = null;
        void queryClient.invalidateQueries({ queryKey: [...IMPORTS_QUERY_KEY, userId, familyId] });
      } catch (error: unknown) {
        if (
          controller.signal.aborted ||
          !mountedRef.current ||
          generation !== operationGenerationRef.current ||
          identityRef.current !== identity
        )
          return;
        const accessLost = handleAccessError(error);
        if (accessLost) return;
        setDraft({ ...activeDraft, status: 'error', error: fixedUploadError(error) });
      } finally {
        if (generation === operationGenerationRef.current && identityRef.current === identity) {
          uploadLockedRef.current = false;
          setUploading(false);
        }
      }
    },
    [familyId, handleAccessError, identity, queryClient, userId],
  );

  const setSelectedFile = useCallback(
    (file: File | undefined) => {
      if (
        !file ||
        uploadLockedRef.current ||
        privateAccessRevokedRef.current ||
        photoActionsDisabledRef.current
      )
        return;
      const generation = ++operationGenerationRef.current;
      operationControllerRef.current?.abort();
      operationControllerRef.current = new AbortController();
      if (currentDraftUrlRef.current) {
        URL.revokeObjectURL(currentDraftUrlRef.current);
        uploadPreviewUrlsRef.current.delete(currentDraftUrlRef.current);
        currentDraftUrlRef.current = null;
      }
      setDraft(null);

      let rawPreviewUrl: string;
      try {
        rawPreviewUrl = URL.createObjectURL(file);
        uploadPreviewUrlsRef.current.add(rawPreviewUrl);
        currentDraftUrlRef.current = rawPreviewUrl;
      } catch {
        setDraft({
          requestId: crypto.randomUUID(),
          previewUrl: '',
          status: 'error',
          error: '写真を準備できませんでした。別の写真を選んでください。',
        });
        return;
      }
      const requestId = crypto.randomUUID();
      setDraft({ requestId, previewUrl: rawPreviewUrl, status: 'converting' });
      void resizeImageFile(file).then(
        ({ blob, width, height }) => {
          if (
            !mountedRef.current ||
            generation !== operationGenerationRef.current ||
            identityRef.current !== identity
          )
            return;
          let previewUrl: string;
          try {
            previewUrl = URL.createObjectURL(blob);
          } catch {
            setDraft((current) =>
              current?.requestId === requestId
                ? {
                    ...current,
                    status: 'error',
                    error: '写真を準備できませんでした。別の写真を選んでください。',
                  }
                : current,
            );
            return;
          }
          uploadPreviewUrlsRef.current.add(previewUrl);
          URL.revokeObjectURL(rawPreviewUrl);
          uploadPreviewUrlsRef.current.delete(rawPreviewUrl);
          currentDraftUrlRef.current = previewUrl;
          const completedDraft: Draft = {
            requestId,
            previewUrl,
            blob,
            width,
            height,
            status: 'ready',
          };
          setDraft(completedDraft);
          void sendDraft(completedDraft, generation);
        },
        (error: unknown) => {
          if (
            !mountedRef.current ||
            generation !== operationGenerationRef.current ||
            identityRef.current !== identity
          )
            return;
          setDraft((current) =>
            current?.requestId === requestId
              ? { ...current, status: 'error', error: fixedUploadError(error) }
              : current,
          );
        },
      );
    },
    [identity, sendDraft],
  );

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    setSelectedFile(file);
  };

  const confirmDelete = async (job: ImportJob) => {
    if (
      deletingIdsRef.current.has(job.id) ||
      privateAccessRevokedRef.current ||
      photoActionsDisabledRef.current
    )
      return;
    deletingIdsRef.current.add(job.id);
    const controller = new AbortController();
    deleteControllerRef.current?.abort();
    deleteControllerRef.current = controller;
    setDeletingIds((current) => new Set(current).add(job.id));
    setDeleteErrors((current) => ({ ...current, [job.id]: '' }));
    try {
      await deleteImport(familyId, job.id, controller.signal);
      if (!mountedRef.current || identityRef.current !== identity) return;
      setConfirmingDeleteId(null);
      if (viewedImportId === job.id) setViewedImportId(null);
      void queryClient.invalidateQueries({ queryKey: [...IMPORTS_QUERY_KEY, userId, familyId] });
    } catch (error: unknown) {
      if (!controller.signal.aborted && mountedRef.current && identityRef.current === identity) {
        const accessLost = handleAccessError(error);
        if (!accessLost) {
          setDeleteErrors((current) => ({ ...current, [job.id]: fixedDeleteError(error) }));
        }
      }
    } finally {
      deletingIdsRef.current.delete(job.id);
      if (mountedRef.current && identityRef.current === identity) {
        setDeletingIds((current) => {
          const next = new Set(current);
          next.delete(job.id);
          return next;
        });
      }
    }
  };

  useEffect(() => {
    if (importsQuery.error) handleAccessError(importsQuery.error);
  }, [handleAccessError, importsQuery.error]);

  const beginViewer = (jobId: string) => {
    viewerReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setViewedImportId(jobId);
  };

  return (
    <PageFrame>
      <header className="mb-[var(--spacing-lg)]">
        <h1 className="m-0 text-2xl font-bold">プリントを取り込む</h1>
        <p className="mt-[var(--spacing-sm)] mb-0 text-sm leading-relaxed text-muted">
          撮った写真は、家族の大人だけが見られます。読み取りは、次の更新で使えるようになります。
        </p>
      </header>

      <section
        aria-label="写真を選ぶ"
        className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]"
      >
        <input
          ref={fileCameraRef}
          id="import-camera-file"
          data-testid="import-camera-input"
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={onFileChange}
          disabled={uploading || draft?.status === 'converting' || photoActionsDisabled}
        />
        <label htmlFor="import-camera-file" className="sr-only">
          プリントを撮影
        </label>
        <input
          ref={filePickerRef}
          id="import-picker-file"
          data-testid="import-picker-input"
          type="file"
          accept="image/*"
          hidden
          onChange={onFileChange}
          disabled={uploading || draft?.status === 'converting' || photoActionsDisabled}
        />
        <label htmlFor="import-picker-file" className="sr-only">
          写真を選ぶ
        </label>
        <button
          type="button"
          data-testid="import-camera-button"
          disabled={uploading || draft?.status === 'converting' || photoActionsDisabled}
          onClick={() => fileCameraRef.current?.click()}
          className={`${buttonClass} w-full bg-accent text-surface`}
        >
          <Camera size={20} aria-hidden="true" />
          プリントを撮影
        </button>
        <button
          type="button"
          data-testid="import-picker-button"
          disabled={uploading || draft?.status === 'converting' || photoActionsDisabled}
          onClick={() => filePickerRef.current?.click()}
          className={`${buttonClass} mt-[var(--spacing-xs)] w-full border border-line bg-surface`}
        >
          写真を選ぶ
        </button>
      </section>

      {draft && (
        <section
          aria-label="選択した写真"
          className="mt-[var(--spacing-md)] rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]"
        >
          <div className="flex min-w-0 items-start gap-[var(--spacing-md)]">
            {draft.previewUrl ? (
              <img
                data-testid="import-preview"
                src={draft.previewUrl}
                alt="保存前の写真プレビュー"
                className="h-24 w-24 shrink-0 rounded-[var(--radius-md)] border border-line object-cover"
              />
            ) : (
              <div
                aria-hidden="true"
                className="flex h-24 w-24 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-chip text-muted"
              >
                <Camera size={24} />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p aria-live="polite" className="m-0 text-sm font-semibold">
                {draft.status === 'converting'
                  ? '写真を準備中...'
                  : uploading
                    ? '保存中...'
                    : '保存前の写真'}
              </p>
              {draft.error && (
                <p
                  role="alert"
                  data-testid="import-upload-error"
                  className="mt-[var(--spacing-xs)] mb-0 text-sm text-deadline"
                >
                  {draft.error}
                </p>
              )}
              {draft.width && draft.height && (
                <p className="mt-[var(--spacing-xs)] mb-0 text-xs text-muted">
                  {draft.width} × {draft.height} px
                </p>
              )}
            </div>
          </div>
          {draft.blob && draft.status === 'error' && (
            <button
              type="button"
              data-testid="import-retry"
              disabled={uploading || photoActionsDisabled}
              onClick={() => void sendDraft(draft, operationGenerationRef.current)}
              className={`${buttonClass} mt-[var(--spacing-md)] w-full bg-accent text-surface`}
            >
              <Upload size={18} aria-hidden="true" />
              {uploading ? '保存中...' : 'もう一度送る'}
            </button>
          )}
        </section>
      )}

      <section aria-labelledby="saved-imports-heading" className="mt-[var(--spacing-xl)]">
        <div className="mb-[var(--spacing-sm)] flex items-center justify-between gap-[var(--spacing-sm)]">
          <h2 id="saved-imports-heading" className="m-0 text-lg font-semibold">
            保存した写真
          </h2>
          {importsQuery.isFetching && importsQuery.data && (
            <span aria-live="polite" className="text-xs text-muted">
              更新中...
            </span>
          )}
        </div>
        {importsQuery.isLoading ? (
          <p aria-live="polite" className="text-sm text-muted">
            一覧を読み込み中...
          </p>
        ) : importsQuery.isError && (!importsQuery.data || importAccessLost) ? (
          <div
            role="alert"
            className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]"
          >
            <p className="m-0 text-sm">写真の一覧を読み込めませんでした。</p>
            <button
              type="button"
              onClick={() => void importsQuery.refetch()}
              className={`${buttonClass} mt-[var(--spacing-sm)] w-full border border-line`}
            >
              <RefreshCw size={16} aria-hidden="true" /> 再試行
            </button>
          </div>
        ) : privateAccessRevoked ? (
          <div
            role="alert"
            className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]"
          >
            <p className="m-0 text-sm">
              家族の写真を確認できませんでした。家族情報を確認してください。
            </p>
            <Link
              to="/onboarding"
              className={`${buttonClass} mt-[var(--spacing-sm)] w-full border border-line`}
            >
              家族の設定
            </Link>
          </div>
        ) : visibleJobs.length === 0 ? (
          <p
            data-testid="import-empty"
            className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)] text-sm text-muted"
          >
            保存した写真はまだありません。プリントを撮影するか、写真を選んでください。
          </p>
        ) : (
          <ul data-testid="import-list" className="m-0 list-none space-y-[var(--spacing-sm)] p-0">
            {visibleJobs.map((job) => (
              <li
                key={job.id}
                data-testid={`import-item-${job.id}`}
                className="min-w-0 rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-sm)]"
              >
                <div className="flex min-w-0 items-center gap-[var(--spacing-sm)]">
                  <button
                    type="button"
                    data-testid={`import-thumbnail-${job.id}`}
                    disabled={!photoUrls[job.id]}
                    onClick={() => beginViewer(job.id)}
                    aria-label={`写真を大きく表示 ${formatTokyoDateTimeSeconds(job.createdAt)}`}
                    className="min-h-[var(--tap-target-min)] min-w-[var(--tap-target-min)] shrink-0 overflow-hidden rounded-[var(--radius-md)] border border-line bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
                  >
                    {photoUrls[job.id] ? (
                      <img src={photoUrls[job.id]} alt="" className="h-16 w-16 object-cover" />
                    ) : (
                      <span className="flex h-16 w-16 items-center justify-center">
                        <RefreshCw size={18} aria-hidden="true" />
                      </span>
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-sm font-semibold">読み取り待ち</p>
                    <time
                      className="mt-[var(--spacing-2xs)] block text-xs text-muted"
                      dateTime={toTokyoIsoString(job.createdAt * 1000)}
                    >
                      {formatTokyoDateTimeSeconds(job.createdAt)}
                    </time>
                  </div>
                  <button
                    type="button"
                    data-testid={`import-delete-${job.id}`}
                    aria-label={`写真を削除 ${formatTokyoDateTimeSeconds(job.createdAt)}`}
                    disabled={deletingIds.has(job.id)}
                    onClick={() => {
                      setConfirmingDeleteId((current) => (current === job.id ? null : job.id));
                      setDeleteErrors((current) => ({ ...current, [job.id]: '' }));
                    }}
                    className={`${buttonClass} min-w-[var(--tap-target-min)] shrink-0 border border-line px-[var(--spacing-sm)]`}
                  >
                    <Trash2 size={18} aria-hidden="true" /> 削除
                  </button>
                </div>
                {confirmingDeleteId === job.id && (
                  <div
                    data-testid="import-delete-confirmation"
                    className="mt-[var(--spacing-sm)] rounded-[var(--radius-md)] border border-line bg-bg p-[var(--spacing-sm)]"
                  >
                    <p className="m-0 text-sm">この写真を削除しますか？</p>
                    {deleteErrors[job.id] && (
                      <p
                        role="alert"
                        data-testid={`import-delete-error-${job.id}`}
                        className="mt-[var(--spacing-xs)] mb-0 text-sm text-deadline"
                      >
                        {deleteErrors[job.id]}
                      </p>
                    )}
                    <div className="mt-[var(--spacing-xs)] flex gap-[var(--spacing-xs)]">
                      <button
                        type="button"
                        data-testid={`import-delete-confirm-${job.id}`}
                        disabled={deletingIds.has(job.id)}
                        onClick={() => void confirmDelete(job)}
                        className={`${buttonClass} flex-1 bg-accent text-surface`}
                      >
                        {deletingIds.has(job.id) ? '削除中...' : '削除する'}
                      </button>
                      <button
                        type="button"
                        disabled={deletingIds.has(job.id)}
                        onClick={() => setConfirmingDeleteId(null)}
                        className={`${buttonClass} flex-1 border border-line bg-surface`}
                      >
                        キャンセル
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {importsQuery.isError && importsQuery.data && !importAccessLost && (
          <output className="mt-[var(--spacing-sm)] block text-sm text-muted">
            最新の一覧を取得できませんでした。表示中の写真を続けています。
          </output>
        )}
      </section>

      {viewedJob && photoUrls[viewedJob.id] && (
        <dialog
          ref={viewerDialogRef}
          onCancel={(event) => {
            event.preventDefault();
            setViewedImportId(null);
          }}
          data-testid="import-viewer"
          aria-modal="true"
          aria-label="写真を拡大表示"
          className="fixed inset-0 z-40 m-0 flex h-full w-full max-h-none max-w-none items-center justify-center border-0 bg-ink/90 p-[var(--spacing-md)] text-inherit"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setViewedImportId(null);
          }}
        >
          <div className="flex max-h-full w-full max-w-[var(--app-max-width)] flex-col items-end gap-[var(--spacing-sm)]">
            <button
              ref={viewerCloseRef}
              type="button"
              data-testid="import-viewer-close"
              aria-label="写真を閉じる"
              onClick={() => setViewedImportId(null)}
              className={`${buttonClass} border border-surface/40 bg-surface text-ink`}
            >
              閉じる
            </button>
            <img
              src={photoUrls[viewedJob.id]}
              alt="保存したプリント"
              className="max-h-[80vh] w-full rounded-[var(--radius-md)] object-contain"
            />
          </div>
        </dialog>
      )}
    </PageFrame>
  );
}

export default function ImportPage(): React.ReactElement {
  const session = useSessionQuery();
  const logoutMutation = useLogoutMutation();
  const queryClient = useQueryClient();
  const user = session.isError ? undefined : session.data;
  const familiesQuery = useFamiliesQuery(user?.id);
  const familyAccessLost =
    familiesQuery.error instanceof FamilyApiError &&
    [401, 403, 404].includes(familiesQuery.error.status ?? 0);
  const family = familyAccessLost
    ? undefined
    : familiesQuery.data?.find((item) => item.creationStatus === 'ready' && item.familyCalendarId);
  const identity = user && family ? `${user.id}:${family.id}` : '';
  const previousIdentityRef = useRef(identity);

  useEffect(() => {
    const oldIdentity = previousIdentityRef.current;
    if (oldIdentity === identity) return;
    previousIdentityRef.current = identity;
    const [oldUserId, oldFamilyId] = oldIdentity.split(':');
    if (!oldUserId || !oldFamilyId) return;
    const oldKey = [...IMPORTS_QUERY_KEY, oldUserId, oldFamilyId] as const;
    void (async () => {
      await queryClient.cancelQueries({ queryKey: oldKey });
      queryClient.removeQueries({ queryKey: oldKey });
    })();
  }, [identity, queryClient]);

  useEffect(() => {
    if (
      session.isError ||
      (familiesQuery.error instanceof FamilyApiError && familiesQuery.error.status === 401)
    ) {
      void logoutMutation.mutateAsync().catch(() => undefined);
    }
  }, [familiesQuery.error, logoutMutation.mutateAsync, session.isError]);

  if (
    session.isLoading ||
    (!session.isError && user && familiesQuery.isLoading && !familiesQuery.data)
  ) {
    return (
      <PageFrame>
        <p aria-live="polite" className="text-sm text-muted">
          読み込み中...
        </p>
      </PageFrame>
    );
  }
  if (!user) {
    return session.isError ? (
      <LoginPrompt
        retry={() => {
          void session.refetch();
        }}
      />
    ) : (
      <LoginPrompt />
    );
  }
  if (!family) {
    return (
      <PageFrame>
        <header className="mb-[var(--spacing-lg)]">
          <h1 className="m-0 text-2xl font-bold">プリントを取り込む</h1>
        </header>
        <section className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]">
          {familiesQuery.isError ? (
            <>
              <p role="alert" className="m-0 text-sm">
                家族情報を読み込めませんでした。
              </p>
              <button
                type="button"
                onClick={() => void familiesQuery.refetch()}
                className={`${buttonClass} mt-[var(--spacing-sm)] w-full border border-line`}
              >
                <RefreshCw size={16} aria-hidden="true" />
                再試行
              </button>
            </>
          ) : (
            <>
              <p className="m-0 text-sm">
                写真を保存するには、先に家族カレンダーを準備してください。
              </p>
              <Link
                to="/onboarding"
                className={`${buttonClass} mt-[var(--spacing-md)] w-full border border-line`}
              >
                家族の設定
              </Link>
            </>
          )}
        </section>
      </PageFrame>
    );
  }
  return <ImportWorkspace key={identity} userId={user.id} familyId={family.id} />;
}
