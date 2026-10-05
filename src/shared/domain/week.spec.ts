import type { ClosureDay } from '@shared/schemas/closure';
import type { DateKey } from '@shared/schemas/date';
import { weekEventSchema, weekQuerySchema } from '@shared/schemas/week';
import type { WeekEvent } from '@shared/schemas/week';
import { getWeekRange } from '@shared/time/week';
import { describe, expect, it } from 'vitest';
import { buildWeekDays } from './week';

function event(overrides: Partial<WeekEvent> & Pick<WeekEvent, 'id' | 'time'>): WeekEvent {
  return weekEventSchema.parse({
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    time: overrides.time,
    memberIds: overrides.memberIds ?? [],
    assigneeMemberId: overrides.assigneeMemberId ?? null,
    status: overrides.status ?? 'confirmed',
    isRoutine: overrides.isRoutine ?? false,
    affectsAvailability: overrides.affectsAvailability ?? true,
    source: overrides.source ?? 'manual',
    items: overrides.items ?? [],
  });
}

function closure(
  overrides: Partial<ClosureDay> & Pick<ClosureDay, 'id' | 'date' | 'memberIds'>,
): ClosureDay {
  return {
    id: overrides.id,
    familyId: overrides.familyId ?? 'family-1',
    date: overrides.date,
    label: overrides.label ?? overrides.id,
    memberIds: overrides.memberIds,
  };
}

