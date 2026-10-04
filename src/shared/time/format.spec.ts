import { describe, expect, it } from 'vitest';
import {
  formatDayNumber,
  formatEventTime,
  formatFullDateLabel,
  formatMonthHeading,
  formatWeekPeriod,
  formatWeekday,
} from './format';

describe('week presentation date formatting', () => {
  it('omits the repeated year for month ranges within the same year', () => {
    expect(formatMonthHeading('2026-09-28', '2026-10-04')).toBe('2026年9月〜10月');
    expect(formatMonthHeading('2026-10-05', '2026-10-11')).toBe('2026年10月');
  });

  it('formats the heading and period across a year boundary', () => {
    expect(formatMonthHeading('2026-12-28', '2027-01-03')).toBe('2026年12月〜2027年1月');
    expect(formatWeekPeriod('2026-12-28', '2027-01-03')).toBe('12/28 – 1/3');
  });

  it('uses the calendar date key for day and weekday labels', () => {
    expect(formatDayNumber('2026-10-05')).toBe('5');
    expect(formatWeekday('2026-10-05')).toBe('月');
    expect(formatFullDateLabel('2026-10-05')).toBe('2026年10月5日 月曜日');
  });

  it('formats all-day events with their inclusive final date', () => {
    expect(
      formatEventTime({ kind: 'all-day', start: '2026-10-05', endExclusive: '2026-10-06' }),
    ).toBe('終日');
    expect(
      formatEventTime({ kind: 'all-day', start: '2026-12-31', endExclusive: '2027-01-03' }),
    ).toBe('終日（12/31〜1/2）');
  });

  it('formats a timed event crossing an exclusive midnight in Tokyo time', () => {
    expect(
      formatEventTime({
        kind: 'timed',
        start: '2026-10-05T23:00:00+09:00',
        endExclusive: '2026-10-06T00:00:00+09:00',
      }),
    ).toBe('23:00–10/6 00:00');
  });

  it('includes the start date when shown on a later day across New Year', () => {
    expect(
      formatEventTime(
        {
          kind: 'timed',
          start: '2026-12-31T23:00:00+09:00',
          endExclusive: '2027-01-01T02:00:00+09:00',
        },
        '2027-01-01',
      ),
    ).toBe('12/31 23:00–1/1 02:00');
  });

  it('converts offset timestamps to Tokyo dates and clocks', () => {
    expect(
      formatEventTime({
        kind: 'timed',
        start: '2026-10-04T23:00:00Z',
        endExclusive: '2026-10-05T00:00:00Z',
      }),
    ).toBe('08:00–09:00');
  });
});
