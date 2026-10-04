import { buildDanranPrivateProperties, toGoogleEventTimes } from '@shared/domain/eventMetadata';
import {
  type EventInput,
  createEventInputSchema,
  eventDeleteResponseSchema,
  eventErrorResponseSchema,
  eventInputSchema,
  eventMutationResponseSchema,
} from '@shared/schemas/events';
import { familyIdSchema } from '@shared/schemas/family';
import type { GoogleEvent } from '@shared/schemas/google-calendar';
import { type AuthConfig, getAuthConfig } from '@worker/auth/config';
import { getSessionUser } from '@worker/auth/session';
import { createDb } from '@worker/db';
import { eventMeta, families, members } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import {
  GoogleCalendarError,
  createGoogleCalendarClient,
  validatePathSegment,
} from '@worker/google/calendar';
import { ReauthNeededError } from '@worker/google/oauth';
import { and, eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { familySecurityMiddleware } from './families';

type RouteContext = Context<{ Bindings: WorkerEnv }>;
type ErrorCode =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'FAMILY_NOT_READY'
  | 'INVALID_INPUT'
  | 'RECURRING_EVENT_UNSUPPORTED'
  | 'REAUTH_REQUIRED'
  | 'CALENDAR_ACCESS_DENIED'
  | 'GOOGLE_TEMPORARY_ERROR'
  | 'GOOGLE_ERROR'
  | 'INTERNAL_ERROR';
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503 | 413;

const ERROR_TEXT: Record<ErrorCode, string> = {
  UNAUTHORIZED: 'Unauthorized',
  NOT_FOUND: 'Family or event not found',
  FAMILY_NOT_READY: 'Family calendar is not ready',
  INVALID_INPUT: 'Invalid event request',
  RECURRING_EVENT_UNSUPPORTED: 'Recurring event changes are not supported',
  REAUTH_REQUIRED: 'Google re-authentication required',
  CALENDAR_ACCESS_DENIED: 'Family calendar access denied',
  GOOGLE_TEMPORARY_ERROR: 'Google Calendar is temporarily unavailable',
  GOOGLE_ERROR: 'Google Calendar request failed',
  INTERNAL_ERROR: 'Internal server error',
};

function errorResponse(c: RouteContext, status: ErrorStatus, code: ErrorCode) {
  return c.json(eventErrorResponseSchema.parse({ error: ERROR_TEXT[code], code }), status);
}

function googleFailure(err: unknown): { status: ErrorStatus; code: ErrorCode } {
  if (err instanceof ReauthNeededError) return { status: 401, code: 'REAUTH_REQUIRED' };
  if (!(err instanceof GoogleCalendarError)) return { status: 502, code: 'GOOGLE_ERROR' };
  if (err.code === 'AUTH_ERROR') return { status: 401, code: 'REAUTH_REQUIRED' };
  if (
    err.code === 'RATE_LIMITED' ||
    (err.code === 'API_ERROR' && (err.googleStatus ?? err.status) >= 500)
  ) {
    return { status: 503, code: 'GOOGLE_TEMPORARY_ERROR' };
  }
  if (err.googleStatus === 403 || err.googleStatus === 404) {
    return { status: 403, code: 'CALENDAR_ACCESS_DENIED' };
  }
  return { status: 502, code: 'GOOGLE_ERROR' };
}

function responseForGoogleFailure(c: RouteContext, err: unknown) {
  const failure = googleFailure(err);
  return errorResponse(c, failure.status, failure.code);
}

function isGoogleMissing(err: unknown): boolean {
  return (
    err instanceof GoogleCalendarError &&
    (err.googleStatus === 404 || err.googleStatus === 410 || err.code === 'NOT_FOUND')
  );
}

function encodeBase32Hex(data: Uint8Array): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuv';
  let result = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}

