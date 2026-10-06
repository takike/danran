import type { DateKey } from '@shared/schemas/date';
import { addCalendarDays, toTokyoDateKey } from '@shared/time';
import { getHoliday, isYearEndBreak } from '@shared/time/holiday';

export type RoutineAutoSkipReason = 'holiday' | 'new_year';

export interface RoutineAutoSkipSettings {
  skipHolidays: boolean;
  skipNewYear: boolean;
}

export interface RoutineAutoSkipCandidate extends RoutineAutoSkipSettings {
  originalStart: string;
  status: 'normal' | 'skipped' | 'moved';
  today: DateKey;
  through: DateKey;
}

/** Gives national holidays precedence when a date belongs to both rules. */
export function getRoutineAutoSkipReason(
  date: DateKey,
  settings: RoutineAutoSkipSettings,
): RoutineAutoSkipReason | null {
  if (settings.skipHolidays && getHoliday(date).isHoliday) return 'holiday';
  if (settings.skipNewYear && isYearEndBreak(date)) return 'new_year';
  return null;
}

/** Selects ordinary occurrences by their original Tokyo date, including both range endpoints. */
export function getRoutineAutoSkipCandidateReason(
  candidate: RoutineAutoSkipCandidate,
): RoutineAutoSkipReason | null {
  if (candidate.status !== 'normal') return null;
  const date = toTokyoDateKey(candidate.originalStart);
  if (date < candidate.today || date > candidate.through) return null;
  return getRoutineAutoSkipReason(date, candidate);
}

export function getRoutineAutoSkipHorizon(today: DateKey): DateKey {
  return addCalendarDays(today, 183);
}
