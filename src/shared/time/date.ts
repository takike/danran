import { TZDate } from '@date-fns/tz';
import { type DateKey, dateKeySchema, isoInstantStringSchema } from '@shared/schemas/date';
import { addDays as dfAddDays } from 'date-fns';
import { TOKYO_TIMEZONE } from './constants';

export interface DayBounds {
  date: DateKey;
  startIso: string;
  endExclusiveIso: string;
  startUtcIso: string;
  endExclusiveUtcIso: string;
}

/**
 * Single private formatter converting a TZDate to canonical DateKey (YYYY-MM-DD).
 */
function formatTZDateToDateKey(tzDate: TZDate): DateKey {
  const year = String(tzDate.getFullYear()).padStart(4, '0');
  const month = String(tzDate.getMonth() + 1).padStart(2, '0');
  const day = String(tzDate.getDate()).padStart(2, '0');
  return dateKeySchema.parse(`${year}-${month}-${day}`);
}

/**
 * Maximum timestamp magnitude supported by JavaScript Date (100,000,000 days in ms).
 */
const MAX_DATE_TIMESTAMP = 8.64e15;

/**
 * Converts a Date, epoch millisecond timestamp, or timezone-aware ISO string to a Tokyo DateKey (YYYY-MM-DD).
 * Rejects invalid dates, invalid instants, and timezone-less instant strings.
 */
export function toTokyoDateKey(input: Date | number | string): DateKey {
  if (typeof input === 'string') {
    if (input.includes('T')) {
      isoInstantStringSchema.parse(input);
      const timestamp = Date.parse(input);
      if (!Number.isFinite(timestamp) || Math.abs(timestamp) > MAX_DATE_TIMESTAMP) {
        throw new TypeError(`Invalid instant string: ${input}`);
      }
      const tzDate = new TZDate(timestamp, TOKYO_TIMEZONE);
      return formatTZDateToDateKey(tzDate);
    }

    return dateKeySchema.parse(input);
  }

  if (typeof input === 'number') {
    if (!Number.isFinite(input) || Math.abs(input) > MAX_DATE_TIMESTAMP) {
      throw new TypeError(`Invalid epoch timestamp: ${input}`);
    }
    const tzDate = new TZDate(input, TOKYO_TIMEZONE);
    return formatTZDateToDateKey(tzDate);
  }

  const timestamp = input.getTime();
  if (Number.isNaN(timestamp) || Math.abs(timestamp) > MAX_DATE_TIMESTAMP) {
    throw new TypeError('Invalid Date object');
  }
  const tzDate = new TZDate(timestamp, TOKYO_TIMEZONE);
  return formatTZDateToDateKey(tzDate);
}

/**
 * Converts an instant to an ISO timestamp with the fixed Asia/Tokyo offset.
 * Milliseconds are included only when non-zero, preserving the instant's precision.
 */
export function toTokyoIsoString(input: Date | number | string): string {
  let timestamp: number;
  if (typeof input === 'string') {
    isoInstantStringSchema.parse(input);
    timestamp = Date.parse(input);
  } else if (typeof input === 'number') {
    timestamp = input;
  } else {
    timestamp = input.getTime();
  }

  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > MAX_DATE_TIMESTAMP) {
    throw new TypeError('Invalid instant');
  }

  const tzDate = new TZDate(timestamp, TOKYO_TIMEZONE);
  const dateKey = formatTZDateToDateKey(tzDate);
  const hours = String(tzDate.getHours()).padStart(2, '0');
  const minutes = String(tzDate.getMinutes()).padStart(2, '0');
  const seconds = String(tzDate.getSeconds()).padStart(2, '0');
  const milliseconds = tzDate.getMilliseconds();
  const fractional = milliseconds === 0 ? '' : `.${String(milliseconds).padStart(3, '0')}`;
  return isoInstantStringSchema.parse(
    `${dateKey}T${hours}:${minutes}:${seconds}${fractional}+09:00`,
  );
}

/**
 * Returns a TZDate at 00:00:00.000 in Asia/Tokyo for the given DateKey.
 */
export function toTokyoTZDate(dateKey: DateKey): TZDate {
  dateKeySchema.parse(dateKey);
  return new TZDate(`${dateKey}T00:00:00+09:00`, TOKYO_TIMEZONE);
}

/**
 * Pure helper for today's DateKey in Asia/Tokyo, accepting an optional injectable now.
 */
export function getTodayDateKey(now?: number | Date): DateKey {
  return toTokyoDateKey(now ?? Date.now());
}

/**
 * Returns weekday index (0 = Sunday, 1 = Monday, ..., 6 = Saturday) in Asia/Tokyo.
 */
export function getWeekday(dateKey: DateKey): number {
  return toTokyoTZDate(dateKey).getDay();
}

/**
 * Pure calendar day arithmetic in Asia/Tokyo, returning a new DateKey.
 * Rejects non-integer or unsafe increments.
 */
export function addCalendarDays(dateKey: DateKey, days: number): DateKey {
  if (!Number.isSafeInteger(days)) {
    throw new TypeError(`Expected safe integer for days, got: ${days}`);
  }
  dateKeySchema.parse(dateKey);
  const tzDate = toTokyoTZDate(dateKey);
  const shifted = dfAddDays(tzDate, days);
  return formatTZDateToDateKey(shifted);
}

/**
 * Pure calendar week arithmetic in Asia/Tokyo, returning a new DateKey.
 * Rejects non-integer or unsafe increments.
 */
export function addCalendarWeeks(dateKey: DateKey, weeks: number): DateKey {
  if (!Number.isSafeInteger(weeks)) {
    throw new TypeError(`Expected safe integer for weeks, got: ${weeks}`);
  }
  return addCalendarDays(dateKey, weeks * 7);
}

/**
 * Returns unambiguous day bounds for a DateKey in Asia/Tokyo (+09:00) and UTC ISO (Z).
 */
export function getDayBounds(dateKey: DateKey): DayBounds {
  dateKeySchema.parse(dateKey);
  const nextDateKey = addCalendarDays(dateKey, 1);
  const startTz = toTokyoTZDate(dateKey);
  const endTz = toTokyoTZDate(nextDateKey);

  return {
    date: dateKey,
    startIso: `${dateKey}T00:00:00+09:00`,
    endExclusiveIso: `${nextDateKey}T00:00:00+09:00`,
    startUtcIso: new Date(startTz.getTime()).toISOString(),
    endExclusiveUtcIso: new Date(endTz.getTime()).toISOString(),
  };
}
