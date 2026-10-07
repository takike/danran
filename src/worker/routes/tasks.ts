import { getItemsTaskDue } from '@shared/domain/taskGeneration';
import { familyIdSchema } from '@shared/schemas/family';
import type { GoogleEvent } from '@shared/schemas/google-calendar';
import {
  type ManualTaskCreate,
  type Task,
  type TaskPatch,
  manualTaskCreateSchema,
  taskDeleteResponseSchema,
  taskErrorResponseSchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
  taskPatchSchema,
} from '@shared/schemas/tasks';
import { type WeekEvent, eventItemsSchema, weekEventTimeSchema } from '@shared/schemas/week';
import { toTokyoIsoString } from '@shared/time/date';
import { type AuthConfig, getAuthConfig } from '@worker/auth/config';
import { getSessionUser } from '@worker/auth/session';
import { createDb } from '@worker/db';
import { eventMeta, families, members, tasks } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import {
  GoogleCalendarError,
  createGoogleCalendarClient,
  validatePathSegment,
} from '@worker/google/calendar';
import { ReauthNeededError } from '@worker/google/oauth';
import { and, asc, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { familySecurityMiddleware } from './families';

type RouteContext = Context<{ Bindings: WorkerEnv }>;
type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'FAMILY_NOT_READY'
  | 'INVALID_INPUT'
  | 'AUTO_TASK_IMMUTABLE'
  | 'RECURRING_EVENT_UNSUPPORTED'
  | 'REAUTH_REQUIRED'
  | 'CALENDAR_ACCESS_DENIED'
  | 'GOOGLE_TEMPORARY_ERROR'
  | 'GOOGLE_ERROR'
  | 'INTERNAL_ERROR';
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503 | 413;

const ERROR_TEXT: Record<ErrorCode, string> = {
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Family or task not found',
  FAMILY_NOT_READY: 'Family calendar is not ready',
  INVALID_INPUT: 'Invalid task request',
  AUTO_TASK_IMMUTABLE: 'Automatic task fields cannot be changed',
  RECURRING_EVENT_UNSUPPORTED: 'Recurring event masters cannot be linked',
  REAUTH_REQUIRED: 'Google re-authentication required',
  CALENDAR_ACCESS_DENIED: 'Family calendar access denied',
  GOOGLE_TEMPORARY_ERROR: 'Google Calendar is temporarily unavailable',
  GOOGLE_ERROR: 'Google Calendar request failed',
  INTERNAL_ERROR: 'Internal server error',
};

const MAX_LINKED_EVENTS = 200;
const EVENT_PAGE_SIZE = 2500;
const MAX_EVENT_PAGES = 4;
const DONE_WINDOW_SECONDS = 14 * 24 * 60 * 60;

function errorResponse(c: RouteContext, status: ErrorStatus, code: ErrorCode) {
  return c.json(taskErrorResponseSchema.parse({ error: ERROR_TEXT[code], code }), status);
}

function googleFailure(err: unknown): { status: ErrorStatus; code: ErrorCode } {
  if (err instanceof ReauthNeededError) return { status: 401, code: 'REAUTH_REQUIRED' };
  if (!(err instanceof GoogleCalendarError)) return { status: 502, code: 'GOOGLE_ERROR' };
  if (err.code === 'AUTH_ERROR') return { status: 401, code: 'REAUTH_REQUIRED' };
  if (err.code === 'RATE_LIMITED' || (err.googleStatus ?? err.status) >= 500) {
    return { status: 503, code: 'GOOGLE_TEMPORARY_ERROR' };
  }
  if (err.googleStatus === 403) return { status: 403, code: 'CALENDAR_ACCESS_DENIED' };
  return { status: 502, code: 'GOOGLE_ERROR' };
}

async function authorizeFamily(c: RouteContext) {
  const db = createDb(c.env.DB);
  const config: AuthConfig = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) return { response: errorResponse(c, 401, 'UNAUTHORIZED') } as const;

  const parsedId = familyIdSchema.safeParse(c.req.param('id'));
  if (!parsedId.success) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  const [family] = await db.select().from(families).where(eq(families.id, parsedId.data));
  if (!family) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  const [member] = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.familyId, family.id),
        eq(members.userId, session.user.id),
        eq(members.status, 'active'),
        eq(members.kind, 'adult'),
      ),
    );
  if (!member) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  if (family.creationStatus !== 'ready' || !family.familyCalendarId) {
    return { response: errorResponse(c, 409, 'FAMILY_NOT_READY') } as const;
  }
  const activeMembers = await db
    .select()
    .from(members)
    .where(and(eq(members.familyId, family.id), eq(members.status, 'active')));
  return { db, family, calendarId: family.familyCalendarId, activeMembers, session } as const;
}

