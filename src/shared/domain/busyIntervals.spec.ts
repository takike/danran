import { describe, expect, it } from 'vitest';
import { mergeBusyIntervals } from './busyIntervals';

describe('mergeBusyIntervals', () => {
  const bounds = {
    start: '2026-10-05T00:00:00+09:00',
    end: '2026-10-12T00:00:00+09:00',
  };

  it('clips to the week and merges overlapping or touching intervals from multiple calendars', () => {
    const source = [
      { start: '2026-10-04T23:00:00+09:00', end: '2026-10-05T01:00:00+09:00' },
      { start: '2026-10-05T01:00:00+09:00', end: '2026-10-05T02:00:00+09:00' },
      { start: '2026-10-05T01:30:00+09:00', end: '2026-10-05T03:00:00+09:00' },
      { start: '2026-10-12T00:00:00+09:00', end: '2026-10-12T01:00:00+09:00' },
      { start: '2026-10-11T23:00:00+09:00', end: '2026-10-12T00:30:00+09:00' },
    ];
    const original = structuredClone(source);

    expect(mergeBusyIntervals(source, bounds)).toEqual([
      { start: '2026-10-05T00:00:00+09:00', end: '2026-10-05T03:00:00+09:00' },
      { start: '2026-10-11T23:00:00+09:00', end: '2026-10-12T00:00:00+09:00' },
    ]);
    expect(source).toEqual(original);
  });

  it('merges intervals across midnight and normalizes offsets to Tokyo', () => {
    expect(
      mergeBusyIntervals(
        [
          { start: '2026-10-06T14:30:00Z', end: '2026-10-06T16:00:00Z' },
          { start: '2026-10-06T16:00:00Z', end: '2026-10-06T16:30:00Z' },
        ],
        bounds,
      ),
    ).toEqual([{ start: '2026-10-06T23:30:00+09:00', end: '2026-10-07T01:30:00+09:00' }]);
  });

  it('drops intervals outside the bounds and returns empty when no interval overlaps', () => {
    expect(
      mergeBusyIntervals(
        [{ start: '2026-10-04T20:00:00+09:00', end: '2026-10-04T21:00:00+09:00' }],
        bounds,
      ),
    ).toEqual([]);
  });

  it('rejects invalid interval and bounds ranges', () => {
    expect(() =>
      mergeBusyIntervals(
        [{ start: '2026-10-05T02:00:00+09:00', end: '2026-10-05T02:00:00+09:00' }],
        bounds,
      ),
    ).toThrow(RangeError);
    expect(() =>
      mergeBusyIntervals([], {
        start: '2026-10-06T00:00:00+09:00',
        end: '2026-10-05T00:00:00+09:00',
      }),
    ).toThrow(RangeError);
  });
});
