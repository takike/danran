import { WeekApiError } from '@client/api/week';
import { AuthenticatedShell } from '@client/components/AuthenticatedShell';
import { Card } from '@client/components/Card';
import { Chip } from '@client/components/Chip';
import { MemberDot } from '@client/components/MemberDot';
import { OAuthNotices } from '@client/components/OAuthNotices';
import { EventDialog } from '@client/features/week/EventDialog';
import { useWeekQuery } from '@client/features/week/useWeek';
import {
  getLongWeekendBadges,
  getVisibleDayEvents,
  getVisibleDayLayout,
} from '@shared/domain/weekPresentation';
import type { AuthUser } from '@shared/schemas/auth';
import { type DateKey, dateKeySchema } from '@shared/schemas/date';
import type { WeekDay, WeekEvent, WeekResponse } from '@shared/schemas/week';
import { addCalendarWeeks, getMondayAnchor, getTodayDateKey } from '@shared/time';
import {
  formatDayNumber,
  formatEventTime,
  formatFullDateLabel,
  formatMonthHeading,
  formatWeekPeriod,
  formatWeekday,
} from '@shared/time/format';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Plus,
  RefreshCw,
  Repeat,
  ShoppingBag,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

interface WeekPageProps {
  userId: string;
  familyId: string;
  familyName: string;
}

type WeekMember = WeekResponse['members'][number];

interface EventEditorState {
  event?: WeekEvent;
  selectedDate?: DateKey;
  members: WeekMember[];
  clientRequestId: string;
}

const memberColor = (member?: WeekMember): string =>
  member ? `var(--member-${member.color})` : 'var(--muted)';

function parseWeekAnchor(value: string | null): DateKey | undefined {
  if (!value) return undefined;
  const parsed = dateKeySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const year = Number(value.slice(0, 4));
  if (year < 1970 || year > 2050) return undefined;
  try {
    const anchor = getMondayAnchor(parsed.data);
    const anchorYear = Number(anchor.slice(0, 4));
    if (anchorYear < 1970 || anchorYear > 2050) return undefined;
    return anchor;
  } catch {
    return undefined;
  }
}

function getVisibleEvents(day: WeekDay, data: WeekResponse, hideRoutines: boolean): WeekEvent[] {
  return getVisibleDayEvents(day, data.events, hideRoutines);
}

function MemberLegend({ members }: { members: WeekMember[] }): React.ReactElement {
  return (
    <ul
      aria-label="メンバー"
      className="mt-[var(--spacing-md)] mb-0 flex flex-wrap gap-x-[var(--spacing-md)] gap-y-[var(--spacing-sm)] p-0 list-none"
    >
      {members.map((member) => (
        <li key={member.id} className="flex min-h-[var(--tap-target-min)] items-center">
          <MemberDot name={member.name} color={memberColor(member)} />
        </li>
      ))}
    </ul>
  );
}

function EventMembers({
  memberIds,
  members,
}: { memberIds: string[]; members: WeekMember[] }): React.ReactElement | null {
  if (memberIds.length === 0) return null;
  const byId = new Map(members.map((member) => [member.id, member]));
  const known = memberIds
    .map((id) => byId.get(id))
    .filter((member): member is WeekMember => member !== undefined);
  if (known.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-x-[var(--spacing-sm)] gap-y-[var(--spacing-xs)]">
      {known.map((member) => (
        <MemberDot
          key={member.id}
          name={member.name}
          color={memberColor(member)}
          className="text-xs"
        />
      ))}
    </span>
  );
}

function EventBadges({
  event,
  members,
  showAssignee = true,
}: { event: WeekEvent; members: WeekMember[]; showAssignee?: boolean }): React.ReactElement | null {
  const assignee = showAssignee
    ? members.find((member) => member.id === event.assigneeMemberId)
    : undefined;
  if (!assignee && event.status !== 'tentative' && !event.isRoutine) return null;
  return (
    <span className="inline-flex max-w-full min-w-0 flex-wrap items-center gap-[var(--spacing-xs)]">
      {assignee && (
        <span className="min-w-0 break-words text-xs text-muted [overflow-wrap:anywhere]">
          担当 {assignee.name}
        </span>
      )}
      {event.status === 'tentative' && (
        <span className="rounded-[var(--radius-sm)] border border-dashed border-accent px-[var(--spacing-xs)] py-[var(--spacing-2xs)] text-xs text-accent">
          候補
        </span>
      )}
      {event.isRoutine && <span className="text-xs text-muted">繰り返し</span>}
    </span>
  );
}

