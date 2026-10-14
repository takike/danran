import type { DateKey } from '@shared/schemas/date';
import type { Task } from '@shared/schemas/tasks';
import {
  differenceInCalendarDays,
  getDayBounds,
  getTodayDateKey,
  toTokyoDateKey,
  toTokyoIsoString,
  toTokyoTZDate,
} from '@shared/time/date';
import { formatShortDate, formatWeekday } from '@shared/time/format';
import { parseIsoInstantMilliseconds } from '@shared/time/interval';
import { getCalendarWeekBounds } from '@shared/time/week';

type ReadyLinkedEvent = Extract<Task['linkedEvent'], { state: 'ready' }>;
type WeekEventTime = ReadyLinkedEvent['time'];
export type EventCountdown = { kind: 'today' } | { kind: 'ended' } | { kind: 'days'; days: number };

export interface ReadyTaskGroup {
  eventId: string;
  title: string;
  time: WeekEventTime;
  memberIds: string[];
  items: string[];
  tasks: Task[];
  completedCount: number;
  totalCount: number;
  countdown: EventCountdown;
}

export interface TaskPresentation {
  today: DateKey;
  week: ReturnType<typeof getCalendarWeekBounds>;
  summary: {
    dueTodayOrEarlier: number;
    dueThisWeek: number;
    unassigned: number;
  };
  readyGroups: ReadyTaskGroup[];
  missingTasks: Task[];
  missingCompletedCount: number;
  missingTotalCount: number;
  unavailableTasks: Task[];
  unavailableCompletedCount: number;
  unavailableTotalCount: number;
  unlinkedTasks: Task[];
  completedTasks: Task[];
  mineCompletedTasks: Task[];
  orderedTasks: Task[];
  mineTasks: Task[];
}

export interface TaskDueLabel {
  label: string | null;
  urgency: 'today' | 'overdue' | null;
}

function getTaskDate(task: Pick<Task, 'due'>): DateKey | null {
  if (task.due.kind === 'date') return task.due.dueAt;
  if (task.due.kind === 'datetime') return toTokyoDateKey(task.due.dueAt);
  return null;
}

function getTaskSortValue(task: Pick<Task, 'due'>): number | null {
  if (task.due.kind === 'date')
    return parseIsoInstantMilliseconds(getDayBounds(task.due.dueAt).endExclusiveIso) - 1;
  if (task.due.kind === 'datetime') return parseIsoInstantMilliseconds(task.due.dueAt);
  return null;
}

function compareTasks(left: Task, right: Task, retainedDoneIds: ReadonlySet<string>): number {
  const leftDone = left.doneAt !== null && !retainedDoneIds.has(left.id);
  const rightDone = right.doneAt !== null && !retainedDoneIds.has(right.id);
  if (leftDone !== rightDone) return leftDone ? 1 : -1;

  const leftDue = getTaskSortValue(left);
  const rightDue = getTaskSortValue(right);
  if (leftDue === null && rightDue !== null) return 1;
  if (leftDue !== null && rightDue === null) return -1;
  if (leftDue !== null && rightDue !== null && leftDue !== rightDue) return leftDue - rightDue;
  return left.id.localeCompare(right.id);
}

function compareEventTimes(left: WeekEventTime, right: WeekEventTime): number {
  const leftStart =
    left.kind === 'all-day'
      ? toTokyoTZDate(left.start).getTime()
      : parseIsoInstantMilliseconds(left.start);
  const rightStart =
    right.kind === 'all-day'
      ? toTokyoTZDate(right.start).getTime()
      : parseIsoInstantMilliseconds(right.start);
  return leftStart - rightStart;
}

function getEventStartDate(time: WeekEventTime): DateKey {
  return time.kind === 'all-day' ? time.start : toTokyoDateKey(time.start);
}

export function getEventCountdown(time: WeekEventTime, today: DateKey): EventCountdown {
  const days = differenceInCalendarDays(getEventStartDate(time), today);
  if (days < 0) return { kind: 'ended' };
  if (days === 0) return { kind: 'today' };
  return { kind: 'days', days };
}

/** Returns the Japanese deadline text and urgency state for a task at the given instant. */
export function getTaskDueLabel(task: Pick<Task, 'due'>, now: number | Date): TaskDueLabel {
  if (task.due.kind === 'none') return { label: null, urgency: null };
  if (task.due.kind === 'unknown') {
    return { label: '期限を確認できません', urgency: null };
  }

  const today = getTodayDateKey(now);
  const dueDate = getTaskDate(task);
  if (!dueDate) return { label: null, urgency: null };
  const nowMilliseconds = typeof now === 'number' ? now : now.getTime();
  const overdue =
    dueDate < today ||
    (task.due.kind === 'datetime' && parseIsoInstantMilliseconds(task.due.dueAt) < nowMilliseconds);
  if (overdue) return { label: '期限を過ぎています', urgency: 'overdue' };
  if (dueDate === today) return { label: '今日まで', urgency: 'today' };

  const dateLabel = `${formatShortDate(dueDate)}（${formatWeekday(dueDate)}）`;
  if (task.due.kind === 'date') return { label: `${dateLabel}まで`, urgency: null };
  const clock = toTokyoIsoString(task.due.dueAt).slice(11, 16);
  return { label: `${dateLabel} ${clock} まで`, urgency: null };
}

