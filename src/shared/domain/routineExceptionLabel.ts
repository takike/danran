import type { DateKey } from '@shared/schemas/date';
import type { WeekEvent } from '@shared/schemas/week';
import { toTokyoDateKey } from '@shared/time/date';

function shortDate(date: DateKey): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

/** Returns the fixed Japanese label for a moved or time-shifted recurring instance. */
export function getRoutineExceptionLabel(
  event: Pick<WeekEvent, 'time' | 'movedFrom'>,
): string | null {
  if (!event.movedFrom) return null;

  const movedFromDate = toTokyoDateKey(event.movedFrom);
  const currentDate =
    event.time.kind === 'all-day' ? event.time.start : toTokyoDateKey(event.time.start);
  return movedFromDate === currentDate ? '時間変更' : `振替（${shortDate(movedFromDate)} から）`;
}
