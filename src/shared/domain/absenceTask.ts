import type { DateKey } from '@shared/schemas/date';
import type { RoutineInput } from '@shared/schemas/routines';
import {
  addCalendarDays,
  formatShortDate,
  formatWeekday,
  toTokyoDateKey,
  toTokyoIsoString,
} from '@shared/time';

const SOURCE_REF_PREFIX = 'absence:v1:';
export interface AbsenceTaskSourceRef {
  routineSettingsId: string;
  originalStart: string;
}

export function createAbsenceTaskSourceRef(input: AbsenceTaskSourceRef): string {
  if (!input.routineSettingsId || !input.originalStart) {
    throw new TypeError('Routine settings ID and original start are required');
  }
  const originalStart = toTokyoIsoString(input.originalStart);
  return `${SOURCE_REF_PREFIX}${encodeURIComponent(input.routineSettingsId)}:${encodeURIComponent(originalStart)}`;
}

export function parseAbsenceTaskSourceRef(value: string | null): AbsenceTaskSourceRef | null {
  if (!value?.startsWith(SOURCE_REF_PREFIX)) return null;
  const parts = value.slice(SOURCE_REF_PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  try {
    const routineSettingsId = decodeURIComponent(parts[0] ?? '');
    const decodedStart = decodeURIComponent(parts[1] ?? '');
    if (!routineSettingsId || !decodedStart) return null;
    const originalStart = toTokyoIsoString(decodedStart);
    toTokyoDateKey(originalStart);
    if (createAbsenceTaskSourceRef({ routineSettingsId, originalStart }) !== value) return null;
    return { routineSettingsId, originalStart };
  } catch {
    return null;
  }
}

export function getAbsenceTaskDueDate(originalStart: string, today: DateKey): DateKey {
  const originalDate = toTokyoDateKey(originalStart);
  return originalDate > today ? addCalendarDays(originalDate, -1) : originalDate;
}

export function getAbsenceTaskDisplayTitle(input: {
  originalStart: string;
  routineTitle?: string | null;
  category?: RoutineInput['category'] | null;
}): string {
  const date = toTokyoDateKey(input.originalStart);
  const dateLabel = `${formatShortDate(date)}（${formatWeekday(date)}）`;
  const isLesson =
    input.category === undefined || input.category === null || input.category === 'lesson';
  if (isLesson) {
    return input.routineTitle
      ? `「${input.routineTitle}」（${dateLabel}）に欠席を連絡`
      : `${dateLabel}の欠席を連絡`;
  }
  return input.routineTitle
    ? `「${input.routineTitle}」（${dateLabel}）のお休みを連絡`
    : `${dateLabel}のお休みを連絡`;
}
