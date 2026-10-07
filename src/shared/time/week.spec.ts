import type { DateKey } from '@shared/schemas/date';
import { getCalendarWeekBounds, getMondayAnchor, getWeekRange } from '@shared/time/week';
import { describe, expect, it } from 'vitest';

describe('src/shared/time/week', () => {
  describe('getMondayAnchor', () => {
    it('anchors any day of the week to its Monday', () => {
      expect(getMondayAnchor('2026-10-05' as DateKey)).toBe('2026-10-05'); // Monday
      expect(getMondayAnchor('2026-10-07' as DateKey)).toBe('2026-10-05'); // Wednesday
      expect(getMondayAnchor('2026-10-10' as DateKey)).toBe('2026-10-05'); // Saturday
      expect(getMondayAnchor('2026-10-11' as DateKey)).toBe('2026-10-05'); // Sunday
    });
  });

  describe('getWeekRange', () => {
    it('returns standard 7-day Mon–Sun week when no consecutive holidays follow', () => {
      const range = getWeekRange('2026-10-19' as DateKey);

      expect(range.start).toBe('2026-10-19');
      expect(range.endInclusive).toBe('2026-10-25');
      expect(range.endExclusive).toBe('2026-10-26');
      expect(range.timeMin).toBe('2026-10-19T00:00:00+09:00');
      expect(range.timeMax).toBe('2026-10-26T00:00:00+09:00');
      expect(range.days).toHaveLength(7);
      expect(range.prevWeekStart).toBe('2026-10-12');
      expect(range.nextWeekStart).toBe('2026-10-26');
    });

    it('extends week through 2026-10-12 for Sports Day 3-day weekend (Task AC)', () => {
      const range = getWeekRange('2026-10-05' as DateKey);

      expect(range.start).toBe('2026-10-05');
      expect(range.endInclusive).toBe('2026-10-12'); // Extended across 10/12 (Sports Day)
      expect(range.endExclusive).toBe('2026-10-13');
      expect(range.timeMin).toBe('2026-10-05T00:00:00+09:00');
      expect(range.timeMax).toBe('2026-10-13T00:00:00+09:00');
      expect(range.days).toHaveLength(8);
      expect(range.days[7]).toBe('2026-10-12');

      // Navigation is strictly anchored to ±7 calendar days
      expect(range.prevWeekStart).toBe('2026-09-28');
      expect(range.nextWeekStart).toBe('2026-10-12');
    });

    it('extends week through 2026-09-23 for Silver Week 5-day continuous holiday', () => {
      const range = getWeekRange('2026-09-14' as DateKey);

      expect(range.start).toBe('2026-09-14');
      expect(range.endInclusive).toBe('2026-09-23'); // 9/21, 9/22, 9/23 consecutive
      expect(range.endExclusive).toBe('2026-09-24');
      expect(range.timeMin).toBe('2026-09-14T00:00:00+09:00');
      expect(range.timeMax).toBe('2026-09-24T00:00:00+09:00');
      expect(range.days).toHaveLength(10);

      expect(range.prevWeekStart).toBe('2026-09-07');
      expect(range.nextWeekStart).toBe('2026-09-21');
    });

    it('does not bridge across normal workdays', () => {
      // If Monday following Sunday is a normal workday, extension halts immediately
      const range = getWeekRange('2026-10-26' as DateKey);
      expect(range.endInclusive).toBe('2026-11-01');
      expect(range.endExclusive).toBe('2026-11-02');
      expect(range.days).toHaveLength(7);
    });

    it('handles year boundary crossing cleanly', () => {
      const range = getWeekRange('2026-12-28' as DateKey);
      expect(range.start).toBe('2026-12-28');
      expect(range.endInclusive).toBe('2027-01-03');
      expect(range.endExclusive).toBe('2027-01-04');
      expect(range.days).toHaveLength(7);
      expect(range.prevWeekStart).toBe('2026-12-21');
      expect(range.nextWeekStart).toBe('2027-01-04');
    });
  });

  describe('getCalendarWeekBounds', () => {
    it('keeps the standard Monday-to-Sunday week without holiday extension', () => {
      expect(getCalendarWeekBounds('2026-10-05' as DateKey)).toEqual({
        start: '2026-10-05',
        endInclusive: '2026-10-11',
        endExclusive: '2026-10-12',
      });
    });
  });
});