function eventPathId(c: RouteContext, eventId: string): string | Response {
  try {
    validatePathSegment('eventId', eventId);
    return eventId;
  } catch {
    return errorResponse(c, 400, 'INVALID_INPUT');
  }
}

function taskPathId(c: RouteContext, taskId: string): string | Response {
  try {
    validatePathSegment('taskId', taskId);
    return taskId;
  } catch {
    return errorResponse(c, 400, 'INVALID_INPUT');
  }
}

function hasRecurrenceMaster(event: GoogleEvent): boolean {
  return event.recurringEventId === undefined && event.recurrence !== undefined;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deterministicTaskId(familyId: string, userId: string, requestId: string) {
  const data = new TextEncoder().encode(
    `danran-task\u0000${familyId}\u0000${userId}\u0000${requestId}`,
  );
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

function dueFields(due: ManualTaskCreate['due']) {
  return due.kind === 'none'
    ? { dueAt: null, dueKind: 'none' as const }
    : { dueAt: due.dueAt, dueKind: due.kind };
}

function safeMemberIds(event: GoogleEvent, activeMemberIds: Set<string>): string[] {
  const privateProperties = event.extendedProperties?.private;
  if (privateProperties?.danran !== '1') return [];
  const value = privateProperties?.members;
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(',').filter((id) => activeMemberIds.has(id)))];
}

