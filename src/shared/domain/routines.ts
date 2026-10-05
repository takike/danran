import type { DateKey } from '@shared/schemas/date';
import { isoInstantStringSchema } from '@shared/schemas/date';
import type { WeekdayCode } from '@shared/schemas/routines';
import { addCalendarDays, getWeekday } from '@shared/time';

const WEEKDAYS: readonly WeekdayCode[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const WEEKDAY_BY_INDEX: readonly WeekdayCode[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEKDAY_LABELS: Record<WeekdayCode, string> = {
  MO: '月',
  TU: '火',
  WE: '水',
  TH: '木',
  FR: '金',
  SA: '土',
  SU: '日',
};

/** Finds the first selected Tokyo weekday on or after the requested start date. */
export function getFirstRoutineDate(startDate: DateKey, weekdays: readonly WeekdayCode[]): DateKey {
  if (weekdays.length === 0) throw new TypeError('At least one weekday is required');
  const selected = new Set(weekdays);
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = addCalendarDays(startDate, offset);
    const weekdayIndex = getWeekday(candidate);
    const code = WEEKDAY_BY_INDEX[weekdayIndex];
    if (code && selected.has(code)) return candidate;
  }
  throw new TypeError('No valid weekday selected');
}

export function buildRoutineRecurrence(input: {
  weekdays: readonly WeekdayCode[];
  interval: 1 | 2;
  endDate: DateKey | null;
}): string[] {
  const ordered = WEEKDAYS.filter((day) => input.weekdays.includes(day));
  if (ordered.length === 0) throw new TypeError('At least one weekday is required');
  const parts = [
    'FREQ=WEEKLY',
    ...(input.interval === 2 ? ['INTERVAL=2'] : []),
    `BYDAY=${ordered.join(',')}`,
  ];
  if (input.endDate !== null) {
    // Google expects UTC UNTIL; 23:59:59 JST is 14:59:59 UTC.
    const compact = input.endDate.replaceAll('-', '');
    parts.push(`UNTIL=${compact}T145959Z`);
  }
  return [`RRULE:${parts.join(';')}`];
}

export function formatRoutineRule(input: {
  weekdays: readonly WeekdayCode[];
  interval: 1 | 2;
  startTime: string;
  endTime: string;
}): string {
  const ordered = WEEKDAYS.filter((day) => input.weekdays.includes(day));
  const days = ordered.map((day) => WEEKDAY_LABELS[day]).join('・');
  const repeat = input.interval === 2 ? '隔週' : '毎週';
  return `${repeat} ${days} ${input.startTime}–${input.endTime}`;
}

export type ParsedRoutineRule =
  | { status: 'ready'; weekdays: WeekdayCode[]; interval: 1 | 2 }
  | { status: 'unsupported'; weekdays: []; interval: null };

/** Parses only the weekly RRULE subset created by Danran; all other recurrence is unsupported. */
export function parseGoogleRoutineRule(recurrence: readonly string[]): ParsedRoutineRule {
  const rules = recurrence.filter((line) => line.startsWith('RRULE:'));
  if (rules.length !== 1 || recurrence.length !== 1)
    return { status: 'unsupported', weekdays: [], interval: null };
  const rule = rules[0];
  if (!rule) return { status: 'unsupported', weekdays: [], interval: null };
  const fields = new Map<string, string>();
  for (const field of rule.slice('RRULE:'.length).split(';')) {
    const separator = field.indexOf('=');
    if (separator <= 0) return { status: 'unsupported', weekdays: [], interval: null };
    const key = field.slice(0, separator);
    if (fields.has(key)) return { status: 'unsupported', weekdays: [], interval: null };
    fields.set(key, field.slice(separator + 1));
  }
  if (fields.get('FREQ') !== 'WEEKLY')
    return { status: 'unsupported', weekdays: [], interval: null };
  const intervalValue = fields.get('INTERVAL') ?? '1';
  if (intervalValue !== '1' && intervalValue !== '2')
    return { status: 'unsupported', weekdays: [], interval: null };
  const allowed = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL']);
  if ([...fields.keys()].some((key) => !allowed.has(key)))
    return { status: 'unsupported', weekdays: [], interval: null };
  const until = fields.get('UNTIL');
  if (until !== undefined) {
    const match = until.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (!match) return { status: 'unsupported', weekdays: [], interval: null };
    const [, year, month, day, hour, minute, second] = match;
    const validUntil = isoInstantStringSchema.safeParse(
      `${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
    );
    if (!validUntil.success) return { status: 'unsupported', weekdays: [], interval: null };
  }
  const rawDays = fields.get('BYDAY')?.split(',') ?? [];
  if (rawDays.length === 0 || rawDays.some((day) => !WEEKDAYS.includes(day as WeekdayCode))) {
    return { status: 'unsupported', weekdays: [], interval: null };
  }
  const uniqueDays = WEEKDAYS.filter((day) => rawDays.includes(day));
  if (uniqueDays.length !== rawDays.length)
    return { status: 'unsupported', weekdays: [], interval: null };
  return { status: 'ready', weekdays: uniqueDays, interval: Number(intervalValue) as 1 | 2 };
}