describe('src/shared/domain/week', () => {
  it('maps all-day, multiday, overnight, and exact-midnight events to every overlapping Tokyo day', () => {
    const range = getWeekRange('2026-10-05' as DateKey);
    const days = buildWeekDays(
      range,
      [
        event({
          id: 'multi',
          time: { kind: 'all-day', start: '2026-10-06', endExclusive: '2026-10-08' },
        }),
        event({
          id: 'one-day',
          time: { kind: 'all-day', start: '2026-10-06', endExclusive: '2026-10-07' },
        }),
        event({
          id: 'overnight',
          time: {
            kind: 'timed',
            start: '2026-10-06T23:00:00+09:00',
            endExclusive: '2026-10-07T01:00:00+09:00',
          },
        }),
        event({
          id: 'starts-midnight',
          time: {
            kind: 'timed',
            start: '2026-10-07T00:00:00+09:00',
            endExclusive: '2026-10-07T01:00:00+09:00',
          },
        }),
        event({
          id: 'ends-midnight',
          time: {
            kind: 'timed',
            start: '2026-10-06T23:00:00+09:00',
            endExclusive: '2026-10-07T00:00:00+09:00',
          },
        }),
      ],
      [],
      [],
    );

    const byDate = new Map(days.map((day) => [day.date, day.eventIds]));
    expect(byDate.get('2026-10-06')).toEqual(['multi', 'one-day', 'ends-midnight', 'overnight']);
    expect(byDate.get('2026-10-07')).toEqual(['multi', 'overnight', 'starts-midnight']);
  });

  it('maps a week-spanning event across New Year without clipping its original interval', () => {
    const range = getWeekRange('2026-12-28' as DateKey);
    const longEvent = event({
      id: 'long',
      time: {
        kind: 'timed',
        start: '2026-12-27T23:00:00+09:00',
        endExclusive: '2027-01-04T00:00:00+09:00',
      },
    });
    const newYearEvent = event({
      id: 'new-year',
      time: { kind: 'all-day', start: '2026-12-31', endExclusive: '2027-01-02' },
    });
    const days = buildWeekDays(range, [longEvent, newYearEvent], [], []);

    expect(range.start).toBe('2026-12-28');
    expect(range.endInclusive).toBe('2027-01-03');
    expect(days).toHaveLength(7);
    expect(days.map((day) => day.eventIds)).toEqual([
      ['long'],
      ['long'],
      ['long'],
      ['new-year', 'long'],
      ['new-year', 'long'],
      ['long'],
      ['long'],
    ]);
    expect(longEvent.time).toEqual({
      kind: 'timed',
      start: '2026-12-27T23:00:00+09:00',
      endExclusive: '2027-01-04T00:00:00+09:00',
    });
    expect(days.find((day) => day.date === '2027-01-01')).toMatchObject({
      holidayName: '元日',
      layout: 'weekend-card',
    });
  });

  it('sorts all-day first, then timed by instant, then title and id', () => {
    const range = getWeekRange('2026-10-05' as DateKey);
    const days = buildWeekDays(
      range,
      [
        event({
          id: 'z-title',
          title: 'Zulu',
          time: {
            kind: 'timed',
            start: '2026-10-06T09:00:00+09:00',
            endExclusive: '2026-10-06T10:00:00+09:00',
          },
        }),
        event({
          id: 'late',
          title: 'Early title',
          time: {
            kind: 'timed',
            start: '2026-10-06T10:00:00+09:00',
            endExclusive: '2026-10-06T11:00:00+09:00',
          },
        }),
        event({
          id: 'a-tie',
          title: 'Alpha',
          time: {
            kind: 'timed',
            start: '2026-10-06T09:00:00+09:00',
            endExclusive: '2026-10-06T09:30:00+09:00',
          },
        }),
        event({
          id: 'b-tie',
          title: 'Alpha',
          time: {
            kind: 'timed',
            start: '2026-10-06T09:00:00+09:00',
            endExclusive: '2026-10-06T09:45:00+09:00',
          },
        }),
        event({
          id: 'all-day',
          time: { kind: 'all-day', start: '2026-10-06', endExclusive: '2026-10-07' },
        }),
      ],
      [],
      [],
    );

    expect(days.find((day) => day.date === '2026-10-06')?.eventIds).toEqual([
      'all-day',
      'a-tie',
      'b-tie',
      'z-title',
      'late',
    ]);
  });

  it('keeps holiday extension and weekday routine layout rules', () => {
    const range = getWeekRange('2026-10-05' as DateKey);
    expect(range.endInclusive).toBe('2026-10-12');

    const days = buildWeekDays(
      range,
      [
        event({
          id: 'nonroutine',
          time: {
            kind: 'timed',
            start: '2026-10-06T09:00:00+09:00',
            endExclusive: '2026-10-06T10:00:00+09:00',
          },
          isRoutine: false,
        }),
        event({
          id: 'routine',
          time: {
            kind: 'timed',
            start: '2026-10-07T09:00:00+09:00',
            endExclusive: '2026-10-07T10:00:00+09:00',
          },
          isRoutine: true,
        }),
      ],
      [],
      [],
    );

    expect(days.find((day) => day.date === '2026-10-06')?.layout).toBe('expanded');
    expect(days.find((day) => day.date === '2026-10-07')?.layout).toBe('compact');
    expect(days.find((day) => day.date === '2026-10-12')?.holidayName).toBe('スポーツの日');
    expect(days.find((day) => day.date === '2026-10-12')?.layout).toBe('weekend-card');
  });

  it('applies family and known-member closures while discarding unknown-only targets', () => {
    const range = getWeekRange('2026-10-05' as DateKey);
    const days = buildWeekDays(
      range,
      [],
      [
        closure({ id: 'family', date: '2026-10-06' as DateKey, memberIds: [] }),
        closure({
          id: 'targeted',
          date: '2026-10-07' as DateKey,
          memberIds: ['member-1', 'unknown', 'member-1'],
        }),
        closure({ id: 'unknown', date: '2026-10-08' as DateKey, memberIds: ['unknown'] }),
      ],
      ['member-1'],
    );

    expect(days.find((day) => day.date === '2026-10-06')).toMatchObject({
      closures: [{ label: 'family', memberIds: [] }],
      layout: 'weekend-card',
    });
    expect(days.find((day) => day.date === '2026-10-07')).toMatchObject({
      closures: [{ label: 'targeted', memberIds: ['member-1'] }],
      layout: 'weekend-card',
    });
    expect(days.find((day) => day.date === '2026-10-08')).toMatchObject({
      closures: [],
      layout: 'compact',
    });
  });

  it('validates supported week query years and strictly Tokyo event times', () => {
    expect(weekQuerySchema.safeParse({ start: '1970-01-01' }).success).toBe(true);
    expect(weekQuerySchema.safeParse({ start: '2050-12-31' }).success).toBe(true);
    expect(weekQuerySchema.safeParse({ start: '1969-12-31' }).success).toBe(false);
    expect(weekQuerySchema.safeParse({ start: '2051-01-01' }).success).toBe(false);
    const eventWithoutValidation = (id: string, start: string, endExclusive: string) => ({
      id,
      title: id,
      time: { kind: 'timed', start, endExclusive },
      memberIds: [],
      assigneeMemberId: null,
      status: 'confirmed',
      isRoutine: false,
      affectsAvailability: true,
      source: 'manual',
      items: [],
    });
    expect(
      weekEventSchema.safeParse(
        eventWithoutValidation('bad-offset', '2026-10-06T09:00:00Z', '2026-10-06T10:00:00Z'),
      ).success,
    ).toBe(false);
    expect(
      weekEventSchema.safeParse(
        eventWithoutValidation(
          'reversed',
          '2026-10-06T10:00:00+09:00',
          '2026-10-06T09:00:00+09:00',
        ),
      ).success,
    ).toBe(false);
  });
});