function DateLabel({
  day,
  isToday,
  large = false,
}: { day: WeekDay; isToday: boolean; large?: boolean }): React.ReactElement {
  return (
    <h3
      className={`m-0 flex min-w-0 flex-wrap items-baseline gap-[var(--spacing-xs)] font-semibold ${large ? 'text-accent' : 'shrink-0'}`}
    >
      <span className={`${large ? 'text-4xl' : 'text-2xl'} leading-none tabular-nums`}>
        {formatDayNumber(day.date)}
      </span>
      <span
        className={`text-sm font-medium ${day.weekday === 0 ? 'text-accent' : day.weekday === 6 ? 'text-member-indigo' : 'text-muted'}`}
      >
        {formatWeekday(day.date)}
      </span>
      {isToday && (
        <span className="rounded-[var(--radius-sm)] bg-accent-tint px-[var(--spacing-xs)] py-[var(--spacing-2xs)] text-xs font-semibold text-accent">
          今日
        </span>
      )}
    </h3>
  );
}

function RoutineChip({ event }: { event: WeekEvent }): React.ReactElement {
  return (
    <span className="inline-flex min-h-[var(--week-chip-min-height)] max-w-full items-center gap-[var(--spacing-xs)] rounded-[var(--radius-sm)] bg-chip px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-xs text-muted">
      {event.isRoutine && <Repeat size={14} aria-hidden="true" className="shrink-0" />}
      <span className="break-words [overflow-wrap:anywhere]">{event.title}</span>
      <span className="break-words tabular-nums [overflow-wrap:anywhere]">
        {formatEventTime(event.time)}
      </span>
    </span>
  );
}

interface EventActions {
  onAdd: (date: string, trigger: HTMLElement) => void;
  onEdit: (event: WeekEvent, trigger: HTMLElement) => void;
  disabled: boolean;
}

function AddDayButton({
  date,
  onAdd,
  disabled,
  className = '',
}: {
  date: DateKey;
  onAdd: EventActions['onAdd'];
  disabled: boolean;
  className?: string;
}): React.ReactElement {
  const fullDateLabel = formatFullDateLabel(date);
  const monthDay = fullDateLabel.slice(fullDateLabel.indexOf('年') + 1).split(' ')[0];
  return (
    <button
      type="button"
      data-testid={`add-event-${date}`}
      aria-label={`${monthDay}に予定を追加`}
      disabled={disabled}
      onClick={(event) => onAdd(date, event.currentTarget)}
      className={`inline-flex h-[var(--tap-target-min)] w-[var(--tap-target-min)] shrink-0 items-center justify-center rounded-[var(--radius-full)] text-muted hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 ${className}`.trim()}
    >
      <Plus size={16} aria-hidden="true" />
    </button>
  );
}

