import type { DateKey } from '@shared/schemas/date';
import { describe, expect, it } from 'vitest';
import {
  getIntervalDurationMinutes,
  getTokyoDayHourBounds,
  parseIsoInstantMilliseconds,
  shiftInstantMinutes,
} from './interval';

describe('shared/time interval helpers', () => {
  it('parses timezone-aware instants and rejects timezone-less values', () => {
    expect(parseIsoInstantMilliseconds('2026-10-05T08:00:00+09:00')).toBe(
      Date.parse('2026-10-04T23:00:00Z'),
    );
    expect(() => parseIsoInstantMilliseconds('2026-10-05T08:00:00')).toThrow();
  });

  it('builds Tokyo day-hour bounds including the next midnight for hour 24', () => {
    const bounds = getTokyoDayHourBounds('2026-10-05' as DateKey, 8, 24);
    expect(bounds.start).toBe(Date.parse('2026-10-04T23:00:00Z'));
    expect(bounds.end).toBe(Date.parse('2026-10-05T15:00:00Z'));
    expect(() => getTokyoDayHourBounds('2026-10-05' as DateKey, 24, 24)).toThrow(RangeError);
  });

  it('shifts instants by fractional minutes and measures exact durations', () => {
    const shifted = shiftInstantMinutes('2026-10-05T08:00:00+09:00', -0.5);
    expect(shifted).toBe(Date.parse('2026-10-04T22:59:30Z'));
    expect(
      getIntervalDurationMinutes('2026-10-05T08:00:00+09:00', '2026-10-05T08:30:30+09:00'),
    ).toBe(30.5);
    expect(() =>
      getIntervalDurationMinutes('2026-10-05T08:00:00+09:00', '2026-10-05T08:00:00+09:00'),
    ).toThrow(RangeError);
  });

  it('rejects a minute shift that overflows the numeric timestamp', () => {
    expect(() => shiftInstantMinutes('2026-10-05T08:00:00+09:00', Number.MAX_VALUE)).toThrow(
      TypeError,
    );
  });
});
