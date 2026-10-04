import type { DateKey } from '@shared/schemas/date';
import type { PersonalEvent } from '@shared/schemas/personal';
import type { WeekEvent } from '@shared/schemas/week';
import { getDayBounds } from '@shared/time/date';

export type PersonalCalendarEvent = PersonalEvent;

export type CalendarDayEntry =
  | { kind: 'family'; event: WeekEvent }
  | { kind: 'personal'; event: PersonalCalendarEvent };

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function startOrder(time: WeekEvent['time']): number | string {
  return time.kind === 'all-day' ? time.start : Date.parse(time.start);
}

function compareEntries(left: CalendarDayEntry, right: CalendarDayEntry): number {
  const leftTime = left.event.time;
  const rightTime = right.event.time;
  const leftAllDay = leftTime.kind === 'all-day';
  const rightAllDay = rightTime.kind === 'all-day';
  if (leftAllDay !== rightAllDay) return leftAllDay ? -1 : 1;

  const leftStart = startOrder(leftTime);
  const rightStart = startOrder(rightTime);
  const startComparison =
    typeof leftStart === 'string' && typeof rightStart === 'string'
      ? compareStrings(leftStart, rightStart)
      : Number(leftStart) - Number(rightStart);
  if (startComparison !== 0) return startComparison;

  return (
    compareStrings(left.event.title, right.event.title) ||
    compareStrings(left.event.id, right.event.id) ||
    compareStrings(left.kind, right.kind)
  );
}

/** Returns personal events overlapping one Tokyo calendar day, retaining each full event range. */
export function getPersonalEventsForDate(
  date: DateKey,
  events: readonly PersonalCalendarEvent[],
  hideRoutines: boolean,
): PersonalCalendarEvent[] {
  const bounds = getDayBounds(date);
  return events
    .filter((event) => !hideRoutines || !event.isRoutine)
    .filter((event) => {
      if (event.time.kind === 'all-day') {
        return (
          event.time.start < bounds.endExclusiveIso.slice(0, 10) && event.time.endExclusive > date
        );
      }
      return (
        Date.parse(event.time.start) < Date.parse(bounds.endExclusiveIso) &&
        Date.parse(event.time.endExclusive) > Date.parse(bounds.startIso)
      );
    })
    .sort((left, right) =>
      compareEntries({ kind: 'personal', event: left }, { kind: 'personal', event: right }),
    );
}

/** Mixes read-only personal events with family events in the shared day-list order. */
export function mergeCalendarDayEntries(
  familyEvents: readonly WeekEvent[],
  personalEvents: readonly PersonalCalendarEvent[],
): CalendarDayEntry[] {
  return [
    ...familyEvents.map((event): CalendarDayEntry => ({ kind: 'family', event })),
    ...personalEvents.map((event): CalendarDayEntry => ({ kind: 'personal', event })),
  ].sort(compareEntries);
}
