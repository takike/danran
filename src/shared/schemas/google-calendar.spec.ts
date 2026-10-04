import { describe, expect, it } from 'vitest';
import {
  insertEventDateTimeSchema,
  patchEventDateTimeSchema,
  patchEventInputSchema,
} from './google-calendar';

describe('Google Calendar PATCH datetime schema', () => {
  it('accepts explicit null fields for timed and all-day values', () => {
    expect(
      patchEventDateTimeSchema.safeParse({
        date: null,
        dateTime: '2026-10-05T09:00:00+09:00',
        timeZone: 'Asia/Tokyo',
      }).success,
    ).toBe(true);
    expect(
      patchEventDateTimeSchema.safeParse({
        date: '2026-10-05',
        dateTime: null,
        timeZone: null,
      }).success,
    ).toBe(true);
  });

  it('keeps accepting legacy PATCH values with the unused field omitted', () => {
    expect(
      patchEventInputSchema.safeParse({
        start: { dateTime: '2026-10-05T09:00:00+09:00' },
        end: { dateTime: '2026-10-05T10:00:00+09:00' },
      }).success,
    ).toBe(true);
  });

  it('rejects ambiguous PATCH values and keeps insert values non-nullable', () => {
    expect(
      patchEventDateTimeSchema.safeParse({
        date: '2026-10-05',
        dateTime: '2026-10-05T09:00:00+09:00',
        timeZone: 'Asia/Tokyo',
      }).success,
    ).toBe(false);
    expect(
      insertEventDateTimeSchema.safeParse({
        date: '2026-10-05',
        dateTime: null,
        timeZone: null,
      }).success,
    ).toBe(false);
  });
});
