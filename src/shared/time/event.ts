import { TZDate } from '@date-fns/tz';
import type { DateKey } from '@shared/schemas/date';
import type { EventInputTime } from '@shared/schemas/events';
import { TOKYO_TIMEZONE } from './constants';
import { addCalendarDays, getTodayDateKey } from './date';
import { toTokyoDateKey, toTokyoIsoString } from './date';

/** Converts an inclusive all-day end date to Google's exclusive end date. */
export function inclusiveEndToExclusive(endInclusive: DateKey): DateKey {
  return addCalendarDays(endInclusive, 1);
}

/** Converts Google's exclusive all-day end date to the final visible date. */
export function exclusiveEndToInclusive(endExclusive: DateKey): DateKey {
  return addCalendarDays(endExclusive, -1);
}

/** Returns date and clock strings suitable for date/time inputs in Asia/Tokyo. */
export function toTokyoDateTimeInputValues(instant: string): { date: DateKey; time: string } {
  const canonical = toTokyoIsoString(instant);
  return { date: toTokyoDateKey(instant), time: canonical.slice(11, 16) };
}

/** Builds the editor's default one-hour timed range, rounded up to the next Tokyo hour. */
export function getDefaultEventTime(
  selectedDate?: DateKey,
  now: number | Date = Date.now(),
): EventInputTime {
  const tokyoNow = new TZDate(typeof now === 'number' ? now : now.getTime(), TOKYO_TIMEZONE);
  const startHour = tokyoNow.getHours() + 1;
  const anchorDate = selectedDate ?? getTodayDateKey(now);
  const startDate = startHour >= 24 ? addCalendarDays(anchorDate, 1) : anchorDate;
  const normalizedHour = startHour >= 24 ? startHour - 24 : startHour;
  const endDate = normalizedHour === 23 ? addCalendarDays(startDate, 1) : startDate;
  const endHour = normalizedHour === 23 ? 0 : normalizedHour + 1;
  return {
    kind: 'timed',
    start: `${startDate}T${String(normalizedHour).padStart(2, '0')}:00:00+09:00`,
    endExclusive: `${endDate}T${String(endHour).padStart(2, '0')}:00:00+09:00`,
  };
}
