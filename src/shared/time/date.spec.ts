import { type DateKey, dateKeySchema, isoInstantStringSchema } from '@shared/schemas/date';
import {
  addCalendarDays,
  addCalendarWeeks,
  differenceInCalendarDays,
  getDayBounds,
  getTodayDateKey,
  getWeekday,
  toTokyoDateKey,
  toTokyoIsoString,
  toTokyoTZDate,
} from '@shared/time/date';
import { describe, expect, it } from 'vitest';

describe('src/shared/time/date', () => {
  describe('dateKeySchema & real calendar validation', () => {
    it.each([
      ['2026-10-05', true],
      ['2024-02-29', true], // Leap year
      ['2028-02-29', true], // Leap year
      ['2026-02-29', false], // Non-leap year
      ['2026-02-30', false],
      ['2026-04-31', false],
      ['2026-13-01', false],
      ['not-a-date', false],
    ])('validates %s correctly as %s', (input, expectedValid) => {
      const result = dateKeySchema.safeParse(input);
      expect(result.success).toBe(expectedValid);
    });
  });

  describe('isoInstantStringSchema', () => {
    it.each([
      ['2026-10-04T15:00:00Z', true],
      ['2026-10-05T00:00:00+09:00', true],
      ['2026-10-04T20:00:00-04:00', true],
      ['2026-10-04T20:00:00+15:00', true], // Valid RFC3339 2-digit hour offset
      ['2026-10-05T00:00:00', false], // Missing timezone
      ['2026-10-05T00:00:00+99:99', false], // Invalid offset
      ['2026-02-29T12:00:00Z', false], // Non-leap year
      ['invalid', false],
    ])('validates instant %s as %s', (input, expectedValid) => {
      const result = isoInstantStringSchema.safeParse(input);
      expect(result.success).toBe(expectedValid);
    });
  });

  describe('toTokyoDateKey', () => {
    it('correctly maps UTC boundary to Tokyo midnight', () => {
      // 2026-10-04T15:00:00Z is 2026-10-05T00:00:00+09:00 (Tokyo Monday)
      expect(toTokyoDateKey('2026-10-04T15:00:00Z')).toBe('2026-10-05');

      // 1 ms before is 2026-10-04T23:59:59.999+09:00 (Tokyo Sunday)
      expect(toTokyoDateKey('2026-10-04T14:59:59.999Z')).toBe('2026-10-04');
    });

    it('handles epoch milliseconds and Date objects without mutating input', () => {
      const epochMs = Date.parse('2026-10-04T15:00:00Z');
      const dateObj = new Date(epochMs);
      const originalTime = dateObj.getTime();

      expect(toTokyoDateKey(epochMs)).toBe('2026-10-05');
      expect(toTokyoDateKey(dateObj)).toBe('2026-10-05');
      expect(dateObj.getTime()).toBe(originalTime);
    });

    it('rejects invalid inputs', () => {
      expect(() => toTokyoDateKey(Number.NaN)).toThrow(TypeError);
      expect(() => toTokyoDateKey(Number.POSITIVE_INFINITY)).toThrow(TypeError);
      expect(() => toTokyoDateKey(new Date('invalid'))).toThrow(TypeError);
      expect(() => toTokyoDateKey('2026-10-05T00:00:00')).toThrow();
      expect(() => toTokyoDateKey('2026-02-30')).toThrow();
    });
  });

  describe('toTokyoIsoString', () => {
    it('converts instants to +09:00 while preserving milliseconds', () => {
      expect(toTokyoIsoString('2026-10-04T15:00:00Z')).toBe('2026-10-05T00:00:00+09:00');
      expect(toTokyoIsoString('2026-10-04T15:00:00.123Z')).toBe('2026-10-05T00:00:00.123+09:00');
      expect(toTokyoIsoString(Date.parse('2026-10-04T15:00:00.456Z'))).toBe(
        '2026-10-05T00:00:00.456+09:00',
      );
    });

    it('rejects invalid inputs and timezone-less strings', () => {
      expect(() => toTokyoIsoString(Number.NaN)).toThrow(TypeError);
      expect(() => toTokyoIsoString(new Date('invalid'))).toThrow(TypeError);
      expect(() => toTokyoIsoString('2026-10-05T00:00:00')).toThrow();
    });
  });

  describe('getTodayDateKey & getWeekday', () => {
    it('uses injectable now for getTodayDateKey', () => {
      const mockNow = Date.parse('2026-10-04T15:00:00Z');
      expect(getTodayDateKey(mockNow)).toBe('2026-10-05');
    });

    it('returns correct weekday in Tokyo independent of host environment', () => {
      expect(getWeekday('2026-10-04' as DateKey)).toBe(0); // Sunday
      expect(getWeekday('2026-10-05' as DateKey)).toBe(1); // Monday
      expect(getWeekday('2026-10-10' as DateKey)).toBe(6); // Saturday
    });
  });

  describe('addCalendarDays & addCalendarWeeks', () => {
    it('handles positive, negative, zero, and month/year crossings', () => {
      expect(addCalendarDays('2026-10-05' as DateKey, 0)).toBe('2026-10-05');
      expect(addCalendarDays('2026-10-05' as DateKey, 3)).toBe('2026-10-08');
      expect(addCalendarDays('2026-10-05' as DateKey, -1)).toBe('2026-10-04');
      // Year crossing
      expect(addCalendarDays('2026-12-31' as DateKey, 1)).toBe('2027-01-01');
      expect(addCalendarDays('2027-01-01' as DateKey, -1)).toBe('2026-12-31');
      // Leap year
      expect(addCalendarDays('2028-02-28' as DateKey, 1)).toBe('2028-02-29');
      expect(addCalendarDays('2028-02-29' as DateKey, 1)).toBe('2028-03-01');
    });

    it('handles calendar weeks', () => {
      expect(addCalendarWeeks('2026-10-05' as DateKey, 1)).toBe('2026-10-12');
      expect(addCalendarWeeks('2026-10-05' as DateKey, -1)).toBe('2026-09-28');
    });

    it('rejects non-safe integer or fractional increments', () => {
      expect(() => addCalendarDays('2026-10-05' as DateKey, 1.5)).toThrow(TypeError);
      expect(() => addCalendarDays('2026-10-05' as DateKey, Number.NaN)).toThrow(TypeError);
      expect(() => addCalendarWeeks('2026-10-05' as DateKey, 0.5)).toThrow(TypeError);
    });
  });

  describe('differenceInCalendarDays', () => {
    it('returns signed calendar-day distance across months and years', () => {
      expect(differenceInCalendarDays('2027-01-02' as DateKey, '2026-12-31' as DateKey)).toBe(2);
      expect(differenceInCalendarDays('2026-12-31' as DateKey, '2027-01-02' as DateKey)).toBe(-2);
      expect(differenceInCalendarDays('2026-10-05' as DateKey, '2026-10-05' as DateKey)).toBe(0);
    });
  });

  describe('getDayBounds', () => {
    it('returns exact +09:00 and UTC Z ISO bounds for Tokyo midnight', () => {
      const bounds = getDayBounds('2026-10-05' as DateKey);

      expect(bounds.date).toBe('2026-10-05');
      expect(bounds.startIso).toBe('2026-10-05T00:00:00+09:00');
      expect(bounds.endExclusiveIso).toBe('2026-10-06T00:00:00+09:00');
      // 2026-10-05 00:00:00 JST is 2026-10-04 15:00:00 UTC
      expect(bounds.startUtcIso).toBe('2026-10-04T15:00:00.000Z');
      expect(bounds.endExclusiveUtcIso).toBe('2026-10-05T15:00:00.000Z');
    });
  });
});
