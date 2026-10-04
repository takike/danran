import type { EventInput } from '@shared/schemas/events';

/** App metadata stored in Google Calendar's private extended properties. */
export function buildDanranPrivateProperties(input: EventInput): Record<string, string> {
  return {
    danran: '1',
    members: [...new Set(input.memberIds)].join(','),
    assignee: input.assigneeMemberId ?? '',
    status: input.status,
    source: 'manual',
  };
}

/** Converts validated editor time to Google's event date fields. */
export function toGoogleEventTimes(time: EventInput['time']): {
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
} {
  if (time.kind === 'all-day') {
    return { start: { date: time.start }, end: { date: time.endExclusive } };
  }
  return {
    start: { dateTime: time.start, timeZone: 'Asia/Tokyo' },
    end: { dateTime: time.endExclusive, timeZone: 'Asia/Tokyo' },
  };
}