function eventTime(event: GoogleEvent): WeekEvent['time'] | null {
  if (event.start?.date && event.end?.date) {
    const parsed = weekEventTimeSchema.safeParse({
      kind: 'all-day',
      start: event.start.date,
      endExclusive: event.end.date,
    });
    return parsed.success ? parsed.data : null;
  }
  if (event.start?.dateTime && event.end?.dateTime) {
    try {
      const parsed = weekEventTimeSchema.safeParse({
        kind: 'timed',
        start: toTokyoIsoString(event.start.dateTime),
        endExclusive: toTokyoIsoString(event.end.dateTime),
      });
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
  return null;
}

function mapTask(
  row: typeof tasks.$inferSelect,
  event: GoogleEvent | undefined,
  meta: typeof eventMeta.$inferSelect | undefined,
  unavailable: boolean,
  activeMemberIds: Set<string>,
): Task {
  if (!row.eventMetaId) {
    return {
      id: row.id,
      title: row.title,
      due:
        row.source === 'items'
          ? { kind: 'unknown' }
          : row.dueKind === 'none'
            ? { kind: 'none' }
            : { kind: row.dueKind, dueAt: row.dueAt ?? '' },
      doneAt: row.doneAt,
      assigneeMemberId: row.assigneeMemberId,
      source: row.source,
      linkedEvent: { state: 'none' },
    };
  }
  const linkedEvent = event?.status === 'cancelled' ? undefined : event;
  if (unavailable) {
    return {
      id: row.id,
      title: row.title,
      due:
        row.source === 'items'
          ? { kind: 'unknown' }
          : row.dueKind === 'none'
            ? { kind: 'none' }
            : { kind: row.dueKind, dueAt: row.dueAt ?? '' },
      doneAt: row.doneAt,
      assigneeMemberId: row.assigneeMemberId,
      source: row.source,
      linkedEvent: { state: 'unavailable', eventId: meta?.eventId ?? row.eventMetaId },
    };
  }
  if (!linkedEvent) {
    return {
      id: row.id,
      title: row.title,
      due:
        row.source === 'items'
          ? { kind: 'unknown' }
          : row.dueKind === 'none'
            ? { kind: 'none' }
            : { kind: row.dueKind, dueAt: row.dueAt ?? '' },
      doneAt: row.doneAt,
      assigneeMemberId: row.assigneeMemberId,
      source: row.source,
      linkedEvent: { state: 'missing', eventId: meta?.eventId ?? row.eventMetaId },
    };
  }
  const time = eventTime(linkedEvent);
  if (!time) {
    return {
      id: row.id,
      title: row.title,
      due:
        row.source === 'items'
          ? { kind: 'unknown' }
          : row.dueKind === 'none'
            ? { kind: 'none' }
            : { kind: row.dueKind, dueAt: row.dueAt ?? '' },
      doneAt: row.doneAt,
      assigneeMemberId: row.assigneeMemberId,
      source: row.source,
      linkedEvent: { state: 'unavailable', eventId: linkedEvent.id },
    };
  }
  const items = parseItems(meta?.itemsJson);
  const due =
    row.source === 'items' ? { dueKind: 'datetime' as const, dueAt: getItemsTaskDue(time) } : null;
  return {
    id: row.id,
    title: row.title,
    due: due
      ? { kind: due.dueKind, dueAt: due.dueAt }
      : row.dueKind === 'none'
        ? { kind: 'none' }
        : { kind: row.dueKind, dueAt: row.dueAt ?? '' },
    doneAt: row.doneAt,
    assigneeMemberId: row.assigneeMemberId,
    source: row.source,
    linkedEvent: {
      state: 'ready',
      eventId: linkedEvent.id,
      title: linkedEvent.summary ?? '',
      time,
      memberIds: safeMemberIds(linkedEvent, activeMemberIds),
      items,
    },
  };
}

function parseItems(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    const result = eventItemsSchema.safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

async function getTask(
  access: Awaited<ReturnType<typeof authorizeFamily>> & { response?: never },
  taskId: string,
) {
  const [task] = await access.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.familyId, access.family.id)));
  return task;
}

async function ensureEventMeta(
  access: Awaited<ReturnType<typeof authorizeFamily>> & { response?: never },
  eventId: string,
) {
  await access.db
    .insert(eventMeta)
    .values({
      id: crypto.randomUUID(),
      familyId: access.family.id,
      calendarId: access.calendarId,
      eventId,
      recurringEventId: null,
      originalStart: null,
      itemsJson: '[]',
      assigneeMemberId: null,
      status: 'confirmed',
      source: 'manual',
      importJobId: null,
    })
    .onConflictDoNothing({ target: [eventMeta.calendarId, eventMeta.eventId] });
  const [meta] = await access.db
    .select()
    .from(eventMeta)
    .where(
      and(
        eq(eventMeta.familyId, access.family.id),
        eq(eventMeta.calendarId, access.calendarId),
        eq(eventMeta.eventId, eventId),
      ),
    );
  return meta;
}

async function validateAssignee(
  c: RouteContext,
  assigneeMemberId: string | null,
  activeMembers: (typeof members.$inferSelect)[],
) {
  if (assigneeMemberId === null) return null;
  const member = activeMembers.find((candidate) => candidate.id === assigneeMemberId);
  return member?.kind === 'adult' ? null : errorResponse(c, 400, 'INVALID_INPUT');
}

