import { PersonalEventsApiError } from '@client/api/personal';
import { WeekApiError } from '@client/api/week';
import { BusyWeekApiError } from '@client/api/week-busy';
import { AuthenticatedShell } from '@client/components/AuthenticatedShell';
import { Chip } from '@client/components/Chip';
import { OAuthNotices } from '@client/components/OAuthNotices';
import { BUSY_CALENDARS_QUERY_KEY } from '@client/features/settings/useBusyCalendars';
import {
  PERSONAL_CALENDARS_QUERY_KEY,
  PERSONAL_WEEK_QUERY_KEY,
  usePersonalWeekQuery,
} from '@client/features/settings/usePersonalEvents';
import { EventDialog } from '@client/features/week/EventDialog';
import { BUSY_WEEK_QUERY_KEY, useBusyWeekQuery } from '@client/features/week/useBusyWeek';
import { useWeekQuery } from '@client/features/week/useWeek';
import { DayTimeline } from '@client/features/weekend-day/DayTimeline';
import { getRoutineExceptionLabel } from '@shared/domain/routineExceptionLabel';
import {
  type WeekendDayLayout,
  buildWeekendDayLayout,
  getLongWeekendPosition,
} from '@shared/domain/weekendDay';
import type { AuthUser } from '@shared/schemas/auth';
import { type DateKey, dateKeySchema } from '@shared/schemas/date';
import type { EventInputTime } from '@shared/schemas/events';
import type { FamilyPublic } from '@shared/schemas/family';
import type { PersonalEvent, PersonalWeekResponse } from '@shared/schemas/personal';
import type { WeekEvent, WeekResponse } from '@shared/schemas/week';
import type { BusyWeekResponse } from '@shared/schemas/week-busy';
import { getWeekday } from '@shared/time/date';
import { formatEventTime, formatFullDateLabel } from '@shared/time/format';
import { getHoliday } from '@shared/time/holiday';
import { getMondayAnchor, getWeekRange } from '@shared/time/week';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  KeyRound,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  ShoppingBag,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';

type WeekMember = WeekResponse['members'][number];
type TimedEventTime = Extract<EventInputTime, { kind: 'timed' }>;

function isSupportedWeekRange(range: ReturnType<typeof getWeekRange>): boolean {
  const startYear = Number(range.start.slice(0, 4));
  const endYear = Number(range.endInclusive.slice(0, 4));
  return startYear >= 1970 && startYear <= 2050 && endYear >= 1970 && endYear <= 2050;
}

interface WeekendDayPageProps {
  userId: string;
  familyId: string;
  familyName: string;
  familyMembers: FamilyPublic['members'];
  selfMemberId?: string;
  dateParam: string;
  requestedWeekStart?: string;
}

interface EventEditorState {
  event?: WeekEvent;
  selectedDate: DateKey;
  initialTime?: TimedEventTime;
  members: WeekMember[];
  clientRequestId: string;
}

function resolveRouteDate(
  dateParam: string,
  requestedWeekStart?: string,
):
  | {
      date: DateKey;
      weekStart: DateKey;
      weekRange: ReturnType<typeof getWeekRange>;
    }
  | undefined {
  const parsedDate = dateKeySchema.safeParse(dateParam);
  if (!parsedDate.success) return undefined;
  const year = Number(parsedDate.data.slice(0, 4));
  if (year < 1970 || year > 2050) return undefined;

  if (requestedWeekStart) {
    const parsedStart = dateKeySchema.safeParse(requestedWeekStart);
    if (parsedStart.success) {
      const startYear = Number(parsedStart.data.slice(0, 4));
      if (startYear >= 1970 && startYear <= 2050) {
        try {
          const stateRange = getWeekRange(parsedStart.data);
          if (
            stateRange.start === parsedStart.data &&
            isSupportedWeekRange(stateRange) &&
            stateRange.days.includes(parsedDate.data)
          ) {
            return { date: parsedDate.data, weekStart: stateRange.start, weekRange: stateRange };
          }
        } catch {
          // Ignore stale or forged navigation state and use the date's own week.
        }
      }
    }
  }

  try {
    const weekStart = getMondayAnchor(parsedDate.data);
    const weekRange = getWeekRange(weekStart);
    if (!isSupportedWeekRange(weekRange) || !weekRange.days.includes(parsedDate.data)) {
      return undefined;
    }
    return { date: parsedDate.data, weekStart, weekRange };
  } catch {
    return undefined;
  }
}

