import { weekResponseSchema } from '@shared/schemas/week';
import { busyWeekResponseSchema } from '@shared/schemas/week-busy';
import { describe, expect, it } from 'vitest';
import {
  buildDayBusyTimeline,
  formatBusyReadout,
  formatCommonFreeReadout,
  formatFreeTimeLabel,
  getTimelineBarSegments,
} from './weekendTimeline';

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
      eventIds: ['routine-event'],
    },
  ],
  events: [
    {
      id: 'routine-event',
      title: 'Routine',
      time: {
        kind: 'timed',
        start: '2026-10-10T12:00:00+09:00',
        endExclusive: '2026-10-10T13:00:00+09:00',
      },
      memberIds: [],
      assigneeMemberId: null,
      status: 'confirmed',
      isRoutine: true,
      source: 'publish',
      items: [],
    },
    {
      id: 'other-day-event',
      title: 'Other date entry',
      time: {
        kind: 'timed',
        start: '2026-10-10T09:00:00+09:00',
        endExclusive: '2026-10-10T10:00:00+09:00',
      },
      memberIds: [],
      assigneeMemberId: null,
      status: 'confirmed',
      isRoutine: false,
      source: 'manual',
      items: [],
    },
  ],
});

const readyAndNotSharedResponse = busyWeekResponseSchema.parse({
  family: { id: 'family' },
  week: {
    start: '2026-10-05',
    endInclusive: '2026-10-11',
    prevWeekStart: '2026-09-28',
    nextWeekStart: '2026-10-12',
    today: '2026-10-05',
  },
  members: [
    {
      memberId: 'adult-a',
      status: 'ready',
      busy: [{ start: '2026-10-10T10:00:00+09:00', end: '2026-10-10T11:00:00+09:00' }],
    },
    { memberId: 'adult-b', status: 'not_shared', busy: [] },
    {
      memberId: 'child-c',
      status: 'ready',
      busy: [{ start: '2026-10-10T14:00:00+09:00', end: '2026-10-10T15:00:00+09:00' }],
    },
    {
      memberId: 'unknown-member',
      status: 'ready',
      busy: [{ start: '2026-10-10T16:00:00+09:00', end: '2026-10-10T17:00:00+09:00' }],
    },
  ],
});