async function verifyEventLink(
  c: RouteContext,
  access: Awaited<ReturnType<typeof authorizeFamily>> & { response?: never },
  eventId: string,
) {
  const validatedId = eventPathId(c, eventId);
  if (validatedId instanceof Response) return { response: validatedId } as const;
  const client = createGoogleCalendarClient(c.env, access.session.user.id);
  let event: GoogleEvent;
  try {
    event = await client.events.get(access.calendarId, eventId);
  } catch (err) {
    if (
      err instanceof GoogleCalendarError &&
      (err.googleStatus === 404 || err.googleStatus === 410 || err.code === 'NOT_FOUND')
    ) {
      return { response: errorResponse(c, 400, 'INVALID_INPUT') } as const;
    }
    const failure = googleFailure(err);
    return { response: errorResponse(c, failure.status, failure.code) } as const;
  }
  if (hasRecurrenceMaster(event)) {
    return { response: errorResponse(c, 409, 'RECURRING_EVENT_UNSUPPORTED') } as const;
  }
  if (event.status === 'cancelled')
    return { response: errorResponse(c, 400, 'INVALID_INPUT') } as const;
  return { meta: await ensureEventMeta(access, eventId), event } as const;
}

async function parsePatch(c: RouteContext): Promise<TaskPatch | null> {
  try {
    const parsed = taskPatchSchema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const tasksRoute = new Hono<{ Bindings: WorkerEnv }>();
tasksRoute.use('*', familySecurityMiddleware);
tasksRoute.use(
  '*',
  bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) =>
      c.json(
        taskErrorResponseSchema.parse({ error: ERROR_TEXT.INVALID_INPUT, code: 'INVALID_INPUT' }),
        413,
      ),
  }),
);

