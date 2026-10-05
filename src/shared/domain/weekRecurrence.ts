import type { DateKey } from '@shared/schemas/date';
import { getDayBounds, parseIsoInstantMilliseconds, toTokyoIsoString } from '@shared/time';

export type WeekRecurrenceDate = { date?: string; dateTime?: string } | null | undefined;

export interface WeekRecurrenceClassification {
  isRecurring: boolean;
  isRoutine: boolean;
  movedFrom: string | null;
}

/**
 * Classifies a singleEvents=true Google Calendar result for the week API.
 * Google does not provide the recurring master's duration in this response,
 * so only a changed start can identify an exception reliably.
 */
export function classifyWeekRecurrence(
  isRecurring: boolean,
  originalStart: WeekRecurrenceDate,
  actualStart: WeekRecurrenceDate,
): WeekRecurrenceClassification {
  if (!isRecurring) return { isRecurring: false, isRoutine: false, movedFrom: null };
  if (!originalStart || !actualStart) {
    return { isRecurring: true, isRoutine: true, movedFrom: null };
  }

  try {
    if (originalStart.dateTime) {
      const original = toTokyoIsoString(originalStart.dateTime);
      if (
        !actualStart.dateTime ||
        parseIsoInstantMilliseconds(actualStart.dateTime) !==
          parseIsoInstantMilliseconds(originalStart.dateTime)
      ) {
        return { isRecurring: true, isRoutine: false, movedFrom: original };
      }
      return { isRecurring: true, isRoutine: true, movedFrom: null };
    }

    if (originalStart.date) {
      const original = getDayBounds(originalStart.date as DateKey).startIso;
      if (actualStart.date !== originalStart.date) {
        return { isRecurring: true, isRoutine: false, movedFrom: original };
      }
      if (actualStart.dateTime) {
        return { isRecurring: true, isRoutine: false, movedFrom: original };
      }
      return { isRecurring: true, isRoutine: true, movedFrom: null };
    }
  } catch {
    // Invalid Google instance metadata is treated conservatively as routine.
  }

  return { isRecurring: true, isRoutine: true, movedFrom: null };
}
