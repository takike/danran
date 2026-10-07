import { PersonalEventsApiError } from '@client/api/personal';
import { WeekApiError } from '@client/api/week';
import { BusyWeekApiError } from '@client/api/week-busy';
import { AuthenticatedShell } from '@client/components/AuthenticatedShell';
import { Card } from '@client/components/Card';
import { Chip } from '@client/components/Chip';
import { MemberDot } from '@client/components/MemberDot';
import { OAuthNotices } from '@client/components/OAuthNotices';
import {
  PERSONAL_CALENDARS_QUERY_KEY,
  PERSONAL_WEEK_QUERY_KEY,
  usePersonalWeekQuery,
} from '@client/features/settings/usePersonalEvents';
import { BusyTimeline } from '@client/features/week/BusyTimeline';
import { EventDialog } from '@client/features/week/EventDialog';
import { BUSY_WEEK_QUERY_KEY, useBusyWeekQuery } from '@client/features/week/useBusyWeek';
import { useWeekQuery } from '@client/features/week/useWeek';
import { type ConflictEvent, getRoutineConflicts } from '@shared/domain/conflicts';
import {
  type PersonalCalendarEvent,
  getPersonalEventsForDate,
  mergeCalendarDayEntries,
} from '@shared/domain/personalEvents';
import { getRoutineExceptionLabel } from '@shared/domain/routineExceptionLabel';
import {
  getLongWeekendBadges,
  getVisibleDayEvents,
  getVisibleDayLayout,
} from '@shared/domain/weekPresentation';
import { type BusyTimelineData, buildDayBusyTimeline } from '@shared/domain/weekendTimeline';
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
  CircleAlert,
  LockKeyhole,
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
  selfMemberId?: string;
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
  isConflicted = false,
}: {
  event: WeekEvent;
  members: WeekMember[];
  showAssignee?: boolean;
  isConflicted?: boolean;
}): React.ReactElement | null {
  const assignee = showAssignee
    ? members.find((member) => member.id === event.assigneeMemberId)
    : undefined;
  if (
    !assignee &&
    event.status !== 'tentative' &&
    !event.isRecurring &&
    !event.movedFrom &&
    !isConflicted
  )
    return null;
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
      {event.isRecurring && (
        <span className="inline-flex items-center gap-[var(--spacing-2xs)] text-xs text-muted">
          <Repeat size={12} aria-hidden="true" className="shrink-0" />
          繰り返し
        </span>
      )}
      {getRoutineExceptionLabel(event) && (
        <span className="text-xs text-accent">{getRoutineExceptionLabel(event)}</span>
      )}
      {isConflicted && <ConflictBadge eventId={event.id} />}
    </span>
  );
}

