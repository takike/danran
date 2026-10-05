import type { DateKey } from '@shared/schemas/date';
import type { WeekResponse } from '@shared/schemas/week';
import type { BusyWeekResponse } from '@shared/schemas/week-busy';
import { toTokyoIsoString } from '@shared/time/date';
import { getTokyoDayHourBounds, parseIsoInstantMilliseconds } from '@shared/time/interval';
import type { BusyInterval } from './busyIntervals';
import { getFreeWindows } from './freeWindows';

export type BusyTimelineMemberStatus = 'adult-ready' | 'not-shared' | 'unavailable' | 'child';

export interface BusyTimelineRow {
  memberId: string;
  name: string;
  color: WeekResponse['members'][number]['color'];
  status: BusyTimelineMemberStatus;
  busy: BusyInterval[];
}

export interface BusyTimelineData {
  kind: 'ready' | 'loading' | 'error' | 'day-error';
  rows: BusyTimelineRow[];
  commonFreeWindows: BusyInterval[];
  freeTimeLabel?: string;
  hasUnavailableMember: boolean;
  hasNotSharedMember: boolean;
}

export interface TimelineBarSegment {
  leftPercent: number;
  widthPercent: number;
  start: string;
  end: string;
}

const TIMELINE_START_HOUR = 8;
const TIMELINE_END_HOUR = 20;
const MINUTES_PER_HALF_HOUR = 30;

/** Computes one day's timeline without allowing missing or duplicate adult data to imply free time. */
export function buildDayBusyTimeline(
  date: DateKey,
  week: WeekResponse,
  response: BusyWeekResponse,
): BusyTimelineData {
  try {
    const day = week.days.find((candidate) => candidate.date === date);
    if (!day) throw new RangeError('The requested date is not part of the week');

    const adults = week.members.filter((member) => member.kind === 'adult');
    const adultIds = new Set(adults.map((member) => member.id));
    const entriesByMember = new Map<string, BusyWeekResponse['members']>();
    for (const entry of response.members) {
      if (!adultIds.has(entry.memberId)) continue;
      const entries = entriesByMember.get(entry.memberId) ?? [];
      entries.push(entry);
      entriesByMember.set(entry.memberId, entries);
    }

    const hasUnavailableMember =
      adults.length === 0 ||
      adults.some((member) => {
        const entries = entriesByMember.get(member.id) ?? [];
        return entries.length !== 1 || entries[0]?.status === 'unavailable';
      });
    const hasNotSharedMember = adults.some((member) => {
      const entries = entriesByMember.get(member.id) ?? [];
      return entries.length === 1 && entries[0]?.status === 'not_shared';
    });

    const personalBusy = Object.fromEntries(
      adults.flatMap((member) => {
        const entries = entriesByMember.get(member.id) ?? [];
        const onlyEntry = entries.length === 1 ? entries[0] : undefined;
        return onlyEntry?.status === 'ready' ? [[member.id, onlyEntry.busy]] : [];
      }),
    );

    const dayEventIds = new Set(day.eventIds);
    const windows = getFreeWindows({
      date,
      memberIds: week.members.map((member) => member.id),
      personalBusy,
      // Routines remain part of availability even when the event list hides them.
      familyEvents: week.events.filter((event) => dayEventIds.has(event.id)),
    });
    const familyBusyByMember = new Map(
      windows.memberBusy.map((member) => [member.memberId, member.busy]),
    );
    const rows = week.members.map((member): BusyTimelineRow => {
      const busy = familyBusyByMember.get(member.id) ?? [];
      if (member.kind === 'child') {
        return {
          memberId: member.id,
          name: member.name,
          color: member.color,
          status: 'child',
          busy,
        };
      }
      const entries = entriesByMember.get(member.id) ?? [];
      const entry = entries.length === 1 ? entries[0] : undefined;
      if (entry?.status === 'not_shared') {
        return {
          memberId: member.id,
          name: member.name,
          color: member.color,
          status: 'not-shared',
          busy,
        };
      }
      if (entry?.status !== 'ready') {
        return {
          memberId: member.id,
          name: member.name,
          color: member.color,
          status: 'unavailable',
          busy: [],
        };
      }
      return {
        memberId: member.id,
        name: member.name,
        color: member.color,
        status: 'adult-ready',
        busy,
      };
    });

    return {
      kind: 'ready',
      rows,
      commonFreeWindows: hasUnavailableMember ? [] : windows.commonFreeWindows,
      freeTimeLabel: hasUnavailableMember
        ? undefined
        : formatFreeTimeLabel(windows.totalFreeMinutes),
      hasUnavailableMember,
      hasNotSharedMember,
    };
  } catch {
    return {
      kind: 'day-error',
      rows: [],
      commonFreeWindows: [],
      hasUnavailableMember: false,
      hasNotSharedMember: false,
    };
  }
}

