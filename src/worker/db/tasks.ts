import { eventItemsSchema } from '@shared/schemas/week';
import type { Database } from '@worker/db';
import { and, eq } from 'drizzle-orm';
import { eventMeta, tasks } from './schema';

/**
 * Reconciles the automatic items task with persisted event metadata. Item presence is always read
 * from D1 so stale request payloads cannot restore an older item list. Due dates are derived from
 * the live Google event when the task list is read and are never stored in this table.
 */
export async function reconcileItemsTask(
  db: Database,
  input: { familyId: string; eventMetaId: string },
): Promise<void> {
  const metadata = await db
    .select({ itemsJson: eventMeta.itemsJson })
    .from(eventMeta)
    .where(and(eq(eventMeta.id, input.eventMetaId), eq(eventMeta.familyId, input.familyId)))
    .limit(1);
  const row = metadata[0];
  if (!row) {
    await db
      .delete(tasks)
      .where(
        and(
          eq(tasks.familyId, input.familyId),
          eq(tasks.eventMetaId, input.eventMetaId),
          eq(tasks.source, 'items'),
        ),
      );
    return;
  }

  let items: string[] = [];
  try {
    items = eventItemsSchema.parse(JSON.parse(row.itemsJson));
  } catch {
    // Malformed legacy metadata cannot justify an automatic task.
  }
  if (items.length === 0) {
    await db
      .delete(tasks)
      .where(
        and(
          eq(tasks.familyId, input.familyId),
          eq(tasks.eventMetaId, input.eventMetaId),
          eq(tasks.source, 'items'),
        ),
      );
    return;
  }

  await db
    .insert(tasks)
    .values({
      id: `task_items_${input.eventMetaId}`,
      familyId: input.familyId,
      title: '持ち物を準備',
      dueAt: null,
      dueKind: 'none',
      eventMetaId: input.eventMetaId,
      source: 'items',
      sourceRef: null,
    })
    .onConflictDoNothing();
}

/** Removes event-derived tasks, detaches surviving tasks, and deletes event metadata atomically. */
export async function detachTasksFromEventMeta(
  db: Database,
  input: { familyId: string; calendarId: string; eventId: string },
): Promise<void> {
  const matching = await db
    .select({ id: eventMeta.id })
    .from(eventMeta)
    .where(
      and(
        eq(eventMeta.familyId, input.familyId),
        eq(eventMeta.calendarId, input.calendarId),
        eq(eventMeta.eventId, input.eventId),
      ),
    )
    .limit(1);
  const eventMetaId = matching[0]?.id;
  if (!eventMetaId) return;

  await db.batch([
    db.delete(tasks).where(and(eq(tasks.eventMetaId, eventMetaId), eq(tasks.source, 'items'))),
    db
      .update(tasks)
      .set({ eventMetaId: null, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(tasks.eventMetaId, eventMetaId)),
    db
      .delete(eventMeta)
      .where(
        and(
          eq(eventMeta.id, eventMetaId),
          eq(eventMeta.familyId, input.familyId),
          eq(eventMeta.calendarId, input.calendarId),
          eq(eventMeta.eventId, input.eventId),
        ),
      ),
  ]);
}
