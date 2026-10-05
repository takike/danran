import type { DateKey } from '@shared/schemas/date';
import type { EventInputTime } from '@shared/schemas/events';
import type { PersonalEvent } from '@shared/schemas/personal';
import type { WeekEvent, WeekResponse } from '@shared/schemas/week';
import type { BusyWeekResponse } from '@shared/schemas/week-busy';
import { getDayBounds, toTokyoIsoString } from '@shared/time/date';
import {
  getIntervalDurationMinutes,
  getTokyoDayHourBounds,
  parseIsoInstantMilliseconds,
  shiftInstantMinutes,
} from '@shared/time/interval';
import type { BusyInterval } from './busyIntervals';
import { getFreeWindows } from './freeWindows';
import { getLongWeekendBadges } from './weekPresentation';

export const DAY_TIMELINE_START_HOUR = 7;
export const DAY_TIMELINE_END_HOUR = 21;
export const DAY_PIXELS_PER_HOUR = 48;
const MIN_BLOCK_HEIGHT = 44;

export type DayEventGeometry =
  | { kind: 'timeline'; top: number; height: number; start: string; end: string }
  | { kind: 'all-day' }
  | { kind: 'outside'; direction: 'before' | 'after' };

export interface DayEventColumn {
  memberIds: string[];
  spansAll: boolean;
  isAssignee: boolean;
  isTarget: boolean;
  assigneeMemberId: string | null;
}

export interface DayBlockLaneInput {
  id: string;
  memberIds: readonly string[];
  top: number;
  height: number;
}

export interface DayBlockLane extends DayBlockLaneInput {
  lane: number;
  laneCount: number;
}

export interface DayMemberLaneInput {
  column: Pick<DayEventColumn, 'memberIds'>;
  laneCount: number;
}

export interface PositionedDayEvent<T extends WeekEvent | PersonalEvent> {
  event: T;
  column: DayEventColumn;
  geometry: Extract<DayEventGeometry, { kind: 'timeline' }>;
  lane: number;
  laneCount: number;
}

export interface WeekendBusyRow {
  memberId: string;
  status: 'ready' | 'not_shared' | 'unavailable' | 'child';
  busy: BusyInterval[];
}

export interface WeekendDayFreeBand {
  start: string;
  end: string;
  initialTime: Extract<EventInputTime, { kind: 'timed' }>;
  geometry: Extract<DayEventGeometry, { kind: 'timeline' }>;
}

export interface FreeBandHitGeometry {
  top: number;
  height: number;
  backgroundTop: number;
}

export interface WeekendDayLayout {
  kind: 'ready' | 'family-error' | 'day-error';
  ownMemberId: string | null;
  familyBlocks: PositionedDayEvent<WeekEvent>[];
  personalBlocks: PositionedDayEvent<PersonalEvent>[];
  allDayFamilyEvents: WeekEvent[];
  allDayPersonalEvents: PersonalEvent[];
  outsideFamilyEvents: WeekEvent[];
  outsidePersonalEvents: PersonalEvent[];
  busyRows: WeekendBusyRow[];
  hasUnavailableMember: boolean;
  hasNotSharedMember: boolean;
  freeBands: WeekendDayFreeBand[];
}

/** Clips an event to the 07:00–21:00 Tokyo day timeline or identifies its bucket. */
export function getDayEventGeometry(
  date: DateKey,
  time: WeekEvent['time'] | PersonalEvent['time'],
  minimumHeight = MIN_BLOCK_HEIGHT,
): DayEventGeometry {
  if (time.kind === 'all-day') return { kind: 'all-day' };
  if (!Number.isFinite(minimumHeight) || minimumHeight <= 0) {
    throw new RangeError('Minimum event card height must be finite and positive');
  }

  const intervalGeometry = getDayIntervalGeometry(date, {
    start: time.start,
    end: time.endExclusive,
  });
  if (intervalGeometry.kind !== 'timeline') return intervalGeometry;
  const bounds = getTokyoDayHourBounds(date, DAY_TIMELINE_START_HOUR, DAY_TIMELINE_END_HOUR);
  const rawTop =
    ((parseIsoInstantMilliseconds(intervalGeometry.start) - bounds.start) / 3_600_000) *
    DAY_PIXELS_PER_HOUR;
  const actualHeight =
    ((parseIsoInstantMilliseconds(intervalGeometry.end) -
      parseIsoInstantMilliseconds(intervalGeometry.start)) /
      3_600_000) *
    DAY_PIXELS_PER_HOUR;
  const timelineHeight = DAY_PIXELS_PER_HOUR * (DAY_TIMELINE_END_HOUR - DAY_TIMELINE_START_HOUR);
  const height = Math.min(timelineHeight, Math.max(minimumHeight, actualHeight));
  const top = Math.min(rawTop, timelineHeight - height);
  if (![top, height].every(Number.isFinite))
    throw new TypeError('Timeline geometry must be finite');
  return { ...intervalGeometry, top, height };
}

