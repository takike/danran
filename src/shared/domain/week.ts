import type { ClosureDay } from '@shared/schemas/closure';
import type { DateKey } from '@shared/schemas/date';
import type { WeekDay, WeekEvent } from '@shared/schemas/week';
import { getDayBounds } from '@shared/time/date';
import { getWeekday } from '@shared/time/date';
import { getHoliday } from '@shared/time/holiday';
import type { WeekRange } from '@shared/time/week';
import { getDayLayout } from './dayLayout';

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function eventStartOrder(event: WeekEvent): number | string {
  return event.time.kind === 'all-day' ? event.time.start : Date.parse(event.time.start);
}

function compareEvents(left: WeekEvent, right: WeekEvent): number {
  const leftAllDay = left.time.kind === 'all-day';
  const rightAllDay = right.time.kind === 'all-day';
  if (leftAllDay !== rightAllDay) return leftAllDay ? -1 : 1;

  const leftStart = eventStartOrder(left);
  const rightStart = eventStartOrder(right);
  const startOrder =
    typeof leftStart === 'string' && typeof rightStart === 'string'
      ? compareStrings(leftStart, rightStart)
      : Number(leftStart) - Number(rightStart);
  return startOrder || compareStrings(left.title, right.title) || compareStrings(left.id, right.id);
}

function eventOverlapsDate(
  event: WeekEvent,
  date: DateKey,
  bounds: ReturnType<typeof getDayBounds>,
): boolean {
  if (event.time.kind === 'all-day') {
    return event.time.start < bounds.endExclusiveIso.slice(0, 10) && event.time.endExclusive > date;
  }

  return (
    Date.parse(event.time.start) < Date.parse(bounds.endExclusiveIso) &&
    Date.parse(event.time.endExclusive) > Date.parse(bounds.startIso)
  );
}

function closureForDate(
  closure: ClosureDay,
  date: DateKey,
  memberIdSet: ReadonlySet<string>,
): { label: string; memberIds: string[] } | null {
  if (closure.date !== date) return null;
  if (closure.memberIds.length === 0) return { label: closure.label, memberIds: [] };

  const knownMemberIds = [...new Set(closure.memberIds.filter((id) => memberIdSet.has(id)))];
  if (knownMemberIds.length === 0) return null;
  return { label: closure.label, memberIds: knownMemberIds };
}

/** Builds the family-visible day cards for a validated, Monday-anchored week range. */
export function buildWeekDays(
  range: WeekRange,
  events: readonly WeekEvent[],
  closures: readonly ClosureDay[],
  memberIds: readonly string[],
): WeekDay[] {
  const memberIdSet = new Set(memberIds);

  return range.days.map((date) => {
    const bounds = getDayBounds(date);
    const dayEvents = events
      .filter((event) => eventOverlapsDate(event, date, bounds))
      .sort(compareEvents);
    const dayClosures = closures
      .map((closure) => closureForDate(closure, date, memberIdSet))
      .filter((closure): closure is { label: string; memberIds: string[] } => closure !== null);
    const holiday = getHoliday(date);

    return {
      date,
      weekday: getWeekday(date),
      holidayName: holiday.name,
      closures: dayClosures,
      layout: getDayLayout({
        date,
        events: dayEvents.map(({ isRoutine, status }) => ({ isRoutine, status })),
        isClosure: dayClosures.length > 0,
      }),
      eventIds: dayEvents.map((event) => event.id),
    };
  });
}
