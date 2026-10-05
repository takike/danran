import type { DateKey } from '@shared/schemas/date';
import { personalEventSchema } from '@shared/schemas/personal';
import { type WeekEvent, weekResponseSchema } from '@shared/schemas/week';
import { busyWeekResponseSchema } from '@shared/schemas/week-busy';
import { describe, expect, it } from 'vitest';
import {
  assignEventColumns,
  buildWeekendDayLayout,
  getDayEventDurationMilliseconds,
  getDayEventGeometry,
  getDayEventHitGeometry,
  getDayEventHitPriority,
  getDayIntervalGeometry,
  getDayMemberColumnTracks,
  getDayMemberLaneCounts,
  getDaySpanningTitleArea,
  getFreeBandHitGeometry,
  getFreeBandInitialEventTime,
  getLongWeekendPosition,
  layoutDayEventBlocks,
} from './weekendDay';

const week = weekResponseSchema.parse({
  family: { id: 'family', name: 'Family' },
  members: [
    { id: 'adult-a', name: 'A', color: 'indigo', kind: 'adult', sortOrder: 0 },
    { id: 'adult-b', name: 'B', color: 'teal', kind: 'adult', sortOrder: 1 },
    { id: 'child-c', name: 'C', color: 'rose', kind: 'child', sortOrder: 2 },
  ],
  week: {
    start: '2026-10-05',
    endInclusive: '2026-10-11',
    prevWeekStart: '2026-09-28',
    nextWeekStart: '2026-10-12',
    today: '2026-10-05',
  },
  days: [
    {
      date: '2026-10-10',
      weekday: 6,
      holidayName: null,
      closures: [],
      layout: 'weekend-card',
      eventIds: ['family-event'],
    },
    {
      date: '2026-10-11',
      weekday: 0,
      holidayName: null,
      closures: [],
      layout: 'weekend-card',
      eventIds: [],
    },
    {
      date: '2026-10-12',
      weekday: 1,
      holidayName: 'スポーツの日',
      closures: [],
      layout: 'weekend-card',
      eventIds: [],
    },
  ],
  events: [],
});

const readyBusy = busyWeekResponseSchema.parse({
  family: { id: 'family' },
  week: week.week,
  members: [
    { memberId: 'adult-a', status: 'ready', busy: [] },
    { memberId: 'adult-b', status: 'ready', busy: [] },
  ],
});

function familyEvent(overrides: Partial<WeekEvent> = {}): WeekEvent {
  return {
    id: 'family-event',
    title: 'Family',
    time: {
      kind: 'timed',
      start: '2026-10-10T12:00:00+09:00',
      endExclusive: '2026-10-10T13:00:00+09:00',
    },
    memberIds: ['adult-a'],
    assigneeMemberId: null,
    status: 'confirmed',
    isRoutine: false,
    source: 'manual',
    items: [],
    ...overrides,
  };
}

