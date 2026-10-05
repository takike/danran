import { routineInstanceSchema } from '@shared/schemas/routines';
import { describe, expect, it } from 'vitest';
import { getRoutineInstanceStatus } from './routineInstances';
import { formatRoutineInstanceChip } from './routineInstances';

describe('getRoutineInstanceStatus', () => {
  const times = {
    originalStart: '2026-10-06T15:00:00+09:00',
    originalEnd: '2026-10-06T16:00:00+09:00',
    start: '2026-10-06T15:00:00+09:00',
    end: '2026-10-06T16:00:00+09:00',
  };

  it('classifies unchanged, cancelled, and moved instances', () => {
    expect(getRoutineInstanceStatus(times)).toBe('normal');
    expect(getRoutineInstanceStatus({ ...times, cancelled: true })).toBe('skipped');
    expect(
      getRoutineInstanceStatus({
        ...times,
        start: '2026-10-08T16:00:00+09:00',
        end: '2026-10-08T17:00:00+09:00',
      }),
    ).toBe('moved');
  });

  it('detects a time-only change', () => {
    expect(getRoutineInstanceStatus({ ...times, start: '2026-10-06T15:30:00+09:00' })).toBe(
      'moved',
    );
    expect(getRoutineInstanceStatus({ ...times, end: '2026-10-06T16:30:00+09:00' })).toBe('moved');
    expect(getRoutineInstanceStatus({ ...times, start: '2026-10-06T06:00:00Z' })).toBe('normal');
  });

  it('requires actual times on an active occurrence', () => {
    expect(() => getRoutineInstanceStatus({ ...times, start: null })).toThrow();
  });

  it('formats normal, skipped, and moved chip text in Tokyo time', () => {
    const normal = routineInstanceSchema.parse({
      id: 'normal',
      ...times,
      status: 'normal',
    });
    const skipped = routineInstanceSchema.parse({
      id: 'skipped',
      originalStart: times.originalStart,
      originalEnd: times.originalEnd,
      start: null,
      end: null,
      status: 'skipped',
    });
    const moved = routineInstanceSchema.parse({
      id: 'moved',
      ...times,
      start: '2026-10-08T16:30:00+09:00',
      end: '2026-10-08T17:30:00+09:00',
      status: 'moved',
    });
    expect(formatRoutineInstanceChip(normal)).toBe('10/6（火）');
    expect(formatRoutineInstanceChip(skipped)).toBe('10/6（火） お休み');
    expect(formatRoutineInstanceChip(moved)).toBe(
      '10/6（火） → 10/8（木） 振替 15:00–16:00 → 16:30–17:30',
    );
  });

  it('rejects malformed timestamps without throwing during boundary validation', () => {
    expect(
      routineInstanceSchema.safeParse({
        id: 'bad',
        originalStart: 'not-a-date',
        originalEnd: '2026-10-06T16:00:00+09:00',
        start: '2026-10-06T15:00:00+09:00',
        end: '2026-10-06T16:00:00+09:00',
        status: 'normal',
      }).success,
    ).toBe(false);
  });
});
