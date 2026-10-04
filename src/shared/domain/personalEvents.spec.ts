import type { DateKey } from '@shared/schemas/date';
import { type WeekEvent, weekEventSchema } from '@shared/schemas/week';
import { describe, expect, it } from 'vitest';
import {
  type PersonalCalendarEvent,
  getPersonalEventsForDate,
  mergeCalendarDayEntries,
} from './personalEvents';

function familyEvent(id: string, title: string, time: WeekEvent['time']): WeekEvent {
  return weekEventSchema.parse({
    id,
    title,
    time,
    memberIds: [],
    assigneeMemberId: null,
    status: 'confirmed',
    isRoutine: false,
    source: 'manual',
    items: [],
  });
}

function personalEvent(
  id: string,
  title: string,
  time: WeekEvent['time'],
  isRoutine = false,
): PersonalCalendarEvent {
  return { id, calendarId: 'primary', title, time, isRoutine };
}

describe('personal calendar day presentation', () => {
  it('assigns all-day, overnight, and multi-day intervals to overlapping Tokyo dates only', () => {
    const events = [
      personalEvent('multi', '旅行', {
        kind: 'all-day',
        start: '2026-10-05',
        endExclusive: '2026-10-08',
      }),
      personalEvent('overnight', '夜勤', {
        kind: 'timed',
        start: '2026-10-06T23:00:00+09:00',
        endExclusive: '2026-10-07T01:00:00+09:00',
      }),
      personalEvent('midnight', '深夜', {
        kind: 'timed',
        start: '2026-10-07T00:00:00+09:00',
        endExclusive: '2026-10-07T01:00:00+09:00',
      }),
      personalEvent('ends-midnight', '終わり', {
        kind: 'timed',
        start: '2026-10-06T23:00:00+09:00',
        endExclusive: '2026-10-07T00:00:00+09:00',
      }),
    ];

    expect(
      getPersonalEventsForDate('2026-10-06' as DateKey, events, false).map(({ id }) => id),
    ).toEqual(['multi', 'overnight', 'ends-midnight']);
    expect(
      getPersonalEventsForDate('2026-10-07' as DateKey, events, false).map(({ id }) => id),
    ).toEqual(['multi', 'overnight', 'midnight']);
    expect(getPersonalEventsForDate('2026-10-08' as DateKey, events, false)).toEqual([]);
  });

  it('sorts all-day entries before timed entries, then start, title, and id', () => {
    const entries = mergeCalendarDayEntries(
      [
        familyEvent('family-b', '会議', {
          kind: 'timed',
          start: '2026-10-05T09:00:00+09:00',
          endExclusive: '2026-10-05T10:00:00+09:00',
        }),
      ],
      [
        personalEvent('same-time-b', '会議', {
          kind: 'timed',
          start: '2026-10-05T09:00:00+09:00',
          endExclusive: '2026-10-05T10:00:00+09:00',
        }),
        personalEvent('all-day', '予定', {
          kind: 'all-day',
          start: '2026-10-05',
          endExclusive: '2026-10-06',
        }),
        personalEvent('same-time-a', '会議', {
          kind: 'timed',
          start: '2026-10-05T09:00:00+09:00',
          endExclusive: '2026-10-05T10:00:00+09:00',
        }),
        personalEvent('earlier', '朝', {
          kind: 'timed',
          start: '2026-10-05T08:00:00+09:00',
          endExclusive: '2026-10-05T09:00:00+09:00',
        }),
      ],
    );

    expect(entries.map((entry) => entry.event.id)).toEqual([
      'all-day',
      'earlier',
      'family-b',
      'same-time-a',
      'same-time-b',
    ]);
  });

  it('filters personal recurring events with the shared routine toggle', () => {
    const events = [
      personalEvent(
        'routine',
        '毎週の予定',
        { kind: 'all-day', start: '2026-10-05', endExclusive: '2026-10-06' },
        true,
      ),
      personalEvent('single', '個人予定', {
        kind: 'all-day',
        start: '2026-10-05',
        endExclusive: '2026-10-06',
      }),
    ];

    expect(
      getPersonalEventsForDate('2026-10-05' as DateKey, events, true).map(({ id }) => id),
    ).toEqual(['single']);
  });
});
