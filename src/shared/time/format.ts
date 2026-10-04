import type { DateKey } from '@shared/schemas/date';
import type { WeekEvent } from '@shared/schemas/week';
import { addCalendarDays, getWeekday, toTokyoDateKey, toTokyoIsoString } from './date';

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const;

function dateParts(date: DateKey): { year: number; month: number; day: number } {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

function formatMonth(date: DateKey): string {
  const { year, month } = dateParts(date);
  return `${year}年${month}月`;
}

function formatShortDate(date: DateKey): string {
  const { month, day } = dateParts(date);
  return `${month}/${day}`;
}

function formatClock(instant: string): string {
  return toTokyoIsoString(instant).slice(11, 16);
}

export function formatMonthHeading(start: DateKey, endInclusive: DateKey): string {
  const startParts = dateParts(start);
  const endParts = dateParts(endInclusive);
  if (startParts.year === endParts.year) {
    return startParts.month === endParts.month
      ? formatMonth(start)
      : `${startParts.year}年${startParts.month}月〜${endParts.month}月`;
  }
  return `${formatMonth(start)}〜${formatMonth(endInclusive)}`;
}

export function formatWeekPeriod(start: DateKey, endInclusive: DateKey): string {
  return `${formatShortDate(start)} – ${formatShortDate(endInclusive)}`;
}

export function formatDayNumber(date: DateKey): string {
  return String(dateParts(date).day);
}

export function formatWeekday(date: DateKey): (typeof WEEKDAY_LABELS)[number] {
  const label = WEEKDAY_LABELS[getWeekday(date)];
  if (!label) {
    throw new RangeError('Unexpected Tokyo weekday index');
  }
  return label;
}

export function formatFullDateLabel(date: DateKey): string {
  const { year, month, day } = dateParts(date);
  return `${year}年${month}月${day}日 ${formatWeekday(date)}曜日`;
}

export function formatEventTime(time: WeekEvent['time'], displayDate?: DateKey): string {
  if (time.kind === 'all-day') {
    const inclusiveEnd = addCalendarDays(time.endExclusive, -1);
    return time.start === inclusiveEnd
      ? '終日'
      : `終日（${formatShortDate(time.start)}〜${formatShortDate(inclusiveEnd)}）`;
  }

  const startDate = toTokyoDateKey(time.start);
  const endDate = toTokyoDateKey(time.endExclusive);
  const startClock = formatClock(time.start);
  const endClock = formatClock(time.endExclusive);
  const visibleStartDate =
    displayDate && displayDate !== startDate ? `${formatShortDate(startDate)} ` : '';
  const endDateLabel = endDate === startDate ? '' : `${formatShortDate(endDate)} `;
  return `${visibleStartDate}${startClock}–${endDateLabel}${endClock}`;
}
