import { PersonalEventsApiError, updatePersonalCalendars } from '@client/api/personal';
import { useReloadProtection } from '@client/features/pwa/useReloadProtection';
import {
  PERSONAL_CALENDARS_QUERY_KEY,
  PERSONAL_WEEK_QUERY_KEY,
  usePersonalCalendarsQuery,
} from '@client/features/settings/usePersonalEvents';
import type { AuthUser } from '@shared/schemas/auth';
import { updatePersonalCalendarsInputSchema } from '@shared/schemas/personal';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Shield } from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

const sectionClass =
  'rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]';
const buttonClass =
  'inline-flex min-h-[var(--tap-target-min)] items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] px-[var(--spacing-md)] text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50';

interface PersonalCalendarsSettingsProps {
  userId: string;
  familyId: string;
}

export function PersonalCalendarsSettings({
  userId,
  familyId,
}: PersonalCalendarsSettingsProps): React.ReactElement {
  const queryClient = useQueryClient();
  const queryKey = [...PERSONAL_CALENDARS_QUERY_KEY, userId, familyId] as const;
  const calendarsQuery = usePersonalCalendarsQuery(userId, familyId);
  const [selectionDraft, setSelectionDraft] = useState<string[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const operationLockRef = useRef(false);
  const generationRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const identityRef = useRef(`${userId}:${familyId}`);

  const updateMutation = useMutation({
    mutationFn: ({ calendarIds, signal }: { calendarIds: string[]; signal: AbortSignal }) =>
      updatePersonalCalendars(familyId, { calendarIds }, signal),
  });

  useEffect(() => {
    const identity = `${userId}:${familyId}`;
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      generationRef.current += 1;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      operationLockRef.current = false;
      updateMutation.reset();
      setSelectionDraft(null);
      setErrorMessage(null);
      setRedirecting(false);
    }
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
    queryError instanceof PersonalEventsApiError &&
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
    queryClient.removeQueries({
      queryKey: [...PERSONAL_CALENDARS_QUERY_KEY, userId, familyId],
      exact: true,
    });
    setSelectionDraft(null);
    if (queryError instanceof PersonalEventsApiError && queryError.code === 'UNAUTHORIZED') {
      void (async () => {
        if (queryClient.getQueryData<AuthUser | null>(['session'])?.id !== userId) return;
        await queryClient.cancelQueries({ queryKey: ['session'] });
        if (queryClient.getQueryData<AuthUser | null>(['session'])?.id !== userId) return;
        queryClient.setQueryData(['session'], null);
        await queryClient.cancelQueries({ queryKey: [...PERSONAL_WEEK_QUERY_KEY, userId] });
        await queryClient.cancelQueries({ queryKey: [...PERSONAL_CALENDARS_QUERY_KEY, userId] });
        queryClient.removeQueries({ queryKey: [...PERSONAL_WEEK_QUERY_KEY, userId] });
        queryClient.removeQueries({ queryKey: [...PERSONAL_CALENDARS_QUERY_KEY, userId] });
      })();
    }
  }, [familyId, queryClient, queryError, restrictedError, userId]);

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
  useReloadProtection(selectionDirty || pending, pending);

  const submitCalendarSelection = async (calendarIds: string[]): Promise<void> => {
    if (operationLockRef.current) return;
    const parsedInput = updatePersonalCalendarsInputSchema.safeParse({ calendarIds });
    if (!parsedInput.success) {
      setErrorMessage('カレンダーの選択内容を確認してください。');
      return;
    }

    operationLockRef.current = true;
    setErrorMessage(null);
    const generation = generationRef.current;
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
        identityRef.current !== `${userId}:${familyId}` ||
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
        calendars: result.calendars,
      });
      setSelectionDraft(null);
      void queryClient.invalidateQueries({
        queryKey: [...PERSONAL_WEEK_QUERY_KEY, userId, familyId],
      });
    } catch (error: unknown) {
      if (
        generationRef.current !== generation ||
        identityRef.current !== `${userId}:${familyId}` ||
        controller.signal.aborted
      ) {
        return;
      }
      setErrorMessage(
        error instanceof PersonalEventsApiError
          ? error.message
          : 'カレンダーの選択を保存できませんでした。再度お試しください。',
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

  return (
    <section
      className={`${sectionClass} mt-[var(--spacing-lg)]`}
      data-testid="personal-calendar-settings"
    >
      <h2 className="m-0 text-base font-semibold">自分の予定の表示</h2>
      <div className="mt-[var(--spacing-sm)] flex items-start gap-[var(--spacing-sm)]">
        <Shield
          size={18}
          aria-hidden="true"
          className="mt-[var(--spacing-2xs)] shrink-0 text-member-green"
        />
        <p className="m-0 min-w-0 text-sm leading-relaxed text-muted">
          個人予定のタイトルと時間はあなたの画面だけに表示され、家族には共有されません。選択したカレンダー
          ID のみを保存し、予定の内容は保存しません。
        </p>
      </div>
      {calendarsQuery.isLoading ? (
        <p aria-live="polite" className="mt-[var(--spacing-md)] mb-0 text-sm text-muted">
          カレンダーを確認中...
        </p>
      ) : calendarsQuery.isError ? (
        <div
          role="alert"
          data-testid="personal-calendar-error"
          className="mt-[var(--spacing-md)] rounded-[var(--radius-md)] border border-line p-[var(--spacing-sm)]"
        >
          <p className="m-0 text-sm">
            {restrictedError
              ? '個人予定を表示する権限がありません。'
              : 'カレンダーを読み込めませんでした。'}
          </p>
          {!restrictedError && (
            <button
              type="button"
              data-testid="retry-personal-calendars"
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
            の予定読み取りに同意すると、選んだ個人カレンダーを自分の週ビューに表示できます。カレンダーを選んで保存すると表示が始まります。
          </p>
          <button
            type="button"
            data-testid="enable-personal-events"
            disabled={pending}
            aria-busy={pending}
            onClick={() => void submitCalendarSelection([])}
            className={`${buttonClass} mt-[var(--spacing-md)] w-full bg-accent text-surface hover:opacity-90`}
          >
            {pending ? 'Google に移動中...' : '自分の予定を表示する'}
          </button>
        </div>
      ) : calendarsQuery.data?.status === 'ready' ? (
        <>
          <p className="mt-[var(--spacing-md)] mb-0 text-sm leading-relaxed text-muted">
            週ビューに表示するカレンダーを選んで保存してください。すべて外すと表示を停止できます。
          </p>
          {calendars.length > 0 ? (
            <fieldset disabled={pending} className="mt-[var(--spacing-sm)] min-w-0 border-0 p-0">
              <legend className="sr-only">表示する個人カレンダー</legend>
              <ul
                aria-label="Google カレンダー"
                className="m-0 list-none space-y-[var(--spacing-xs)] p-0"
              >
                {calendars.map((calendar) => (
                  <li key={calendar.id}>
                    <label
                      htmlFor={`personal-calendar-${calendar.id}`}
                      className="flex min-h-[var(--tap-target-min)] min-w-0 items-center gap-[var(--spacing-sm)] rounded-[var(--radius-sm)] px-[var(--spacing-xs)] text-sm hover:bg-chip"
                    >
                      <input
                        id={`personal-calendar-${calendar.id}`}
                        data-testid={`personal-calendar-${calendar.id}`}
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
              表示できる個人カレンダーがありません。
            </p>
          )}
          <button
            type="button"
            data-testid="save-personal-calendars"
            disabled={pending}
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
          data-testid="personal-calendar-error"
          className="mt-[var(--spacing-sm)] mb-0 text-sm text-accent"
        >
          {errorMessage}
        </p>
      )}
    </section>
  );
}
