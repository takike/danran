import holidayJp from '@holiday-jp/holiday_jp';
import { type DateKey, dateKeySchema } from '@shared/schemas/date';
import { HOLIDAY_DATASET_MAX_YEAR, HOLIDAY_DATASET_MIN_YEAR } from './constants';

export class UnsupportedHolidayYearError extends RangeError {
  constructor(year: number) {
    super(
      `Holiday dataset only supports years ${HOLIDAY_DATASET_MIN_YEAR}-${HOLIDAY_DATASET_MAX_YEAR} (requested: ${year}). Update @holiday-jp/holiday_jp annually for future years.`,
    );
    this.name = 'UnsupportedHolidayYearError';
  }
}

export interface HolidayInfo {
  isHoliday: boolean;
  name: string | null;
}

const holidaysMap: Readonly<Record<string, { date: string; name: string }>> = holidayJp.holidays;

/**
 * Returns Japanese national holiday information for a given DateKey.
 * Throws UnsupportedHolidayYearError for years outside the dataset range (1970–2050).
 */
export function getHoliday(dateKey: DateKey): HolidayInfo {
  dateKeySchema.parse(dateKey);
  const year = Number(dateKey.slice(0, 4));
  if (year < HOLIDAY_DATASET_MIN_YEAR || year > HOLIDAY_DATASET_MAX_YEAR) {
    throw new UnsupportedHolidayYearError(year);
  }

  const isHol = holidayJp.isHoliday(dateKey);
  if (!isHol) {
    return { isHoliday: false, name: null };
  }

  const entry = holidaysMap[dateKey];
  return {
    isHoliday: true,
    name: entry ? entry.name : null,
  };
}

/**
 * Returns true if the DateKey is a Japanese national holiday.
 */
export function isHoliday(dateKey: DateKey): boolean {
  return getHoliday(dateKey).isHoliday;
}

/**
 * Helper to identify the conventional year-end / New Year break (12/29–1/3)
 * used as the default for routine skipping in Danran.
 * Note: Dec 29–31 and Jan 2–3 are not statutory national holidays unless Jan 1 or a substitute holiday.
 */
export function isYearEndBreak(dateKey: DateKey): boolean {
  dateKeySchema.parse(dateKey);
  const monthDay = dateKey.slice(5);
  return (
    monthDay === '12-29' ||
    monthDay === '12-30' ||
    monthDay === '12-31' ||
    monthDay === '01-01' ||
    monthDay === '01-02' ||
    monthDay === '01-03'
  );
}
