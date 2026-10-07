import { describe, expect, it } from 'vitest';
import { getItemsTask } from './taskGeneration';

describe('getItemsTask', () => {
  it('creates one automatic task when the event has items', () => {
    expect(
      getItemsTask(['水筒'], {
        kind: 'timed',
        start: '2026-10-08T09:00:00+09:00',
        endExclusive: '2026-10-08T10:00:00+09:00',
      }),
    ).toEqual({
      title: '持ち物を準備',
      dueKind: 'datetime',
      dueAt: '2026-10-07T20:00:00+09:00',
    });
  });

  it('does not create a task when there are no items', () => {
    expect(
      getItemsTask([], {
        kind: 'all-day',
        start: '2026-10-08',
        endExclusive: '2026-10-09',
      }),
    ).toBeNull();
  });

  it('uses the day before an all-day event', () => {
    expect(
      getItemsTask(['帽子'], {
        kind: 'all-day',
        start: '2026-10-08',
        endExclusive: '2026-10-09',
      })?.dueAt,
    ).toBe('2026-10-07T20:00:00+09:00');
  });

  it('uses the Tokyo start date for timed events and handles midnight starts', () => {
    expect(
      getItemsTask(['上履き'], {
        kind: 'timed',
        start: '2026-10-08T00:00:00+09:00',
        endExclusive: '2026-10-08T01:00:00+09:00',
      })?.dueAt,
    ).toBe('2026-10-07T20:00:00+09:00');
    expect(
      getItemsTask(['上履き'], {
        kind: 'timed',
        start: '2026-10-08T00:30:00+09:00',
        endExclusive: '2026-10-08T01:30:00+09:00',
      })?.dueAt,
    ).toBe('2026-10-07T20:00:00+09:00');
    expect(
      getItemsTask(['上履き'], {
        kind: 'timed',
        start: '2026-10-07T16:00:00Z',
        endExclusive: '2026-10-07T17:00:00Z',
      })?.dueAt,
    ).toBe('2026-10-07T20:00:00+09:00');
  });

  it('moves to the previous month or year when needed', () => {
    const monthEnd = getItemsTask(['持ち物'], {
      kind: 'all-day',
      start: '2026-03-01',
      endExclusive: '2026-03-02',
    });
    const yearEnd = getItemsTask(['持ち物'], {
      kind: 'all-day',
      start: '2026-01-01',
      endExclusive: '2026-01-02',
    });
    expect(monthEnd?.dueAt).toBe('2026-02-28T20:00:00+09:00');
    expect(yearEnd?.dueAt).toBe('2025-12-31T20:00:00+09:00');
  });
});