function targetsLabel(event: WeekEvent, members: readonly WeekMember[]): string {
  if (event.memberIds.length === 0) return '家族全員';
  const names = event.memberIds
    .map((memberId) => members.find((member) => member.id === memberId)?.name)
    .filter((name): name is string => Boolean(name));
  return names.length > 0 ? names.join('・') : '家族全員';
}

function FamilyEventCardDetails({
  event,
  date,
  members,
}: {
  event: WeekEvent;
  date: DateKey;
  members: readonly WeekMember[];
}): React.ReactElement {
  const assignee = event.assigneeMemberId
    ? members.find((member) => member.id === event.assigneeMemberId)
    : undefined;
  return (
    <>
      <span className="flex max-w-full min-w-0 flex-wrap items-center gap-[var(--spacing-xs)] font-semibold">
        {event.isRecurring && <Repeat size={14} aria-label="繰り返し予定" className="shrink-0" />}
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{event.title}</span>
        {getRoutineExceptionLabel(event) && (
          <span className="text-xs text-accent">{getRoutineExceptionLabel(event)}</span>
        )}
      </span>
      <span className="text-muted">
        {formatEventTime(event.time, date)} · {targetsLabel(event, members)}
      </span>
      {(event.status === 'tentative' || assignee) && (
        <span className="flex max-w-full flex-wrap gap-[var(--spacing-xs)]">
          {event.status === 'tentative' && (
            <span className="rounded-[var(--radius-sm)] bg-accent-tint px-[var(--spacing-xs)] py-[var(--spacing-2xs)] text-accent">
              候補
            </span>
          )}
          {assignee && (
            <span className="rounded-[var(--radius-sm)] bg-chip px-[var(--spacing-xs)] py-[var(--spacing-2xs)] text-muted">
              担当：{assignee.name}
            </span>
          )}
        </span>
      )}
      {event.items.length > 0 && (
        <span className="flex max-w-full flex-wrap gap-[var(--spacing-xs)]">
          {event.items.map((item, index) => (
            <span
              key={`${event.id}-item-${index}`}
              className="inline-flex min-w-0 items-center gap-[var(--spacing-2xs)] rounded-[var(--radius-sm)] bg-chip px-[var(--spacing-xs)] py-[var(--spacing-2xs)] font-normal"
            >
              <ShoppingBag size={12} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{item}</span>
            </span>
          ))}
        </span>
      )}
    </>
  );
}

function PersonalEventCard({
  event,
  date,
}: { event: PersonalEvent; date: DateKey }): React.ReactElement {
  return (
    <div
      data-testid={`weekend-day-personal-event-${event.id}`}
      className="min-w-0 rounded-[var(--radius-md)] border border-dashed border-focus bg-surface p-[var(--spacing-sm)]"
    >
      <p className="m-0 break-words text-sm font-semibold [overflow-wrap:anywhere]">
        {event.title}
      </p>
      <p className="mt-[var(--spacing-2xs)] mb-0 text-xs text-muted">
        {formatEventTime(event.time, date)}
      </p>
      <p className="mt-[var(--spacing-xs)] mb-0 inline-flex items-center gap-[var(--spacing-xs)] text-xs text-muted">
        <KeyRound size={14} aria-hidden="true" />
        自分だけ
      </p>
    </div>
  );
}