/** Clips an interval to the timeline without expanding or shifting its actual duration. */
export function getDayIntervalGeometry(
  date: DateKey,
  interval: Pick<BusyInterval, 'start' | 'end'>,
): DayEventGeometry {
  const bounds = getTokyoDayHourBounds(date, DAY_TIMELINE_START_HOUR, DAY_TIMELINE_END_HOUR);
  const start = parseIsoInstantMilliseconds(interval.start);
  const end = parseIsoInstantMilliseconds(interval.end);
  if (end <= start) throw new RangeError('Event end must follow start');
  if (end <= bounds.start) return { kind: 'outside', direction: 'before' };
  if (start >= bounds.end) return { kind: 'outside', direction: 'after' };

  const clippedStart = Math.max(start, bounds.start);
  const clippedEnd = Math.min(end, bounds.end);
  const top = ((clippedStart - bounds.start) / 3_600_000) * DAY_PIXELS_PER_HOUR;
  const height = ((clippedEnd - clippedStart) / 3_600_000) * DAY_PIXELS_PER_HOUR;
  if (![top, height].every(Number.isFinite))
    throw new TypeError('Timeline geometry must be finite');
  return {
    kind: 'timeline',
    top,
    height,
    start: toTokyoIsoString(clippedStart),
    end: toTokyoIsoString(clippedEnd),
  };
}

/** Assigns family events to target columns and adds a distinct assignee-only column when needed. */
export function assignEventColumns(
  targetMemberIds: readonly string[],
  assigneeMemberId: string | null,
  members: readonly Pick<WeekResponse['members'][number], 'id'>[],
): DayEventColumn[] {
  const knownIds = new Set(members.map((member) => member.id));
  const targets = [...new Set(targetMemberIds)].filter((memberId) => knownIds.has(memberId));
  const assignee = assigneeMemberId && knownIds.has(assigneeMemberId) ? assigneeMemberId : null;

  if (targets.length === 0) {
    return [
      {
        memberIds: members.map((member) => member.id),
        spansAll: true,
        isAssignee: assignee !== null,
        isTarget: false,
        assigneeMemberId: assignee,
      },
    ];
  }
  const columns = targets.map((memberId) => ({
    memberIds: [memberId],
    spansAll: false,
    isAssignee: memberId === assignee,
    isTarget: true,
    assigneeMemberId: memberId === assignee ? assignee : null,
  }));
  if (assignee && !targets.includes(assignee)) {
    columns.push({
      memberIds: [assignee],
      spansAll: false,
      isAssignee: true,
      isTarget: false,
      assigneeMemberId: assignee,
    });
  }
  return columns;
}

/** Assigns overlap lanes independently per member column, accounting for short-block minimum height. */
export function layoutDayEventBlocks(blocks: readonly DayBlockLaneInput[]): DayBlockLane[] {
  const normalized = blocks.map((block) => {
    if (!Number.isFinite(block.top) || !Number.isFinite(block.height) || block.height <= 0) {
      throw new RangeError('Timeline block geometry must be finite and positive');
    }
    return { ...block, memberIds: [...new Set(block.memberIds)] };
  });
  const overlaps = (left: DayBlockLaneInput, right: DayBlockLaneInput) =>
    left.top < right.top + right.height &&
    right.top < left.top + left.height &&
    (left.memberIds.length === 0 ||
      right.memberIds.length === 0 ||
      left.memberIds.some((id) => right.memberIds.includes(id)));

  const unseen = new Set(normalized.map((_, index) => index));
  const results = new Map<number, { lane: number; laneCount: number }>();
  while (unseen.size > 0) {
    const first = unseen.values().next().value as number;
    const cluster: number[] = [];
    const queue = [first];
    unseen.delete(first);
    while (queue.length > 0) {
      const index = queue.pop();
      if (index === undefined) continue;
      cluster.push(index);
      const block = normalized[index];
      if (!block) continue;
      for (const candidateIndex of [...unseen]) {
        const candidate = normalized[candidateIndex];
        if (candidate && overlaps(block, candidate)) {
          unseen.delete(candidateIndex);
          queue.push(candidateIndex);
        }
      }
    }

    cluster.sort((leftIndex, rightIndex) => {
      const left = normalized[leftIndex];
      const right = normalized[rightIndex];
      return (
        (left?.top ?? 0) - (right?.top ?? 0) || (left?.id ?? '').localeCompare(right?.id ?? '')
      );
    });
    const placedByLane: DayBlockLaneInput[][] = [];
    for (const index of cluster) {
      const block = normalized[index];
      if (!block) continue;
      let lane = placedByLane.findIndex((placedBlocks) =>
        placedBlocks.every((placed) => !overlaps(block, placed)),
      );
      if (lane < 0) lane = placedByLane.length;
      const laneBlocks = placedByLane[lane] ?? [];
      laneBlocks.push(block);
      placedByLane[lane] = laneBlocks;
      results.set(index, { lane, laneCount: 0 });
    }
    const count = placedByLane.length;
    for (const index of cluster) {
      const placement = results.get(index);
      if (placement) results.set(index, { ...placement, laneCount: count });
    }
  }

  return normalized.map((block, index) => ({
    ...block,
    ...(results.get(index) ?? { lane: 0, laneCount: 1 }),
  }));
}