describe('weekend day presentation', () => {
  it('clips timeline blocks at 07:00 and 21:00 with a 24px visual minimum', () => {
    expect(
      getDayEventGeometry('2026-10-10', {
        kind: 'timed',
        start: '2026-10-10T06:00:00+09:00',
        endExclusive: '2026-10-10T07:00:00+09:00',
      }),
    ).toEqual({ kind: 'outside', direction: 'before' });
    expect(
      getDayEventGeometry('2026-10-10', {
        kind: 'timed',
        start: '2026-10-10T21:00:00+09:00',
        endExclusive: '2026-10-10T22:00:00+09:00',
      }),
    ).toEqual({ kind: 'outside', direction: 'after' });
    expect(
      getDayEventGeometry('2026-10-10', {
        kind: 'timed',
        start: '2026-10-10T06:30:00+09:00',
        endExclusive: '2026-10-10T07:30:00+09:00',
      }),
    ).toMatchObject({ kind: 'timeline', top: 0, height: 24, start: '2026-10-10T07:00:00+09:00' });
    expect(
      getDayEventGeometry('2026-10-10', {
        kind: 'timed',
        start: '2026-10-10T20:30:00+09:00',
        endExclusive: '2026-10-10T21:00:00+09:00',
      }),
    ).toMatchObject({ kind: 'timeline', top: 648, height: 24, end: '2026-10-10T21:00:00+09:00' });
    expect(
      getDayEventGeometry('2026-10-10', {
        kind: 'timed',
        start: '2026-10-10T23:30:00+09:00',
        endExclusive: '2026-10-11T00:00:00+09:00',
      }),
    ).toMatchObject({ kind: 'outside', direction: 'after' });
  });

  it('keeps free bands and busy intervals at their exact clipped time geometry', () => {
    expect(
      getDayIntervalGeometry('2026-10-10', {
        start: '2026-10-10T10:00:00+09:00',
        end: '2026-10-10T10:05:00+09:00',
      }),
    ).toEqual({
      kind: 'timeline',
      top: 144,
      height: 4,
      start: '2026-10-10T10:00:00+09:00',
      end: '2026-10-10T10:05:00+09:00',
    });
    const result = buildWeekendDayLayout({
      date: '2026-10-10',
      members: week.members,
      hasFamilyEvents: true,
      busyResponse: readyBusy,
      ownMemberId: 'adult-a',
      ownPersonalEvents: [],
    });
    expect(result.freeBands[0]?.geometry.height).toBe(576);
    expect(getFreeBandHitGeometry({ top: 48, height: 24 })).toEqual({
      top: 38,
      height: 44,
      backgroundTop: 10,
    });
    expect(getFreeBandHitGeometry({ top: 648, height: 24 })).toEqual({
      top: 628,
      height: 44,
      backgroundTop: 20,
    });
    expect(getFreeBandHitGeometry({ top: 100, height: 240 })).toEqual({
      top: 100,
      height: 240,
      backgroundTop: 0,
    });
    expect(() => getFreeBandHitGeometry({ top: 650, height: 30 })).toThrow(RangeError);
    const halfHourOnly = busyWeekResponseSchema.parse({
      ...readyBusy,
      members: [
        {
          memberId: 'adult-a',
          status: 'ready',
          busy: [{ start: '2026-10-10T08:30:00+09:00', end: '2026-10-10T20:00:00+09:00' }],
        },
        { memberId: 'adult-b', status: 'ready', busy: [] },
      ],
    });
    const shortBand = buildWeekendDayLayout({
      date: '2026-10-10',
      members: week.members,
      hasFamilyEvents: true,
      busyResponse: halfHourOnly,
      ownMemberId: 'adult-a',
      ownPersonalEvents: [],
    }).freeBands[0];
    expect(shortBand?.geometry.height).toBe(24);
    expect(shortBand?.initialTime.endExclusive).toBe('2026-10-10T08:30:00+09:00');
  });

  it('buckets all-day events and rejects invalid timed intervals', () => {
    expect(
      getDayEventGeometry('2026-10-10', {
        kind: 'all-day',
        start: '2026-10-10',
        endExclusive: '2026-10-11',
      }),
    ).toEqual({ kind: 'all-day' });
    expect(() =>
      getDayEventGeometry('2026-10-10', {
        kind: 'timed',
        start: '2026-10-10T10:00:00+09:00',
        endExclusive: '2026-10-10T09:00:00+09:00',
      }),
    ).toThrow(RangeError);
  });

  it('keeps visible event height proportional for every status and item count', () => {
    const intervals = [
      ['10:00', '11:00', 48],
      ['10:00', '10:30', 24],
      ['10:00', '10:15', 24],
      ['10:00', '12:00', 96],
    ] as const;
    for (const [start, end, height] of intervals) {
      for (const status of ['confirmed', 'tentative'] as const) {
        for (const items of [[], ['水筒', '着替え']]) {
          const event = familyEvent({
            status,
            items,
            time: {
              kind: 'timed',
              start: `2026-10-10T${start}:00+09:00`,
              endExclusive: `2026-10-10T${end}:00+09:00`,
            },
          });
          const layout = buildWeekendDayLayout({
            date: '2026-10-10',
            members: week.members,
            dayEvents: [event],
            hasFamilyEvents: true,
            busyResponse: readyBusy,
            ownMemberId: 'adult-a',
            ownPersonalEvents: [],
          });
          expect(layout.familyBlocks[0]?.geometry.height).toBe(height);
        }
      }
    }

    const privateEvent = personalEventSchema.parse({
      id: 'private-short',
      calendarId: 'personal-calendar',
      title: 'Private',
      time: {
        kind: 'timed',
        start: '2026-10-10T10:00:00+09:00',
        endExclusive: '2026-10-10T10:30:00+09:00',
      },
      isRoutine: false,
    });
    const privateLayout = buildWeekendDayLayout({
      date: '2026-10-10',
      members: week.members,
      hasFamilyEvents: true,
      busyResponse: readyBusy,
      ownMemberId: 'adult-a',
      ownPersonalMemberId: 'adult-a',
      ownPersonalEvents: [privateEvent],
    });
    expect(privateLayout.personalBlocks[0]?.geometry.height).toBe(24);
  });

  it('keeps 44px event hit areas separate and prioritizes the shorter exact duration', () => {
    const geometry15 = getDayEventGeometry('2026-10-10', {
      kind: 'timed',
      start: '2026-10-10T10:00:00+09:00',
      endExclusive: '2026-10-10T10:15:00+09:00',
    });
    const geometry30 = getDayEventGeometry('2026-10-10', {
      kind: 'timed',
      start: '2026-10-10T10:00:00+09:00',
      endExclusive: '2026-10-10T10:30:00+09:00',
    });
    expect(geometry15).toMatchObject({ kind: 'timeline', height: 24 });
    expect(geometry30).toMatchObject({ kind: 'timeline', height: 24 });
    if (geometry15.kind !== 'timeline' || geometry30.kind !== 'timeline') return;
    expect(getDayEventDurationMilliseconds(geometry15)).toBe(15 * 60 * 1000);
    expect(getDayEventDurationMilliseconds(geometry30)).toBe(30 * 60 * 1000);
    expect(getDayEventHitPriority(geometry15)).toBeGreaterThan(getDayEventHitPriority(geometry30));
    expect(getDayEventHitGeometry(geometry15).height).toBe(44);
    expect(getDayEventHitGeometry(geometry30).height).toBe(44);
    expect(getDayEventHitGeometry({ top: 648, height: 24 })).toEqual({
      top: 628,
      height: 44,
      faceTop: 20,
    });
    expect(
      layoutDayEventBlocks([
        { id: 'half-hour', memberIds: ['adult-a'], top: 120, height: 24 },
        { id: 'hour-after', memberIds: ['adult-a'], top: 144, height: 48 },
      ]).map(({ lane, laneCount }) => [lane, laneCount]),
    ).toEqual([
      [0, 1],
      [0, 1],
    ]);
  });

  it('assigns empty targets across all columns and avoids duplicate assignee columns', () => {
    const members = week.members.map(({ id }) => ({ id }));
    expect(assignEventColumns([], 'adult-b', members)).toEqual([
      {
        memberIds: ['adult-a', 'adult-b', 'child-c'],
        spansAll: true,
        isAssignee: true,
        isTarget: false,
        assigneeMemberId: 'adult-b',
      },
    ]);
    expect(assignEventColumns(['adult-a', 'adult-a'], 'adult-a', members)).toEqual([
      {
        memberIds: ['adult-a'],
        spansAll: false,
        isAssignee: true,
        isTarget: true,
        assigneeMemberId: 'adult-a',
      },
    ]);
    expect(
      assignEventColumns(['adult-a'], 'adult-b', members).map((column) => column.memberIds),
    ).toEqual([['adult-a'], ['adult-b']]);
  });

  it('uses independent overlap lanes for different columns and shared lanes for overlaps', () => {
    const blocks = layoutDayEventBlocks([
      { id: 'a1', memberIds: ['adult-a'], top: 10, height: 40 },
      { id: 'b1', memberIds: ['adult-b'], top: 10, height: 40 },
      { id: 'span', memberIds: ['adult-a', 'adult-b'], top: 20, height: 40 },
      { id: 'later', memberIds: ['adult-a'], top: 80, height: 40 },
    ]);
    expect(blocks.map(({ lane, laneCount }) => [lane, laneCount])).toEqual([
      [0, 2],
      [0, 2],
      [1, 2],
      [0, 1],
    ]);
    expect(
      layoutDayEventBlocks([
        { id: 'a1', memberIds: ['adult-a'], top: 10, height: 44 },
        { id: 'a2', memberIds: ['adult-a'], top: 10, height: 44 },
        { id: 'a3', memberIds: ['adult-a'], top: 10, height: 44 },
        { id: 'b1', memberIds: ['adult-b'], top: 10, height: 44 },
      ]).map(({ lane, laneCount }) => [lane, laneCount]),
    ).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [0, 1],
    ]);
    expect(
      getDayMemberLaneCounts(week.members, [
        { column: { memberIds: ['adult-a', 'adult-b'] }, laneCount: 2 },
        { column: { memberIds: ['adult-a'] }, laneCount: 3 },
      ]),
    ).toEqual([3, 2, 1]);
    for (const memberCount of [1, 2, 3, 4]) {
      expect(getDayMemberColumnTracks(memberCount)).toEqual(
        Array(memberCount).fill('minmax(0, 1fr)'),
      );
    }
    expect(getDayMemberColumnTracks(5)).toEqual(Array(5).fill('var(--day-member-column-width)'));
    expect(getDayMemberColumnTracks(8)).toEqual(Array(8).fill('var(--day-member-column-width)'));
    expect(getDayMemberColumnTracks(0)).toEqual([]);
  });

  it('places a spanning title in the widest clear member run at its start', () => {
    const span = { geometry: { top: 100 }, lane: 0, laneCount: 2 };
    const local = (memberIds: string[], top: number, height = 88) => ({
      column: { memberIds, spansAll: false },
      geometry: { top, height },
    });

    expect(getDaySpanningTitleArea(span, ['a', 'b', 'c', 'd'], [local(['a'], 100)])).toEqual({
      left: 0.25,
      width: 0.75,
      titleOnly: true,
    });
    expect(
      getDaySpanningTitleArea(span, ['a', 'b', 'c', 'd'], [local(['a'], 100), local(['c'], 100)]),
    ).toEqual({ left: 0.25, width: 0.25, titleOnly: true });
    expect(
      getDaySpanningTitleArea(
        { geometry: { top: 100 }, lane: 1, laneCount: 2 },
        ['a', 'b', 'c', 'd'],
        ['a', 'b', 'c', 'd'].map((memberId) => local([memberId], 100)),
      ),
    ).toEqual({ left: 0.125, width: 0.125, titleOnly: true });
    expect(
      getDaySpanningTitleArea(
        { geometry: { top: 100 }, lane: 0, laneCount: 1 },
        ['a', 'b', 'c', 'd'],
        [local(['a'], 144)],
      ),
    ).toEqual({ left: 0, width: 1, titleOnly: false });
    expect(
      getDaySpanningTitleArea(
        { geometry: { top: 100 }, lane: 0, laneCount: 2 },
        ['a', 'b', 'c', 'd'],
        [local(['a'], 144)],
      ),
    ).toEqual({ left: 0, width: 1, titleOnly: false });
  });

  it('uses one-hour or band-length initial time from the band start', () => {
    expect(
      getFreeBandInitialEventTime({
        start: '2026-10-10T09:00:00+09:00',
        end: '2026-10-10T11:00:00+09:00',
      }),
    ).toEqual({
      kind: 'timed',
      start: '2026-10-10T09:00:00+09:00',
      endExclusive: '2026-10-10T10:00:00+09:00',
    });
    expect(
      getFreeBandInitialEventTime({
        start: '2026-10-10T09:00:00+09:00',
        end: '2026-10-10T09:45:00+09:00',
      }).endExclusive,
    ).toBe('2026-10-10T09:45:00+09:00');
  });

  it('labels only known three-day-or-longer weekend badges with the correct ordinal', () => {
    expect(getLongWeekendPosition('2026-10-10', week.days)).toEqual({
      dayNumber: 1,
      dayCount: 3,
      label: '3連休の1日目',
    });
    expect(getLongWeekendPosition('2026-10-12', week.days)).toEqual({
      dayNumber: 3,
      dayCount: 3,
      label: '3連休の3日目',
    });
    expect(getLongWeekendPosition('2026-10-05', week.days)).toBeUndefined();
  });

  it('keeps own personal blocks in the matching second adult column and combines lanes', () => {
    const privateEvent = personalEventSchema.parse({
      id: 'private-event',
      calendarId: 'private-calendar',
      title: 'Only me',
      time: {
        kind: 'timed',
        start: '2026-10-10T12:15:00+09:00',
        endExclusive: '2026-10-10T12:45:00+09:00',
      },
      isRoutine: false,
    });
    const result = buildWeekendDayLayout({
      date: '2026-10-10',
      members: week.members,
      dayEvents: [familyEvent({ memberIds: ['adult-b'] })],
      hasFamilyEvents: true,
      busyResponse: readyBusy,
      ownMemberId: 'adult-b',
      ownPersonalMemberId: 'adult-b',
      ownPersonalEvents: [privateEvent],
    });
    expect(result.kind).toBe('ready');
    expect(result.ownMemberId).toBe('adult-b');
    expect(result.personalBlocks[0]?.column.memberIds).toEqual(['adult-b']);
    expect(result.familyBlocks[0]?.laneCount).toBe(2);
    expect(result.personalBlocks[0]?.laneCount).toBe(2);
    expect(result.freeBands.length).toBeGreaterThan(0);
  });

  it('drops private events with a mismatched response member and keeps privacy buckets separate', () => {
    const privateEvent = personalEventSchema.parse({
      id: 'private-event',
      calendarId: 'private-calendar',
      title: 'Only me',
      time: { kind: 'all-day', start: '2026-10-10', endExclusive: '2026-10-11' },
      isRoutine: false,
    });
    const result = buildWeekendDayLayout({
      date: '2026-10-10',
      members: week.members,
      dayEvents: [familyEvent()],
      hasFamilyEvents: true,
      busyResponse: readyBusy,
      ownMemberId: 'adult-b',
      ownPersonalMemberId: 'adult-a',
      ownPersonalEvents: [privateEvent],
    });
    expect(result.ownMemberId).toBeNull();
    expect(result.allDayPersonalEvents).toEqual([]);
    expect(result.familyBlocks[0]?.event.title).toBe('Family');
    expect(result.busyRows).toEqual([
      { memberId: 'adult-a', status: 'ready', busy: [] },
      { memberId: 'adult-b', status: 'ready', busy: [] },
      { memberId: 'child-c', status: 'child', busy: [] },
    ]);
  });

  it('filters week-long personal events to the requested date before bucketing', () => {
    const events = [
      personalEventSchema.parse({
        id: 'ended-at-midnight',
        calendarId: 'c1',
        title: 'Previous day',
        time: {
          kind: 'timed',
          start: '2026-10-09T23:00:00+09:00',
          endExclusive: '2026-10-10T00:00:00+09:00',
        },
        isRoutine: false,
      }),
      personalEventSchema.parse({
        id: 'same-day-late',
        calendarId: 'c2',
        title: 'Late',
        time: {
          kind: 'timed',
          start: '2026-10-10T22:00:00+09:00',
          endExclusive: '2026-10-11T00:00:00+09:00',
        },
        isRoutine: false,
      }),
      personalEventSchema.parse({
        id: 'future-day',
        calendarId: 'c3',
        title: 'Future',
        time: {
          kind: 'timed',
          start: '2026-10-11T22:00:00+09:00',
          endExclusive: '2026-10-12T00:00:00+09:00',
        },
        isRoutine: false,
      }),
      personalEventSchema.parse({
        id: 'overlapping-all-day',
        calendarId: 'c4',
        title: 'Multi-day',
        time: { kind: 'all-day', start: '2026-10-09', endExclusive: '2026-10-11' },
        isRoutine: false,
      }),
    ];
    const result = buildWeekendDayLayout({
      date: '2026-10-10',
      members: week.members,
      dayEvents: [],
      hasFamilyEvents: true,
      busyResponse: readyBusy,
      ownMemberId: 'adult-a',
      ownPersonalMemberId: 'adult-a',
      ownPersonalEvents: events,
    });
    expect(result.outsidePersonalEvents.map((event) => event.id)).toEqual(['same-day-late']);
    expect(result.allDayPersonalEvents.map((event) => event.id)).toEqual(['overlapping-all-day']);
  });

  it('clips private busy intervals to the selected Tokyo calendar day for readouts', () => {
    const busyResponse = busyWeekResponseSchema.parse({
      ...readyBusy,
      members: [
        {
          memberId: 'adult-a',
          status: 'ready',
          busy: [
            { start: '2026-10-09T09:00:00+09:00', end: '2026-10-09T10:00:00+09:00' },
            { start: '2026-10-09T23:00:00+09:00', end: '2026-10-10T08:00:00+09:00' },
            { start: '2026-10-10T23:00:00+09:00', end: '2026-10-11T01:00:00+09:00' },
            { start: '2026-10-11T09:00:00+09:00', end: '2026-10-11T10:00:00+09:00' },
          ],
        },
        { memberId: 'adult-b', status: 'ready', busy: [] },
      ],
    });
    const result = buildWeekendDayLayout({
      date: '2026-10-10',
      members: week.members,
      hasFamilyEvents: true,
      busyResponse,
      ownMemberId: 'adult-a',
      ownPersonalMemberId: 'adult-a',
      ownPersonalEvents: [],
    });

    expect(result.busyRows.find((row) => row.memberId === 'adult-a')?.busy).toEqual([
      { start: '2026-10-10T00:00:00+09:00', end: '2026-10-10T08:00:00+09:00' },
      { start: '2026-10-10T23:00:00+09:00', end: '2026-10-11T00:00:00+09:00' },
    ]);
  });

  it('hides common free bands for unavailable or incomplete adults and indicates not-shared separately', () => {
    const incomplete = busyWeekResponseSchema.parse({
      family: { id: 'family' },
      week: week.week,
      members: [{ memberId: 'adult-a', status: 'ready', busy: [] }],
    });
    const unavailable = busyWeekResponseSchema.parse({
      family: { id: 'family' },
      week: week.week,
      members: [
        { memberId: 'adult-a', status: 'ready', busy: [] },
        { memberId: 'adult-b', status: 'unavailable', busy: [] },
      ],
    });
    const notShared = busyWeekResponseSchema.parse({
      family: { id: 'family' },
      week: week.week,
      members: [
        { memberId: 'adult-a', status: 'ready', busy: [] },
        { memberId: 'adult-b', status: 'not_shared', busy: [] },
      ],
    });
    const options = {
      date: '2026-10-10' as const,
      members: week.members,
      dayEvents: [familyEvent()],
      hasFamilyEvents: true,
      ownMemberId: 'adult-a',
      ownPersonalEvents: [],
    };
    expect(buildWeekendDayLayout({ ...options, busyResponse: incomplete })).toMatchObject({
      hasUnavailableMember: true,
      freeBands: [],
    });
    expect(buildWeekendDayLayout({ ...options, busyResponse: unavailable })).toMatchObject({
      hasUnavailableMember: true,
      freeBands: [],
    });
    expect(buildWeekendDayLayout({ ...options, busyResponse: notShared })).toMatchObject({
      hasUnavailableMember: false,
      hasNotSharedMember: true,
    });
    expect(
      buildWeekendDayLayout({ ...options, busyResponse: notShared }).freeBands.length,
    ).toBeGreaterThan(0);
    expect(
      buildWeekendDayLayout({ ...options, busyResponse: readyBusy, hasFamilyEvents: false }),
    ).toMatchObject({ kind: 'family-error', freeBands: [] });
    expect(
      buildWeekendDayLayout({
        ...options,
        members: week.members.filter((member) => member.kind === 'child'),
        busyResponse: readyBusy,
      }),
    ).toMatchObject({ hasUnavailableMember: true, freeBands: [] });
  });

  it('fails closed for duplicate adults and catches invalid day calculations', () => {
    const duplicate = busyWeekResponseSchema.parse({
      family: { id: 'family' },
      week: week.week,
      members: [
        { memberId: 'adult-a', status: 'ready', busy: [] },
        { memberId: 'adult-a', status: 'ready', busy: [] },
        { memberId: 'adult-b', status: 'ready', busy: [] },
      ],
    });
    const result = buildWeekendDayLayout({
      date: '2026-10-10',
      members: week.members,
      dayEvents: [familyEvent()],
      hasFamilyEvents: true,
      busyResponse: duplicate,
      ownMemberId: 'adult-a',
      ownPersonalEvents: [],
    });
    expect(result).toMatchObject({ hasUnavailableMember: true, freeBands: [] });
    expect(
      buildWeekendDayLayout({
        date: 'not-a-date' as DateKey,
        members: week.members,
        hasFamilyEvents: false,
        ownMemberId: 'adult-a',
        ownPersonalEvents: [],
      }).kind,
    ).toBe('day-error');
  });
});
