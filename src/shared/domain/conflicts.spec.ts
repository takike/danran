import { describe, expect, it } from 'vitest';
import type { ConflictEvent } from './conflicts';
import { getRoutineConflicts } from './conflicts';

const familyMembers = ['adult-1', 'child-1', 'child-2'];

function event(
  id: string,
  time: ConflictEvent['time'],
  options: Partial<Omit<ConflictEvent, 'id' | 'time'>> = {},
): ConflictEvent {
  return {
    id,
    time,
    memberIds: options.memberIds ?? [],
    assigneeMemberId: options.assigneeMemberId ?? null,
    status: options.status ?? 'confirmed',
    isRecurring: options.isRecurring ?? false,
  };
}

function timed(start: string, endExclusive: string): ConflictEvent['time'] {
  return { kind: 'timed', start, endExclusive };
}

function allDay(start: string, endExclusive: string): ConflictEvent['time'] {
  return { kind: 'all-day', start, endExclusive };
}

describe('getRoutineConflicts', () => {
  it('detects half-open timed overlaps and excludes intervals that only touch', () => {
    const routine = event(
      'routine',
      timed('2026-10-10T09:00:00+09:00', '2026-10-10T10:00:00+09:00'),
      {
        isRecurring: true,
        memberIds: ['child-1'],
      },
    );
    const overlapping = event(
      'overlap',
      timed('2026-10-10T09:59:00+09:00', '2026-10-10T10:30:00+09:00'),
      { memberIds: ['child-1'] },
    );
    const touchingAfter = event(
      'touching-after',
      timed('2026-10-10T10:00:00+09:00', '2026-10-10T10:30:00+09:00'),
      { memberIds: ['child-1'] },
    );
    const touchingBefore = event(
      'touching-before',
      timed('2026-10-10T08:30:00+09:00', '2026-10-10T09:00:00+09:00'),
      { memberIds: ['child-1'] },
    );

    expect(
      getRoutineConflicts([routine, touchingAfter, overlapping, touchingBefore], familyMembers),
    ).toEqual([{ routineInstanceId: 'routine', eventId: 'overlap', memberIds: ['child-1'] }]);
  });

  it('detects timed intervals crossing Tokyo midnight', () => {
    const routine = event(
      'overnight-routine',
      timed('2026-10-10T23:30:00+09:00', '2026-10-11T00:30:00+09:00'),
      {
        isRecurring: true,
        memberIds: ['child-1'],
      },
    );
    const nextDay = event(
      'after-midnight-event',
      timed('2026-10-11T00:00:00+09:00', '2026-10-11T00:15:00+09:00'),
      { memberIds: ['child-1'] },
    );

    expect(getRoutineConflicts([routine, nextDay], familyMembers)).toEqual([
      {
        routineInstanceId: 'overnight-routine',
        eventId: 'after-midnight-event',
        memberIds: ['child-1'],
      },
    ]);
  });

  it('treats one-day and multi-day all-day events as Tokyo date ranges with an exclusive end', () => {
    const routines = [
      event('single-day-routine', timed('2026-10-10T12:00:00+09:00', '2026-10-10T13:00:00+09:00'), {
        isRecurring: true,
        memberIds: ['child-1'],
      }),
      event(
        'last-in-multi-day-routine',
        timed('2026-10-12T12:00:00+09:00', '2026-10-12T13:00:00+09:00'),
        {
          isRecurring: true,
          memberIds: ['child-1'],
        },
      ),
      event(
        'at-exclusive-end-routine',
        timed('2026-10-13T00:00:00+09:00', '2026-10-13T01:00:00+09:00'),
        {
          isRecurring: true,
          memberIds: ['child-1'],
        },
      ),
    ];
    const oneDay = event('one-day', allDay('2026-10-10', '2026-10-11'), { memberIds: ['child-1'] });
    const multipleDays = event('multiple-days', allDay('2026-10-11', '2026-10-13'), {
      memberIds: ['child-1'],
    });

    expect(getRoutineConflicts([...routines, oneDay, multipleDays], familyMembers)).toEqual([
      {
        routineInstanceId: 'last-in-multi-day-routine',
        eventId: 'multiple-days',
        memberIds: ['child-1'],
      },
      { routineInstanceId: 'single-day-routine', eventId: 'one-day', memberIds: ['child-1'] },
    ]);
  });

  it('requires at least one shared active member and treats empty target lists as all active members', () => {
    const routine = event(
      'routine',
      timed('2026-10-10T09:00:00+09:00', '2026-10-10T10:00:00+09:00'),
      {
        isRecurring: true,
        memberIds: ['child-1'],
      },
    );
    const allMembersEvent = event(
      'all-members',
      timed('2026-10-10T09:30:00+09:00', '2026-10-10T10:30:00+09:00'),
    );
    const unrelated = event(
      'unrelated',
      timed('2026-10-10T09:30:00+09:00', '2026-10-10T10:30:00+09:00'),
      { memberIds: ['child-2'] },
    );
    const unknownOnly = event(
      'unknown-only',
      timed('2026-10-10T09:30:00+09:00', '2026-10-10T10:30:00+09:00'),
      { memberIds: ['not-a-family-member'] },
    );

    expect(
      getRoutineConflicts([routine, allMembersEvent, unrelated, unknownOnly], familyMembers),
    ).toEqual([{ routineInstanceId: 'routine', eventId: 'all-members', memberIds: ['child-1'] }]);
  });

  it('includes a shared assignee, deduplicates valid IDs, and returns deterministic member pairs', () => {
    const routine = event(
      'routine',
      timed('2026-10-10T09:00:00+09:00', '2026-10-10T10:00:00+09:00'),
      {
        isRecurring: true,
        memberIds: ['child-1', 'child-1', 'unknown'],
        assigneeMemberId: 'adult-1',
      },
    );
    const assigneeOnly = event(
      'assignee-only',
      timed('2026-10-10T09:30:00+09:00', '2026-10-10T10:30:00+09:00'),
      { memberIds: ['adult-1', 'adult-1', 'unknown'] },
    );

    expect(getRoutineConflicts([routine, assigneeOnly], familyMembers)).toEqual([
      { routineInstanceId: 'routine', eventId: 'assignee-only', memberIds: ['adult-1'] },
    ]);
    const bothListsEmpty = event(
      'all-shared',
      timed('2026-10-10T09:30:00+09:00', '2026-10-10T10:30:00+09:00'),
    );
    expect(getRoutineConflicts([routine, bothListsEmpty], familyMembers)[0]?.memberIds).toEqual([
      'adult-1',
      'child-1',
    ]);

    const emptyTargetRoutine = event(
      'empty-target-routine',
      timed('2026-10-10T09:00:00+09:00', '2026-10-10T10:00:00+09:00'),
      { isRecurring: true },
    );
    expect(getRoutineConflicts([emptyTargetRoutine, bothListsEmpty], familyMembers)).toEqual([
      {
        routineInstanceId: 'empty-target-routine',
        eventId: 'all-shared',
        memberIds: ['adult-1', 'child-1', 'child-2'],
      },
    ]);
  });

  it('returns each routine and event pair once even if an event appears on multiple pages', () => {
    const routine = event(
      'routine',
      timed('2026-10-10T09:00:00+09:00', '2026-10-10T10:00:00+09:00'),
      { isRecurring: true, memberIds: ['child-1'] },
    );
    const oneOff = event(
      'one-off',
      timed('2026-10-10T09:30:00+09:00', '2026-10-10T10:30:00+09:00'),
      { memberIds: ['child-1'] },
    );

    expect(getRoutineConflicts([routine, oneOff, { ...oneOff }], familyMembers)).toEqual([
      { routineInstanceId: 'routine', eventId: 'one-off', memberIds: ['child-1'] },
    ]);
  });

  it('ignores tentative, cancelled, recurring counterparts, and all-day recurring routines', () => {
    const routine = event(
      'routine',
      timed('2026-10-10T09:00:00+09:00', '2026-10-10T10:00:00+09:00'),
      {
        isRecurring: true,
        memberIds: ['child-1'],
      },
    );
    const candidates = [
      event('tentative', timed('2026-10-10T09:10:00+09:00', '2026-10-10T09:20:00+09:00'), {
        memberIds: ['child-1'],
        status: 'tentative',
      }),
      event('cancelled', timed('2026-10-10T09:10:00+09:00', '2026-10-10T09:20:00+09:00'), {
        memberIds: ['child-1'],
        status: 'cancelled',
      }),
      event('another-routine', timed('2026-10-10T09:10:00+09:00', '2026-10-10T09:20:00+09:00'), {
        memberIds: ['child-1'],
        isRecurring: true,
      }),
      event('all-day-routine', allDay('2026-10-10', '2026-10-11'), {
        memberIds: ['child-1'],
        isRecurring: true,
      }),
    ];

    expect(getRoutineConflicts([routine, ...candidates], familyMembers)).toEqual([]);

    const confirmedOneOff = event(
      'confirmed-one-off',
      timed('2026-10-10T09:10:00+09:00', '2026-10-10T09:20:00+09:00'),
      { memberIds: ['child-1'] },
    );
    const cancelledRoutine = event(
      'cancelled-routine',
      timed('2026-10-10T09:10:00+09:00', '2026-10-10T09:20:00+09:00'),
      { isRecurring: true, memberIds: ['child-1'], status: 'cancelled' },
    );
    const tentativeRoutine = event(
      'tentative-routine',
      timed('2026-10-10T09:10:00+09:00', '2026-10-10T09:20:00+09:00'),
      { isRecurring: true, memberIds: ['child-1'], status: 'tentative' },
    );
    const expected = [
      { routineInstanceId: 'routine', eventId: 'confirmed-one-off', memberIds: ['child-1'] },
    ];
    expect(
      getRoutineConflicts(
        [routine, confirmedOneOff, cancelledRoutine, tentativeRoutine],
        familyMembers,
      ),
    ).toEqual(expected);
  });

  it('uses a moved routine instance actual interval and detects Sports Day against Saturday piano', () => {
    const moved = event(
      'moved-routine',
      timed('2026-10-10T10:00:00+09:00', '2026-10-10T11:00:00+09:00'),
      {
        isRecurring: true,
        memberIds: ['child-1'],
      },
    );
    const sportsDay = event(
      'sports-day',
      timed('2026-10-10T10:30:00+09:00', '2026-10-10T12:00:00+09:00'),
      { memberIds: ['child-1'] },
    );
    const atOriginalTime = event(
      'original-slot-event',
      timed('2026-10-10T09:00:00+09:00', '2026-10-10T09:30:00+09:00'),
      { memberIds: ['child-1'] },
    );

    expect(getRoutineConflicts([moved, sportsDay, atOriginalTime], familyMembers)).toEqual([
      { routineInstanceId: 'moved-routine', eventId: 'sports-day', memberIds: ['child-1'] },
    ]);

    const saturdayPiano = event(
      'saturday-piano',
      timed('2026-10-10T09:30:00+09:00', '2026-10-10T10:30:00+09:00'),
      { isRecurring: true, memberIds: ['child-2'] },
    );
    const schoolSportsDay = event(
      'school-sports-day',
      timed('2026-10-10T10:00:00+09:00', '2026-10-10T11:00:00+09:00'),
      { memberIds: ['child-2'] },
    );
    expect(getRoutineConflicts([schoolSportsDay, saturdayPiano], familyMembers)).toEqual([
      { routineInstanceId: 'saturday-piano', eventId: 'school-sports-day', memberIds: ['child-2'] },
    ]);
  });
});
