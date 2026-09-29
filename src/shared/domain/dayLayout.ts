import type { DateKey } from '@shared/schemas/date';
import { getWeekday } from '@shared/time/date';
import { isHoliday } from '@shared/time/holiday';

export type DayLayoutType = 'weekend-card' | 'expanded' | 'compact';

export interface DayLayoutEventInput {
  id?: string;
  title?: string;
  /**
   * Whether the event represents a recurring family routine (e.g. weekly lessons, chores).
   */
  isRoutine: boolean;
  /**
   * Event lifecycle status (e.g. 'confirmed', 'tentative', 'cancelled').
   * Cancelled events are ignored when determining day layout expansion.
   */
  status?: string;
}

export interface DayLayoutOptions {
  /** The calendar date key (YYYY-MM-DD) */
  date: DateKey;
  /** Family events scheduled for this day, pre-filtered and authorized by caller */
  events?: readonly DayLayoutEventInput[];
  /** Explicit closure flag for this day (e.g. nursery closure) */
  isClosure?: boolean;
  /** Optional list of closure date strings to match against the date */
  closureDates?: readonly (DateKey | string)[];
}

/**
 * Pure domain function determining the layout presentation of a day in Danran.
 *
 * Rules (in priority order):
 * 1. 'weekend-card': Saturday, Sunday, Japanese national holiday, or nursery/school closure day.
 * 2. 'expanded': Weekday with at least one active non-routine family event.
 * 3. 'compact': Weekday with only routine events, cancelled events, or no family events.
 *
 * Note: Deadlines and personal published chips do not expand a weekday;
 * only active non-routine family events trigger expansion.
 */
export function getDayLayout(options: DayLayoutOptions): DayLayoutType {
  const { date, events = [], isClosure = false, closureDates = [] } = options;

  const weekday = getWeekday(date);
  const isWeekend = weekday === 0 || weekday === 6;
  const isNationalHoliday = isHoliday(date);
  const isDayClosure = isClosure || closureDates.includes(date);

  // Highest priority: weekend, national holiday, or closure renders as a weekend card
  if (isWeekend || isNationalHoliday || isDayClosure) {
    return 'weekend-card';
  }

  // Active (non-cancelled) non-routine family event expands the weekday
  const hasActiveNonRoutineEvent = events.some(
    (event) => event.status !== 'cancelled' && !event.isRoutine,
  );

  if (hasActiveNonRoutineEvent) {
    return 'expanded';
  }

  return 'compact';
}