/** Returns the maximum simultaneous lane count needed by each member, in family display order. */
export function getDayMemberLaneCounts(
  members: readonly Pick<WeekResponse['members'][number], 'id'>[],
  blocks: readonly DayMemberLaneInput[],
): number[] {
  return members.map((member) => {
    const laneCounts = blocks
      .filter((block) => block.column.memberIds.includes(member.id))
      .map((block) => block.laneCount);
    if (laneCounts.some((count) => !Number.isSafeInteger(count) || count < 1)) {
      throw new RangeError('Timeline lane count must be a positive integer');
    }
    return Math.max(1, ...laneCounts);
  });
}

/** Builds deterministic grid tracks that keep every rendered lane at least the chosen token width. */
export function getDayMemberColumnTracks(
  laneCounts: readonly number[],
  laneWidth = 'var(--day-member-column-width)',
): string[] {
  if (!laneWidth.trim()) throw new TypeError('Timeline lane width must not be empty');
  return laneCounts.map((laneCount) => {
    if (!Number.isSafeInteger(laneCount) || laneCount < 1) {
      throw new RangeError('Timeline lane count must be a positive integer');
    }
    return laneCount === 1
      ? laneWidth
      : `calc(${Array.from({ length: laneCount }, () => laneWidth).join(' + ')})`;
  });
}

/** Keeps free-window geometry exact while providing a clipped minimum-sized hit target. */
export function getFreeBandHitGeometry(
  geometry: Pick<Extract<DayEventGeometry, { kind: 'timeline' }>, 'top' | 'height'>,
  timelineHeight = DAY_PIXELS_PER_HOUR * (DAY_TIMELINE_END_HOUR - DAY_TIMELINE_START_HOUR),
  minimumHitHeight = 44,
): FreeBandHitGeometry {
  if (
    !Number.isFinite(geometry.top) ||
    !Number.isFinite(geometry.height) ||
    geometry.top < 0 ||
    geometry.height <= 0 ||
    geometry.top + geometry.height > timelineHeight ||
    !Number.isFinite(timelineHeight) ||
    timelineHeight <= 0 ||
    !Number.isFinite(minimumHitHeight) ||
    minimumHitHeight <= 0
  ) {
    throw new RangeError('Invalid free-band hit geometry');
  }
  const height = Math.min(timelineHeight, Math.max(minimumHitHeight, geometry.height));
  const top = Math.max(
    0,
    Math.min(geometry.top - (height - geometry.height) / 2, timelineHeight - height),
  );
  return { top, height, backgroundTop: geometry.top - top };
}

/** Builds a one-hour (or shorter) timed event range from the start of a free band. */
export function getFreeBandInitialEventTime(
  interval: BusyInterval,
): Extract<EventInputTime, { kind: 'timed' }> {
  const duration = getIntervalDurationMinutes(interval.start, interval.end);
  const minutes = Math.min(60, duration);
  return {
    kind: 'timed',
    start: toTokyoIsoString(interval.start),
    endExclusive: toTokyoIsoString(shiftInstantMinutes(interval.start, minutes)),
  };
}