tasksRoute.get('/:id/tasks', async (c) => {
  const access = await authorizeFamily(c);
  if ('response' in access) return access.response;
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = await access.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.familyId, access.family.id),
          or(isNull(tasks.doneAt), gte(tasks.doneAt, now - DONE_WINDOW_SECONDS)),
        ),
      )
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
    const metaIds = [...new Set(rows.flatMap((row) => (row.eventMetaId ? [row.eventMetaId] : [])))];
    const metaRows: (typeof eventMeta.$inferSelect)[] = [];
    for (let offset = 0; offset < metaIds.length; offset += 80) {
      const chunk = metaIds.slice(offset, offset + 80);
      metaRows.push(
        ...(await access.db
          .select()
          .from(eventMeta)
          .where(
            and(
              eq(eventMeta.familyId, access.family.id),
              eq(eventMeta.calendarId, access.calendarId),
              inArray(eventMeta.id, chunk),
            ),
          )),
      );
    }
    const metadata = new Map(metaRows.map((meta) => [meta.id, meta]));
    const linked = rows.filter((row) => row.eventMetaId !== null);
    const eventIds = [
      ...new Set(
        linked.flatMap((row) => {
          const meta = metadata.get(row.eventMetaId ?? '');
          return meta ? [meta.eventId] : [];
        }),
      ),
    ];
    const eventsById = new Map<string, GoogleEvent>();
    let lookupUnavailable = false;
    if (eventIds.length > 0) {
      if (eventIds.length > MAX_LINKED_EVENTS) {
        lookupUnavailable = true;
      } else {
        try {
          const client = createGoogleCalendarClient(c.env, access.session.user.id);
          const seenTokens = new Set<string>();
          let pageToken: string | undefined;
          let complete = false;
          for (let pageNo = 0; pageNo < MAX_EVENT_PAGES; pageNo += 1) {
            const page = await client.events.list(access.calendarId, {
              singleEvents: true,
              showDeleted: false,
              maxResults: EVENT_PAGE_SIZE,
              pageToken,
              timeZone: 'Asia/Tokyo',
            });
            for (const event of page.items) {
              if (event.status !== 'cancelled' && eventIds.includes(event.id))
                eventsById.set(event.id, event);
            }
            if (eventIds.every((id) => eventsById.has(id))) {
              complete = true;
              break;
            }
            if (page.nextPageToken === undefined) {
              complete = true;
              break;
            }
            if (!page.nextPageToken.trim() || seenTokens.has(page.nextPageToken)) break;
            seenTokens.add(page.nextPageToken);
            if (pageNo === MAX_EVENT_PAGES - 1) break;
            pageToken = page.nextPageToken;
          }
          if (!complete) lookupUnavailable = true;
        } catch {
          lookupUnavailable = true;
        }
      }
    }
    const activeMemberIds = new Set(access.activeMembers.map((member) => member.id));
    return c.json(
      taskListResponseSchema.parse({
        tasks: rows.map((row) => {
          const meta = row.eventMetaId ? metadata.get(row.eventMetaId) : undefined;
          return mapTask(
            row,
            meta ? eventsById.get(meta.eventId) : undefined,
            meta,
            lookupUnavailable,
            activeMemberIds,
          );
        }),
      }),
    );
  } catch {
    return errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

tasksRoute.post('/:id/tasks', async (c) => {
  const access = await authorizeFamily(c);
  if ('response' in access) return access.response;
  let input: ManualTaskCreate;
  try {
    const parsed = manualTaskCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return errorResponse(c, 400, 'INVALID_INPUT');
    input = parsed.data;
  } catch {
    return errorResponse(c, 400, 'INVALID_INPUT');
  }
  const invalidAssignee = await validateAssignee(c, input.assigneeMemberId, access.activeMembers);
  if (invalidAssignee) return invalidAssignee;
  try {
    const id = await deterministicTaskId(
      access.family.id,
      access.session.user.id,
      input.clientRequestId,
    );
    const [existing] = await access.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.familyId, access.family.id)));
    if (existing) {
      const eventMetaRows = existing.eventMetaId
        ? await access.db.select().from(eventMeta).where(eq(eventMeta.id, existing.eventMetaId))
        : [];
      const existingMeta = eventMetaRows[0];
      let googleEvent: GoogleEvent | undefined;
      if (existingMeta) {
        try {
          googleEvent = await createGoogleCalendarClient(c.env, access.session.user.id).events.get(
            access.calendarId,
            existingMeta.eventId,
          );
        } catch {
          /* represented as unavailable */
        }
      }
      return c.json(
        taskMutationResponseSchema.parse({
          task: mapTask(
            existing,
            googleEvent,
            existingMeta,
            Boolean(existing.eventMetaId && !googleEvent),
            new Set(access.activeMembers.map((m) => m.id)),
          ),
        }),
        200,
      );
    }
    let linkedMeta: typeof eventMeta.$inferSelect | undefined;
    let linkedGoogleEvent: GoogleEvent | undefined;
    if (input.eventId) {
      const checked = await verifyEventLink(c, access, input.eventId);
      if ('response' in checked) return checked.response;
      linkedMeta = checked.meta;
      linkedGoogleEvent = checked.event;
    }
    const now = Math.floor(Date.now() / 1000);
    const result = await access.db
      .insert(tasks)
      .values({
        id,
        familyId: access.family.id,
        title: input.title,
        ...dueFields(input.due),
        doneAt: null,
        assigneeMemberId: input.assigneeMemberId,
        eventMetaId: linkedMeta?.id ?? null,
        source: 'manual',
        sourceRef: `${access.session.user.id}:${input.clientRequestId}`,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const created =
      result[0] ??
      (
        await access.db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, id), eq(tasks.familyId, access.family.id)))
      )[0];
    if (!created) return errorResponse(c, 500, 'INTERNAL_ERROR');
    return c.json(
      taskMutationResponseSchema.parse({
        task: mapTask(
          created,
          linkedGoogleEvent,
          linkedMeta,
          Boolean(linkedMeta && !linkedGoogleEvent),
          new Set(access.activeMembers.map((m) => m.id)),
        ),
      }),
      201,
    );
  } catch (err) {
    if (err instanceof GoogleCalendarError) {
      const failure = googleFailure(err);
      return errorResponse(c, failure.status, failure.code);
    }
    return errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

tasksRoute.patch('/:id/tasks/:taskId', async (c) => {
  const access = await authorizeFamily(c);
  if ('response' in access) return access.response;
  const taskId = taskPathId(c, c.req.param('taskId'));
  if (taskId instanceof Response) return taskId;
  const patch = await parsePatch(c);
  if (!patch) return errorResponse(c, 400, 'INVALID_INPUT');
  const invalidAssignee = await validateAssignee(
    c,
    patch.assigneeMemberId ?? null,
    access.activeMembers,
  );
  if (invalidAssignee) return invalidAssignee;
  try {
    const current = await getTask(access, taskId);
    if (!current) return errorResponse(c, 404, 'NOT_FOUND');
    if (
      current.source !== 'manual' &&
      (patch.title !== undefined || patch.due !== undefined || patch.eventId !== undefined)
    ) {
      return errorResponse(c, 409, 'AUTO_TASK_IMMUTABLE');
    }
    let linkedMetaId = current.eventMetaId;
    if (patch.eventId !== undefined) {
      if (patch.eventId === null) linkedMetaId = null;
      else {
        const checked = await verifyEventLink(c, access, patch.eventId);
        if ('response' in checked) return checked.response;
        linkedMetaId = checked.meta?.id ?? null;
      }
    }
    const update: Partial<typeof tasks.$inferInsert> = { updatedAt: Math.floor(Date.now() / 1000) };
    if (patch.title !== undefined) update.title = patch.title;
    if (patch.due !== undefined) Object.assign(update, dueFields(patch.due));
    if (patch.assigneeMemberId !== undefined) update.assigneeMemberId = patch.assigneeMemberId;
    if (patch.eventId !== undefined) update.eventMetaId = linkedMetaId;
    if (patch.done === true && current.doneAt === null)
      update.doneAt = Math.floor(Date.now() / 1000);
    if (patch.done === false && current.doneAt !== null) update.doneAt = null;
    await access.db
      .update(tasks)
      .set(update)
      .where(and(eq(tasks.id, taskId), eq(tasks.familyId, access.family.id)));
    const updated = await getTask(access, taskId);
    if (!updated) return errorResponse(c, 404, 'NOT_FOUND');
    const metaRows = updated.eventMetaId
      ? await access.db.select().from(eventMeta).where(eq(eventMeta.id, updated.eventMetaId))
      : [];
    let event: GoogleEvent | undefined;
    if (metaRows[0]) {
      try {
        event = await createGoogleCalendarClient(c.env, access.session.user.id).events.get(
          access.calendarId,
          metaRows[0].eventId,
        );
      } catch {
        /* represented as unavailable */
      }
    }
    return c.json(
      taskMutationResponseSchema.parse({
        task: mapTask(
          updated,
          event,
          metaRows[0],
          Boolean(updated.eventMetaId && !event),
          new Set(access.activeMembers.map((m) => m.id)),
        ),
      }),
    );
  } catch (err) {
    if (err instanceof GoogleCalendarError) {
      const failure = googleFailure(err);
      return errorResponse(c, failure.status, failure.code);
    }
    return errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

tasksRoute.delete('/:id/tasks/:taskId', async (c) => {
  const access = await authorizeFamily(c);
  if ('response' in access) return access.response;
  const taskId = taskPathId(c, c.req.param('taskId'));
  if (taskId instanceof Response) return taskId;
  try {
    const current = await getTask(access, taskId);
    if (!current) return errorResponse(c, 404, 'NOT_FOUND');
    if (current.source !== 'manual') return errorResponse(c, 409, 'AUTO_TASK_IMMUTABLE');
    await access.db
      .delete(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.familyId, access.family.id)));
    return c.json(taskDeleteResponseSchema.parse({ ok: true }));
  } catch {
    return errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});
