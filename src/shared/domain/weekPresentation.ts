import type { DateKey } from '@shared/schemas/date';
import type { WeekDay, WeekEvent } from '@shared/schemas/week';
import { addCalendarDays } from '@shared/time/date';

export interface LongWeekendBadge {
  start: DateKey;
  endInclusive: DateKey;
  dayCount: number;
}

/** Groups consecutive weekend-card days, including holidays and local closures, into long weekends. */
export function getLongWeekendBadges(days: readonly WeekDay[]): LongWeekendBadge[] {
  const weekendDates = [
    ...new Set(days.filter((day) => day.layout === 'weekend-card').map((day) => day.date)),
  ].sort();
  const badges: LongWeekendBadge[] = [];
  let runStart: DateKey | undefined;
  let previousDate: DateKey | undefined;
  let runDayCount = 0;

  const finishRun = () => {
    if (runStart && previousDate && runDayCount >= 3) {
      badges.push({ start: runStart, endInclusive: previousDate, dayCount: runDayCount });
    }
  };

  for (const date of weekendDates) {
    if (!runStart) {
      runStart = date;
      previousDate = date;
      runDayCount = 1;
      continue;
    }

    if (previousDate && addCalendarDays(previousDate, 1) === date) {
      previousDate = date;
      runDayCount += 1;
      continue;
    }

    finishRun();
    runStart = date;
    previousDate = date;
    runDayCount = 1;
  }

  finishRun();
  return badges;
}

/** Returns visible family events in API order, optionally omitting routines. */
export function getVisibleDayEvents(
  day: WeekDay,
  events: readonly WeekEvent[],
  hideRoutines: boolean,
): WeekEvent[] {
  const eventsById = new Map(events.map((event) => [event.id, event]));
  return day.eventIds
    .map((eventId) => eventsById.get(eventId))
    .filter((event): event is WeekEvent => event !== undefined)
    .filter((event) => !hideRoutines || !event.isRoutine);
}

/** Keeps the API layout unless an expanded day has no events left to present. */
export function getVisibleDayLayout(
  day: WeekDay,
  visibleEvents: readonly WeekEvent[],
): WeekDay['layout'] {
  return day.layout === 'expanded' && visibleEvents.length === 0 ? 'compact' : day.layout;
}