async function makeDeterministicEventId(familyId: string, userId: string, requestId: string) {
  const bytes = new TextEncoder().encode(
    `danran-event\u0000${familyId}\u0000${userId}\u0000${requestId}`,
  );
  return encodeBase32Hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function googleTime(time: EventInput['time']) {
  const value = toGoogleEventTimes(time);
  return {
    start: value.start,
    end: value.end,
  };
}

function stringProperties(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

async function authorizeFamily(c: RouteContext) {
  const db = createDb(c.env.DB);
  const config: AuthConfig = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) return { response: errorResponse(c, 401, 'UNAUTHORIZED') } as const;

  const parsedId = familyIdSchema.safeParse(c.req.param('id'));
  if (!parsedId.success) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  const familyRows = await db.select().from(families).where(eq(families.id, parsedId.data));
  const family = familyRows[0];
  if (!family) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  const activeMembers = await db
    .select()
    .from(members)
    .where(and(eq(members.familyId, family.id), eq(members.status, 'active')));
  if (!activeMembers.some((member) => member.userId === session.user.id)) {
    return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  }
  if (family.creationStatus !== 'ready' || !family.familyCalendarId) {
    return { response: errorResponse(c, 409, 'FAMILY_NOT_READY') } as const;
  }
  return { db, family, calendarId: family.familyCalendarId, activeMembers, session } as const;
}

function validateEventId(c: RouteContext, eventId: string): string | Response {
  try {
    validatePathSegment('eventId', eventId);
    return eventId;
  } catch {
    return errorResponse(c, 400, 'INVALID_INPUT');
  }
}

function validateMembers(
  c: RouteContext,
  input: EventInput,
  activeMembers: (typeof members.$inferSelect)[],
) {
  const memberIds = new Set(activeMembers.map((member) => member.id));
  if (input.memberIds.some((id) => !memberIds.has(id)))
    return errorResponse(c, 400, 'INVALID_INPUT');
  if (input.assigneeMemberId !== null) {
    const assignee = activeMembers.find((member) => member.id === input.assigneeMemberId);
    if (!assignee || assignee.kind !== 'adult') return errorResponse(c, 400, 'INVALID_INPUT');
  }
  if ([...new Set(input.memberIds)].join(',').length > 1024)
    return errorResponse(c, 400, 'INVALID_INPUT');
  return null;
}

async function saveMetadata(
  db: ReturnType<typeof createDb>,
  familyId: string,
  calendarId: string,
  eventId: string,
  input: EventInput,
  conflictBehavior: 'update' | 'ignore' = 'update',
) {
  const insert = db.insert(eventMeta).values({
    id: crypto.randomUUID(),
    familyId,
    calendarId,
    eventId,
    recurringEventId: null,
    originalStart: null,
    itemsJson: JSON.stringify(input.items),
    assigneeMemberId: input.assigneeMemberId,
    status: input.status,
    source: 'manual',
    importJobId: null,
  });
  if (conflictBehavior === 'ignore') {
    await insert.onConflictDoNothing({ target: [eventMeta.calendarId, eventMeta.eventId] });
  } else {
    await insert.onConflictDoUpdate({
      target: [eventMeta.calendarId, eventMeta.eventId],
      set: {
        familyId,
        itemsJson: JSON.stringify(input.items),
        assigneeMemberId: input.assigneeMemberId,
        status: input.status,
        source: 'manual',
        updatedAt: Math.floor(Date.now() / 1000),
      },
    });
  }
}

function hasRecurrence(event: GoogleEvent): boolean {
  return event.recurringEventId !== undefined || event.recurrence !== undefined;
}

async function parseBody(c: RouteContext): Promise<EventInput | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  const parsed = eventInputSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export const eventsRoute = new Hono<{ Bindings: WorkerEnv }>();
eventsRoute.use('*', familySecurityMiddleware);
eventsRoute.use(
  '*',
  bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) =>
      c.json(
        eventErrorResponseSchema.parse({ error: ERROR_TEXT.INVALID_INPUT, code: 'INVALID_INPUT' }),
        413,
      ),
  }),
);

