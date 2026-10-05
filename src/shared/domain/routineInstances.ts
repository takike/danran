import type { RoutineInstanceStatus } from '@shared/schemas/routines';
import type { RoutineInstance } from '@shared/schemas/routines';
import { getWeekday, toTokyoDateKey, toTokyoIsoString } from '@shared/time';
import { parseIsoInstantMilliseconds } from '@shared/time/interval';

export interface RoutineInstanceTimes {
  originalStart: string;
  originalEnd: string;
  start: string | null;
  end: string | null;
  cancelled?: boolean;
}

/** Classifies a Google Calendar occurrence by comparing its real instants. */
export function getRoutineInstanceStatus(value: RoutineInstanceTimes): RoutineInstanceStatus {
  if (value.cancelled) return 'skipped';
  if (value.start === null || value.end === null)
    throw new TypeError('Active instance needs dates');
  if (
    parseIsoInstantMilliseconds(value.originalStart) !== parseIsoInstantMilliseconds(value.start) ||
    parseIsoInstantMilliseconds(value.originalEnd) !== parseIsoInstantMilliseconds(value.end)
  ) {
    return 'moved';
  }
  return 'normal';
}

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const;

function formatRoutineDate(value: string): string {
  const date = toTokyoDateKey(value);
  const [, month, day] = date.split('-');
  const weekday = WEEKDAY_LABELS[getWeekday(date)];
  return `${Number(month)}/${Number(day)}（${weekday}）`;
}

function formatClock(value: string): string {
  return toTokyoIsoString(value).slice(11, 16);
}

/** Produces the short Japanese label shown on an upcoming routine chip. */
export function formatRoutineInstanceChip(instance: RoutineInstance): string {
  const originalDate = formatRoutineDate(instance.originalStart);
  if (instance.status === 'skipped') return `${originalDate} お休み`;
  if (instance.status === 'normal') return originalDate;
  if (instance.start === null || instance.end === null) {
    throw new TypeError('Moved instance needs actual times');
  }
  const dateLabel = `${originalDate} → ${formatRoutineDate(instance.start)} 振替`;
  const originalStartTime = formatClock(instance.originalStart);
  const originalEndTime = formatClock(instance.originalEnd);
  const actualStartTime = formatClock(instance.start);
  const actualEndTime = formatClock(instance.end);
  if (originalStartTime === actualStartTime && originalEndTime === actualEndTime) {
    return dateLabel;
  }
  return `${dateLabel} ${originalStartTime}–${originalEndTime} → ${actualStartTime}–${actualEndTime}`;
}
