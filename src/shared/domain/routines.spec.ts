import { describe, expect, it } from 'vitest';
import {
  buildRoutineRecurrence,
  formatRoutineRule,
  getFirstRoutineDate,
  parseGoogleRoutineRule,
} from './routines';

describe('routine rules', () => {
  it('finds the first selected weekday in Tokyo calendar dates', () => {
    expect(getFirstRoutineDate('2026-10-05', ['MO'])).toBe('2026-10-05');
    expect(getFirstRoutineDate('2026-10-06', ['MO', 'WE'])).toBe('2026-10-07');
    expect(getFirstRoutineDate('2026-10-31', ['MO'])).toBe('2026-11-02');
  });

  it('builds weekly, biweekly, and inclusive end date RRULEs', () => {
    expect(buildRoutineRecurrence({ weekdays: ['TU'], interval: 1, endDate: null })).toEqual([
      'RRULE:FREQ=WEEKLY;BYDAY=TU',
    ]);
    expect(
      buildRoutineRecurrence({ weekdays: ['SA', 'TU'], interval: 2, endDate: '2026-12-31' }),
    ).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SA;UNTIL=20261231T145959Z']);
  });

  it('formats the Japanese list rule and parses supported recurrence only', () => {
    expect(
      formatRoutineRule({
        weekdays: ['SA', 'TU'],
        interval: 2,
        startTime: '10:00',
        endTime: '11:00',
      }),
    ).toBe('隔週 火・土 10:00–11:00');
    expect(parseGoogleRoutineRule(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SA'])).toEqual({
      status: 'ready',
      weekdays: ['TU', 'SA'],
      interval: 2,
    });
    expect(parseGoogleRoutineRule(['RRULE:FREQ=MONTHLY;BYDAY=TU'])).toEqual({
      status: 'unsupported',
      weekdays: [],
      interval: null,
    });
  });
});