/** Returns an ordinal long-weekend label for a date in a consecutive holiday/weekend run. */
export function getLongWeekendPosition(
  date: DateKey,
  days: readonly WeekResponse['days'][number][],
): { dayNumber: number; dayCount: number; label: string } | undefined {
  const badge = getLongWeekendBadges(days).find(
    (candidate) => candidate.start <= date && date <= candidate.endInclusive,
  );
  if (!badge) return undefined;
  const dayNumber = days.filter(
    (day) => day.layout === 'weekend-card' && day.date >= badge.start && day.date <= date,
  ).length;
  const dayCount = badge.dayCount;
  return { dayNumber, dayCount, label: `${dayCount}連休の${dayNumber}日目` };
}

/** Aggregates a day without mixing private event details into family busy output. */
export function buildWeekendDayLayout(options: {
  date: DateKey;
  members: readonly WeekResponse['members'][number][];
  dayEvents?: readonly WeekEvent[];
  hasFamilyEvents: boolean;
  busyResponse?: BusyWeekResponse;
  ownMemberId: string;
  ownPersonalMemberId?: string;
  ownPersonalEvents: readonly PersonalEvent[];
}): WeekendDayLayout {
  try {
    const members = options.members;
    const dayEvents = (options.dayEvents ?? []).filter((event) =>
      eventOverlapsDate(options.date, event.time),
    );
    const adults = members.filter((member) => member.kind === 'adult');
    const ownMemberId =
      options.ownPersonalMemberId === options.ownMemberId &&
      adults.some((member) => member.id === options.ownMemberId)
        ? options.ownMemberId
        : null;
    const adultIds = new Set(adults.map((member) => member.id));
    const busyById = new Map<string, BusyWeekResponse['members']>();
    for (const entry of options.busyResponse?.members ?? []) {
      if (!adultIds.has(entry.memberId)) continue;
      const existing = busyById.get(entry.memberId) ?? [];
      existing.push(entry);
      busyById.set(entry.memberId, existing);
    }
    const duplicateOrMissing =
      !options.busyResponse ||
      adults.length === 0 ||
      adults.some((member) => (busyById.get(member.id)?.length ?? 0) !== 1);
    const hasUnavailableMember =
      duplicateOrMissing ||
      adults.some((member) => busyById.get(member.id)?.[0]?.status === 'unavailable');
    const hasNotSharedMember = adults.some(
      (member) => busyById.get(member.id)?.[0]?.status === 'not_shared',
    );
    const personalBusy = Object.fromEntries(
      adults.flatMap((member) => {
        const entry = busyById.get(member.id)?.[0];
        return entry?.status === 'ready' ? [[member.id, entry.busy]] : [];
      }),
    );
    const windows = getFreeWindows({
      date: options.date,
      memberIds: members.map((member) => member.id),
      personalBusy,
      familyEvents: dayEvents,
      startHour: 8,
      endHour: 20,
    });
    const freeBands =
      hasUnavailableMember || !options.hasFamilyEvents
        ? []
        : windows.commonFreeWindows.map((interval) => ({
            ...interval,
            initialTime: getFreeBandInitialEventTime(interval),
            geometry: getTimelineIntervalGeometry(options.date, interval),
          }));

    const family = categorizeAndPositionEvents(options.date, dayEvents, members);
    const ownEvents = ownMemberId
      ? options.ownPersonalEvents.filter((event) => eventOverlapsDate(options.date, event.time))
      : [];
    const personal = categorizeAndPositionEvents(
      options.date,
      ownEvents,
      members,
      options.ownMemberId,
    );
    const allBlockLanes = layoutDayEventBlocks([
      ...family.blocks.map(toLaneInput),
      ...personal.blocks.map(toLaneInput),
    ]);
    family.blocks = family.blocks.map((block, index) => ({
      ...block,
      lane: allBlockLanes[index]?.lane ?? 0,
      laneCount: allBlockLanes[index]?.laneCount ?? 1,
    }));
    personal.blocks = personal.blocks.map((block, index) => {
      const lane = allBlockLanes[family.blocks.length + index];
      return { ...block, lane: lane?.lane ?? 0, laneCount: lane?.laneCount ?? 1 };
    });
    const busyRows: WeekendBusyRow[] = members.map((member) => {
      if (member.kind === 'child') return { memberId: member.id, status: 'child', busy: [] };
      const entry = busyById.get(member.id)?.[0];
      if (busyById.get(member.id)?.length !== 1 || entry?.status === 'unavailable' || !entry) {
        return { memberId: member.id, status: 'unavailable', busy: [] };
      }
      if (entry.status === 'not_shared')
        return { memberId: member.id, status: 'not_shared', busy: [] };
      return {
        memberId: member.id,
        status: 'ready',
        busy: clipBusyIntervalsToDay(options.date, entry.busy),
      };
    });
    return {
      kind: options.hasFamilyEvents ? 'ready' : 'family-error',
      ownMemberId,
      familyBlocks: family.blocks,
      personalBlocks: personal.blocks,
      allDayFamilyEvents: family.allDay,
      allDayPersonalEvents: personal.allDay,
      outsideFamilyEvents: family.outside,
      outsidePersonalEvents: personal.outside,
      busyRows,
      hasUnavailableMember,
      hasNotSharedMember,
      freeBands,
    };
  } catch {
    return {
      kind: 'day-error',
      ownMemberId: null,
      familyBlocks: [],
      personalBlocks: [],
      allDayFamilyEvents: [],
      allDayPersonalEvents: [],
      outsideFamilyEvents: [],
      outsidePersonalEvents: [],
      busyRows: [],
      hasUnavailableMember: false,
      hasNotSharedMember: false,
      freeBands: [],
    };
  }
}

