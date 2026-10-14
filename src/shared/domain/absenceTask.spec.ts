import { describe, expect, it } from 'vitest';
import {
  createAbsenceTaskSourceRef,
  getAbsenceTaskDisplayTitle,
  getAbsenceTaskDueDate,
  parseAbsenceTaskSourceRef,
} from './absenceTask';

describe('absence task helpers', () => {
  it('round trips the routine and original start without ambiguous delimiters', () => {
    const value = createAbsenceTaskSourceRef({
      routineSettingsId: 'routine:id/with space',
      originalStart: '2026-10-17T10:30:00+09:00',
    });
    expect(parseAbsenceTaskSourceRef(value)).toEqual({
      routineSettingsId: 'routine:id/with space',
      originalStart: '2026-10-17T10:30:00+09:00',
    });
    expect(
      createAbsenceTaskSourceRef({
        routineSettingsId: 'routine:id/with space',
        originalStart: '2026-10-17T01:30:00Z',
      }),
    ).toBe(value);
    expect(parseAbsenceTaskSourceRef('absence:v1:bad%:bad')).toBeNull();
    expect(parseAbsenceTaskSourceRef('absence:v1:routine:2026-10-17T10:30:00+09:00')).toBeNull();
  });

  it('sets due date to the previous Tokyo date when the routine is in the future', () => {
    expect(getAbsenceTaskDueDate('2026-11-01T00:30:00+09:00', '2026-10-12')).toBe('2026-10-31');
    expect(getAbsenceTaskDueDate('2027-01-01T09:00:00+09:00', '2026-12-31')).toBe('2026-12-31');
  });

  it('uses the original date when today or earlier', () => {
    expect(getAbsenceTaskDueDate('2026-10-12T23:00:00+09:00', '2026-10-12')).toBe('2026-10-12');
    expect(getAbsenceTaskDueDate('2026-10-11T23:00:00+09:00', '2026-10-12')).toBe('2026-10-11');
  });

  it('formats lesson and other routine titles with type-specific title-free fallbacks', () => {
    expect(
      getAbsenceTaskDisplayTitle({
        routineTitle: 'ピアノ',
        originalStart: '2026-10-17T10:30:00+09:00',
      }),
    ).toBe('「ピアノ」（10/17（土））に欠席を連絡');
    expect(getAbsenceTaskDisplayTitle({ originalStart: '2026-10-17T10:30:00+09:00' })).toBe(
      '10/17（土）の欠席を連絡',
    );
    expect(
      getAbsenceTaskDisplayTitle({
        category: 'lesson',
        routineTitle: 'ピアノ',
        originalStart: '2026-10-17T10:30:00+09:00',
      }),
    ).toBe('「ピアノ」（10/17（土））に欠席を連絡');
    expect(
      getAbsenceTaskDisplayTitle({
        category: 'lesson',
        originalStart: '2026-10-17T10:30:00+09:00',
      }),
    ).toBe('10/17（土）の欠席を連絡');
    expect(
      getAbsenceTaskDisplayTitle({
        category: 'housework',
        routineTitle: '家事代行',
        originalStart: '2026-10-17T10:30:00+09:00',
      }),
    ).toBe('「家事代行」（10/17（土））のお休みを連絡');
    expect(
      getAbsenceTaskDisplayTitle({
        category: 'housework',
        originalStart: '2026-10-17T10:30:00+09:00',
      }),
    ).toBe('10/17（土）のお休みを連絡');
    expect(
      getAbsenceTaskDisplayTitle({
        category: 'other',
        originalStart: '2026-10-17T10:30:00+09:00',
      }),
    ).toBe('10/17（土）のお休みを連絡');
    expect(
      getAbsenceTaskDisplayTitle({
        category: 'other',
        routineTitle: 'その他',
        originalStart: '2026-10-17T10:30:00+09:00',
      }),
    ).toBe('「その他」（10/17（土））のお休みを連絡');
  });
});