function WeekendDayContent({
  props,
  route,
}: {
  props: WeekendDayPageProps;
  route: NonNullable<ReturnType<typeof resolveRouteDate>>;
}): React.ReactElement {
  const { userId, familyId, familyName, familyMembers, selfMemberId } = props;
  const { date, weekStart, weekRange } = route;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [familyAccessRevoked, setFamilyAccessRevoked] = useState(false);
  const [revokedBusyIdentity, setRevokedBusyIdentity] = useState<string | null>(null);
  const [revokedPersonalIdentity, setRevokedPersonalIdentity] = useState<string | null>(null);
  const queryIdentity = `${userId}:${familyId}:${weekStart}`;
  const weekQuery = useWeekQuery(userId, familyId, weekStart, !familyAccessRevoked);
  const busyWeekQuery = useBusyWeekQuery(
    userId,
    familyId,
    weekStart,
    !familyAccessRevoked && revokedBusyIdentity !== queryIdentity,
  );
  const personalWeekQuery = usePersonalWeekQuery(
    userId,
    familyId,
    weekStart,
    !familyAccessRevoked && revokedPersonalIdentity !== queryIdentity,
  );
  const [eventEditor, setEventEditor] = useState<EventEditorState | null>(null);
  const [routineNotice, setRoutineNotice] = useState(false);
  const invokingControlRef = useRef<HTMLElement | null>(null);
  const firstFreeBandRef = useRef<HTMLButtonElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const hadEditorOpenRef = useRef(false);
  const focusRestoreTimerRef = useRef<number | undefined>(undefined);

  const clearSessionAfterUnauthorized = useCallback(async () => {
    if (queryClient.getQueryData<AuthUser | null>(['session'])?.id !== userId) return;
    await queryClient.cancelQueries({ queryKey: ['session'] });
    if (queryClient.getQueryData<AuthUser | null>(['session'])?.id !== userId) return;
    queryClient.setQueryData(['session'], null);
    const privateKeys = [
      ['week', userId],
      ['week-busy', userId],
      ['personal-week', userId],
      ['personal-calendars', userId],
      ['families', userId],
    ] as const;
    for (const queryKey of privateKeys) await queryClient.cancelQueries({ queryKey });
    for (const queryKey of privateKeys) queryClient.removeQueries({ queryKey });
  }, [queryClient, userId]);

  useEffect(() => {
    const errors = [weekQuery.error, busyWeekQuery.error, personalWeekQuery.error];
    if (
      errors.some(
        (error) =>
          (error instanceof WeekApiError ||
            error instanceof BusyWeekApiError ||
            error instanceof PersonalEventsApiError) &&
          error.code === 'UNAUTHORIZED',
      )
    ) {
      void clearSessionAfterUnauthorized();
    }
  }, [
    busyWeekQuery.error,
    clearSessionAfterUnauthorized,
    personalWeekQuery.error,
    weekQuery.error,
  ]);

  useEffect(() => {
    const error = weekQuery.error;
    if (
      !(error instanceof WeekApiError) ||
      (error.code !== 'FORBIDDEN' && error.code !== 'NOT_FOUND')
    ) {
      return;
    }
    setFamilyAccessRevoked(true);
    void (async () => {
      const keys = [
        ['week', userId, familyId],
        [...BUSY_WEEK_QUERY_KEY, userId, familyId],
        [...PERSONAL_WEEK_QUERY_KEY, userId, familyId],
        [...BUSY_CALENDARS_QUERY_KEY, userId, familyId],
        [...PERSONAL_CALENDARS_QUERY_KEY, userId, familyId],
      ] as const;
      for (const queryKey of keys) await queryClient.cancelQueries({ queryKey });
      for (const queryKey of keys) queryClient.removeQueries({ queryKey });
    })();
  }, [familyId, queryClient, userId, weekQuery.error]);

  useEffect(() => {
    const error = busyWeekQuery.error;
    if (
      !(error instanceof BusyWeekApiError) ||
      (error.code !== 'FORBIDDEN' &&
        error.code !== 'NOT_FOUND' &&
        error.status !== 403 &&
        error.status !== 404)
    ) {
      return;
    }
    setRevokedBusyIdentity(queryIdentity);
    void (async () => {
      const key = [...BUSY_WEEK_QUERY_KEY, userId, familyId] as const;
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.removeQueries({ queryKey: key });
    })();
  }, [busyWeekQuery.error, familyId, queryClient, queryIdentity, userId]);

  useEffect(() => {
    const error = personalWeekQuery.error;
    if (
      !(error instanceof PersonalEventsApiError) ||
      (error.code !== 'FORBIDDEN' &&
        error.code !== 'NOT_FOUND' &&
        error.status !== 403 &&
        error.status !== 404)
    ) {
      return;
    }
    setRevokedPersonalIdentity(queryIdentity);
    void (async () => {
      const key = [...PERSONAL_WEEK_QUERY_KEY, userId, familyId] as const;
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.removeQueries({ queryKey: key });
    })();
  }, [familyId, personalWeekQuery.error, queryClient, queryIdentity, userId]);

  const weekData =
    !familyAccessRevoked &&
    !weekQuery.isError &&
    !weekQuery.isPlaceholderData &&
    weekQuery.data?.family.id === familyId &&
    weekQuery.data.week.start === weekStart &&
    weekQuery.data.week.endInclusive === weekRange.endInclusive &&
    weekQuery.data.days.some((day) => day.date === date)
      ? weekQuery.data
      : undefined;
  const day = weekData?.days.find((candidate) => candidate.date === date);
  const members: WeekMember[] = useMemo(
    () =>
      weekData?.members ??
      familyMembers.map(({ id, name, color, kind, sortOrder }) => ({
        id,
        name,
        color,
        kind,
        sortOrder,
      })),
    [familyMembers, weekData],
  );

  const busyResponse: BusyWeekResponse | undefined =
    !familyAccessRevoked &&
    revokedBusyIdentity !== queryIdentity &&
    !busyWeekQuery.isError &&
    busyWeekQuery.data?.family.id === familyId &&
    busyWeekQuery.data.week.start === weekStart &&
    busyWeekQuery.data.week.endInclusive === weekRange.endInclusive
      ? busyWeekQuery.data
      : undefined;
  const personalResponse: PersonalWeekResponse | undefined =
    !familyAccessRevoked &&
    revokedPersonalIdentity !== queryIdentity &&
    !personalWeekQuery.isError &&
    personalWeekQuery.data?.family.id === familyId &&
    personalWeekQuery.data.week.start === weekStart &&
    personalWeekQuery.data.week.endInclusive === weekRange.endInclusive
      ? personalWeekQuery.data
      : undefined;
  const personalMemberId =
    personalResponse?.status === 'ready' &&
    selfMemberId &&
    personalResponse.memberId === selfMemberId
      ? personalResponse.memberId
      : undefined;
  const personalEvents = useMemo(
    () => (personalMemberId ? (personalResponse?.events ?? []) : []),
    [personalMemberId, personalResponse],
  );
  const dayEvents = useMemo(
    () =>
      day && weekData
        ? weekData.events.filter((event) => day.eventIds.includes(event.id))
        : undefined,
    [day, weekData],
  );
  const layout: WeekendDayLayout = useMemo(
    () =>
      buildWeekendDayLayout({
        date,
        members,
        dayEvents,
        hasFamilyEvents: Boolean(day && weekData),
        busyResponse,
        ownMemberId: selfMemberId ?? '',
        ownPersonalMemberId: personalMemberId,
        ownPersonalEvents: personalEvents,
      }),
    [
      busyResponse,
      date,
      day,
      dayEvents,
      members,
      personalEvents,
      personalMemberId,
      selfMemberId,
      weekData,
    ],
  );
  const busyResponseReady = Boolean(busyResponse);

  useEffect(() => {
    if (eventEditor) {
      hadEditorOpenRef.current = true;
      return;
    }
    if (!hadEditorOpenRef.current) return;
    hadEditorOpenRef.current = false;
    if (focusRestoreTimerRef.current !== undefined) {
      window.clearTimeout(focusRestoreTimerRef.current);
    }
    focusRestoreTimerRef.current = window.setTimeout(() => {
      focusRestoreTimerRef.current = undefined;
      if (document.querySelector('dialog[open]')) return;
      if (invokingControlRef.current?.isConnected) invokingControlRef.current.focus();
      else addButtonRef.current?.focus();
      invokingControlRef.current = null;
    }, 0);
  }, [eventEditor]);

  useEffect(
    () => () => {
      if (focusRestoreTimerRef.current !== undefined) {
        window.clearTimeout(focusRestoreTimerRef.current);
      }
    },
    [],
  );

  const openNew = useCallback(
    (initialTime?: TimedEventTime, trigger?: HTMLElement) => {
      if (!weekData || familyAccessRevoked) return;
      invokingControlRef.current = trigger ?? addButtonRef.current;
      setRoutineNotice(false);
      setEventEditor({
        selectedDate: date,
        initialTime,
        members: weekData.members,
        clientRequestId: crypto.randomUUID(),
      });
    },
    [date, familyAccessRevoked, weekData],
  );
  const openEdit = useCallback(
    (event: WeekEvent, trigger: HTMLButtonElement) => {
      if (event.isRecurring) {
        invokingControlRef.current = trigger;
        setRoutineNotice(true);
        return;
      }
      if (!weekData) return;
      invokingControlRef.current = trigger;
      setRoutineNotice(false);
      setEventEditor({
        event,
        selectedDate: date,
        members: weekData.members,
        clientRequestId: crypto.randomUUID(),
      });
    },
    [date, weekData],
  );
  const openEditFromCard = (event: WeekEvent, trigger: HTMLButtonElement) => {
    if (event.isRecurring) {
      invokingControlRef.current = trigger;
      setRoutineNotice(true);
      return;
    }
    openEdit(event, trigger);
  };
  const closeEventEditor = useCallback(() => setEventEditor(null), []);
  const closeEventEditorFromHistory = useCallback(() => {
    if (
      window.history.state?.danranEventDialog === `event-dialog-${eventEditor?.clientRequestId}`
    ) {
      window.history.back();
    }
    closeEventEditor();
  }, [closeEventEditor, eventEditor?.clientRequestId]);

  useEffect(() => {
    if (!familyAccessRevoked) return;
    setRoutineNotice(false);
    if (eventEditor) closeEventEditorFromHistory();
  }, [closeEventEditorFromHistory, eventEditor, familyAccessRevoked]);

  const findFirstFreeBand = () => {
    const target = firstFreeBandRef.current;
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.focus({ preventScroll: true });
  };

  const isFamilyPending =
    !weekData && !familyAccessRevoked && (weekQuery.isPending || weekQuery.isFetching);
  const isFamilyFailed = !weekData && !isFamilyPending;
  const weekError = weekQuery.error;
  const unauthorized = weekError instanceof WeekApiError && weekError.code === 'UNAUTHORIZED';
  const reauthRequired = weekError instanceof WeekApiError && weekError.code === 'REAUTH_REQUIRED';
  const calendarAccessDenied =
    weekError instanceof WeekApiError && weekError.code === 'CALENDAR_ACCESS_DENIED';
  const weekErrorMessage = familyAccessRevoked
    ? 'この家族の予定を表示する権限がありません。家族一覧を更新して、もう一度お試しください。'
    : unauthorized
      ? 'セッションの有効期限が切れました。Google で再度ログインしてください。'
      : reauthRequired
        ? 'Google で再度ログインすると家族カレンダーを読み込めます。'
        : calendarAccessDenied
          ? '家族カレンダーが共有されているか、オーナーに確認してください。'
          : weekError instanceof WeekApiError && weekError.code
            ? weekError.message
            : '予定を読み込めませんでした。通信状態を確認して、もう一度お試しください。';
  const dayHoliday = day?.holidayName ?? getHoliday(date).name;
  const contextDays =
    weekData?.days ??
    weekRange.days.map((dayDate) => {
      const holiday = getHoliday(dayDate);
      const weekday = getWeekday(dayDate);
      return {
        date: dayDate,
        weekday,
        holidayName: holiday.name,
        closures: [],
        layout:
          holiday.isHoliday || weekday === 0 || weekday === 6
            ? ('weekend-card' as const)
            : ('compact' as const),
        eventIds: [],
      };
    });
  const longWeekend = getLongWeekendPosition(date, contextDays);
  const searchDisabled =
    !weekData || !busyResponseReady || layout.hasUnavailableMember || layout.freeBands.length === 0;
  const searchDisabledReason = !weekData
    ? '家族予定を取得できないため、空き時間から探せません。'
    : !busyResponseReady
      ? '空き状況を取得できないため、空き時間から探せません。'
      : layout.hasUnavailableMember
        ? '空き状況を取得できない人がいるため、空き時間から探せません。'
        : '共通の空き時間がありません。';

  return (
    <AuthenticatedShell
      activeTab="week"
      onCapture={() => navigate('/import')}
      mainTestId="weekend-day-screen"
      className="overflow-x-hidden"
    >
      <OAuthNotices />
      <header className="mb-[var(--spacing-lg)] min-w-0">
        <Link
          to={`/?week=${weekStart}`}
          data-testid="weekend-day-back"
          className="inline-flex min-h-[var(--tap-target-min)] items-center gap-[var(--spacing-xs)] rounded-[var(--radius-sm)] pr-[var(--spacing-sm)] text-sm font-medium text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ArrowLeft size={18} aria-hidden="true" />
          週へ戻る
        </Link>
        <p className="mt-[var(--spacing-sm)] mb-0 min-w-0 break-words text-sm text-muted [overflow-wrap:anywhere]">
          {familyName}
        </p>
        <h1
          data-testid="weekend-day-heading"
          className="mt-[var(--spacing-xs)] mb-0 break-words text-3xl font-semibold tracking-tight [overflow-wrap:anywhere]"
        >
          {formatFullDateLabel(date)}
        </h1>
        <div className="mt-[var(--spacing-sm)] flex min-w-0 flex-wrap items-center gap-[var(--spacing-xs)]">
          {longWeekend && <Chip className="text-xs">{longWeekend.label}</Chip>}
          {dayHoliday && <Chip className="text-xs">{dayHoliday}</Chip>}
          {day?.closures.map((closure, index) => (
            <Chip key={`${closure.label}-${index}`} className="text-xs">
              {closure.label}
            </Chip>
          ))}
        </div>
        <p className="mt-[var(--spacing-sm)] mb-0 text-xs leading-relaxed text-muted">
          斜線はほかの家族の「予定あり」、点線枠は自分だけに見える予定です。
        </p>
      </header>

      {isFamilyPending && (
        <section
          data-testid="weekend-day-week-loading"
          aria-live="polite"
          className="mb-[var(--spacing-md)] rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-sm)] text-xs text-muted"
        >
          <RefreshCw
            size={14}
            aria-hidden="true"
            className="mr-[var(--spacing-xs)] inline animate-spin"
          />
          週の予定を読み込み中...
        </section>
      )}
      {isFamilyFailed && (
        <section
          role="alert"
          data-testid="weekend-day-week-error"
          className="mb-[var(--spacing-md)] rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]"
        >
          <div className="flex items-start gap-[var(--spacing-sm)]">
            <AlertCircle
              size={20}
              aria-hidden="true"
              className="mt-[var(--spacing-2xs)] shrink-0 text-accent"
            />
            <div className="min-w-0">
              <h2 className="m-0 text-sm font-semibold">
                {familyAccessRevoked
                  ? '家族情報が更新されました'
                  : unauthorized
                    ? 'ログインが必要です'
                    : reauthRequired
                      ? 'Google カレンダーの再認証が必要です'
                      : calendarAccessDenied
                        ? '家族カレンダーにアクセスできません'
                        : '週の予定を取得できませんでした'}
              </h2>
              <p className="mt-[var(--spacing-xs)] mb-0 text-xs leading-relaxed text-muted">
                {weekErrorMessage}
              </p>
            </div>
          </div>
          {familyAccessRevoked ? (
            <Link
              to="/"
              className="mt-[var(--spacing-md)] inline-flex min-h-[var(--tap-target-min)] w-full items-center justify-center rounded-[var(--radius-md)] border border-line bg-surface px-[var(--spacing-md)] text-sm font-medium"
            >
              家族一覧へ戻る
            </Link>
          ) : unauthorized || reauthRequired ? (
            <button
              type="button"
              data-testid="login-button"
              onClick={() => window.location.assign('/api/auth/login')}
              className="mt-[var(--spacing-md)] min-h-[var(--tap-target-min)] w-full rounded-[var(--radius-md)] bg-accent px-[var(--spacing-md)] text-sm font-semibold text-surface"
            >
              {reauthRequired ? 'Google で再ログイン' : 'Google でログイン'}
            </button>
          ) : (
            <button
              type="button"
              data-testid="weekend-day-week-retry"
              onClick={() => void weekQuery.refetch()}
              className="mt-[var(--spacing-md)] min-h-[var(--tap-target-min)] w-full rounded-[var(--radius-md)] border border-line bg-surface px-[var(--spacing-md)] text-sm font-medium"
            >
              再試行
            </button>
          )}
        </section>
      )}
      {busyWeekQuery.isFetching && !busyResponse && (
        <p
          data-testid="weekend-day-busy-loading"
          aria-live="polite"
          className="mb-[var(--spacing-sm)] text-xs text-muted"
        >
          空き状況を読み込み中...
        </p>
      )}
      {(busyWeekQuery.isError || revokedBusyIdentity === queryIdentity) && (
        <output
          data-testid="weekend-day-busy-error"
          className="mb-[var(--spacing-sm)] block rounded-[var(--radius-sm)] bg-chip px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-xs text-muted"
        >
          空き状況を読み込めませんでした。家族の予定は表示しています。
        </output>
      )}
      {personalWeekQuery.isFetching && !personalResponse && (
        <p
          data-testid="weekend-day-personal-loading"
          aria-live="polite"
          className="mb-[var(--spacing-sm)] text-xs text-muted"
        >
          自分の予定を読み込み中...
        </p>
      )}
      {(personalWeekQuery.isError || revokedPersonalIdentity === queryIdentity) && (
        <output
          data-testid="weekend-day-personal-error"
          className="mb-[var(--spacing-sm)] block rounded-[var(--radius-sm)] bg-chip px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-xs text-muted"
        >
          自分の個人予定を表示できませんでした。家族の予定は表示しています。
        </output>
      )}
      {personalResponse && personalResponse.status !== 'ready' && !personalWeekQuery.isError && (
        <p
          data-testid="weekend-day-personal-note"
          className="mb-[var(--spacing-sm)] text-xs text-muted"
        >
          自分の個人予定は表示していません。
        </p>
      )}

      {layout.allDayFamilyEvents.length > 0 || layout.allDayPersonalEvents.length > 0 ? (
        <section
          data-testid="weekend-day-all-day"
          aria-label="終日の予定"
          className="mb-[var(--spacing-md)] rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-sm)]"
        >
          <h2 className="m-0 mb-[var(--spacing-xs)] text-xs font-semibold text-muted">
            終日の予定
          </h2>
          <ul className="m-0 grid list-none gap-[var(--spacing-xs)] p-0">
            {layout.allDayFamilyEvents.map((event) => (
              <li key={event.id}>
                <button
                  type="button"
                  data-testid={`weekend-day-all-day-${event.id}`}
                  onClick={(eventTarget) => openEditFromCard(event, eventTarget.currentTarget)}
                  className="flex min-h-[var(--tap-target-min)] w-full flex-col items-start gap-[var(--spacing-2xs)] rounded-[var(--radius-sm)] border border-line bg-chip px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-left text-xs"
                >
                  <FamilyEventCardDetails event={event} date={date} members={members} />
                </button>
              </li>
            ))}
            {layout.allDayPersonalEvents.map((event) => (
              <li key={event.id}>
                <PersonalEventCard event={event} date={date} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <DayTimeline
        date={date}
        members={members}
        layout={layout}
        busyResponseReady={busyResponseReady}
        onEdit={openEdit}
        onRoutineNotice={() => setRoutineNotice(true)}
        onAddFromFreeBand={(initialTime, trigger) => openNew(initialTime, trigger)}
        firstFreeBandRef={firstFreeBandRef}
      />

      {layout.outsideFamilyEvents.length > 0 || layout.outsidePersonalEvents.length > 0 ? (
        <section
          data-testid="weekend-day-outside-hours"
          className="mt-[var(--spacing-md)] rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-sm)]"
        >
          <h2 className="m-0 mb-[var(--spacing-xs)] text-xs font-semibold text-muted">
            時間帯の外の予定
          </h2>
          <ul className="m-0 grid list-none gap-[var(--spacing-xs)] p-0">
            {layout.outsideFamilyEvents.map((event) => (
              <li key={event.id}>
                <button
                  type="button"
                  data-testid={`weekend-day-outside-${event.id}`}
                  onClick={(eventTarget) => openEditFromCard(event, eventTarget.currentTarget)}
                  className="flex min-h-[var(--tap-target-min)] w-full flex-col items-start gap-[var(--spacing-2xs)] rounded-[var(--radius-sm)] bg-chip px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-left text-xs"
                >
                  <FamilyEventCardDetails event={event} date={date} members={members} />
                </button>
              </li>
            ))}
            {layout.outsidePersonalEvents.map((event) => (
              <li key={event.id}>
                <PersonalEventCard event={event} date={date} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {routineNotice && (
        <output
          data-testid="weekend-day-routine-notice"
          className="mt-[var(--spacing-md)] block rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-sm)] text-sm text-muted"
        >
          この予定は繰り返し予定です。休み・振替は『繰り返し』タブで設定できます。{' '}
          <Link
            to="/routines"
            data-testid="weekend-day-routines-link"
            className="inline-flex min-h-[var(--tap-target-min)] items-center rounded-[var(--radius-sm)] px-[var(--spacing-xs)] font-semibold text-ink underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            繰り返しタブを開く
          </Link>
        </output>
      )}

      <div className="mt-[var(--spacing-lg)] grid grid-cols-2 gap-[var(--spacing-sm)]">
        <button
          type="button"
          data-testid="weekend-day-search"
          disabled={searchDisabled}
          onClick={findFirstFreeBand}
          className="inline-flex min-h-[var(--tap-target-min)] items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] border border-line bg-surface px-[var(--spacing-sm)] text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Search size={16} aria-hidden="true" />
          空き時間から探す
        </button>
        <button
          ref={addButtonRef}
          type="button"
          data-testid="weekend-day-add"
          disabled={!weekData || familyAccessRevoked}
          onClick={(event) => openNew(undefined, event.currentTarget)}
          className="inline-flex min-h-[var(--tap-target-min)] items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] bg-accent px-[var(--spacing-sm)] text-xs font-semibold text-surface disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Plus size={16} aria-hidden="true" />
          家族の予定を追加
        </button>
      </div>
      {searchDisabled && (
        <p className="mt-[var(--spacing-xs)] mb-0 text-center text-xs text-muted">
          {searchDisabledReason}
        </p>
      )}

      {routineNotice && (
        <p className="sr-only">
          この予定は繰り返し予定です。休み・振替は『繰り返し』タブで設定できます。
        </p>
      )}
      {eventEditor && !familyAccessRevoked && (
        <EventDialog
          familyId={familyId}
          userId={userId}
          members={eventEditor.members}
          event={eventEditor.event}
          selectedDate={eventEditor.selectedDate}
          initialTime={eventEditor.initialTime}
          clientRequestId={eventEditor.clientRequestId}
          onClose={closeEventEditor}
          onSaved={closeEventEditorFromHistory}
          onUnauthorized={() => void clearSessionAfterUnauthorized()}
        />
      )}
      <footer className="mt-[var(--spacing-xl)] border-t border-line pt-[var(--spacing-md)] text-center">
        <Link
          to="/privacy"
          data-testid="privacy-link"
          className="inline-flex min-h-[var(--tap-target-min)] items-center justify-center rounded-[var(--radius-sm)] px-[var(--spacing-md)] py-[var(--spacing-xs)] text-xs text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          プライバシーポリシー
        </Link>
      </footer>
    </AuthenticatedShell>
  );
}

export default function WeekendDayPage(props: WeekendDayPageProps): React.ReactElement {
  const route = resolveRouteDate(props.dateParam, props.requestedWeekStart);
  if (!route) return <Navigate to="/" replace />;
  return <WeekendDayContent props={props} route={route} />;
}