describe('weekend timeline presentation', () => {
  it('clips bars to 08:00–20:00 and reports positions as finite percentages', () => {
    const segments = getTimelineBarSegments('2026-10-10', [
      { start: '2026-10-10T07:00:00+09:00', end: '2026-10-10T09:00:00+09:00' },
      { start: '2026-10-10T19:00:00+09:00', end: '2026-10-10T22:00:00+09:00' },
      { start: '2026-10-10T20:00:00+09:00', end: '2026-10-10T21:00:00+09:00' },
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      leftPercent: 0,
      start: '2026-10-10T08:00:00+09:00',
      end: '2026-10-10T09:00:00+09:00',
    });
    expect(segments[0]?.widthPercent).toBeCloseTo(100 / 12);
    expect(segments[1]).toMatchObject({
      start: '2026-10-10T19:00:00+09:00',
      end: '2026-10-10T20:00:00+09:00',
    });
    expect(segments[1]?.leftPercent).toBeCloseTo((11 / 12) * 100);
    expect(segments[1]?.widthPercent).toBeCloseTo(100 / 12);
    for (const segment of segments) {
      expect(Number.isFinite(segment.leftPercent)).toBe(true);
      expect(Number.isFinite(segment.widthPercent)).toBe(true);
      expect(segment.leftPercent).toBeGreaterThanOrEqual(0);
      expect(segment.leftPercent + segment.widthPercent).toBeLessThanOrEqual(100);
    }
  });

  it('formats total free time in floored half-hour increments', () => {
    expect(formatFreeTimeLabel(0)).toBe('みんな空きなし');
    expect(formatFreeTimeLabel(29)).toBe('みんな空きなし');
    expect(formatFreeTimeLabel(30)).toBe('みんな空き 0.5時間');
    expect(formatFreeTimeLabel(239)).toBe('みんな空き 3.5時間');
    expect(formatFreeTimeLabel(240)).toBe('みんな空き 4時間');
  });

  it('creates Japanese accessible readouts through Tokyo time formatting', () => {
    const intervals = [
      { start: '2026-10-10T01:00:00Z', end: '2026-10-10T03:00:00Z' },
      { start: '2026-10-10T06:00:00Z', end: '2026-10-10T07:00:00Z' },
    ];
    expect(formatBusyReadout('彩', intervals)).toBe('彩：10:00–12:00、15:00–16:00 は予定あり');
    expect(formatCommonFreeReadout(intervals)).toBe('共通の空き：10:00–12:00、15:00–16:00');
    expect(formatBusyReadout('彩', [])).toBe('彩：予定ありの時間はありません');
    expect(formatCommonFreeReadout([])).toBe('共通の空きはありません');
  });

  it('throws on invalid timeline inputs for the caller to handle per day', () => {
    expect(() =>
      getTimelineBarSegments('2026-10-10', [{ start: '2026-10-10', end: 'bad' }]),
    ).toThrow();
    expect(() =>
      getTimelineBarSegments('2026-10-10', [
        { start: '2026-10-10T10:00:00+09:00', end: '2026-10-10T09:00:00+09:00' },
      ]),
    ).toThrow(RangeError);
    expect(() => formatFreeTimeLabel(Number.NaN)).toThrow(RangeError);
  });

  it('uses only the day event IDs, counts routines, and ignores child/unknown personal busy entries', () => {
    const result = buildDayBusyTimeline('2026-10-10', week, readyAndNotSharedResponse);
    expect(result.kind).toBe('ready');
    expect(result.hasNotSharedMember).toBe(true);
    expect(result.hasUnavailableMember).toBe(false);
    expect(result.rows.find((row) => row.memberId === 'adult-a')?.busy).toEqual([
      { start: '2026-10-10T10:00:00+09:00', end: '2026-10-10T11:00:00+09:00' },
      { start: '2026-10-10T12:00:00+09:00', end: '2026-10-10T13:00:00+09:00' },
    ]);
    expect(result.rows.find((row) => row.memberId === 'adult-b')?.busy).toEqual([
      { start: '2026-10-10T12:00:00+09:00', end: '2026-10-10T13:00:00+09:00' },
    ]);
    expect(result.rows.find((row) => row.memberId === 'child-c')?.busy).toEqual([
      { start: '2026-10-10T12:00:00+09:00', end: '2026-10-10T13:00:00+09:00' },
    ]);
  });

  it('marks missing and duplicate adult data unavailable and suppresses the common result', () => {
    const missingAdult = busyWeekResponseSchema.parse({
      ...readyAndNotSharedResponse,
      members: readyAndNotSharedResponse.members.filter((member) => member.memberId !== 'adult-b'),
    });
    const missing = buildDayBusyTimeline('2026-10-10', week, missingAdult);
    expect(missing.hasUnavailableMember).toBe(true);
    expect(missing.commonFreeWindows).toEqual([]);
    expect(missing.freeTimeLabel).toBeUndefined();
    expect(missing.rows.find((row) => row.memberId === 'adult-b')?.status).toBe('unavailable');

    const duplicateAdult = busyWeekResponseSchema.parse({
      ...readyAndNotSharedResponse,
      members: [
        ...readyAndNotSharedResponse.members,
        { memberId: 'adult-a', status: 'ready', busy: [] },
      ],
    });
    const duplicate = buildDayBusyTimeline('2026-10-10', week, duplicateAdult);
    expect(duplicate.hasUnavailableMember).toBe(true);
    expect(duplicate.commonFreeWindows).toEqual([]);
    expect(duplicate.rows.find((row) => row.memberId === 'adult-a')?.status).toBe('unavailable');
  });

  it('returns a per-day error if availability calculation receives invalid date data', () => {
    const invalidWeek = {
      ...week,
      events: week.events.map((event) =>
        event.id === 'routine-event'
          ? {
              ...event,
              time: { kind: 'timed' as const, start: 'invalid', endExclusive: 'invalid' },
            }
          : event,
      ),
    };
    const result = buildDayBusyTimeline('2026-10-10', invalidWeek, readyAndNotSharedResponse);
    expect(result.kind).toBe('day-error');
    expect(result.commonFreeWindows).toEqual([]);
  });
});
