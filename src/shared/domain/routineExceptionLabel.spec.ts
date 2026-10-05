import { describe, expect, it } from 'vitest';
import { getRoutineExceptionLabel } from './routineExceptionLabel';

describe('getRoutineExceptionLabel', () => {
  it('labels a move using the original Tokyo date', () => {
    expect(
      getRoutineExceptionLabel({
        time: {
          kind: 'timed',
          start: '2026-10-21T17:00:00+09:00',
          endExclusive: '2026-10-21T18:00:00+09:00',
        },
        movedFrom: '2026-10-20T17:00:00+09:00',
      }),
    ).toBe('振替（10/20 から）');
  });

  it('labels a same-day time change', () => {
    expect(
      getRoutineExceptionLabel({
        time: {
          kind: 'timed',
          start: '2026-10-20T18:00:00+09:00',
          endExclusive: '2026-10-20T19:00:00+09:00',
        },
        movedFrom: '2026-10-20T17:00:00+09:00',
      }),
    ).toBe('時間変更');
  });

  it('treats all-day dates as Tokyo calendar dates', () => {
    expect(
      getRoutineExceptionLabel({
        time: { kind: 'all-day', start: '2026-10-22', endExclusive: '2026-10-23' },
        movedFrom: '2026-10-20T15:00:00Z',
      }),
    ).toBe('振替（10/21 から）');
  });

  it('returns no label when the original instance is unknown', () => {
    expect(
      getRoutineExceptionLabel({
        time: {
          kind: 'timed',
          start: '2026-10-21T17:00:00+09:00',
          endExclusive: '2026-10-21T18:00:00+09:00',
        },
        movedFrom: null,
      }),
    ).toBeNull();
  });
});
