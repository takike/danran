import type { Task } from '@shared/schemas/tasks';
import { describe, expect, it } from 'vitest';
import { buildTaskPresentation, getEventCountdown, getTaskDueLabel } from './taskPresentation';

function makeTask(id: string, overrides: Partial<Omit<Task, 'id'>> = {}): Task {
  return {
    id,
    title: id,
    due: { kind: 'none' },
    doneAt: null,
    assigneeMemberId: null,
    source: 'manual',
    linkedEvent: { state: 'none' },
    ...overrides,
  };
}

function readyEvent(
  eventId: string,
  start: string,
  endExclusive: string,
): Extract<Task['linkedEvent'], { state: 'ready' }> {
  return {
    state: 'ready',
    eventId,
    title: eventId,
    time: { kind: 'all-day', start, endExclusive },
    memberIds: [],
    items: [],
  };
}

describe('task presentation', () => {
  it('orders ready event groups by start and groups tasks per event', () => {
    const presentation = buildTaskPresentation(
      [
        makeTask('event-later', {
          linkedEvent: readyEvent('event-later', '2026-10-10', '2026-10-11'),
        }),
        makeTask('event-earlier-2', {
          linkedEvent: readyEvent('event-earlier', '2026-10-08', '2026-10-09'),
        }),
        makeTask('event-earlier-1', {
          linkedEvent: readyEvent('event-earlier', '2026-10-08', '2026-10-09'),
          doneAt: 1,
        }),
      ],
      { now: new Date('2026-10-08T01:00:00Z'), currentMemberId: 'member-self' },
    );

    expect(presentation.readyGroups.map(({ eventId }) => eventId)).toEqual([
      'event-earlier',
      'event-later',
    ]);
    expect(presentation.readyGroups[0]).toMatchObject({
      tasks: [{ id: 'event-earlier-2' }],
      completedCount: 1,
      totalCount: 2,
      countdown: { kind: 'today' },
    });
    expect(presentation.completedTasks.map(({ id }) => id)).toEqual(['event-earlier-1']);
    expect(presentation.readyGroups[1]?.countdown).toEqual({ kind: 'days', days: 2 });
  });

  it('orders visible unfinished rows by due date and hides completed rows', () => {
    const presentation = buildTaskPresentation(
      [
        makeTask('complete-earliest', {
          due: { kind: 'date', dueAt: '2026-10-08' },
          doneAt: 1,
        }),
        makeTask('unknown', { due: { kind: 'unknown' } }),
        makeTask('none'),
        makeTask('later', { due: { kind: 'datetime', dueAt: '2026-10-10T12:00:00+09:00' } }),
        makeTask('same-day-date', { due: { kind: 'date', dueAt: '2026-10-10' } }),
        makeTask('same-day-time', {
          due: { kind: 'datetime', dueAt: '2026-10-10T20:00:00+09:00' },
        }),
        makeTask('earlier', { due: { kind: 'date', dueAt: '2026-10-09' } }),
      ],
      { now: new Date('2026-10-08T01:00:00Z'), currentMemberId: 'member-self' },
    );

    expect(presentation.orderedTasks.map(({ id }) => id)).toEqual([
      'earlier',
      'later',
      'same-day-time',
      'same-day-date',
      'none',
      'unknown',
    ]);
    expect(presentation.completedTasks.map(({ id }) => id)).toEqual(['complete-earliest']);
  });

  it('keeps retained completed tasks in their due order and excludes them from the completed list', () => {
    const presentation = buildTaskPresentation(
      [
        makeTask('retained-earlier', {
          due: { kind: 'date', dueAt: '2026-10-09' },
          doneAt: 100,
        }),
        makeTask('unfinished-later', { due: { kind: 'date', dueAt: '2026-10-10' } }),
        makeTask('completed-hidden', { doneAt: 300 }),
      ],
      {
        now: new Date('2026-10-08T01:00:00Z'),
        currentMemberId: 'member-self',
        retainedDoneIds: new Set(['retained-earlier']),
      },
    );

    expect(presentation.orderedTasks.map(({ id }) => id)).toEqual([
      'retained-earlier',
      'unfinished-later',
    ]);
    expect(presentation.completedTasks.map(({ id }) => id)).toEqual(['completed-hidden']);
  });

  it('hides ready event groups without visible tasks while retaining all task counts', () => {
    const presentation = buildTaskPresentation(
      [
        makeTask('all-done', {
          doneAt: 100,
          linkedEvent: readyEvent('past-event', '2026-10-01', '2026-10-02'),
        }),
        makeTask('active', {
          linkedEvent: readyEvent('active-event', '2026-10-10', '2026-10-11'),
        }),
      ],
      { now: new Date('2026-10-08T01:00:00Z'), currentMemberId: 'member-self' },
    );

    expect(presentation.readyGroups.map(({ eventId }) => eventId)).toEqual(['active-event']);
    expect(presentation.readyGroups[0]).toMatchObject({ completedCount: 0, totalCount: 1 });
    expect(presentation.completedTasks.map(({ id }) => id)).toEqual(['all-done']);
  });

  it('keeps an event group for a retained last row, counts all its tasks, and hides it after release', () => {
    const tasks = [
      makeTask('retained-event-task', {
        doneAt: 200,
        linkedEvent: readyEvent('event', '2026-10-01', '2026-10-02'),
      }),
      makeTask('other-event-task', {
        doneAt: 100,
        linkedEvent: readyEvent('event', '2026-10-01', '2026-10-02'),
      }),
    ];
    const retained = buildTaskPresentation(tasks, {
      now: new Date('2026-10-08T01:00:00Z'),
      currentMemberId: 'member-self',
      retainedDoneIds: new Set(['retained-event-task']),
    });
    const released = buildTaskPresentation(tasks, {
      now: new Date('2026-10-08T01:00:00Z'),
      currentMemberId: 'member-self',
    });

    expect(retained.readyGroups).toMatchObject([
      {
        eventId: 'event',
        tasks: [{ id: 'retained-event-task' }],
        completedCount: 2,
        totalCount: 2,
      },
    ]);
    expect(retained.completedTasks.map(({ id }) => id)).toEqual(['other-event-task']);
    expect(released.readyGroups).toEqual([]);
  });

  it('counts completed tasks only for the current member in mine view data', () => {
    const presentation = buildTaskPresentation(
      [
        makeTask('self-old', { doneAt: 100, assigneeMemberId: 'member-self' }),
        makeTask('other-newest', { doneAt: 300, assigneeMemberId: 'member-other' }),
        makeTask('self-newest', { doneAt: 200, assigneeMemberId: 'member-self' }),
      ],
      { now: new Date('2026-10-08T01:00:00Z'), currentMemberId: 'member-self' },
    );

    expect(presentation.mineCompletedTasks.map(({ id }) => id)).toEqual([
      'self-newest',
      'self-old',
    ]);
    expect(presentation.completedTasks.map(({ id }) => id)).toEqual([
      'other-newest',
      'self-newest',
      'self-old',
    ]);
  });

  it('places a date-only deadline before midnight on the following day', () => {
    const presentation = buildTaskPresentation(
      [
        makeTask('a-midnight', {
          due: { kind: 'datetime', dueAt: '2026-10-09T00:00:00+09:00' },
        }),
        makeTask('z-date', { due: { kind: 'date', dueAt: '2026-10-08' } }),
      ],
      { now: new Date('2026-10-08T01:00:00Z'), currentMemberId: 'member-self' },
    );

    expect(presentation.orderedTasks.map(({ id }) => id)).toEqual(['z-date', 'a-midnight']);
  });

  it('counts unfinished known deadlines through today and Sunday, without holiday extension', () => {
    const presentation = buildTaskPresentation(
      [
        makeTask('past-date', { due: { kind: 'date', dueAt: '2026-10-07' } }),
        makeTask('today-past-time', {
          due: { kind: 'datetime', dueAt: '2026-10-08T09:00:00+09:00' },
          assigneeMemberId: 'member-self',
        }),
        makeTask('today-later-time', {
          due: { kind: 'datetime', dueAt: '2026-10-08T23:00:00+09:00' },
        }),
        makeTask('sunday', { due: { kind: 'date', dueAt: '2026-10-11' } }),
        makeTask('holiday-monday', { due: { kind: 'date', dueAt: '2026-10-12' } }),
        makeTask('no-deadline'),
        makeTask('unknown-deadline', { due: { kind: 'unknown' } }),
        makeTask('completed-today', {
          due: { kind: 'date', dueAt: '2026-10-08' },
          doneAt: 1,
        }),
      ],
      { now: new Date('2026-10-08T03:00:00Z'), currentMemberId: 'member-self' },
    );

    expect(presentation.today).toBe('2026-10-08');
    expect(presentation.week).toEqual({
      start: '2026-10-05',
      endInclusive: '2026-10-11',
      endExclusive: '2026-10-12',
    });
    expect(presentation.summary).toEqual({
      dueTodayOrEarlier: 3,
      dueThisWeek: 4,
      unassigned: 6,
    });
    expect(presentation.mineTasks.map(({ id }) => id)).toEqual(['today-past-time']);
  });

  it('changes the fixed summary week at Monday midnight in Tokyo', () => {
    const tasks = [
      makeTask('sunday', { due: { kind: 'date', dueAt: '2026-10-11' } }),
      makeTask('monday', { due: { kind: 'date', dueAt: '2026-10-12' } }),
    ];
    const beforeMidnight = buildTaskPresentation(tasks, {
      now: new Date('2026-10-11T14:59:59Z'),
      currentMemberId: 'member-self',
    });
    const atMidnight = buildTaskPresentation(tasks, {
      now: new Date('2026-10-11T15:00:00Z'),
      currentMemberId: 'member-self',
    });

    expect(beforeMidnight.today).toBe('2026-10-11');
    expect(beforeMidnight.week).toEqual({
      start: '2026-10-05',
      endInclusive: '2026-10-11',
      endExclusive: '2026-10-12',
    });
    expect(beforeMidnight.summary).toMatchObject({ dueTodayOrEarlier: 1, dueThisWeek: 1 });
    expect(atMidnight.today).toBe('2026-10-12');
    expect(atMidnight.week).toEqual({
      start: '2026-10-12',
      endInclusive: '2026-10-18',
      endExclusive: '2026-10-19',
    });
    expect(atMidnight.summary).toMatchObject({ dueTodayOrEarlier: 2, dueThisWeek: 2 });
  });

  it('labels date and datetime deadlines with Tokyo urgency', () => {
    const now = new Date('2026-10-08T12:00:00+09:00');
    expect(getTaskDueLabel({ due: { kind: 'none' } }, now)).toEqual({
      label: null,
      urgency: null,
    });
    expect(getTaskDueLabel({ due: { kind: 'unknown' } }, now)).toEqual({
      label: '期限を確認できません',
      urgency: null,
    });
    expect(getTaskDueLabel({ due: { kind: 'date', dueAt: '2026-10-07' } }, now)).toEqual({
      label: '期限を過ぎています',
      urgency: 'overdue',
    });
    expect(getTaskDueLabel({ due: { kind: 'date', dueAt: '2026-10-08' } }, now)).toEqual({
      label: '今日まで',
      urgency: 'today',
    });
    expect(getTaskDueLabel({ due: { kind: 'date', dueAt: '2026-10-09' } }, now)).toEqual({
      label: '10/9（金）まで',
      urgency: null,
    });
    expect(
      getTaskDueLabel({ due: { kind: 'datetime', dueAt: '2026-10-08T11:59:00+09:00' } }, now),
    ).toEqual({ label: '期限を過ぎています', urgency: 'overdue' });
    expect(
      getTaskDueLabel({ due: { kind: 'datetime', dueAt: '2026-10-09T20:00:00+09:00' } }, now),
    ).toEqual({ label: '10/9（金） 20:00 まで', urgency: null });
    expect(
      getTaskDueLabel(
        { due: { kind: 'datetime', dueAt: '2026-10-07T16:00:00Z' } },
        new Date('2026-10-07T16:00:00Z'),
      ),
    ).toEqual({ label: '今日まで', urgency: 'today' });
  });

  it('counts event days using Tokyo calendar dates', () => {
    expect(
      getEventCountdown(
        { kind: 'timed', start: '2026-10-07T16:00:00Z', endExclusive: '2026-10-07T17:00:00Z' },
        '2026-10-08',
      ),
    ).toEqual({ kind: 'today' });
    expect(
      getEventCountdown(
        { kind: 'all-day', start: '2026-10-07', endExclusive: '2026-10-08' },
        '2026-10-08',
      ),
    ).toEqual({ kind: 'ended' });
    expect(
      getEventCountdown(
        { kind: 'all-day', start: '2026-10-11', endExclusive: '2026-10-12' },
        '2026-10-08',
      ),
    ).toEqual({ kind: 'days', days: 3 });
    for (const days of [1, 2, 3, 4]) {
      expect(
        getEventCountdown(
          {
            kind: 'all-day',
            start: `2026-10-${String(8 + days).padStart(2, '0')}`,
            endExclusive: `2026-10-${String(9 + days).padStart(2, '0')}`,
          },
          '2026-10-08',
        ),
      ).toEqual({ kind: 'days', days });
    }
  });

  it('keeps missing, unavailable, and unlinked tasks in separate presentation groups', () => {
    const presentation = buildTaskPresentation(
      [
        makeTask('unlinked'),
        makeTask('missing', { linkedEvent: { state: 'missing', eventId: 'gone' } }),
        makeTask('missing-done', {
          doneAt: 100,
          linkedEvent: { state: 'missing', eventId: 'gone' },
        }),
        makeTask('unavailable', {
          linkedEvent: { state: 'unavailable', eventId: 'unknown' },
        }),
        makeTask('unavailable-done', {
          doneAt: 200,
          linkedEvent: { state: 'unavailable', eventId: 'unknown' },
        }),
        makeTask('unlinked-done', { doneAt: 300 }),
      ],
      { now: new Date('2026-10-08T03:00:00Z'), currentMemberId: 'member-self' },
    );

    expect(presentation.missingTasks.map(({ id }) => id)).toEqual(['missing']);
    expect([presentation.missingCompletedCount, presentation.missingTotalCount]).toEqual([1, 2]);
    expect(presentation.unavailableTasks.map(({ id }) => id)).toEqual(['unavailable']);
    expect([presentation.unavailableCompletedCount, presentation.unavailableTotalCount]).toEqual([
      1, 2,
    ]);
    expect(presentation.unlinkedTasks.map(({ id }) => id)).toEqual(['unlinked']);
    expect(presentation.completedTasks.map(({ id }) => id)).toEqual([
      'unlinked-done',
      'unavailable-done',
      'missing-done',
    ]);
  });
});
