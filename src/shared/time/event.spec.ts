import { describe, expect, it } from 'vitest';
import {
  exclusiveEndToInclusive,
  getDefaultEventTime,
  inclusiveEndToExclusive,
  toTokyoDateTimeInputValues,
} from './event';

describe('event time helpers', () => {
  it('converts inclusive and exclusive all-day boundaries', () => {
    expect(inclusiveEndToExclusive('2026-10-05')).toBe('2026-10-06');
    expect(exclusiveEndToInclusive('2026-10-06')).toBe('2026-10-05');
  });

  it('uses the strictly following Tokyo hour when now is exactly on the hour', () => {
    expect(getDefaultEventTime(undefined, new Date('2026-10-05T00:00:00.000Z'))).toEqual({
      kind: 'timed',
      start: '2026-10-05T10:00:00+09:00',
      endExclusive: '2026-10-05T11:00:00+09:00',
    });
  });

  it('rounds minutes and milliseconds up to the next full hour', () => {
    expect(getDefaultEventTime(undefined, new Date('2026-10-05T00:59:59.999Z'))).toMatchObject({
      start: '2026-10-05T10:00:00+09:00',
      endExclusive: '2026-10-05T11:00:00+09:00',
    });
  });

  it('rolls 23:30 to midnight for today and a selected date', () => {
    const now = new Date('2026-10-05T14:30:00.000Z');
    expect(getDefaultEventTime(undefined, now)).toMatchObject({
      start: '2026-10-06T00:00:00+09:00',
      endExclusive: '2026-10-06T01:00:00+09:00',
    });
    expect(getDefaultEventTime('2026-10-12', now)).toMatchObject({
      start: '2026-10-13T00:00:00+09:00',
      endExclusive: '2026-10-13T01:00:00+09:00',
    });
  });

  it('uses Tokyo calendar dates regardless of the host timezone', () => {
    expect(getDefaultEventTime(undefined, new Date('2026-10-04T15:30:00.000Z'))).toMatchObject({
      start: '2026-10-05T01:00:00+09:00',
      endExclusive: '2026-10-05T02:00:00+09:00',
    });
  });

  it('converts equivalent instants to stable Tokyo date and time input values', () => {
    expect(toTokyoDateTimeInputValues('2026-10-04T16:30:00Z')).toEqual({
      date: '2026-10-05',
      time: '01:30',
    });
    expect(toTokyoDateTimeInputValues('2026-10-05T01:30:00+09:00')).toEqual({
      date: '2026-10-05',
      time: '01:30',
    });
  });

  it('rejects invalid instants when converting to editor values', () => {
    expect(() => toTokyoDateTimeInputValues('2026-02-30T01:30:00+09:00')).toThrow();
    expect(() => toTokyoDateTimeInputValues('2026-10-05T01:30:00')).toThrow();
  });
});
