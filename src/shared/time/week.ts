import { type DateKey, dateKeySchema } from '@shared/schemas/date';
import { addCalendarDays, addCalendarWeeks, getWeekday } from './date';
import { isHoliday } from './holiday';

export interface WeekRange {
  /** Canonical Monday anchor of the week (YYYY-MM-DD) */
  start: DateKey;
  /** Final inclusive date of the displayed week (Sunday or extended consecutive national holiday) */
  endInclusive: DateKey;
  /** Exclusive boundary date (immediately following endInclusive) */
  endExclusive: DateKey;
  /** ISO 8601 start instant at 00:00:00+09:00 for Google Calendar timeMin query */
  timeMin: string;
  /** ISO 8601 exclusive end instant at 00:00:00+09:00 for Google Calendar timeMax query */
  timeMax: string;
  /** List of all calendar DateKeys included in this week */
  days: DateKey[];
  /** Previous week start date key (anchored Monday - 7 days) */
  prevWeekStart: DateKey;
  /** Next week start date key (anchored Monday + 7 days) */
  nextWeekStart: DateKey;
}

/**
 * Returns the Monday anchor DateKey for any given date in Asia/Tokyo.
 */
export function getMondayAnchor(dateKey: DateKey): DateKey {
  dateKeySchema.parse(dateKey);
  const weekday = getWeekday(dateKey);
  const daysFromMonday = (weekday + 6) % 7;
  return addCalendarDays(dateKey, -daysFromMonday);
}

/**
 * Computes the Monday-anchored week range in Asia/Tokyo.
 *
 * Rules:
 * - Basic week runs Monday through Sunday (7 days).
 * - If consecutive national holidays immediately follow Sunday, the week extends
 *   continuously through the final consecutive national holiday (e.g. 2026-10-05..12).
 * - A normal workday stops extension immediately; never bridges across a workday.
 * - Week navigation (prevWeekStart / nextWeekStart) is always anchored by ±7 calendar days
 *   from the starting Monday, independent of extended display length.
 * - Local facility closures (closure_days) affect dayLayout ('weekend-card') but do not
 *   extend the week boundary.
 */
export function getWeekRange(anchorDate: DateKey): WeekRange {
  const monday = getMondayAnchor(anchorDate);
  const days: DateKey[] = [];

  // Base 7-day week (Monday to Sunday)
  for (let i = 0; i < 7; i++) {
    days.push(addCalendarDays(monday, i));
  }

  // Extend across consecutive following national holidays
  let cursor = addCalendarDays(monday, 7);
  while (isHoliday(cursor)) {
    days.push(cursor);
    cursor = addCalendarDays(cursor, 1);
  }

  const endExclusive = cursor;
  const endInclusive = addCalendarDays(cursor, -1);

  return {
    start: monday,
    endInclusive,
    endExclusive,
    timeMin: `${monday}T00:00:00+09:00`,
    timeMax: `${endExclusive}T00:00:00+09:00`,
    days,
    prevWeekStart: addCalendarWeeks(monday, -1),
    nextWeekStart: addCalendarWeeks(monday, 1),
  };
}
