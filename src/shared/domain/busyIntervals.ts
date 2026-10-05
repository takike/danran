import { isoInstantStringSchema } from '@shared/schemas/date';
import { toTokyoIsoString } from '@shared/time/date';
import { parseIsoInstantMilliseconds } from '@shared/time/interval';

export interface BusyInterval {
  start: string;
  end: string;
}

export interface BusyIntervalBounds {
  start: string;
  end: string;
}

interface NumericInterval {
  start: number;
  end: number;
}

/** Clips and merges busy intervals, returning canonical Tokyo instants. */
export function mergeBusyIntervals(
  intervals: readonly BusyInterval[],
  bounds: BusyIntervalBounds,
): BusyInterval[] {
  const boundStart = parseIsoInstantMilliseconds(bounds.start);
  const boundEnd = parseIsoInstantMilliseconds(bounds.end);
  if (boundEnd <= boundStart) throw new RangeError('Busy interval bounds end must follow start');

  const clipped: NumericInterval[] = [];
  for (const interval of intervals) {
    isoInstantStringSchema.parse(interval.start);
    isoInstantStringSchema.parse(interval.end);
    const start = parseIsoInstantMilliseconds(interval.start);
    const end = parseIsoInstantMilliseconds(interval.end);
    if (end <= start) throw new RangeError('Busy interval end must follow start');
    const clippedStart = Math.max(start, boundStart);
    const clippedEnd = Math.min(end, boundEnd);
    if (clippedStart < clippedEnd) clipped.push({ start: clippedStart, end: clippedEnd });
  }

  clipped.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: NumericInterval[] = [];
  for (const interval of clipped) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
    } else {
      previous.end = Math.max(previous.end, interval.end);
    }
  }

  return merged.map(({ start, end }) => ({
    start: toTokyoIsoString(start),
    end: toTokyoIsoString(end),
  }));
}