function EventEditButton({
  event,
  onEdit,
  disabled,
  children,
}: EventActions & { event: WeekEvent; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      type="button"
      data-testid={`edit-event-${event.id}`}
      aria-label={`予定を編集: ${event.title}`}
      disabled={disabled}
      onClick={(clickEvent) => onEdit(event, clickEvent.currentTarget)}
      className="inline-flex min-h-[var(--tap-target-min)] min-w-[var(--tap-target-min)] max-w-full items-center rounded-[var(--radius-sm)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function CompactDay({
  day,
  events,
  members,
  isToday,
  onAdd,
  onEdit,
  disabled,
}: {
  day: WeekDay;
  events: WeekEvent[];
  members: WeekMember[];
  isToday: boolean;
} & EventActions): React.ReactElement {
  const routineEvents = events.filter((event) => event.isRoutine);
  const otherEvents = events.filter((event) => !event.isRoutine);
  return (
    <li
      data-testid="week-day"
      data-date={day.date}
      data-layout="compact"
      aria-label={`${formatFullDateLabel(day.date)}${events.length === 0 ? '、予定なし' : ''}`}
      className="relative grid min-h-[var(--tap-target-min)] grid-cols-[var(--week-date-column)_minmax(0,1fr)] items-center gap-[var(--spacing-sm)] border-b border-line py-[var(--spacing-xs)] last:border-0"
    >
      <DateLabel day={day} isToday={isToday} />
      <div
        className={`flex min-w-0 flex-wrap content-center items-center gap-[var(--spacing-xs)] pr-[var(--tap-target-min)] ${events.length > 0 ? 'min-h-[var(--tap-target-min)] py-[var(--spacing-2xs)]' : ''}`}
      >
        {routineEvents.map((event) => (
          <EventEditButton
            key={event.id}
            event={event}
            onAdd={onAdd}
            onEdit={onEdit}
            disabled={disabled}
          >
            <RoutineChip event={event} />
          </EventEditButton>
        ))}
        {otherEvents.map((event) => (
          <EventEditButton
            key={event.id}
            event={event}
            onAdd={onAdd}
            onEdit={onEdit}
            disabled={disabled}
          >
            <span className="inline-flex min-h-[var(--week-chip-min-height)] max-w-full flex-wrap items-center gap-x-[var(--spacing-xs)] gap-y-[var(--spacing-2xs)] rounded-[var(--radius-sm)] bg-accent-tint px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-xs text-ink">
              <EventMembers memberIds={event.memberIds} members={members} />
              <span className="break-words font-medium [overflow-wrap:anywhere]">
                {event.title}
              </span>
              <EventBadges event={event} members={members} />
            </span>
          </EventEditButton>
        ))}
        {events.length === 0 && <span className="sr-only">予定なし</span>}
      </div>
      <AddDayButton
        date={day.date}
        onAdd={onAdd}
        disabled={disabled}
        className="absolute right-0 top-1/2 -translate-y-1/2"
      />
    </li>
  );
}