eventsRoute.post('/:id/events', async (c) => {
  try {
    const access = await authorizeFamily(c);
    if ('response' in access) return access.response;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_INPUT');
    }
    const parsed = createEventInputSchema.safeParse(body);
    if (!parsed.success) return errorResponse(c, 400, 'INVALID_INPUT');
    const input = parsed.data;
    const invalidMembers = validateMembers(c, input, access.activeMembers);
    if (invalidMembers) return invalidMembers;

    const eventId = await makeDeterministicEventId(
      access.family.id,
      access.session.user.id,
      input.clientRequestId,
    );
    const client = createGoogleCalendarClient(c.env, access.session.user.id);
    let event: GoogleEvent;
    const properties = buildDanranPrivateProperties(input);
    try {
      event = await client.events.insert(
        access.calendarId,
        {
          id: eventId,
          summary: input.title,
          ...googleTime(input.time),
          status: input.status,
          extendedProperties: { private: properties },
        },
        { sendUpdates: 'none' },
      );
    } catch (err) {
      if (!(err instanceof GoogleCalendarError) || err.code !== 'CONFLICT') {
        return responseForGoogleFailure(c, err);
      }
      try {
        event = await client.events.get(access.calendarId, eventId);
      } catch (getError) {
        return responseForGoogleFailure(c, getError);
      }
    }
    try {
      await saveMetadata(access.db, access.family.id, access.calendarId, event.id, input, 'ignore');
    } catch {
      return errorResponse(c, 500, 'INTERNAL_ERROR');
    }
    return c.json(eventMutationResponseSchema.parse({ eventId: event.id }), 200);
  } catch (err) {
    return err instanceof GoogleCalendarError
      ? responseForGoogleFailure(c, err)
      : errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

eventsRoute.patch('/:id/events/:eventId', async (c) => {
  try {
    const access = await authorizeFamily(c);
    if ('response' in access) return access.response;
    const rawEventId = c.req.param('eventId');
    const parsedEventId = validateEventId(c, rawEventId);
    if (parsedEventId instanceof Response) return parsedEventId;
    const input = await parseBody(c);
    if (!input) return errorResponse(c, 400, 'INVALID_INPUT');
    const invalidMembers = validateMembers(c, input, access.activeMembers);
    if (invalidMembers) return invalidMembers;

    const client = createGoogleCalendarClient(c.env, access.session.user.id);
    let existing: GoogleEvent;
    try {
      existing = await client.events.get(access.calendarId, parsedEventId);
    } catch (err) {
      return isGoogleMissing(err)
        ? errorResponse(c, 404, 'NOT_FOUND')
        : responseForGoogleFailure(c, err);
    }
    if (hasRecurrence(existing)) return errorResponse(c, 409, 'RECURRING_EVENT_UNSUPPORTED');

    const oldProperties = existing.extendedProperties;
    const mergedPrivate = {
      ...stringProperties(oldProperties?.private),
      ...buildDanranPrivateProperties(input),
    };
    const shared = stringProperties(oldProperties?.shared);
    const patch = {
      summary: input.title,
      ...googleTime(input.time),
      status: input.status,
      extendedProperties: {
        private: mergedPrivate,
        ...(Object.keys(shared).length ? { shared } : {}),
      },
    };
    let updated: GoogleEvent;
    try {
      updated = await client.events.patch(access.calendarId, parsedEventId, patch, {
        sendUpdates: 'none',
      });
    } catch (err) {
      return isGoogleMissing(err)
        ? errorResponse(c, 404, 'NOT_FOUND')
        : responseForGoogleFailure(c, err);
    }
    try {
      await saveMetadata(access.db, access.family.id, access.calendarId, updated.id, input);
    } catch {
      return errorResponse(c, 500, 'INTERNAL_ERROR');
    }
    return c.json(eventMutationResponseSchema.parse({ eventId: updated.id }), 200);
  } catch (err) {
    return err instanceof GoogleCalendarError
      ? responseForGoogleFailure(c, err)
      : errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

eventsRoute.delete('/:id/events/:eventId', async (c) => {
  try {
    const access = await authorizeFamily(c);
    if ('response' in access) return access.response;
    const rawEventId = c.req.param('eventId');
    const eventId = validateEventId(c, rawEventId);
    if (eventId instanceof Response) return eventId;
    const client = createGoogleCalendarClient(c.env, access.session.user.id);
    try {
      const existing = await client.events.get(access.calendarId, eventId);
      if (hasRecurrence(existing)) return errorResponse(c, 409, 'RECURRING_EVENT_UNSUPPORTED');
    } catch (err) {
      if (!isGoogleMissing(err)) return responseForGoogleFailure(c, err);
    }
    try {
      await client.events.delete(access.calendarId, eventId, { sendUpdates: 'none' });
    } catch (err) {
      if (!isGoogleMissing(err)) return responseForGoogleFailure(c, err);
    }
    try {
      await access.db
        .delete(eventMeta)
        .where(
          and(
            eq(eventMeta.familyId, access.family.id),
            eq(eventMeta.calendarId, access.calendarId),
            eq(eventMeta.eventId, eventId),
          ),
        );
    } catch {
      return errorResponse(c, 500, 'INTERNAL_ERROR');
    }
    return c.json(eventDeleteResponseSchema.parse({ ok: true }), 200);
  } catch (err) {
    return err instanceof GoogleCalendarError
      ? responseForGoogleFailure(c, err)
      : errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});
