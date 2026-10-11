import type { DateKey } from '@shared/schemas/date';
import type { Task } from '@shared/schemas/tasks';
import { describe, expect, it } from 'vitest';
import { buildWeekTaskPresentation } from './weekTasks';

function task(input: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    id: input.id,
    title: input.title ?? input.id,
    due: input.due ?? { kind: 'none' },
    doneAt: input.doneAt ?? null,
    assigneeMemberId: input.assigneeMemberId ?? null,
    source: input.source ?? 'manual',
    linkedEvent: input.linkedEvent ?? { state: 'none' },
  };
}

function readyEvent(eventId: string): Task['linkedEvent'] {
  return {
    state: 'ready',
    eventId,
    title: `Event ${eventId}`,
    time: {
      kind: 'timed',
      start: '2026-10-06T10:00:00+09:00',
      endExclusive: '2026-10-06T11:00:00+09:00',
    },
    memberIds: [],
    items: [],
  };
}

describe('buildWeekTaskPresentation', () => {
  it('groups date and datetime deadlines by Tokyo date, including generated items tasks', () => {
    const tasks = [
      task({
        id: 'items',
        source: 'items',
        due: { kind: 'datetime', dueAt: '2026-10-05T11:00:00Z' },
      }),
      task({ id: 'date', due: { kind: 'date', dueAt: '2026-10-05' as DateKey } }),
      task({ id: 'before-midnight', due: { kind: 'datetime', dueAt: '2026-10-04T14:59:59Z' } }),
      task({ id: 'at-midnight', due: { kind: 'datetime', dueAt: '2026-10-04T15:00:00Z' } }),
      task({ id: 'after-midnight', due: { kind: 'datetime', dueAt: '2026-10-05T15:00:00Z' } }),
    ];

    const result = buildWeekTaskPresentation(tasks);

    expect([...result.deadlinesByDate.keys()].sort()).toEqual([
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
    ]);
    expect(result.deadlinesByDate.get('2026-10-04' as DateKey)?.map(({ id }) => id)).toEqual([
      'before-midnight',
    ]);
    expect(result.deadlinesByDate.get('2026-10-05' as DateKey)?.map(({ id }) => id)).toEqual([
      'at-midnight',
      'items',
      'date',
    ]);
    expect(result.deadlinesByDate.get('2026-10-06' as DateKey)?.map(({ id }) => id)).toEqual([
      'after-midnight',
    ]);
  });

  it('orders exact deadline times first, date-only deadlines last, then by id on ties', () => {
    const tasks = [
      task({ id: 'b', due: { kind: 'date', dueAt: '2026-10-05' as DateKey } }),
      task({ id: 'z', due: { kind: 'datetime', dueAt: '2026-10-04T15:30:00Z' } }),
      task({ id: 'a', due: { kind: 'datetime', dueAt: '2026-10-05T00:30:00+09:00' } }),
      task({ id: 'a-date', due: { kind: 'date', dueAt: '2026-10-05' as DateKey } }),
    ];

    const result = buildWeekTaskPresentation(tasks);

    expect(result.deadlinesByDate.get('2026-10-05' as DateKey)?.map(({ id }) => id)).toEqual([
      'a',
      'z',
      'a-date',
      'b',
    ]);
  });

  it('excludes completed and undated tasks from deadlines without rolling old deadlines forward', () => {
    const tasks = [
      task({ id: 'overdue', due: { kind: 'date', dueAt: '2026-10-04' as DateKey } }),
      task({ id: 'done', due: { kind: 'date', dueAt: '2026-10-05' as DateKey }, doneAt: 1 }),
      task({ id: 'none', due: { kind: 'none' } }),
      task({ id: 'unknown', due: { kind: 'unknown' } }),
    ];

    const result = buildWeekTaskPresentation(tasks);

    expect([...result.deadlinesByDate.keys()]).toEqual(['2026-10-04']);
    expect(result.deadlinesByDate.get('2026-10-04' as DateKey)?.map(({ id }) => id)).toEqual([
      'overdue',
    ]);
  });

  it('counts unfinished linked tasks regardless of due kind and excludes none or completed tasks', () => {
    const tasks = [
      task({ id: 'ready-1', linkedEvent: readyEvent('ready'), due: { kind: 'none' } }),
      task({ id: 'ready-2', linkedEvent: readyEvent('ready'), due: { kind: 'unknown' } }),
      task({
        id: 'missing',
        linkedEvent: { state: 'missing', eventId: 'missing' },
        due: { kind: 'date', dueAt: '2026-10-05' as DateKey },
      }),
      task({ id: 'unavailable', linkedEvent: { state: 'unavailable', eventId: 'unavailable' } }),
      task({ id: 'none', linkedEvent: { state: 'none' } }),
      task({ id: 'done', linkedEvent: readyEvent('ready'), doneAt: 123 }),
    ];

    const result = buildWeekTaskPresentation(tasks);

    expect(result.remainingByEventId).toEqual(
      new Map([
        ['ready', 2],
        ['missing', 1],
        ['unavailable', 1],
      ]),
    );
  });

  it('does not include a zero count and does not mutate the task list or task objects', () => {
    const completed = Object.freeze(
      task({ id: 'done', linkedEvent: readyEvent('empty'), doneAt: 1 }),
    );
    const open = Object.freeze(
      task({ id: 'open', due: { kind: 'datetime', dueAt: '2026-10-05T00:00:00+09:00' } }),
    );
    const tasks: readonly Task[] = Object.freeze([completed, open]);
    const originalIds = tasks.map(({ id }) => id);

    const result = buildWeekTaskPresentation(tasks);

    expect(result.remainingByEventId.has('empty')).toBe(false);
    expect(result.deadlinesByDate.get('2026-10-05' as DateKey)?.map(({ id }) => id)).toEqual([
      'open',
    ]);
    expect(tasks.map(({ id }) => id)).toEqual(originalIds);
    expect(tasks[0]).toBe(completed);
    expect(tasks[1]).toBe(open);
  });
});