function eventOverlapsDate(
  date: DateKey,
  time: WeekEvent['time'] | PersonalEvent['time'],
): boolean {
  const bounds = getDayBounds(date);
  if (time.kind === 'all-day')
    return time.start < bounds.endExclusiveIso.slice(0, 10) && time.endExclusive > date;
  return (
    parseIsoInstantMilliseconds(time.start) < parseIsoInstantMilliseconds(bounds.endExclusiveIso) &&
    parseIsoInstantMilliseconds(time.endExclusive) > parseIsoInstantMilliseconds(bounds.startIso)
  );
}

function clipBusyIntervalsToDay(date: DateKey, intervals: readonly BusyInterval[]): BusyInterval[] {
  const bounds = getDayBounds(date);
  const dayStart = parseIsoInstantMilliseconds(bounds.startIso);
  const dayEnd = parseIsoInstantMilliseconds(bounds.endExclusiveIso);
  return intervals.flatMap((interval) => {
    const start = parseIsoInstantMilliseconds(interval.start);
    const end = parseIsoInstantMilliseconds(interval.end);
    if (end <= start) throw new RangeError('Busy interval end must follow start');
    if (end <= dayStart || start >= dayEnd) return [];
    return [
      {
        start: toTokyoIsoString(Math.max(start, dayStart)),
        end: toTokyoIsoString(Math.min(end, dayEnd)),
      },
    ];
  });
}

function getTimelineIntervalGeometry(
  date: DateKey,
  interval: BusyInterval,
): Extract<DayEventGeometry, { kind: 'timeline' }> {
  const geometry = getDayIntervalGeometry(date, interval);
  if (geometry.kind !== 'timeline') throw new RangeError('Expected interval inside timeline');
  return geometry;
}

function categorizeAndPositionEvents<T extends WeekEvent | PersonalEvent>(
  date: DateKey,
  events: readonly T[],
  members: readonly WeekResponse['members'][number][],
  personalMemberId?: string,
): { blocks: PositionedDayEvent<T>[]; allDay: T[]; outside: T[] } {
  const allDay: T[] = [];
  const outside: T[] = [];
  const drafts: Array<{
    event: T;
    column: DayEventColumn;
    geometry: Extract<DayEventGeometry, { kind: 'timeline' }>;
  }> = [];
  for (const event of events) {
    const geometry = getDayEventGeometry(date, event.time, getMinimumCardHeight(event));
    if (geometry.kind === 'all-day') {
      allDay.push(event);
      continue;
    }
    if (geometry.kind === 'outside') {
      outside.push(event);
      continue;
    }
    const columns =
      'memberIds' in event
        ? assignEventColumns(
            event.memberIds,
            'assigneeMemberId' in event ? event.assigneeMemberId : null,
            members,
          )
        : [
            {
              memberIds: personalMemberId ? [personalMemberId] : [],
              spansAll: false,
              isAssignee: false,
              isTarget: true,
              assigneeMemberId: null,
            },
          ];
    for (const column of columns) drafts.push({ event, column, geometry });
  }
  const blocks = drafts.map((draft) => ({ ...draft, lane: 0, laneCount: 1 }));
  return { blocks, allDay, outside };
}

function toLaneInput(
  block: PositionedDayEvent<WeekEvent | PersonalEvent>,
  index: number,
): DayBlockLaneInput {
  return {
    id: `${block.event.id}:${index}`,
    memberIds: block.column.memberIds,
    top: block.geometry.top,
    height: block.geometry.height,
  };
}

function getMinimumCardHeight(event: WeekEvent | PersonalEvent): number {
  if (!('status' in event)) return 68;
  const baseHeight = event.status === 'tentative' ? 88 : 68;
  return baseHeight + event.items.length * 24;
}
