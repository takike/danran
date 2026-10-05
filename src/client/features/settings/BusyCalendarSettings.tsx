import { BusyCalendarsApiError, updateBusyCalendars } from '@client/api/busy';
import { useReloadProtection } from '@client/features/pwa/useReloadProtection';
import {
  BUSY_CALENDARS_QUERY_KEY,
  useBusyCalendarsQuery,
} from '@client/features/settings/useBusyCalendars';
import type { AuthUser } from '@shared/schemas/auth';
import { updateBusyCalendarsInputSchema } from '@shared/schemas/busy';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, ExternalLink, Shield } from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useSearchParams } from 'react-router-dom';

const sectionClass =
  'rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]';
const buttonClass =
  'inline-flex min-h-[var(--tap-target-min)] items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] px-[var(--spacing-md)] text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50';

interface BusyCalendarSettingsProps {
  userId: string;
  familyId: string;
}

export function BusyCalendarSettings({
  userId,
  familyId,
}: BusyCalendarSettingsProps): React.ReactElement {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const queryKey = [...BUSY_CALENDARS_QUERY_KEY, userId, familyId] as const;
  const calendarsQuery = useBusyCalendarsQuery(userId, familyId);
  const [selectionDraft, setSelectionDraft] = useState<string[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const operationLockRef = useRef(false);
  const generationRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const identityRef = useRef(`${userId}:${familyId}`);

  const updateMutation = useMutation({
    mutationFn: ({ calendarIds, signal }: { calendarIds: string[]; signal: AbortSignal }) =>
      updateBusyCalendars(familyId, { calendarIds }, signal),
  });

  useEffect(() => {
    const identity = `${userId}:${familyId}`;
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    generationRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    operationLockRef.current = false;
    updateMutation.reset();
    setSelectionDraft(null);
    setErrorMessage(null);
    setRedirecting(false);
  }, [familyId, updateMutation.reset, userId]);

  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      generationRef.current += 1;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      operationLockRef.current = false;
      setRedirecting(false);
      updateMutation.reset();
    };
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, [updateMutation.reset]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      requestControllerRef.current?.abort();
    };
  }, []);

  const queryError = calendarsQuery.error;
  const restrictedError =
    queryError instanceof BusyCalendarsApiError &&
    (queryError.status === 401 || queryError.status === 403 || queryError.status === 404);
  const restrictedIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    const restrictedIdentity = restrictedError ? `${userId}:${familyId}` : null;
    if (!restrictedIdentity) {
      restrictedIdentityRef.current = null;
      return;
    }
    if (restrictedIdentityRef.current === restrictedIdentity) return;
    restrictedIdentityRef.current = restrictedIdentity;
    queryClient.removeQueries({ queryKey, exact: true });
    setSelectionDraft(null);
    if (queryError instanceof BusyCalendarsApiError && queryError.code === 'UNAUTHORIZED') {
      void (async () => {
        if (queryClient.getQueryData<AuthUser | null>(['session'])?.id !== userId) return;
        await queryClient.cancelQueries({ queryKey: ['session'] });
        if (queryClient.getQueryData<AuthUser | null>(['session'])?.id !== userId) return;
        queryClient.setQueryData(['session'], null);
        await queryClient.cancelQueries({ queryKey: [...BUSY_CALENDARS_QUERY_KEY, userId] });
        await queryClient.cancelQueries({ queryKey: ['personal-week', userId] });
        await queryClient.cancelQueries({ queryKey: ['personal-calendars', userId] });
        queryClient.removeQueries({ queryKey: [...BUSY_CALENDARS_QUERY_KEY, userId] });
        queryClient.removeQueries({ queryKey: ['personal-week', userId] });
        queryClient.removeQueries({ queryKey: ['personal-calendars', userId] });
      })();
    }
  }, [familyId, queryClient, queryError, queryKey, restrictedError, userId]);

  const pending = updateMutation.isPending || redirecting;
  const calendars = calendarsQuery.data?.status === 'ready' ? calendarsQuery.data.calendars : [];
  const savedSelection = calendars
    .filter((calendar) => calendar.selected)
    .map((calendar) => calendar.id);
  const selectedIds = selectionDraft ?? savedSelection;
  const selectionDirty =
    selectionDraft !== null &&
    (selectionDraft.length !== savedSelection.length ||
      selectionDraft.some((calendarId) => !savedSelection.includes(calendarId)));
  const canSaveSelection =
    calendarsQuery.data?.status === 'ready' &&
    (calendarsQuery.data.hasSavedSelection || selectedIds.length > 0);
  useReloadProtection(selectionDirty || pending, pending);

  const submitCalendarSelection = async (calendarIds: string[]): Promise<void> => {
    if (operationLockRef.current) return;
    const parsedInput = updateBusyCalendarsInputSchema.safeParse({ calendarIds });
    if (!parsedInput.success) {
      setErrorMessage('カレンダーの選択内容を確認してください。');
      return;
    }

    operationLockRef.current = true;
    setErrorMessage(null);
    const generation = generationRef.current;
    const identity = `${userId}:${familyId}`;
    const controller = new AbortController();
    let keepLockedForRedirect = false;
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    try {
      const result = await updateMutation.mutateAsync({
        calendarIds: parsedInput.data.calendarIds,
        signal: controller.signal,
      });
      if (
        generationRef.current !== generation ||
        identityRef.current !== identity ||
        controller.signal.aborted
      ) {
        return;
      }
      if (result.authorizationRequired) {
        keepLockedForRedirect = true;
        flushSync(() => setRedirecting(true));
        try {
          window.location.assign(result.authorizationUrl);
        } catch {
          keepLockedForRedirect = false;
          setRedirecting(false);
          setErrorMessage('Google の同意画面を開けませんでした。もう一度お試しください。');
        }
        return;
      }

      queryClient.setQueryData(queryKey, {
        status: 'ready',
        memberId: result.memberId,
        hasSavedSelection: result.hasSavedSelection,
        calendars: result.calendars,
      });
      setSelectionDraft(null);
    } catch (error: unknown) {
      if (
        generationRef.current !== generation ||
        identityRef.current !== identity ||
        controller.signal.aborted
      ) {
        return;
      }
      setErrorMessage(
        error instanceof BusyCalendarsApiError
          ? error.message
          : '空き状況のカレンダーを保存できませんでした。再度お試しください。',
      );
    } finally {
      if (
        !keepLockedForRedirect &&
        generationRef.current === generation &&
        requestControllerRef.current === controller
      ) {
        operationLockRef.current = false;
        requestControllerRef.current = null;
      }
    }
  };

  const toggleCalendar = (calendarId: string): void => {
    setSelectionDraft((current) => {
      const selected = current ?? savedSelection;
      return selected.includes(calendarId)
        ? selected.filter((id) => id !== calendarId)
        : [...selected, calendarId];
    });
    setErrorMessage(null);
  };

  const callbackError = searchParams.get('error');
  const busyNotice =
    callbackError === 'busy_denied'
      ? {
          testId: 'busy-consent-error',
          message:
            'Google の空き状況共有は有効になっていません。必要な場合は、もう一度お試しください。',
        }
      : callbackError === 'busy_failed'
        ? {
            testId: 'busy-consent-error',
            message:
              'Google との連携を確認できませんでした。時間をおいて、もう一度お試しください。',
          }
        : callbackError === 'busy_account_mismatch'
          ? {
              testId: 'busy-consent-error',
              message:
                'ログイン中のアカウントと空き状況を共有するアカウントが異なります。アカウントを確認してください。',
            }
          : searchParams.get('busy') === 'granted'
            ? {
                testId: 'busy-consent-success',
                message:
                  '空き状況の共有を許可しました。共有するカレンダーを選んで保存してください。',
              }
            : null;

  return (
    <section
      className={`${sectionClass} mt-[var(--spacing-lg)]`}
      data-testid="busy-calendar-settings"
    >
      <h2 className="m-0 text-base font-semibold">空き状況の共有</h2>
      {busyNotice && (
        <div
          data-testid={busyNotice.testId}
          role={busyNotice.testId === 'busy-consent-error' ? 'alert' : 'status'}
          className="mt-[var(--spacing-sm)] flex items-start gap-[var(--spacing-xs)] rounded-[var(--radius-md)] border border-line bg-chip p-[var(--spacing-sm)] text-xs leading-relaxed text-ink"
        >
          <AlertCircle size={16} aria-hidden="true" className="mt-[var(--spacing-2xs)] shrink-0" />
          <span>{busyNotice.message}</span>
        </div>
      )}
      <div className="mt-[var(--spacing-sm)] flex items-start gap-[var(--spacing-sm)]">
        <Shield
          size={18}
          aria-hidden="true"
          className="mt-[var(--spacing-2xs)] shrink-0 text-member-green"
        />
        <p className="m-0 min-w-0 text-sm leading-relaxed text-muted">
          家族に伝わるのは「予定あり」の時間帯だけです。予定のタイトルや内容は共有されません。保存するのは選択したカレンダー
          ID のみです。
        </p>
      </div>
      <p className="mt-[var(--spacing-sm)] mb-0 text-xs leading-relaxed text-muted">
        会社の Google
        カレンダーも含める場合は、会社のアカウント側で自分の個人アカウントに「予定の有無のみ」を共有すると一覧に現れます。会社の設定で外部共有が禁止されている場合は利用できません。
      </p>
      {calendarsQuery.isLoading ? (
        <p aria-live="polite" className="mt-[var(--spacing-md)] mb-0 text-sm text-muted">
          空き状況に使うカレンダーを確認中...
        </p>
      ) : calendarsQuery.isError ? (
        <div
          role="alert"
          data-testid="busy-calendar-error"
          className="mt-[var(--spacing-md)] rounded-[var(--radius-md)] border border-line p-[var(--spacing-sm)]"
        >
          <p className="m-0 text-sm">
            {restrictedError
              ? '空き状況を共有する権限がありません。'
              : '空き状況に使うカレンダーを読み込めませんでした。'}
          </p>
          {!restrictedError && (
            <button
              type="button"
              data-testid="retry-busy-calendars"
              onClick={() => void calendarsQuery.refetch()}
              className={`${buttonClass} mt-[var(--spacing-xs)] border border-line text-ink hover:bg-chip`}
            >
              再試行
            </button>
          )}
        </div>
      ) : calendarsQuery.data?.status === 'authorization_required' ? (
        <div className="mt-[var(--spacing-md)]">
          <p className="m-0 text-sm leading-relaxed text-muted">
            Google
            の空き状況読み取りに同意すると、選んだカレンダーの「予定あり」の時間帯を家族に共有できます。予定の内容は共有されません。
          </p>
          <button
            type="button"
            data-testid="enable-busy-sharing"
            disabled={pending}
            aria-busy={pending}
            onClick={() => void submitCalendarSelection([])}
            className={`${buttonClass} mt-[var(--spacing-md)] w-full bg-accent text-surface hover:opacity-90`}
          >
            {pending ? 'Google に移動中...' : '空き状況を家族に共有する'}
          </button>
        </div>
      ) : calendarsQuery.data?.status === 'ready' ? (
        <>
          {!calendarsQuery.data.hasSavedSelection && (
            <output
              data-testid="busy-calendar-not-sharing"
              className="mt-[var(--spacing-md)] mb-0 block rounded-[var(--radius-md)] border border-line bg-chip p-[var(--spacing-sm)] text-sm leading-relaxed text-ink"
            >
              現在、空き状況は共有していません。共有するカレンダーを選んで保存してください。
            </output>
          )}
          <p className="mt-[var(--spacing-md)] mb-0 text-sm leading-relaxed text-muted">
            空き状況に使うカレンダーを選んで保存してください。すべて外すと共有を停止できます。
          </p>
          {calendars.length > 0 ? (
            <fieldset disabled={pending} className="mt-[var(--spacing-sm)] min-w-0 border-0 p-0">
              <legend className="sr-only">空き状況を共有するカレンダー</legend>
              <ul
                aria-label="Google カレンダー"
                className="m-0 list-none space-y-[var(--spacing-xs)] p-0"
              >
                {calendars.map((calendar) => (
                  <li key={calendar.id}>
                    <label
                      htmlFor={`busy-calendar-${calendar.id}`}
                      className="flex min-h-[var(--tap-target-min)] min-w-0 items-center gap-[var(--spacing-sm)] rounded-[var(--radius-sm)] px-[var(--spacing-xs)] text-sm hover:bg-chip"
                    >
                      <input
                        id={`busy-calendar-${calendar.id}`}
                        data-testid={`busy-calendar-${calendar.id}`}
                        type="checkbox"
                        checked={selectedIds.includes(calendar.id)}
                        onChange={() => toggleCalendar(calendar.id)}
                        className="h-5 w-5 shrink-0 accent-accent"
                      />
                      <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                        {calendar.name}
                      </span>
                      {calendar.isPrimary && (
                        <span className="shrink-0 text-xs text-muted">主</span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : (
            <p className="mt-[var(--spacing-sm)] mb-0 text-sm text-muted">
              選択できるカレンダーがありません。
            </p>
          )}
          <button
            type="button"
            data-testid="save-busy-calendars"
            disabled={pending || !canSaveSelection}
            onClick={() => void submitCalendarSelection(selectedIds)}
            className={`${buttonClass} mt-[var(--spacing-sm)] w-full bg-accent text-surface hover:opacity-90`}
          >
            <Check size={16} aria-hidden="true" />
            {pending ? '保存中...' : 'カレンダーの選択を保存'}
          </button>
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
            className="mt-[var(--spacing-sm)] inline-flex min-h-[var(--tap-target-min)] min-w-0 items-center gap-[var(--spacing-xs)] text-sm text-muted underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <ExternalLink size={16} aria-hidden="true" className="shrink-0" />
            Google の権限を取り消す方法
          </a>
        </>
      ) : null}
      {errorMessage && (
        <p
          role="alert"
          data-testid="busy-calendar-save-error"
          className="mt-[var(--spacing-sm)] mb-0 text-sm text-accent"
        >
          {errorMessage}
        </p>
      )}
    </section>
  );
}