function ConflictBadge({ eventId }: { eventId: string }): React.ReactElement {
  return (
    <span
      data-testid={`week-event-conflict-${eventId}`}
      className="inline-flex shrink-0 items-center gap-[var(--spacing-2xs)] rounded-[var(--radius-sm)] border border-line bg-chip px-[var(--spacing-xs)] py-[var(--spacing-2xs)] text-xs font-semibold text-muted"
    >
      <CircleAlert size={13} aria-hidden="true" className="shrink-0" />
      重複
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

function RoutineChip({
  event,
  isConflicted,
}: { event: WeekEvent; isConflicted: boolean }): React.ReactElement {
  return (
    <span className="inline-flex min-h-[var(--week-chip-min-height)] max-w-full items-center gap-[var(--spacing-xs)] rounded-[var(--radius-sm)] bg-chip px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-xs text-muted">
      {event.isRecurring && <Repeat size={14} aria-hidden="true" className="shrink-0" />}
      <span className="break-words [overflow-wrap:anywhere]">{event.title}</span>
      <span className="break-words tabular-nums [overflow-wrap:anywhere]">
        {formatEventTime(event.time)}
      </span>
      {isConflicted && <ConflictBadge eventId={event.id} />}
    </span>
  );
}

function PersonalEventLabel({
  event,
  member,
  date,
}: {
  event: PersonalCalendarEvent;
  member?: WeekMember;
  date: DateKey;
}): React.ReactElement {
  return (
    <span
      data-testid={`personal-event-${event.id}`}
      className="inline-flex min-h-[var(--week-chip-min-height)] min-w-0 max-w-full flex-wrap items-center gap-x-[var(--spacing-xs)] gap-y-[var(--spacing-2xs)] rounded-[var(--radius-sm)] border border-dashed bg-surface px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-xs text-ink"
      style={{ borderColor: member ? `var(--member-${member.color})` : 'var(--line)' }}
    >
      <LockKeyhole size={13} aria-hidden="true" className="shrink-0 text-muted" />
      <span className="shrink-0 text-muted">自分だけ</span>
      <span className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">
        {event.title}
      </span>
      {event.isRoutine && <span className="shrink-0 text-muted">繰り返し</span>}
      <span className="shrink-0 tabular-nums text-muted">{formatEventTime(event.time, date)}</span>
    </span>
  );
}

function PersonalEventRow({
  event,
  member,
  date,
}: {
  event: PersonalCalendarEvent;
  member?: WeekMember;
  date: DateKey;
}): React.ReactElement {
  return (
    <li
      data-testid={`personal-event-${event.id}`}
      className="grid min-w-0 grid-cols-[var(--event-time-column)_minmax(0,1fr)] gap-[var(--spacing-xs)] py-[var(--spacing-xs)]"
    >
      <time className="break-words pt-[var(--spacing-2xs)] text-xs tabular-nums text-muted [overflow-wrap:anywhere]">
        {formatEventTime(event.time, date)}
      </time>
      <div
        className="min-w-0 rounded-[var(--radius-sm)] border border-dashed bg-surface px-[var(--spacing-sm)] py-[var(--spacing-xs)]"
        style={{ borderColor: member ? `var(--member-${member.color})` : 'var(--line)' }}
      >
        <div className="flex min-h-[var(--tap-target-min)] min-w-0 flex-wrap items-center gap-x-[var(--spacing-xs)] gap-y-[var(--spacing-xs)]">
          <LockKeyhole size={14} aria-hidden="true" className="shrink-0 text-muted" />
          <span className="shrink-0 text-xs text-muted">自分だけ</span>
          <span className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">
            {event.title}
          </span>
          {event.isRoutine && <span className="text-xs text-muted">繰り返し</span>}
        </div>
      </div>
    </li>
  );
}

function PersonalEventsDialog({
  date,
  events,
  member,
  onClose,
}: {
  date: DateKey;
  events: PersonalCalendarEvent[];
  member?: WeekMember;
  onClose: () => void;
}): React.ReactElement {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      data-testid="personal-events-dialog"
      aria-labelledby="personal-events-dialog-title"
      onClose={onClose}
      className="m-auto max-h-[85dvh] w-[calc(100%-var(--spacing-lg))] max-w-[var(--app-max-width)] overflow-y-auto rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)] text-ink shadow-[var(--week-card-shadow)] backdrop:bg-ink/40"
    >
      <header className="flex items-start justify-between gap-[var(--spacing-sm)]">
        <div className="min-w-0">
          <h2 id="personal-events-dialog-title" className="m-0 text-base font-semibold">
            {formatFullDateLabel(date)}の自分の予定
          </h2>
          <p className="mt-[var(--spacing-2xs)] mb-0 text-xs text-muted">
            家族には表示されません。
          </p>
        </div>
        <button
          type="button"
          data-testid="personal-events-dialog-close"
          onClick={() => dialogRef.current?.close()}
          className="min-h-[var(--tap-target-min)] shrink-0 rounded-[var(--radius-sm)] px-[var(--spacing-sm)] text-sm text-muted underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          閉じる
        </button>
      </header>
      <ul className="mt-[var(--spacing-sm)] mb-0 list-none divide-y divide-line p-0">
        {events.map((event) => (
          <PersonalEventRow key={event.id} event={event} member={member} date={date} />
        ))}
      </ul>
    </dialog>
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
  isConflicted = false,
  onEdit,
  disabled,
  children,
  className = '',
  ariaDescribedBy,
}: EventActions & {
  event: WeekEvent;
  isConflicted?: boolean;
  children: React.ReactNode;
  className?: string;
  ariaDescribedBy?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      data-testid={`edit-event-${event.id}`}
      aria-label={`予定を編集: ${event.title}${isConflicted ? '、重複' : ''}`}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={(clickEvent) => onEdit(event, clickEvent.currentTarget)}
      className={`inline-flex min-h-[var(--tap-target-min)] min-w-[var(--tap-target-min)] max-w-full items-center rounded-[var(--radius-sm)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-60 ${className}`.trim()}
    >
      {children}
    </button>
  );
}

function CompactDay({
  day,
  events,
  conflictEventIds,
  personalEvents,
  members,
  personalMember,
  isToday,
  onAdd,
  onEdit,
  disabled,
  onShowMorePersonal,
}: {
  day: WeekDay;
  events: WeekEvent[];
  conflictEventIds: ReadonlySet<string>;
  personalEvents: PersonalCalendarEvent[];
  members: WeekMember[];
  personalMember?: WeekMember;
  isToday: boolean;
  onShowMorePersonal: (
    day: DateKey,
    events: PersonalCalendarEvent[],
    trigger: HTMLButtonElement,
  ) => void;
} & EventActions): React.ReactElement {
  const routineEvents = events.filter((event) => event.isRoutine);
  const otherEvents = events.filter((event) => !event.isRoutine);
  return (
    <li
      data-testid="week-day"
      data-date={day.date}
      data-layout="compact"
      aria-label={`${formatFullDateLabel(day.date)}${events.length === 0 && personalEvents.length === 0 ? '、予定なし' : ''}`}
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
            isConflicted={conflictEventIds.has(event.id)}
            onAdd={onAdd}
            onEdit={onEdit}
            disabled={disabled}
          >
            <RoutineChip event={event} isConflicted={conflictEventIds.has(event.id)} />
          </EventEditButton>
        ))}
        {otherEvents.map((event) => (
          <EventEditButton
            key={event.id}
            event={event}
            isConflicted={conflictEventIds.has(event.id)}
            onAdd={onAdd}
            onEdit={onEdit}
            disabled={disabled}
          >
            <span className="inline-flex min-h-[var(--week-chip-min-height)] max-w-full flex-wrap items-center gap-x-[var(--spacing-xs)] gap-y-[var(--spacing-2xs)] rounded-[var(--radius-sm)] bg-accent-tint px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-xs text-ink">
              <EventMembers memberIds={event.memberIds} members={members} />
              <span className="break-words font-medium [overflow-wrap:anywhere]">
                {event.title}
              </span>
              <EventBadges
                event={event}
                members={members}
                isConflicted={conflictEventIds.has(event.id)}
              />
            </span>
          </EventEditButton>
        ))}
        {personalEvents.slice(0, 2).map((event) => (
          <PersonalEventLabel
            key={`personal-${event.id}`}
            event={event}
            member={personalMember}
            date={day.date}
          />
        ))}
        {personalEvents.length > 2 && (
          <button
            type="button"
            data-testid={`personal-events-more-${day.date}`}
            aria-label={`${formatFullDateLabel(day.date)}の自分の予定をすべて表示（ほか${personalEvents.length - 2}件）`}
            onClick={(clickEvent) =>
              onShowMorePersonal(day.date, personalEvents, clickEvent.currentTarget)
            }
            className="inline-flex min-h-[var(--tap-target-min)] items-center rounded-[var(--radius-sm)] px-[var(--spacing-sm)] text-xs text-muted underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            ほか {personalEvents.length - 2} 件
          </button>
        )}
        {events.length === 0 && personalEvents.length === 0 && (
          <span className="sr-only">予定なし</span>
        )}
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
  conflictEventIds,
  personalEvents,
  members,
  personalMember,
  isToday,
  onAdd,
  onEdit,
  disabled,
}: {
  day: WeekDay;
  events: WeekEvent[];
  conflictEventIds: ReadonlySet<string>;
  personalEvents: PersonalCalendarEvent[];
  members: WeekMember[];
  personalMember?: WeekMember;
  isToday: boolean;
} & EventActions): React.ReactElement {
  const entries = mergeCalendarDayEntries(events, personalEvents);
  return (
    <li
      data-testid="week-day"
      data-date={day.date}
      data-layout="expanded"
      aria-label={formatFullDateLabel(day.date)}
      className="grid grid-cols-[var(--week-date-column)_minmax(0,1fr)_var(--tap-target-min)] items-start gap-[var(--spacing-sm)] border-b border-line py-[var(--spacing-sm)] last:border-0"
    >
      <DateLabel day={day} isToday={isToday} />
      <Card
        data-testid="expanded-day-card"
        className="min-w-0 rounded-[var(--radius-lg)] border-line p-[var(--spacing-sm)]"
      >
        <div className="mb-[var(--spacing-2xs)] flex flex-wrap items-center gap-[var(--spacing-xs)]">
          <span className="rounded-[var(--radius-sm)] border border-accent px-[var(--spacing-xs)] py-[var(--spacing-2xs)] text-xs font-semibold text-accent">
            いつもと違う日
          </span>
          {entries.length === 0 && <span className="text-xs text-muted">予定なし</span>}
        </div>
        <ul className="m-0 list-none space-y-[var(--spacing-xs)] p-0">
          {entries.map((entry) => {
            if (entry.kind === 'personal') {
              return (
                <PersonalEventRow
                  key={`personal-${entry.event.id}`}
                  event={entry.event}
                  member={personalMember}
                  date={day.date}
                />
              );
            }
            const event = entry.event;
            return (
              <li key={event.id} className="flex min-w-0 flex-col">
                <EventEditButton
                  event={event}
                  isConflicted={conflictEventIds.has(event.id)}
                  onAdd={onAdd}
                  onEdit={onEdit}
                  disabled={disabled}
                  className="w-full flex-col items-stretch py-0"
                  ariaDescribedBy={`expanded-event-details-${event.id}-${day.date}`}
                >
                  <span
                    id={`expanded-event-details-${event.id}-${day.date}`}
                    data-testid={`expanded-event-meta-${event.id}`}
                    className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-[var(--spacing-xs)] text-xs text-muted"
                  >
                    <span className="tabular-nums">{formatEventTime(event.time, day.date)}</span>
                    <span className="w-fit min-w-0 max-w-full justify-self-end">
                      <EventBadges
                        event={event}
                        members={members}
                        isConflicted={conflictEventIds.has(event.id)}
                      />
                    </span>
                  </span>
                  <span
                    data-testid={`expanded-event-title-row-${event.id}`}
                    className="flex min-w-0 flex-wrap items-center gap-x-[var(--spacing-sm)] gap-y-[var(--spacing-xs)]"
                  >
                    <EventMembers memberIds={event.memberIds} members={members} />
                    <span className="min-w-0 break-words text-sm font-semibold [overflow-wrap:anywhere]">
                      {event.title}
                    </span>
                  </span>
                </EventEditButton>
                {event.items.length > 0 && (
                  <div className="mt-[var(--spacing-xs)] flex min-w-0 max-w-full flex-wrap gap-[var(--spacing-xs)]">
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
            );
          })}
        </ul>
      </Card>
      <AddDayButton date={day.date} onAdd={onAdd} disabled={disabled} />
    </li>
  );
}

function WeekendEvent({
  event,
  day,
  members,
  isConflicted,
  onAdd,
  onEdit,
  disabled,
}: {
  event: WeekEvent;
  day: WeekDay;
  members: WeekMember[];
  isConflicted: boolean;
} & EventActions): React.ReactElement {
  const member = members.find((candidate) => event.memberIds.includes(candidate.id));
  const assignee = members.find((candidate) => candidate.id === event.assigneeMemberId);
  return (
    <li className="grid min-w-0 grid-cols-[var(--event-time-column)_minmax(0,1fr)] gap-[var(--spacing-xs)] py-[var(--spacing-xs)]">
      <time className="break-words pt-[var(--spacing-2xs)] text-xs tabular-nums text-muted [overflow-wrap:anywhere]">
        {formatEventTime(event.time, day.date)}
      </time>
      <div className="min-w-0">
        <EventEditButton
          event={event}
          isConflicted={isConflicted}
          onAdd={onAdd}
          onEdit={onEdit}
          disabled={disabled}
        >
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
            <EventBadges
              event={event}
              members={members}
              showAssignee={false}
              isConflicted={isConflicted}
            />
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
  weekStart,
  availability,
  selfMemberId,
  events,
  conflictEventIds,
  personalEvents,
  members,
  personalMember,
  isToday,
  longWeekendDayCount,
  onAdd,
  onEdit,
  disabled,
}: {
  day: WeekDay;
  weekStart: DateKey;
  availability: BusyTimelineData;
  selfMemberId?: string;
  events: WeekEvent[];
  conflictEventIds: ReadonlySet<string>;
  personalEvents: PersonalCalendarEvent[];
  members: WeekMember[];
  personalMember?: WeekMember;
  isToday: boolean;
  longWeekendDayCount?: number;
} & EventActions): React.ReactElement {
  const entries = mergeCalendarDayEntries(events, personalEvents);
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
        <div className="ml-auto flex shrink-0 flex-col items-end gap-[var(--spacing-xs)]">
          {availability.kind === 'ready' && availability.freeTimeLabel && (
            <span
              data-testid={`busy-common-summary-${day.date}`}
              className="text-right text-xs font-semibold tabular-nums text-accent"
            >
              {availability.freeTimeLabel}
            </span>
          )}
          <AddDayButton date={day.date} onAdd={onAdd} disabled={disabled} />
        </div>
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

      {entries.length > 0 ? (
        <ul className="mt-[var(--spacing-md)] mb-0 list-none divide-y divide-line p-0">
          {entries.map((entry) =>
            entry.kind === 'personal' ? (
              <PersonalEventRow
                key={`personal-${entry.event.id}`}
                event={entry.event}
                member={personalMember}
                date={day.date}
              />
            ) : (
              <WeekendEvent
                key={entry.event.id}
                event={entry.event}
                day={day}
                members={members}
                isConflicted={conflictEventIds.has(entry.event.id)}
                onAdd={onAdd}
                onEdit={onEdit}
                disabled={disabled}
              />
            ),
          )}
        </ul>
      ) : (
        <p className="mt-[var(--spacing-md)] mb-0 text-sm text-muted">予定なし</p>
      )}
      <BusyTimeline date={day.date} data={availability} selfMemberId={selfMemberId} />
      <div className="mt-[var(--spacing-xs)] flex justify-end">
        <Link
          to={`/day/${day.date}`}
          state={{ weekStart }}
          data-testid={`weekend-day-link-${day.date}`}
          className="inline-flex min-h-[var(--tap-target-min)] items-center rounded-[var(--radius-sm)] px-[var(--spacing-sm)] text-sm font-medium text-accent underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          この日を詳しく見る
        </Link>
      </div>
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
  selfMemberId,
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
  const [personalDialog, setPersonalDialog] = useState<{
    identity: string;
    date: DateKey;
  } | null>(null);
  const [revokedPersonalIdentity, setRevokedPersonalIdentity] = useState<string | null>(null);
  const [revokedBusyIdentity, setRevokedBusyIdentity] = useState<string | null>(null);
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

  // Reset scope-bound dialog and access state when the authenticated week identity changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity is intentionally used as a transition key.
  useEffect(() => {
    setRevokedPersonalIdentity(null);
    setRevokedBusyIdentity(null);
    setPersonalDialog(null);
  }, [userId, familyId, requestStart]);

  const weekQuery = useWeekQuery(userId, invalidUrlWeek ? undefined : familyId, requestStart);
  const data = weekQuery.isError ? undefined : weekQuery.data;
  const personalIdentity = `${userId}:${familyId}:${requestStart ?? ''}`;
  const personalWeekQuery = usePersonalWeekQuery(
    userId,
    familyId,
    requestStart,
    !invalidUrlWeek && revokedPersonalIdentity !== personalIdentity,
  );
  const busyIdentity = `${userId}:${familyId}:${requestStart ?? ''}`;
  const busyWeekQuery = useBusyWeekQuery(
    userId,
    familyId,
    requestStart,
    !invalidUrlWeek && revokedBusyIdentity !== busyIdentity,
  );
  const personalResponse =
    personalWeekQuery.isError || personalWeekQuery.isFetching ? undefined : personalWeekQuery.data;
  const personalResponseMatches = Boolean(
    personalResponse &&
      requestStart &&
      data &&
      data.week.start === requestStart &&
      personalResponse.family.id === familyId &&
      personalResponse.week.start === requestStart &&
      personalResponse.week.start === data.week.start &&
      personalResponse.family.id === data.family.id,
  );
  const personalEvents =
    personalResponseMatches && personalResponse?.status === 'ready' ? personalResponse.events : [];
  const personalMember =
    personalResponseMatches && data
      ? data.members.find((member) => member.id === personalResponse?.memberId)
      : undefined;
  const busyResponse =
    busyWeekQuery.isError || busyWeekQuery.isFetching || weekQuery.isPlaceholderData
      ? undefined
      : busyWeekQuery.data;
  const busyResponseMatches = Boolean(
    busyResponse &&
      requestStart &&
      data &&
      !weekQuery.isPlaceholderData &&
      data.week.start === requestStart &&
      busyResponse.family.id === familyId &&
      busyResponse.family.id === data.family.id &&
      busyResponse.week.start === requestStart &&
      busyResponse.week.start === data.week.start &&
      busyResponse.week.endInclusive === data.week.endInclusive,
  );
  const busyQueryError =
    revokedBusyIdentity === busyIdentity ||
    busyWeekQuery.isError ||
    (!busyWeekQuery.isFetching &&
      !busyWeekQuery.isPending &&
      !weekQuery.isPlaceholderData &&
      !busyResponseMatches);
  const busyTimelineKind: BusyTimelineData['kind'] = busyQueryError
    ? 'error'
    : busyWeekQuery.isLoading || busyWeekQuery.isFetching || weekQuery.isPlaceholderData
      ? 'loading'
      : busyResponseMatches
        ? 'ready'
        : 'error';
  const canEditEvents = Boolean(data && !weekQuery.isPlaceholderData && !invalidUrlWeek);
  const conflictEventIds = new Set(
    data
      ? getRoutineConflicts(
          data.events.map(
            (event): ConflictEvent => ({
              id: event.id,
              time: event.time,
              memberIds: event.memberIds,
              assigneeMemberId: event.assigneeMemberId,
              status: event.status,
              isRecurring: event.isRecurring,
            }),
          ),
          data.members.map((member) => member.id),
        ).flatMap((conflict) => [conflict.routineInstanceId, conflict.eventId])
      : [],
  );
  const longWeekendCounts = new Map(
    data ? getLongWeekendBadges(data.days).map((badge) => [badge.start, badge.dayCount]) : [],
  );
  const timelineForDay = (date: DateKey): BusyTimelineData => {
    if (busyTimelineKind !== 'ready' || !busyResponseMatches || !data || !busyResponse) {
      return {
        kind: busyTimelineKind,
        rows: [],
        commonFreeWindows: [],
        hasUnavailableMember: false,
        hasNotSharedMember: false,
      };
    }
    return buildDayBusyTimeline(date, data, busyResponse);
  };

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
      if (event.isRecurring) {
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
    await queryClient.cancelQueries({ queryKey: [...PERSONAL_WEEK_QUERY_KEY, userId] });
    await queryClient.cancelQueries({ queryKey: [...PERSONAL_CALENDARS_QUERY_KEY, userId] });
    await queryClient.cancelQueries({ queryKey: [...BUSY_WEEK_QUERY_KEY, userId] });
    queryClient.removeQueries({ queryKey: ['week', userId] });
    queryClient.removeQueries({ queryKey: ['families', userId] });
    queryClient.removeQueries({ queryKey: [...PERSONAL_WEEK_QUERY_KEY, userId] });
    queryClient.removeQueries({ queryKey: [...PERSONAL_CALENDARS_QUERY_KEY, userId] });
    queryClient.removeQueries({ queryKey: [...BUSY_WEEK_QUERY_KEY, userId] });
  }, [queryClient, userId]);

  useEffect(() => {
    const error = personalWeekQuery.error;
    if (!(error instanceof PersonalEventsApiError)) return;
    if (error.code === 'UNAUTHORIZED') {
      void clearSessionAfterUnauthorized();
      return;
    }
    if (
      error.status === 403 ||
      error.status === 404 ||
      error.code === 'FORBIDDEN' ||
      error.code === 'NOT_FOUND' ||
      error.code === 'CALENDAR_ACCESS_DENIED'
    ) {
      setRevokedPersonalIdentity(personalIdentity);
      void (async () => {
        await queryClient.cancelQueries({
          queryKey: [...PERSONAL_WEEK_QUERY_KEY, userId, familyId],
        });
        await queryClient.cancelQueries({
          queryKey: [...PERSONAL_CALENDARS_QUERY_KEY, userId, familyId],
        });
        queryClient.removeQueries({ queryKey: [...PERSONAL_WEEK_QUERY_KEY, userId, familyId] });
        queryClient.removeQueries({
          queryKey: [...PERSONAL_CALENDARS_QUERY_KEY, userId, familyId],
        });
      })();
    }
  }, [
    clearSessionAfterUnauthorized,
    familyId,
    personalIdentity,
    personalWeekQuery.error,
    queryClient,
    userId,
  ]);

  useEffect(() => {
    const error = busyWeekQuery.error;
    if (!(error instanceof BusyWeekApiError)) return;
    if (error.code === 'UNAUTHORIZED') {
      void clearSessionAfterUnauthorized();
      return;
    }
    if (
      error.status === 403 ||
      error.status === 404 ||
      error.code === 'FORBIDDEN' ||
      error.code === 'NOT_FOUND'
    ) {
      setRevokedBusyIdentity(busyIdentity);
      void (async () => {
        await queryClient.cancelQueries({
          queryKey: [...BUSY_WEEK_QUERY_KEY, userId, familyId],
        });
        queryClient.removeQueries({
          queryKey: [...BUSY_WEEK_QUERY_KEY, userId, familyId],
        });
      })();
    }
  }, [
    busyIdentity,
    busyWeekQuery.error,
    clearSessionAfterUnauthorized,
    familyId,
    queryClient,
    userId,
  ]);

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
      void clearSessionAfterUnauthorized();
    }
  }, [clearSessionAfterUnauthorized, weekQuery.error]);

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
          {personalWeekQuery.isError ||
          revokedPersonalIdentity === personalIdentity ||
          (personalResponseMatches && personalResponse?.status !== 'ready') ? (
            <aside
              data-testid="personal-events-status"
              className="mb-[var(--spacing-md)] rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-sm)] text-xs leading-relaxed text-muted"
            >
              <p className="m-0">
                {personalWeekQuery.error instanceof PersonalEventsApiError &&
                personalWeekQuery.error.code === 'REAUTH_REQUIRED'
                  ? '個人予定の再認証が必要です。家族の予定は引き続き表示しています。'
                  : personalWeekQuery.error instanceof PersonalEventsApiError &&
                      (personalWeekQuery.error.code === 'FORBIDDEN' ||
                        personalWeekQuery.error.code === 'NOT_FOUND' ||
                        personalWeekQuery.error.code === 'CALENDAR_ACCESS_DENIED')
                    ? '個人予定は現在表示できません。家族の予定は引き続き表示しています。'
                    : personalWeekQuery.isError || revokedPersonalIdentity === personalIdentity
                      ? '個人予定を読み込めませんでした。家族の予定は引き続き表示しています。'
                      : personalResponse?.status === 'authorization_required'
                        ? '個人予定を表示するには、家族ページで Google の同意が必要です。'
                        : '表示する個人カレンダーを家族ページで選んでください。'}
              </p>
              <Link
                to="/family"
                className="mt-[var(--spacing-xs)] inline-flex min-h-[var(--tap-target-min)] items-center text-xs font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                家族ページを開く
              </Link>
            </aside>
          ) : null}
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
                      conflictEventIds={conflictEventIds}
                      personalEvents={getPersonalEventsForDate(
                        day.date,
                        personalEvents,
                        hideRoutines,
                      )}
                      members={data.members}
                      personalMember={personalMember}
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
                      conflictEventIds={conflictEventIds}
                      personalEvents={getPersonalEventsForDate(
                        day.date,
                        personalEvents,
                        hideRoutines,
                      )}
                      members={data.members}
                      personalMember={personalMember}
                      isToday={isToday}
                      onAdd={(date, trigger) => openNewEvent(date, trigger)}
                      onEdit={openEditEvent}
                      disabled={!canEditEvents}
                      onShowMorePersonal={(date) =>
                        setPersonalDialog({ identity: personalIdentity, date })
                      }
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
                  weekStart={data.week.start}
                  availability={timelineForDay(day.date)}
                  selfMemberId={selfMemberId}
                  events={getVisibleEvents(day, data, hideRoutines)}
                  conflictEventIds={conflictEventIds}
                  personalEvents={getPersonalEventsForDate(day.date, personalEvents, hideRoutines)}
                  members={data.members}
                  personalMember={personalMember}
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
              この予定は繰り返し予定です。休み・振替は『繰り返し』タブで設定できます。{' '}
              <Link
                to="/routines"
                data-testid="routine-event-routines-link"
                className="inline-flex min-h-[var(--tap-target-min)] items-center rounded-[var(--radius-sm)] px-[var(--spacing-xs)] font-semibold text-ink underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                繰り返しタブを開く
              </Link>
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
      {personalDialog?.identity === personalIdentity &&
        personalResponseMatches &&
        personalEvents.length > 0 && (
          <PersonalEventsDialog
            date={personalDialog.date}
            events={getPersonalEventsForDate(personalDialog.date, personalEvents, hideRoutines)}
            member={personalMember}
            onClose={() => setPersonalDialog(null)}
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