/** Converts busy intervals into clipped 08:00–20:00 bar segments for one Tokyo day. */
export function getTimelineBarSegments(
  date: DateKey,
  intervals: readonly BusyInterval[],
): TimelineBarSegment[] {
  const bounds = getTokyoDayHourBounds(date, TIMELINE_START_HOUR, TIMELINE_END_HOUR);
  const dayDuration = bounds.end - bounds.start;
  const clipped: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const start = parseIsoInstantMilliseconds(interval.start);
    const end = parseIsoInstantMilliseconds(interval.end);
    if (end <= start) throw new RangeError('Busy interval end must follow start');
    const clippedStart = Math.max(start, bounds.start);
    const clippedEnd = Math.min(end, bounds.end);
    if (clippedStart < clippedEnd) clipped.push({ start: clippedStart, end: clippedEnd });
  }
  clipped.sort((left, right) => left.start - right.start || left.end - right.end);
  return clipped.map(({ start, end }) => {
    const leftPercent = Math.max(0, Math.min(100, ((start - bounds.start) / dayDuration) * 100));
    const widthPercent = Math.max(
      0,
      Math.min(100 - leftPercent, ((end - start) / dayDuration) * 100),
    );
    if (!Number.isFinite(leftPercent) || !Number.isFinite(widthPercent)) {
      throw new TypeError('Timeline bar percentages must be finite');
    }
    return {
      leftPercent,
      widthPercent,
      start: toTokyoIsoString(start),
      end: toTokyoIsoString(end),
    };
  });
}

function formatClock(instant: string): string {
  return toTokyoIsoString(instant).slice(11, 16);
}

function intervalLabel(interval: BusyInterval): string {
  const start = parseIsoInstantMilliseconds(interval.start);
  const end = parseIsoInstantMilliseconds(interval.end);
  if (end <= start) throw new RangeError('Busy interval end must follow start');
  return `${formatClock(interval.start)}–${formatClock(interval.end)}`;
}

function joinedIntervals(intervals: readonly BusyInterval[]): string {
  return intervals.map(intervalLabel).join('、');
}

/** Creates a screen-reader sentence for a member's busy intervals. */
export function formatBusyReadout(label: string, intervals: readonly BusyInterval[]): string {
  const times = joinedIntervals(intervals);
  return times ? `${label}：${times} は予定あり` : `${label}：予定ありの時間はありません`;
}

/** Creates a screen-reader sentence for common free intervals. */
export function formatCommonFreeReadout(intervals: readonly BusyInterval[]): string {
  const times = joinedIntervals(intervals);
  return times ? `共通の空き：${times}` : '共通の空きはありません';
}

/** Floors to half-hour increments and returns the compact family-wide free-time label. */
export function formatFreeTimeLabel(totalFreeMinutes: number): string {
  if (!Number.isFinite(totalFreeMinutes) || totalFreeMinutes < 0) {
    throw new RangeError('Free time must be a finite non-negative number');
  }
  const roundedDown = Math.floor(totalFreeMinutes / MINUTES_PER_HALF_HOUR) * MINUTES_PER_HALF_HOUR;
  if (roundedDown === 0) return 'みんな空きなし';
  const hours = roundedDown / 60;
  return `みんな空き ${Number.isInteger(hours) ? String(hours) : hours.toFixed(1)}時間`;
}
