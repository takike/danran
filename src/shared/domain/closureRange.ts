import { type DateKey, dateKeySchema } from '@shared/schemas/date';
import { addCalendarDays } from '@shared/time/date';

const MAX_CLOSURE_RANGE_DAYS = 31;

function assertSupportedDate(date: DateKey): void {
  const year = Number(date.slice(0, 4));
  if (year < 1970 || year > 2050) {
    throw new RangeError('Closure dates must be between 1970 and 2050');
  }
}

/** Expands an inclusive closure range into canonical Tokyo calendar date keys. */
export function expandClosureDateRange(start: string, end: string = start): DateKey[] {
  const startDate = dateKeySchema.parse(start);
  const endDate = dateKeySchema.parse(end);
  assertSupportedDate(startDate);
  assertSupportedDate(endDate);

  if (endDate < startDate) throw new RangeError('Closure range end must not precede its start');

  const dates: DateKey[] = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    dates.push(cursor);
    if (dates.length > MAX_CLOSURE_RANGE_DAYS) {
      throw new RangeError('Closure ranges cannot exceed 31 days');
    }
    if (cursor === endDate) break;
    cursor = addCalendarDays(cursor, 1);
  }
  return dates;
}

export function canonicalClosureMemberIds(memberIds: readonly string[]): string[] {
  return [...new Set(memberIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
