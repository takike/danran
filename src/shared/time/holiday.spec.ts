import type { DateKey } from '@shared/schemas/date';
import {
  UnsupportedHolidayYearError,
  getHoliday,
  isHoliday,
  isYearEndBreak,
} from '@shared/time/holiday';
import { describe, expect, it } from 'vitest';

describe('src/shared/time/holiday', () => {
  describe('Japanese national holiday lookup', () => {
    it.each([
      ['2026-10-12', true, 'スポーツの日'],
      ['2027-03-22', true, '春分の日 振替休日'],
      ['2026-05-06', true, 'こどもの日 振替休日'],
      ['2026-09-21', true, '敬老の日'],
      ['2026-09-22', true, '休日'], // 国民の休日 is labeled '休日' in @holiday-jp/holiday_jp
      ['2026-09-23', true, '秋分の日'],
      ['2026-10-05', false, null], // Ordinary Monday
      ['2026-10-07', false, null], // Ordinary Wednesday
    ])('evaluates %s: isHoliday=%s, name=%s', (dateKey, expectedIsHoliday, expectedName) => {
      const info = getHoliday(dateKey as DateKey);
      expect(info.isHoliday).toBe(expectedIsHoliday);
      expect(info.name).toBe(expectedName);
      expect(isHoliday(dateKey as DateKey)).toBe(expectedIsHoliday);
    });
  });

  describe('Dataset coverage boundaries (1970–2050)', () => {
    it('supports edge years in dataset', () => {
      expect(getHoliday('1970-01-01' as DateKey).isHoliday).toBe(true);
      expect(getHoliday('2050-11-23' as DateKey).isHoliday).toBe(true);
    });

    it('throws UnsupportedHolidayYearError for years outside 1970–2050', () => {
      expect(() => getHoliday('1969-12-31' as DateKey)).toThrow(UnsupportedHolidayYearError);
      expect(() => getHoliday('2051-01-01' as DateKey)).toThrow(UnsupportedHolidayYearError);
    });
  });

  describe('isYearEndBreak', () => {
    it.each([
      ['2026-12-28', false],
      ['2026-12-29', true],
      ['2026-12-30', true],
      ['2026-12-31', true],
      ['2027-01-01', true],
      ['2027-01-02', true],
      ['2027-01-03', true],
      ['2027-01-04', false],
    ])('evaluates %s as year-end break: %s', (dateKey, expected) => {
      expect(isYearEndBreak(dateKey as DateKey)).toBe(expected);
    });

    it('does not misclassify non-statutory year-end dates as national holidays', () => {
      // 12/29-31 and 1/2-3 are routine break defaults, NOT national holidays unless substitute
      expect(isHoliday('2026-12-29' as DateKey)).toBe(false);
      expect(isHoliday('2026-12-30' as DateKey)).toBe(false);
      expect(isHoliday('2026-12-31' as DateKey)).toBe(false);
      expect(isHoliday('2027-01-01' as DateKey)).toBe(true); // 元日 is statutory holiday
      expect(isHoliday('2027-01-02' as DateKey)).toBe(false);
      expect(isHoliday('2027-01-03' as DateKey)).toBe(false);
    });

    it('recognizes Jan 2 as a national holiday when it acts as a substitute holiday', () => {
      // 2023-01-01 fell on a Sunday, so 2023-01-02 was an official substitute holiday
      const jan2Substitute = '2023-01-02' as DateKey;
      expect(isHoliday(jan2Substitute)).toBe(true);
      expect(getHoliday(jan2Substitute).name).toBe('元日 振替休日');
      expect(isYearEndBreak(jan2Substitute)).toBe(true);
    });
  });
});
