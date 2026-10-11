import type { DateKey } from '@shared/schemas/date';
import type { Task } from '@shared/schemas/tasks';
import { getDayBounds, toTokyoDateKey } from '@shared/time';
import { parseIsoInstantMilliseconds } from '@shared/time/interval';

export interface WeekTaskPresentation {
  deadlinesByDate: Map<DateKey, Task[]>;
  remainingByEventId: Map<string, number>;
}

function getDeadlineDate(task: Task): DateKey | null {
  if (task.due.kind === 'date') return task.due.dueAt;
  if (task.due.kind === 'datetime') return toTokyoDateKey(task.due.dueAt);
  return null;
}

function getDeadlineTime(task: Task): number {
  if (task.due.kind === 'date') {
    return parseIsoInstantMilliseconds(getDayBounds(task.due.dueAt).endExclusiveIso) - 1;
  }
  if (task.due.kind === 'datetime') return parseIsoInstantMilliseconds(task.due.dueAt);
  return Number.POSITIVE_INFINITY;
}

function compareDeadlines(left: Task, right: Task): number {
  return getDeadlineTime(left) - getDeadlineTime(right) || left.id.localeCompare(right.id);
}

/** Builds deadline lists and remaining linked-task counts for week-view presentation. */
export function buildWeekTaskPresentation(tasks: readonly Task[]): WeekTaskPresentation {
  const deadlinesByDate = new Map<DateKey, Task[]>();
  const remainingByEventId = new Map<string, number>();

  for (const task of tasks) {
    if (task.doneAt !== null) continue;

    const deadlineDate = getDeadlineDate(task);
    if (deadlineDate !== null) {
      const dateTasks = deadlinesByDate.get(deadlineDate);
      if (dateTasks) dateTasks.push(task);
      else deadlinesByDate.set(deadlineDate, [task]);
    }

    if (task.linkedEvent.state !== 'none') {
      const eventId = task.linkedEvent.eventId;
      remainingByEventId.set(eventId, (remainingByEventId.get(eventId) ?? 0) + 1);
    }
  }

  for (const dateTasks of deadlinesByDate.values()) dateTasks.sort(compareDeadlines);

  return { deadlinesByDate, remainingByEventId };
}
