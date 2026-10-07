import type { DateKey } from '@shared/schemas/date';
import type { EventInputTime } from '@shared/schemas/events';
import { addCalendarDays, toTokyoDateKey } from '@shared/time/date';

export interface ItemsTask {
  title: '持ち物を準備';
  dueKind: 'datetime';
  dueAt: string;
}

/** Derives the deadline for a stored items task from the event's current start time. */
export function getItemsTaskDue(time: EventInputTime): string {
  const eventDate: DateKey = time.kind === 'all-day' ? time.start : toTokyoDateKey(time.start);
  const dueDate = addCalendarDays(eventDate, -1);
  return `${dueDate}T20:00:00+09:00`;
}

/** Derives the single automatic preparation task for an event's current items and start time. */
export function getItemsTask(items: readonly string[], time: EventInputTime): ItemsTask | null {
  if (items.length === 0) return null;

  return {
    title: '持ち物を準備',
    dueKind: 'datetime',
    dueAt: getItemsTaskDue(time),
  };
}