function ExpandedDay({
  day,
  events,
  members,
  isToday,
  onAdd,
  onEdit,
  disabled,
}: {
  day: WeekDay;
  events: WeekEvent[];
  members: WeekMember[];
  isToday: boolean;
} & EventActions): React.ReactElement {
  return (
    <li
      data-testid="week-day"
      data-date={day.date}
      data-layout="expanded"
      aria-label={formatFullDateLabel(day.date)}
      className="grid grid-cols-[var(--week-date-column)_minmax(0,1fr)] items-start gap-[var(--spacing-sm)] border-b border-line py-[var(--spacing-sm)] last:border-0"
    >
      <DateLabel day={day} isToday={isToday} />
      <Card className="min-w-0 rounded-[var(--radius-lg)] border-line p-[var(--spacing-sm)]">
        <div className="mb-[var(--spacing-sm)] flex flex-wrap items-center justify-between gap-[var(--spacing-xs)]">
          <span className="rounded-[var(--radius-sm)] border border-accent px-[var(--spacing-xs)] py-[var(--spacing-2xs)] text-xs font-semibold text-accent">
            いつもと違う日
          </span>
          {events.length === 0 && <span className="text-xs text-muted">予定なし</span>}
          <AddDayButton date={day.date} onAdd={onAdd} disabled={disabled} />
        </div>
        <ul className="m-0 list-none space-y-[var(--spacing-sm)] p-0">
          {events.map((event) => (
            <li key={event.id} className="min-w-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-[var(--spacing-sm)] gap-y-[var(--spacing-xs)] text-xs text-muted">
                <span className="tabular-nums">{formatEventTime(event.time, day.date)}</span>
                <EventBadges event={event} members={members} />
              </div>
              <EventEditButton event={event} onAdd={onAdd} onEdit={onEdit} disabled={disabled}>
                <span className="mt-[var(--spacing-xs)] flex min-h-[var(--tap-target-min)] min-w-0 flex-wrap items-center gap-x-[var(--spacing-sm)] gap-y-[var(--spacing-xs)]">
                  <EventMembers memberIds={event.memberIds} members={members} />
                  <span className="min-w-0 break-words text-sm font-semibold [overflow-wrap:anywhere]">
                    {event.title}
                  </span>
                </span>
              </EventEditButton>
              {event.items.length > 0 && (
                <div className="mt-[var(--spacing-sm)] flex min-w-0 max-w-full flex-wrap gap-[var(--spacing-xs)]">
                  {event.items.map((item, index) => (
                    <span
                      key={`${event.id}-item-${index}`}
                      className="inline-flex min-w-0 max-w-full items-start gap-[var(--spacing-xs)] rounded-[var(--radius-sm)] bg-deadline-tint px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-xs text-ink"
                    >
                      <ShoppingBag
                        size={14}
                        aria-hidden="true"
                        className="mt-[var(--spacing-2xs)] shrink-0"
                      />
                      <span className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
                        {item}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </li>
  );
}

function WeekendEvent({
  event,
  day,
  members,
  onAdd,
  onEdit,
  disabled,
}: { event: WeekEvent; day: WeekDay; members: WeekMember[] } & EventActions): React.ReactElement {
  const member = members.find((candidate) => event.memberIds.includes(candidate.id));
  const assignee = members.find((candidate) => candidate.id === event.assigneeMemberId);
  return (
    <li className="grid min-w-0 grid-cols-[var(--event-time-column)_minmax(0,1fr)] gap-[var(--spacing-xs)] py-[var(--spacing-xs)]">
      <time className="break-words pt-[var(--spacing-2xs)] text-xs tabular-nums text-muted [overflow-wrap:anywhere]">
        {formatEventTime(event.time, day.date)}
      </time>
      <div className="min-w-0">
        <EventEditButton event={event} onAdd={onAdd} onEdit={onEdit} disabled={disabled}>
          <span className="flex min-h-[var(--tap-target-min)] min-w-0 flex-wrap items-center gap-x-[var(--spacing-xs)] gap-y-[var(--spacing-xs)]">
            {member && (
              <span
                className="h-[var(--member-dot-size)] w-[var(--member-dot-size)] shrink-0 rounded-[var(--radius-full)]"
                aria-hidden="true"
                style={{ backgroundColor: memberColor(member) }}
              />
            )}
            <span className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">
              {event.title}
            </span>
            <EventBadges event={event} members={members} showAssignee={false} />
          </span>
        </EventEditButton>
        <div className="mt-[var(--spacing-2xs)] flex min-w-0 flex-wrap items-center gap-x-[var(--spacing-sm)] gap-y-[var(--spacing-xs)]">
          <EventMembers memberIds={event.memberIds} members={members} />
          {assignee && (
            <span className="min-w-0 break-words text-xs text-muted [overflow-wrap:anywhere]">
              担当 {assignee.name}
            </span>
          )}
          {event.items.map((item, index) => (
            <span
              key={`${event.id}-item-${index}`}
              className="inline-flex min-w-0 max-w-full items-start gap-[var(--spacing-xs)] rounded-[var(--radius-sm)] bg-deadline-tint px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-xs"
            >
              <ShoppingBag
                size={14}
                aria-hidden="true"
                className="mt-[var(--spacing-2xs)] shrink-0"
              />
              <span className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
                {item}
              </span>
            </span>
          ))}
        </div>
      </div>
    </li>
  );
}

function WeekendDay({
  day,
  events,
  members,
  isToday,
  longWeekendDayCount,
  onAdd,
  onEdit,
  disabled,
}: {
  day: WeekDay;
  events: WeekEvent[];
  members: WeekMember[];
  isToday: boolean;
  longWeekendDayCount?: number;
} & EventActions): React.ReactElement {
  return (
    <article
      aria-label={formatFullDateLabel(day.date)}
      data-testid="week-day"
      data-date={day.date}
      data-layout="weekend-card"
      className="mb-[var(--spacing-md)] rounded-[var(--radius-lg)] border border-transparent bg-surface p-[var(--spacing-md)] text-ink shadow-[var(--week-card-shadow)]"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-[var(--spacing-sm)]">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-[var(--spacing-sm)]">
          <DateLabel day={day} isToday={isToday} large />
          {day.holidayName && (
            <span className="break-words text-xs text-accent [overflow-wrap:anywhere]">
              {day.holidayName}
            </span>
          )}
          {longWeekendDayCount && (
            <span className="rounded-[var(--radius-full)] bg-accent px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-xs font-semibold text-surface">
              {longWeekendDayCount}連休
            </span>
          )}
        </div>
        <AddDayButton date={day.date} onAdd={onAdd} disabled={disabled} />
      </header>

      {(day.closures.length > 0 || day.holidayName) && (
        <div className="mt-[var(--spacing-sm)] flex flex-wrap gap-[var(--spacing-xs)]">
          {day.closures.map((closure, index) => (
            <Chip key={`${day.date}-closure-${index}`} className="max-w-full text-xs">
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{closure.label}</span>
            </Chip>
          ))}
          {day.holidayName && <Chip className="text-xs">祝日</Chip>}
        </div>
      )}

      {events.length > 0 ? (
        <ul className="mt-[var(--spacing-md)] mb-0 list-none divide-y divide-line p-0">
          {events.map((event) => (
            <WeekendEvent
              key={event.id}
              event={event}
              day={day}
              members={members}
              onAdd={onAdd}
              onEdit={onEdit}
              disabled={disabled}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-[var(--spacing-md)] mb-0 text-sm text-muted">予定なし</p>
      )}
    </article>
  );
}

function InvalidWeek(): React.ReactElement {
  return (
    <section
      role="alert"
      className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]"
    >
      <h2 className="m-0 text-base font-semibold">週の日付を確認してください</h2>
      <p className="mt-[var(--spacing-sm)] mb-0 text-sm leading-relaxed text-muted">
        1970年から2050年までの実在する日付を指定してください。
      </p>
    </section>
  );
}

export default function WeekPage({
  userId,
  familyId,
  familyName,
}: WeekPageProps): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const urlWeek = searchParams.get('week');
  const validUrlAnchor = parseWeekAnchor(urlWeek);
  const invalidUrlWeek = urlWeek !== null && validUrlAnchor === undefined;
  const currentMonday = getMondayAnchor(getTodayDateKey());
  const requestStart = invalidUrlWeek ? undefined : (validUrlAnchor ?? currentMonday);
  const previousStart = requestStart ? addCalendarWeeks(requestStart, -1) : undefined;
  const nextStart = requestStart ? addCalendarWeeks(requestStart, 1) : undefined;
  const [hideRoutines, setHideRoutines] = useState(false);
  const [eventEditor, setEventEditor] = useState<EventEditorState | null>(null);
  const [routineNotice, setRoutineNotice] = useState(false);
  const invokingControlRef = useRef<HTMLElement | null>(null);
  const addEventButtonRef = useRef<HTMLButtonElement | null>(null);
  const hadOpenEditorRef = useRef(false);
  const focusRestoreTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (requestStart === undefined || urlWeek === requestStart) return;
    const next = new URLSearchParams(searchParams);
    next.set('week', requestStart);
    setSearchParams(next, { replace: true });
  }, [requestStart, searchParams, setSearchParams, urlWeek]);

  const weekQuery = useWeekQuery(userId, invalidUrlWeek ? undefined : familyId, requestStart);
  const data = weekQuery.isError ? undefined : weekQuery.data;
  const canEditEvents = Boolean(data && !weekQuery.isPlaceholderData && !invalidUrlWeek);
  const longWeekendCounts = new Map(
    data ? getLongWeekendBadges(data.days).map((badge) => [badge.start, badge.dayCount]) : [],
  );

  const showWeek = (start: DateKey | undefined, replace = false) => {
    const next = new URLSearchParams(searchParams);
    if (start) next.set('week', start);
    else next.delete('week');
    setSearchParams(next, { replace });
  };

  const closeEventEditor = useCallback(() => setEventEditor(null), []);
  const openNewEvent = useCallback(
    (date: string | undefined, trigger: HTMLElement) => {
      if (!data) return;
      invokingControlRef.current = trigger;
      setRoutineNotice(false);
      setEventEditor({
        selectedDate: date as DateKey | undefined,
        members: data.members,
        clientRequestId: crypto.randomUUID(),
      });
    },
    [data],
  );
  const openEditEvent = useCallback(
    (event: WeekEvent, trigger: HTMLElement) => {
      if (!data) return;
      invokingControlRef.current = trigger;
      if (event.isRoutine) {
        setRoutineNotice(true);
        return;
      }
      setRoutineNotice(false);
      setEventEditor({ event, members: data.members, clientRequestId: crypto.randomUUID() });
    },
    [data],
  );

  useEffect(() => {
    if (eventEditor) {
      if (focusRestoreTimerRef.current !== undefined) {
        window.clearTimeout(focusRestoreTimerRef.current);
        focusRestoreTimerRef.current = undefined;
      }
      hadOpenEditorRef.current = true;
      return;
    }
    if (hadOpenEditorRef.current) {
      hadOpenEditorRef.current = false;
      focusRestoreTimerRef.current = window.setTimeout(() => {
        focusRestoreTimerRef.current = undefined;
        if (document.querySelector('dialog[open]')) return;
        if (invokingControlRef.current?.isConnected) invokingControlRef.current.focus();
        else addEventButtonRef.current?.focus();
        invokingControlRef.current = null;
      }, 0);
    }
  }, [eventEditor]);

  const clearSessionAfterUnauthorized = useCallback(async () => {
    if (queryClient.getQueryData<AuthUser | null>(['session'])?.id !== userId) return;
    await queryClient.cancelQueries({ queryKey: ['session'] });
    if (queryClient.getQueryData<AuthUser | null>(['session'])?.id !== userId) return;
    queryClient.setQueryData(['session'], null);
    await queryClient.cancelQueries({ queryKey: ['week', userId] });
    await queryClient.cancelQueries({ queryKey: ['families', userId] });
    queryClient.removeQueries({ queryKey: ['week', userId] });
    queryClient.removeQueries({ queryKey: ['families', userId] });
  }, [queryClient, userId]);

  const closeEventEditorFromHistory = useCallback(() => {
    if (
      window.history.state?.danranEventDialog === `event-dialog-${eventEditor?.clientRequestId}`
    ) {
      window.history.back();
    }
    closeEventEditor();
  }, [closeEventEditor, eventEditor?.clientRequestId]);

  useEffect(() => {
    if (
      weekQuery.error instanceof WeekApiError &&
      weekQuery.error.status === 401 &&
      weekQuery.error.code === 'UNAUTHORIZED'
    ) {
      void (async () => {
        if (queryClient.getQueryData<AuthUser | null>(['session'])?.id !== userId) return;
        await queryClient.cancelQueries({ queryKey: ['session'] });
        if (queryClient.getQueryData<AuthUser | null>(['session'])?.id !== userId) return;
        queryClient.setQueryData(['session'], null);
        await queryClient.cancelQueries({ queryKey: ['week', userId] });
        await queryClient.cancelQueries({ queryKey: ['families', userId] });
        queryClient.removeQueries({ queryKey: ['week', userId] });
        queryClient.removeQueries({ queryKey: ['families', userId] });
      })();
    }
  }, [queryClient, userId, weekQuery.error]);

  const onCapture = () => navigate('/import');
  const error = weekQuery.error;
  const unauthorized =
    error instanceof WeekApiError && error.status === 401 && error.code === 'UNAUTHORIZED';
  const needsGoogleReauth = error instanceof WeekApiError && error.code === 'REAUTH_REQUIRED';
  const invalidApiRange = error instanceof WeekApiError && error.code === 'INVALID_INPUT';
  const calendarAccessDenied =
    error instanceof WeekApiError && error.code === 'CALENDAR_ACCESS_DENIED';

  return (
    <AuthenticatedShell activeTab="week" onCapture={onCapture} mainTestId="home-screen">
      <OAuthNotices />
      <header className="mb-[var(--spacing-lg)]">
        <p className="m-0 min-w-0 max-w-full break-words text-sm text-muted [overflow-wrap:anywhere]">
          {familyName}
        </p>
        <div className="mt-[var(--spacing-xs)] flex items-center justify-between gap-[var(--spacing-sm)]">
          <div className="min-w-0">
            {data ? (
              <>
                <p className="m-0 text-sm text-muted">
                  {formatMonthHeading(data.week.start, data.week.endInclusive)}
                </p>
                <h1 className="m-0 break-words text-3xl font-semibold tracking-tight">
                  {formatWeekPeriod(data.week.start, data.week.endInclusive)}
                </h1>
              </>
            ) : (
              <h1 className="m-0 text-2xl font-bold">週の予定</h1>
            )}
            {weekQuery.isFetching && data && (
              <p data-testid="week-updating" aria-live="polite" className="m-0 text-xs text-muted">
                更新中...
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-[var(--spacing-xs)]">
            <button
              type="button"
              aria-label="前の週"
              disabled={!previousStart}
              onClick={() => previousStart && showWeek(previousStart)}
              className="inline-flex h-[var(--tap-target-min)] w-[var(--tap-target-min)] items-center justify-center rounded-[var(--radius-full)] border border-line bg-surface text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ArrowLeft size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="次の週"
              disabled={!nextStart}
              onClick={() => nextStart && showWeek(nextStart)}
              className="inline-flex h-[var(--tap-target-min)] w-[var(--tap-target-min)] items-center justify-center rounded-[var(--radius-full)] border border-line bg-surface text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ArrowRight size={20} aria-hidden="true" />
            </button>
          </div>
        </div>
        {data && <MemberLegend members={data.members} />}
      </header>

      {invalidUrlWeek ? (
        <>
          <InvalidWeek />
          <button
            type="button"
            onClick={() => showWeek(currentMonday, true)}
            className="mt-[var(--spacing-md)] min-h-[var(--tap-target-min)] w-full rounded-[var(--radius-md)] bg-accent px-[var(--spacing-md)] text-sm font-semibold text-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            今週へ
          </button>
        </>
      ) : weekQuery.isLoading ? (
        <section
          aria-live="polite"
          className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-lg)] text-center"
        >
          <RefreshCw
            size={24}
            aria-hidden="true"
            className="mx-auto mb-[var(--spacing-sm)] animate-spin text-accent"
          />
          <p className="m-0 text-sm text-muted">週の予定を読み込み中...</p>
        </section>
      ) : weekQuery.isError || !data ? (
        <section
          role="alert"
          className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]"
        >
          <div className="flex items-start gap-[var(--spacing-sm)]">
            <AlertCircle
              size={20}
              aria-hidden="true"
              className="mt-[var(--spacing-2xs)] shrink-0 text-accent"
            />
            <div className="min-w-0">
              <h2 className="m-0 text-sm font-semibold">
                {unauthorized
                  ? 'ログインが必要です'
                  : invalidApiRange
                    ? '週の日付を確認してください'
                    : needsGoogleReauth
                      ? 'Google カレンダーの再認証が必要です'
                      : calendarAccessDenied
                        ? '家族カレンダーにアクセスできません'
                        : '週の予定を取得できませんでした'}
              </h2>
              <p className="mt-[var(--spacing-xs)] mb-0 break-words text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
                {unauthorized
                  ? 'セッションの有効期限が切れました。Google で再度ログインしてください。'
                  : invalidApiRange
                    ? '祝日を含めた週の範囲が対応期間外です。今週の予定を表示してください。'
                    : needsGoogleReauth
                      ? 'Google で再度ログインすると家族カレンダーを読み込めます。'
                      : calendarAccessDenied
                        ? '家族カレンダーが共有されているか、オーナーに確認してください。'
                        : error instanceof WeekApiError && error.code
                          ? error.message
                          : '予定を読み込めませんでした。通信状態を確認して、もう一度お試しください。'}
              </p>
            </div>
          </div>
          <div className="mt-[var(--spacing-md)] flex flex-col gap-[var(--spacing-sm)]">
            {unauthorized ? (
              <button
                type="button"
                data-testid="login-button"
                onClick={() => window.location.assign('/api/auth/login')}
                className="min-h-[var(--tap-target-min)] rounded-[var(--radius-md)] bg-accent px-[var(--spacing-md)] text-sm font-semibold text-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Google でログイン
              </button>
            ) : needsGoogleReauth ? (
              <button
                type="button"
                onClick={() => window.location.assign('/api/auth/login')}
                className="min-h-[var(--tap-target-min)] rounded-[var(--radius-md)] bg-accent px-[var(--spacing-md)] text-sm font-semibold text-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Google で再ログイン
              </button>
            ) : invalidApiRange ? (
              <button
                type="button"
                onClick={() => showWeek(currentMonday, true)}
                className="min-h-[var(--tap-target-min)] rounded-[var(--radius-md)] bg-accent px-[var(--spacing-md)] text-sm font-semibold text-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                今週へ
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void weekQuery.refetch()}
                className="inline-flex min-h-[var(--tap-target-min)] items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] border border-line bg-surface px-[var(--spacing-md)] text-sm font-medium hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <RefreshCw size={16} aria-hidden="true" />
                再試行
              </button>
            )}
          </div>
        </section>
      ) : (
        <>
          <div className="mb-[var(--spacing-md)] flex justify-end">
            <button
              type="button"
              ref={addEventButtonRef}
              data-testid="add-event"
              disabled={!canEditEvents}
              onClick={(clickEvent) => openNewEvent(undefined, clickEvent.currentTarget)}
              className="inline-flex min-h-[var(--tap-target-min)] items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] bg-accent px-[var(--spacing-md)] text-sm font-semibold text-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
            >
              <Plus size={18} aria-hidden="true" />
              予定を追加
            </button>
          </div>
          {data.week.start !== getMondayAnchor(data.week.today) && (
            <button
              type="button"
              onClick={() => showWeek(getMondayAnchor(data.week.today))}
              className="mb-[var(--spacing-md)] inline-flex min-h-[var(--tap-target-min)] items-center gap-[var(--spacing-xs)] rounded-[var(--radius-full)] border border-line bg-surface px-[var(--spacing-md)] text-sm font-medium text-ink hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <CalendarDays size={16} aria-hidden="true" />
              今週へ
            </button>
          )}

          <section aria-labelledby="weekday-heading">
            <div className="flex flex-wrap items-center justify-between gap-[var(--spacing-sm)] border-b border-line pb-[var(--spacing-sm)]">
              <h2 id="weekday-heading" className="m-0 text-sm font-semibold tracking-wide">
                平日 いつもどおり
              </h2>
              <button
                type="button"
                aria-pressed={hideRoutines}
                onClick={() => setHideRoutines((value) => !value)}
                className="inline-flex min-h-[var(--tap-target-min)] items-center rounded-[var(--radius-sm)] px-[var(--spacing-xs)] text-xs text-muted underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {hideRoutines ? 'ルーティンを表示' : 'ルーティンを隠す'}
              </button>
            </div>
            <ul className="m-0 list-none p-0">
              {[...data.days]
                .sort((left, right) => left.date.localeCompare(right.date))
                .filter((day) => day.layout !== 'weekend-card')
                .map((day) => {
                  const events = getVisibleEvents(day, data, hideRoutines);
                  const isToday = day.date === data.week.today;
                  return getVisibleDayLayout(day, events) === 'expanded' ? (
                    <ExpandedDay
                      key={day.date}
                      day={day}
                      events={events}
                      members={data.members}
                      isToday={isToday}
                      onAdd={(date, trigger) => openNewEvent(date, trigger)}
                      onEdit={openEditEvent}
                      disabled={!canEditEvents}
                    />
                  ) : (
                    <CompactDay
                      key={day.date}
                      day={day}
                      events={events}
                      members={data.members}
                      isToday={isToday}
                      onAdd={(date, trigger) => openNewEvent(date, trigger)}
                      onEdit={openEditEvent}
                      disabled={!canEditEvents}
                    />
                  );
                })}
            </ul>
          </section>

          <section aria-labelledby="weekend-heading" className="mt-[var(--spacing-xl)]">
            <div className="mb-[var(--spacing-md)] flex items-center justify-between gap-[var(--spacing-sm)]">
              <h2 id="weekend-heading" className="m-0 text-base font-bold text-accent">
                週末・祝日
              </h2>
            </div>
            {[...data.days]
              .sort((left, right) => left.date.localeCompare(right.date))
              .filter((day) => day.layout === 'weekend-card')
              .map((day) => (
                <WeekendDay
                  key={day.date}
                  day={day}
                  events={getVisibleEvents(day, data, hideRoutines)}
                  members={data.members}
                  isToday={day.date === data.week.today}
                  longWeekendDayCount={longWeekendCounts.get(day.date)}
                  onAdd={(date, trigger) => openNewEvent(date, trigger)}
                  onEdit={openEditEvent}
                  disabled={!canEditEvents}
                />
              ))}
          </section>
          {routineNotice && (
            <output
              data-testid="routine-event-notice"
              className="mt-[var(--spacing-md)] block rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-sm)] text-sm text-muted"
            >
              繰り返し予定の変更は準備中です。
            </output>
          )}
          <p className="mt-[var(--spacing-md)] min-w-0 max-w-full break-words text-center text-xs text-muted [overflow-wrap:anywhere]">
            {data.family.name}の家族予定
          </p>
        </>
      )}
      {eventEditor && (
        <EventDialog
          familyId={familyId}
          userId={userId}
          members={eventEditor.members}
          event={eventEditor.event}
          selectedDate={eventEditor.selectedDate}
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
          className="inline-flex min-h-[var(--tap-target-min)] items-center justify-center rounded-[var(--radius-sm)] px-[var(--spacing-md)] py-[var(--spacing-xs)] text-xs text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          プライバシーポリシー
        </Link>
      </footer>
    </AuthenticatedShell>
  );
}