/** Builds the S5 groups, due ordering, countdowns, and summaries without mutating API data. */
export function buildTaskPresentation(
  tasks: readonly Task[],
  input: {
    now: number | Date;
    currentMemberId: string;
    retainedDoneIds?: ReadonlySet<string>;
  },
): TaskPresentation {
  const retainedDoneIds = input.retainedDoneIds ?? new Set<string>();
  const today = getTodayDateKey(input.now);
  const week = getCalendarWeekBounds(today);
  let dueTodayOrEarlier = 0;
  let dueThisWeek = 0;
  let unassigned = 0;
  const readyByEvent = new Map<string, { event: ReadyLinkedEvent; tasks: Task[] }>();
  const missingTasks: Task[] = [];
  const unavailableTasks: Task[] = [];
  const unlinkedTasks: Task[] = [];
  const completedTasks: Task[] = [];

  for (const task of tasks) {
    if (task.doneAt !== null) {
      if (!retainedDoneIds.has(task.id)) completedTasks.push(task);
    }
    if (task.doneAt === null) {
      const dueDate = getTaskDate(task);
      if (dueDate !== null) {
        if (dueDate <= today) dueTodayOrEarlier += 1;
        if (dueDate <= week.endInclusive) dueThisWeek += 1;
      }
      if (task.assigneeMemberId === null) unassigned += 1;
    }

    const linkedEvent = task.linkedEvent;
    if (linkedEvent.state === 'ready') {
      const group = readyByEvent.get(linkedEvent.eventId);
      if (group) group.tasks.push(task);
      else readyByEvent.set(linkedEvent.eventId, { event: linkedEvent, tasks: [task] });
    } else if (linkedEvent.state === 'missing') {
      missingTasks.push(task);
    } else if (linkedEvent.state === 'unavailable') {
      unavailableTasks.push(task);
    } else {
      unlinkedTasks.push(task);
    }
  }

  const readyGroups = [...readyByEvent.entries()]
    .map(([eventId, group]) => {
      const allTasks = group.tasks;
      const visibleTasks = allTasks.filter(
        (task) => task.doneAt === null || retainedDoneIds.has(task.id),
      );
      if (visibleTasks.length === 0) return null;
      const sortedTasks = [...visibleTasks].sort((left, right) =>
        compareTasks(left, right, retainedDoneIds),
      );
      return {
        eventId,
        title: group.event.title,
        time: group.event.time,
        memberIds: group.event.memberIds,
        items: group.event.items,
        tasks: sortedTasks,
        completedCount: allTasks.filter((task) => task.doneAt !== null).length,
        totalCount: allTasks.length,
        countdown: getEventCountdown(group.event.time, today),
      };
    })
    .filter((group): group is ReadyTaskGroup => group !== null)
    .sort((left, right) => {
      const byTime = compareEventTimes(left.time, right.time);
      return byTime || left.eventId.localeCompare(right.eventId);
    });

  const visibleTasks = tasks.filter((task) => task.doneAt === null || retainedDoneIds.has(task.id));
  const orderedTasks = [...visibleTasks].sort((left, right) =>
    compareTasks(left, right, retainedDoneIds),
  );
  const sortCompleted = (left: Task, right: Task) => {
    const byDoneAt = (right.doneAt ?? 0) - (left.doneAt ?? 0);
    return byDoneAt || left.id.localeCompare(right.id);
  };
  return {
    today,
    week,
    summary: { dueTodayOrEarlier, dueThisWeek, unassigned },
    readyGroups,
    missingCompletedCount: missingTasks.filter((task) => task.doneAt !== null).length,
    missingTotalCount: missingTasks.length,
    missingTasks: missingTasks
      .filter((task) => task.doneAt === null || retainedDoneIds.has(task.id))
      .sort((left, right) => compareTasks(left, right, retainedDoneIds)),
    unavailableCompletedCount: unavailableTasks.filter((task) => task.doneAt !== null).length,
    unavailableTotalCount: unavailableTasks.length,
    unavailableTasks: unavailableTasks
      .filter((task) => task.doneAt === null || retainedDoneIds.has(task.id))
      .sort((left, right) => compareTasks(left, right, retainedDoneIds)),
    unlinkedTasks: unlinkedTasks
      .filter((task) => task.doneAt === null || retainedDoneIds.has(task.id))
      .sort((left, right) => compareTasks(left, right, retainedDoneIds)),
    completedTasks: completedTasks.sort(sortCompleted),
    mineCompletedTasks: completedTasks
      .filter((task) => task.assigneeMemberId === input.currentMemberId)
      .sort(sortCompleted),
    orderedTasks,
    mineTasks: orderedTasks.filter((task) => task.assigneeMemberId === input.currentMemberId),
  };
}
