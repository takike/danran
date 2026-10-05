import { describe, expect, it } from 'vitest';
import { classifyWeekRecurrence } from './weekRecurrence';

describe('classifyWeekRecurrence', () => {
  it('keeps an unchanged recurring occurrence routine', () => {
    expect(
      classifyWeekRecurrence(
        true,
        { dateTime: '2026-10-05T09:00:00Z' },
        { dateTime: '2026-10-05T18:00:00+09:00' },
      ),
    ).toEqual({ isRecurring: true, isRoutine: true, movedFrom: null });
  });

  it('marks a moved day as an exception and returns its original Tokyo instant', () => {
    expect(
      classifyWeekRecurrence(
        true,
        { dateTime: '2026-10-05T09:00:00+09:00' },
        { dateTime: '2026-10-06T09:00:00+09:00' },
      ),
    ).toEqual({
      isRecurring: true,
      isRoutine: false,
      movedFrom: '2026-10-05T09:00:00+09:00',
    });
  });

  it('marks a one-minute start change as an exception', () => {
    expect(
      classifyWeekRecurrence(
        true,
        { dateTime: '2026-10-05T09:00:00+09:00' },
        { dateTime: '2026-10-05T09:01:00+09:00' },
      ).isRoutine,
    ).toBe(false);
  });

  it('recognizes equivalent Z and +09:00 instants', () => {
    expect(
      classifyWeekRecurrence(
        true,
        { dateTime: '2026-10-04T15:00:00Z' },
        { dateTime: '2026-10-05T00:00:00+09:00' },
      ),
    ).toEqual({ isRecurring: true, isRoutine: true, movedFrom: null });
  });

  it('returns a Tokyo midnight instant for a moved all-day occurrence', () => {
    expect(classifyWeekRecurrence(true, { date: '2026-10-05' }, { date: '2026-10-06' })).toEqual({
      isRecurring: true,
      isRoutine: false,
      movedFrom: '2026-10-05T00:00:00+09:00',
    });
  });

  it('treats a timed/all-day type change as an exception without throwing', () => {
    expect(
      classifyWeekRecurrence(
        true,
        { date: '2026-10-05' },
        { dateTime: '2026-10-05T00:00:00+09:00' },
      ),
    ).toEqual({
      isRecurring: true,
      isRoutine: false,
      movedFrom: '2026-10-05T00:00:00+09:00',
    });
  });

  it('keeps a recurring event routine when original start metadata is missing', () => {
    expect(
      classifyWeekRecurrence(true, undefined, { dateTime: '2026-10-05T09:00:00+09:00' }),
    ).toEqual({ isRecurring: true, isRoutine: true, movedFrom: null });
  });

  it('classifies a one-off event as non-recurring', () => {
    expect(classifyWeekRecurrence(false, { dateTime: '2026-10-05T09:00:00+09:00' }, null)).toEqual({
      isRecurring: false,
      isRoutine: false,
      movedFrom: null,
    });
  });
});
