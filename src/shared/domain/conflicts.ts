import type { WeekEvent } from '@shared/schemas/week';
import { getDayBounds } from '@shared/time';
import { parseIsoInstantMilliseconds } from '@shared/time/interval';

export interface ConflictEvent {
  id: string;
  time: WeekEvent['time'];
  memberIds: readonly string[];
  assigneeMemberId: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  isRecurring: boolean;
}

export interface RoutineConflict {
  routineInstanceId: string;
  eventId: string;
  memberIds: string[];
}

/** Finds confirmed, timed routine instances that overlap confirmed one-off family events. */
export function getRoutineConflicts(
  events: readonly ConflictEvent[],
  familyMemberIds: readonly string[],
): RoutineConflict[] {
  const activeIds = [...new Set(familyMemberIds)];
  const activeSet = new Set(activeIds);
  const uniqueEvents = [...new Map(events.map((event) => [event.id, event])).values()];
  const recurring = uniqueEvents
    .filter(
      (event) => event.isRecurring && event.status === 'confirmed' && event.time.kind === 'timed',
    )
    .map((event) => {
      if (event.time.kind !== 'timed') return null;
      const start = parseIsoInstantMilliseconds(event.time.start);
      const end = parseIsoInstantMilliseconds(event.time.endExclusive);
      if (end <= start) throw new RangeError('Routine end must follow start');
      return { event, start, end, members: involvedMembers(event, activeIds, activeSet) };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
  const standalone = uniqueEvents
    .filter((event) => !event.isRecurring && event.status === 'confirmed')
    .map((event) => ({
      event,
      interval: eventInterval(event),
      members: involvedMembers(event, activeIds, activeSet),
    }));
  const results: RoutineConflict[] = [];

  for (const routine of recurring) {
    if (routine.members.size === 0) continue;

    for (const event of standalone) {
      const [eventStart, eventEnd] = event.interval;
      if (routine.start >= eventEnd || eventStart >= routine.end) continue;
      const shared = [...event.members].filter((memberId) => routine.members.has(memberId)).sort();
      if (shared.length > 0) {
        results.push({
          routineInstanceId: routine.event.id,
          eventId: event.event.id,
          memberIds: shared,
        });
      }
    }
  }

  return results.sort(
    (left, right) =>
      left.routineInstanceId.localeCompare(right.routineInstanceId) ||
      left.eventId.localeCompare(right.eventId),
  );
}

function involvedMembers(
  event: ConflictEvent,
  activeIds: readonly string[],
  activeSet: ReadonlySet<string>,
): Set<string> {
  const members =
    event.memberIds.length === 0
      ? new Set(activeIds)
      : new Set(event.memberIds.filter((memberId) => activeSet.has(memberId)));
  if (event.assigneeMemberId && activeSet.has(event.assigneeMemberId)) {
    members.add(event.assigneeMemberId);
  }
  return members;
}

function eventInterval(event: ConflictEvent): [number, number] {
  if (event.time.kind === 'timed') {
    const start = parseIsoInstantMilliseconds(event.time.start);
    const end = parseIsoInstantMilliseconds(event.time.endExclusive);
    if (end <= start) throw new RangeError('Event end must follow start');
    return [start, end];
  }
  const start = getDayBounds(event.time.start).startIso;
  const end = getDayBounds(event.time.endExclusive).startIso;
  const startMs = parseIsoInstantMilliseconds(start);
  const endMs = parseIsoInstantMilliseconds(end);
  if (endMs <= startMs) throw new RangeError('All-day event end must follow start');
  return [startMs, endMs];
}
