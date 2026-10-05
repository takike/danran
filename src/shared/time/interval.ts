import type { DateKey } from '@shared/schemas/date';
import { dateKeySchema, isoInstantStringSchema } from '@shared/schemas/date';
import { addCalendarDays } from './date';

const MAX_DATE_TIMESTAMP = 8.64e15;

export interface TokyoDayHourBounds {
  start: number;
  end: number;
}

/** Parses a timezone-aware ISO instant into epoch milliseconds. */
export function parseIsoInstantMilliseconds(value: string): number {
  isoInstantStringSchema.parse(value);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError('Invalid ISO instant');
  return milliseconds;
}

/** Returns the UTC instants for an hour range on a Tokyo calendar day. */
export function getTokyoDayHourBounds(
  date: DateKey,
  startHour: number,
  endHour: number,
): TokyoDayHourBounds {
  dateKeySchema.parse(date);
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    startHour >= endHour ||
    endHour > 24
  ) {
    throw new RangeError('Tokyo day hours must satisfy 0 <= startHour < endHour <= 24');
  }

  return {
    start: parseIsoInstantMilliseconds(formatTokyoHour(date, startHour)),
    end: parseIsoInstantMilliseconds(formatTokyoHour(date, endHour)),
  };
}

/** Shifts a timezone-aware ISO instant by a finite number of minutes. */
export function shiftInstantMinutes(value: string, minutes: number): number {
  if (!Number.isFinite(minutes)) throw new TypeError('Minute shift must be finite');
  const shifted = parseIsoInstantMilliseconds(value) + minutes * 60_000;
  if (!Number.isFinite(shifted) || Math.abs(shifted) > MAX_DATE_TIMESTAMP) {
    throw new TypeError('Shifted instant is outside the supported date range');
  }
  return shifted;
}

/** Returns an interval's exact duration in minutes, rejecting empty or reversed ranges. */
export function getIntervalDurationMinutes(start: string, end: string): number {
  const startMilliseconds = parseIsoInstantMilliseconds(start);
  const endMilliseconds = parseIsoInstantMilliseconds(end);
  if (endMilliseconds <= startMilliseconds) throw new RangeError('Interval end must follow start');
  return (endMilliseconds - startMilliseconds) / 60_000;
}

function formatTokyoHour(date: DateKey, hour: number): string {
  const normalizedDate = hour === 24 ? addCalendarDays(date, 1) : date;
  const normalizedHour = hour === 24 ? 0 : hour;
  return `${normalizedDate}T${String(normalizedHour).padStart(2, '0')}:00:00+09:00`;
}
