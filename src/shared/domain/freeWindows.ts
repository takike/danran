import type { DateKey } from '@shared/schemas/date';
import type { WeekEvent } from '@shared/schemas/week';
import { toTokyoIsoString } from '@shared/time/date';
import {
  getIntervalDurationMinutes,
  getTokyoDayHourBounds,
  parseIsoInstantMilliseconds,
  shiftInstantMinutes,
} from '@shared/time/interval';

export interface BusyInterval {
  start: string;
  end: string;
}

export type FreeWindowsFamilyEvent = Readonly<
  Omit<Pick<WeekEvent, 'time' | 'memberIds' | 'assigneeMemberId' | 'status'>, 'memberIds'> & {
    memberIds: readonly string[];
  }
> & {
  affectsAvailability?: boolean;
};

export interface FreeWindowsOptions {
  date: DateKey;
  memberIds: readonly string[];
  personalBusy?: Readonly<Record<string, readonly BusyInterval[]>>;
  familyEvents?: readonly FreeWindowsFamilyEvent[];
  startHour?: number;
  endHour?: number;
  minFreeMinutes?: number;
  assigneeBufferMinutes?: number;
}

export interface FreeWindowsResult {
  memberBusy: Array<{ memberId: string; busy: BusyInterval[] }>;
  commonFreeWindows: BusyInterval[];
  totalFreeMinutes: number;
}

interface NumericInterval {
  start: number;
  end: number;
}

/** Calculates member busy time and the common free windows for one Tokyo calendar day. */
export function getFreeWindows(options: FreeWindowsOptions): FreeWindowsResult {
  const startHour = options.startHour ?? 8;
  const endHour = options.endHour ?? 20;
  const minFreeMinutes = options.minFreeMinutes ?? 30;
  const assigneeBufferMinutes = options.assigneeBufferMinutes ?? 0;

  assertFiniteNonNegative(minFreeMinutes, 'Minimum free minutes');
  assertFiniteNonNegative(assigneeBufferMinutes, 'Assignee buffer minutes');
  const dayBounds = getTokyoDayHourBounds(options.date, startHour, endHour);
  const memberIds = [...new Set(options.memberIds)];
  if (memberIds.length === 0) {
    return { memberBusy: [], commonFreeWindows: [], totalFreeMinutes: 0 };
  }

  const knownMembers = new Set(memberIds);
  const busyByMember = new Map<string, NumericInterval[]>(
    memberIds.map((memberId) => [memberId, []]),
  );

  for (const memberId of memberIds) {
    const personalBusy = options.personalBusy;
    const intervals =
      personalBusy && Object.hasOwn(personalBusy, memberId) ? (personalBusy[memberId] ?? []) : [];
    for (const interval of intervals) {
      const start = parseIsoInstantMilliseconds(interval.start);
      const end = parseIsoInstantMilliseconds(interval.end);
      if (end <= start) throw new RangeError('Busy interval end must follow start');
      addClippedInterval(busyByMember, memberId, start, end, dayBounds);
    }
  }

  for (const event of options.familyEvents ?? []) {
    if (
      event.status !== 'confirmed' ||
      event.affectsAvailability === false ||
      event.time.kind !== 'timed'
    ) {
      continue;
    }

    const targets =
      event.memberIds.length === 0
        ? memberIds
        : [...new Set(event.memberIds.filter((memberId) => knownMembers.has(memberId)))];
    const assignee =
      event.assigneeMemberId && knownMembers.has(event.assigneeMemberId)
        ? event.assigneeMemberId
        : undefined;
    if (targets.length === 0 && assignee === undefined) continue;

    const start = parseIsoInstantMilliseconds(event.time.start);
    const end = parseIsoInstantMilliseconds(event.time.endExclusive);
    if (end <= start) throw new RangeError('Family event end must follow start');

    for (const memberId of targets) {
      addClippedInterval(busyByMember, memberId, start, end, dayBounds);
    }
    if (assignee !== undefined) {
      addClippedInterval(
        busyByMember,
        assignee,
        shiftInstantMinutes(event.time.start, -assigneeBufferMinutes),
        shiftInstantMinutes(event.time.endExclusive, assigneeBufferMinutes),
        dayBounds,
      );
    }
  }

  const memberBusy = memberIds.map((memberId) => ({
    memberId,
    busy: mergeIntervals(busyByMember.get(memberId) ?? []).map(toBusyInterval),
  }));
  const allBusy = mergeIntervals(
    memberBusy.flatMap(({ busy }) =>
      busy.map(({ start, end }) => ({
        start: parseIsoInstantMilliseconds(start),
        end: parseIsoInstantMilliseconds(end),
      })),
    ),
  );
  const commonFreeWindows = complementIntervals(dayBounds, allBusy)
    .filter(
      (interval) =>
        getIntervalDurationMinutes(
          toTokyoIsoString(interval.start),
          toTokyoIsoString(interval.end),
        ) >= minFreeMinutes,
    )
    .map(toBusyInterval);

  return {
    memberBusy,
    commonFreeWindows,
    totalFreeMinutes: commonFreeWindows.reduce(
      (total, interval) => total + getIntervalDurationMinutes(interval.start, interval.end),
      0,
    ),
  };
}

function addClippedInterval(
  busyByMember: Map<string, NumericInterval[]>,
  memberId: string,
  start: number,
  end: number,
  bounds: NumericInterval,
): void {
  const clippedStart = Math.max(start, bounds.start);
  const clippedEnd = Math.min(end, bounds.end);
  if (clippedStart >= clippedEnd) return;
  busyByMember.get(memberId)?.push({ start: clippedStart, end: clippedEnd });
}

function mergeIntervals(intervals: readonly NumericInterval[]): NumericInterval[] {
  const sorted = [...intervals].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: NumericInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
    } else if (interval.end > previous.end) {
      previous.end = interval.end;
    }
  }
  return merged;
}

function complementIntervals(
  bounds: NumericInterval,
  busy: readonly NumericInterval[],
): NumericInterval[] {
  const free: NumericInterval[] = [];
  let cursor = bounds.start;
  for (const interval of busy) {
    if (cursor < interval.start) free.push({ start: cursor, end: interval.start });
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < bounds.end) free.push({ start: cursor, end: bounds.end });
  return free;
}

function toBusyInterval(interval: NumericInterval): BusyInterval {
  return {
    start: toTokyoIsoString(interval.start),
    end: toTokyoIsoString(interval.end),
  };
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${label} must be finite and non-negative`);
}
