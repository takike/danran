import type { WeekDay, WeekEvent } from '@shared/schemas/week';
import { describe, expect, it } from 'vitest';
import { getLongWeekendBadges, getVisibleDayEvents, getVisibleDayLayout } from './weekPresentation';

function day(date: string, layout: WeekDay['layout'], closures: WeekDay['closures'] = []): WeekDay {
  return {
    date,
    weekday: 0,
    holidayName: null,
    closures,
    layout,
    eventIds: [],
  };
}

function event(id: string, isRoutine: boolean, source: WeekEvent['source'] = 'manual'): WeekEvent {
  return {
    id,
    title: id,
    time: { kind: 'all-day', start: '2026-10-05', endExclusive: '2026-10-06' },
    memberIds: [],
    assigneeMemberId: null,
    status: 'confirmed',
    isRoutine,
    affectsAvailability: true,
    source,
    items: [],
  };
}

describe('week presentation helpers', () => {
  it('groups sorted contiguous weekend-card dates into badges of three days or more', () => {
    const badges = getLongWeekendBadges([
      day('2026-10-12', 'weekend-card'),
      day('2026-10-07', 'compact'),
      day('2026-10-10', 'weekend-card'),
      day('2026-10-11', 'weekend-card'),
      day('2026-10-13', 'compact'),
      day('2026-10-03', 'weekend-card'),
      day('2026-10-04', 'weekend-card'),
    ]);

    expect(badges).toEqual([{ start: '2026-10-10', endInclusive: '2026-10-12', dayCount: 3 }]);
  });

  it('deduplicates dates, splits gaps, and groups a four-day closure run across New Year', () => {
    expect(
      getLongWeekendBadges([
        day('2027-01-02', 'weekend-card'),
        day('2026-12-31', 'weekend-card', [{ label: '年末休園', memberIds: ['m_1'] }]),
        day('2027-01-01', 'weekend-card'),
        day('2027-01-01', 'weekend-card'),
        day('2027-01-03', 'weekend-card'),
        day('2027-01-07', 'weekend-card'),
        day('2027-01-06', 'weekend-card'),
        day('2027-01-08', 'weekend-card'),
      ]),
    ).toEqual([
      { start: '2026-12-31', endInclusive: '2027-01-03', dayCount: 4 },
      { start: '2027-01-06', endInclusive: '2027-01-08', dayCount: 3 },
    ]);
  });

  it('returns no badges for empty or short runs', () => {
    expect(getLongWeekendBadges([])).toEqual([]);
    expect(
      getLongWeekendBadges([day('2026-10-10', 'weekend-card'), day('2026-10-11', 'weekend-card')]),
    ).toEqual([]);
  });

  it('keeps published events visible while optionally omitting routines', () => {
    const events = [
      event('routine', true),
      event('single', false),
      event('published', false, 'publish'),
      event('external', false, 'external'),
    ];
    const expandedDay = {
      ...day('2026-10-05', 'expanded'),
      eventIds: ['routine', 'single', 'published', 'external'],
    };

    expect(getVisibleDayEvents(expandedDay, events, true).map(({ id }) => id)).toEqual([
      'single',
      'published',
      'external',
    ]);
    expect(getVisibleDayEvents(expandedDay, events, false).map(({ id }) => id)).toEqual([
      'routine',
      'single',
      'published',
      'external',
    ]);
  });

  it('uses compact layout only when an expanded day has no visible events', () => {
    const expanded = day('2026-10-05', 'expanded');
    const compact = day('2026-10-06', 'compact');
    const weekend = day('2026-10-10', 'weekend-card');
    expect(getVisibleDayLayout(expanded, [])).toBe('compact');
    expect(getVisibleDayLayout(expanded, [event('visible', false)])).toBe('expanded');
    expect(getVisibleDayLayout(compact, [])).toBe('compact');
    expect(getVisibleDayLayout(weekend, [])).toBe('weekend-card');
  });
});
