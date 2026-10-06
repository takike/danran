import { describe, expect, it } from 'vitest';
import {
  getRoutineAutoSkipCandidateReason,
  getRoutineAutoSkipHorizon,
  getRoutineAutoSkipReason,
} from './routineAutoSkips';

describe('routine automatic skip rules', () => {
  it('uses Japanese national and substitute holidays, with holiday reason priority', () => {
    expect(getRoutineAutoSkipReason('2026-11-03', { skipHolidays: true, skipNewYear: false })).toBe(
      'holiday',
    );
    expect(getRoutineAutoSkipReason('2026-05-06', { skipHolidays: true, skipNewYear: false })).toBe(
      'holiday',
    );
    expect(getRoutineAutoSkipReason('2027-01-01', { skipHolidays: true, skipNewYear: true })).toBe(
      'holiday',
    );
  });

  it('uses the year-end reason for January 1 when holiday skipping is disabled', () => {
    expect(getRoutineAutoSkipReason('2027-01-01', { skipHolidays: false, skipNewYear: true })).toBe(
      'new_year',
    );
  });

  it.each(['2026-12-29', '2026-12-31', '2027-01-02', '2027-01-03'] as const)(
    'selects the fixed year-end break date %s',
    (date) => {
      expect(getRoutineAutoSkipReason(date, { skipHolidays: false, skipNewYear: true })).toBe(
        'new_year',
      );
    },
  );

  it.each(['2026-12-28', '2027-01-04'] as const)(
    'does not select outside year-end break: %s',
    (date) => {
      expect(getRoutineAutoSkipReason(date, { skipHolidays: false, skipNewYear: true })).toBeNull();
    },
  );

  it('returns no reason when both settings are disabled', () => {
    expect(
      getRoutineAutoSkipReason('2026-11-03', { skipHolidays: false, skipNewYear: false }),
    ).toBe(null);
  });

  it('uses the Tokyo original date and includes both horizon endpoints', () => {
    const settings = { skipHolidays: true, skipNewYear: false };
    const range = { today: '2026-11-03' as const, through: '2026-11-23' as const };
    expect(
      getRoutineAutoSkipCandidateReason({
        ...settings,
        ...range,
        originalStart: '2026-11-02T15:00:00.000Z',
        status: 'normal',
      }),
    ).toBe('holiday');
    expect(
      getRoutineAutoSkipCandidateReason({
        ...settings,
        ...range,
        originalStart: '2026-11-23T14:59:00.000Z',
        status: 'normal',
      }),
    ).toBe('holiday');
    expect(
      getRoutineAutoSkipCandidateReason({
        ...settings,
        ...range,
        originalStart: '2026-11-02T14:59:00.000Z',
        status: 'normal',
      }),
    ).toBeNull();
    expect(
      getRoutineAutoSkipCandidateReason({
        ...settings,
        ...range,
        originalStart: '2026-11-23T15:00:00.000Z',
        status: 'normal',
      }),
    ).toBeNull();
  });

  it.each(['skipped', 'moved'] as const)('does not select a %s exception', (status) => {
    expect(
      getRoutineAutoSkipCandidateReason({
        originalStart: '2026-11-02T15:00:00.000Z',
        status,
        today: '2026-11-03',
        through: '2026-11-23',
        skipHolidays: true,
        skipNewYear: true,
      }),
    ).toBeNull();
  });

  it('sets the application horizon to 183 Tokyo calendar days', () => {
    expect(getRoutineAutoSkipHorizon('2026-10-06')).toBe('2027-04-07');
  });
});
