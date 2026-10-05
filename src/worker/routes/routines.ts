import {
  buildRoutineRecurrence,
  getFirstRoutineDate,
  parseGoogleRoutineRule,
} from '@shared/domain/routines';
import { familyIdSchema } from '@shared/schemas/family';
import type { GoogleEvent, InsertEventInput } from '@shared/schemas/google-calendar';
import {
  type RoutineInput,
  createRoutineInputSchema,
  routineCreateResponseSchema,
  routineDeleteResponseSchema,
  routineErrorResponseSchema,
  routineListResponseSchema,
} from '@shared/schemas/routines';
import { toTokyoDateKey, toTokyoIsoString } from '@shared/time';
import { type AuthConfig, getAuthConfig } from '@worker/auth/config';
import { getSessionUser } from '@worker/auth/session';
import { createDb } from '@worker/db';
import { families, members, routineSettings } from '@worker/db/schema';
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
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'FAMILY_NOT_READY'
  | 'INVALID_INPUT'
  | 'REAUTH_REQUIRED'
  | 'CALENDAR_ACCESS_DENIED'
  | 'GOOGLE_TEMPORARY_ERROR'
  | 'GOOGLE_ERROR'
  | 'INTERNAL_ERROR';
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503 | 413;

const ERROR_TEXT: Record<ErrorCode, string> = {
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Family or routine not found',
  FAMILY_NOT_READY: 'Family calendar is not ready',
  INVALID_INPUT: 'Invalid routine request',
  REAUTH_REQUIRED: 'Google re-authentication required',
  CALENDAR_ACCESS_DENIED: 'Family calendar access denied',
  GOOGLE_TEMPORARY_ERROR: 'Google Calendar is temporarily unavailable',
  GOOGLE_ERROR: 'Google Calendar request failed',
  INTERNAL_ERROR: 'Internal server error',
};

function errorResponse(c: RouteContext, status: ErrorStatus, code: ErrorCode) {
  return c.json(routineErrorResponseSchema.parse({ error: ERROR_TEXT[code], code }), status);
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
  if (err.googleStatus === 403 || err.googleStatus === 404)
    return { status: 403, code: 'CALENDAR_ACCESS_DENIED' };
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

async function deterministicId(
  namespace: string,
  familyId: string,
  userId: string,
  requestId: string,
) {
  const input = new TextEncoder().encode(
    `danran-${namespace}\u0000${familyId}\u0000${userId}\u0000${requestId}`,
  );
  return encodeBase32Hex(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
}

function privateProperties(event: GoogleEvent): Record<string, unknown> {
  const value = event.extendedProperties?.private;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function validateGoogleEventId(c: RouteContext, value: string): string | Response {
  try {
    validatePathSegment('eventId', value);
    return value;
  } catch {
    return errorResponse(c, 400, 'INVALID_INPUT');
  }
}

async function authorizeFamily(c: RouteContext) {
  const db = createDb(c.env.DB);
  const config: AuthConfig = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) return { response: errorResponse(c, 401, 'UNAUTHORIZED') } as const;
  const parsedId = familyIdSchema.safeParse(c.req.param('id'));
  if (!parsedId.success) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  const family = (await db.select().from(families).where(eq(families.id, parsedId.data)))[0];
  if (!family) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  const activeMembers = await db
    .select()
    .from(members)
    .where(and(eq(members.familyId, family.id), eq(members.status, 'active')));
  if (
    !activeMembers.some((member) => member.userId === session.user.id && member.kind === 'adult')
  ) {
    return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  }
  if (family.creationStatus !== 'ready' || !family.familyCalendarId) {
    return { response: errorResponse(c, 409, 'FAMILY_NOT_READY') } as const;
  }
  return { db, family, calendarId: family.familyCalendarId, activeMembers, session } as const;
}

function validateMembers(
  c: RouteContext,
  input: RoutineInput,
  activeMembers: (typeof members.$inferSelect)[],
) {
  const knownMembers = new Set(activeMembers.map((member) => member.id));
  if (input.memberIds.some((id) => !knownMembers.has(id)))
    return errorResponse(c, 400, 'INVALID_INPUT');
  if (input.assigneeMemberId !== null) {
    const assignee = activeMembers.find((member) => member.id === input.assigneeMemberId);
    if (!assignee || assignee.kind !== 'adult') return errorResponse(c, 400, 'INVALID_INPUT');
  }
  return null;
}

async function routineFingerprint(input: RoutineInput): Promise<string> {
  const normalized = {
    title: input.title,
    weekdays: [...new Set(input.weekdays)].sort(),
    interval: input.interval,
    startDate: input.startDate,
    startTime: input.startTime,
    endTime: input.endTime,
    endDate: input.endDate,
    memberIds: [...new Set(input.memberIds)].sort(),
    assigneeMemberId: input.assigneeMemberId,
    category: input.category,
    affectsAvailability: input.affectsAvailability,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(normalized));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function expectedRoutineMatches(
  event: GoogleEvent,
  input: RoutineInput,
  firstDate: string,
): Promise<boolean> {
  const props = privateProperties(event);
  const actualMembers = typeof props.members === 'string' ? props.members : '';
  const start = deriveDateTime(event.start);
  const end = deriveDateTime(event.end);
  const recurrence = event.recurrence ?? [];
  const parsedRule = parseGoogleRoutineRule(recurrence);
  const expectedWeekdays = [...new Set(input.weekdays)].sort();
  const actualWeekdays = parsedRule.status === 'ready' ? [...parsedRule.weekdays].sort() : [];
  const recurrenceHasUntil = recurrence.some((line) => /(?:^|;)UNTIL=/.test(line));
  const matchesEndDate =
    input.endDate === null
      ? !recurrenceHasUntil
      : recurrenceHasUntil && parseUntilDate(recurrence) === input.endDate;
  return (
    event.status !== 'cancelled' &&
    props.danran === '1' &&
    Boolean(event.recurrence?.length) &&
    event.summary === input.title &&
    start.date === firstDate &&
    start.time === input.startTime &&
    end.date === firstDate &&
    end.time === input.endTime &&
    parsedRule.status === 'ready' &&
    parsedRule.interval === input.interval &&
    actualWeekdays.join(',') === expectedWeekdays.join(',') &&
    matchesEndDate &&
    actualMembers.split(',').filter(Boolean).sort().join(',') ===
      [...new Set(input.memberIds)].sort().join(',') &&
    props.assignee === (input.assigneeMemberId ?? '') &&
    props.status === 'confirmed' &&
    props.routineRequestHash === (await routineFingerprint(input))
  );
}

function deriveDateTime(value: GoogleEvent['start']): { date: string | null; time: string | null } {
  if (!value) return { date: null, time: null };
  if (value.date) return { date: value.date, time: null };
  if (!value.dateTime) return { date: null, time: null };
  return {
    date: toTokyoDateKey(value.dateTime),
    time: toTokyoIsoString(value.dateTime).slice(11, 16),
  };
}

function parseUntilDate(recurrence: readonly string[]): string | null {
  const line = recurrence.find((item) => item.startsWith('RRULE:'));
  const match = line?.match(/(?:^|;)UNTIL=(\d{8}T\d{6}Z)(?:;|$)/);
  const value = match?.[1];
  if (!value) return null;
  try {
    return toTokyoDateKey(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
    );
  } catch {
    return null;
  }
}

function routineFromGoogle(
  row: typeof routineSettings.$inferSelect,
  event: GoogleEvent,
  activeMemberIds: ReadonlySet<string>,
) {
  const recurrence = event.recurrence ?? [];
  const parsedRule = parseGoogleRoutineRule(recurrence);
  const start = deriveDateTime(event.start);
  const end = deriveDateTime(event.end);
  const timeSupported = start.time !== null && end.time !== null && start.date === end.date;
  const props = privateProperties(event);
  const rawMemberIds =
    typeof props.members === 'string'
      ? props.members.split(',').filter((id) => id && activeMemberIds.has(id))
      : [];
  const assigneeValue =
    typeof props.assignee === 'string' && props.assignee ? props.assignee : null;
  const assignee = assigneeValue && activeMemberIds.has(assigneeValue) ? assigneeValue : null;
  return {
    id: row.id,
    title: event.summary ?? null,
    weekdays: parsedRule.status === 'ready' && timeSupported ? parsedRule.weekdays : [],
    interval: parsedRule.status === 'ready' && timeSupported ? parsedRule.interval : null,
    startDate: start.date,
    endDate: parseUntilDate(recurrence),
    startTime: start.time,
    endTime: end.time,
    memberIds: rawMemberIds,
    assigneeMemberId: assignee,
    category: row.category,
    affectsAvailability: row.affectsAvailability,
    status: parsedRule.status === 'ready' && timeSupported ? 'ready' : 'unsupported',
  };
}

export const routinesRoute = new Hono<{ Bindings: WorkerEnv }>();
routinesRoute.use('*', familySecurityMiddleware);
routinesRoute.use(
  '*',
  bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) =>
      c.json(
        routineErrorResponseSchema.parse({
          error: ERROR_TEXT.INVALID_INPUT,
          code: 'INVALID_INPUT',
        }),
        413,
      ),
  }),
);

routinesRoute.post('/:id/routines', async (c) => {
  try {
    const access = await authorizeFamily(c);
    if ('response' in access) return access.response;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_INPUT');
    }
    const parsed = createRoutineInputSchema.safeParse(body);
    if (!parsed.success) return errorResponse(c, 400, 'INVALID_INPUT');
    const input = parsed.data;
    const invalidMembers = validateMembers(c, input, access.activeMembers);
    if (invalidMembers) return invalidMembers;
    const firstDate = getFirstRoutineDate(input.startDate, input.weekdays);
    if (input.endDate !== null && input.endDate < firstDate)
      return errorResponse(c, 400, 'INVALID_INPUT');
    const eventId = await deterministicId(
      'routine',
      access.family.id,
      access.session.user.id,
      input.clientRequestId,
    );
    const client = createGoogleCalendarClient(c.env, access.session.user.id);
    const privateProperties: Record<string, string> = {
      danran: '1',
      members: [...new Set(input.memberIds)].sort().join(','),
      assignee: input.assigneeMemberId ?? '',
      status: 'confirmed',
      source: 'manual',
      routineRequestHash: await routineFingerprint(input),
    };
    const eventInput: InsertEventInput = {
      id: eventId,
      summary: input.title,
      start: { dateTime: `${firstDate}T${input.startTime}:00+09:00`, timeZone: 'Asia/Tokyo' },
      end: { dateTime: `${firstDate}T${input.endTime}:00+09:00`, timeZone: 'Asia/Tokyo' },
      recurrence: buildRoutineRecurrence(input),
      status: 'confirmed',
      extendedProperties: { private: privateProperties },
    };
    let event: GoogleEvent;
    try {
      event = await client.events.insert(access.calendarId, eventInput, { sendUpdates: 'none' });
    } catch (err) {
      if (!(err instanceof GoogleCalendarError) || err.code !== 'CONFLICT')
        return responseForGoogleFailure(c, err);
      try {
        event = await client.events.get(access.calendarId, eventId);
      } catch (getError) {
        return responseForGoogleFailure(c, getError);
      }
      if (!(await expectedRoutineMatches(event, input, firstDate)))
        return errorResponse(c, 400, 'INVALID_INPUT');
    }
    if (event.id !== eventId || !event.recurrence?.length)
      return errorResponse(c, 502, 'GOOGLE_ERROR');
    const routineId = await deterministicId(
      'routine-row',
      access.family.id,
      access.session.user.id,
      input.clientRequestId,
    );
    try {
      await access.db
        .insert(routineSettings)
        .values({
          id: routineId,
          familyId: access.family.id,
          calendarId: access.calendarId,
          recurringEventId: event.id,
          category: input.category,
          skipHolidays: false,
          skipNewYear: false,
          affectsAvailability: input.affectsAvailability,
          defaultAssigneeMemberId: input.assigneeMemberId,
        })
        .onConflictDoNothing({
          target: [routineSettings.calendarId, routineSettings.recurringEventId],
        });
    } catch {
      return errorResponse(c, 500, 'INTERNAL_ERROR');
    }
    const saved = (
      await access.db
        .select()
        .from(routineSettings)
        .where(
          and(
            eq(routineSettings.familyId, access.family.id),
            eq(routineSettings.calendarId, access.calendarId),
            eq(routineSettings.recurringEventId, event.id),
          ),
        )
    )[0];
    if (!saved) return errorResponse(c, 500, 'INTERNAL_ERROR');
    return c.json(
      routineCreateResponseSchema.parse({ routineId: saved.id, eventId: event.id }),
      200,
    );
  } catch (err) {
    return err instanceof GoogleCalendarError
      ? responseForGoogleFailure(c, err)
      : errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

routinesRoute.get('/:id/routines', async (c) => {
  try {
    const access = await authorizeFamily(c);
    if ('response' in access) return access.response;
    const rows = await access.db
      .select()
      .from(routineSettings)
      .where(
        and(
          eq(routineSettings.familyId, access.family.id),
          eq(routineSettings.calendarId, access.calendarId),
        ),
      );
    const client = createGoogleCalendarClient(c.env, access.session.user.id);
    const results = [];
    for (const row of rows) {
      try {
        const event = await client.events.get(access.calendarId, row.recurringEventId);
        if (event.status === 'cancelled') {
          results.push({
            id: row.id,
            title: null,
            weekdays: [],
            interval: null,
            startDate: null,
            endDate: null,
            startTime: null,
            endTime: null,
            memberIds: [],
            assigneeMemberId: null,
            category: row.category,
            affectsAvailability: row.affectsAvailability,
            status: 'missing' as const,
          });
          continue;
        }
        if (!event.recurrence?.length) {
          results.push({
            id: row.id,
            title: event.summary ?? null,
            weekdays: [],
            interval: null,
            startDate: deriveDateTime(event.start).date,
            endDate: null,
            startTime: deriveDateTime(event.start).time,
            endTime: deriveDateTime(event.end).time,
            memberIds: [],
            assigneeMemberId: null,
            category: row.category,
            affectsAvailability: row.affectsAvailability,
            status: 'unsupported' as const,
          });
        } else {
          results.push(
            routineFromGoogle(row, event, new Set(access.activeMembers.map((member) => member.id))),
          );
        }
      } catch (err) {
        if (!isGoogleMissing(err)) return responseForGoogleFailure(c, err);
        results.push({
          id: row.id,
          title: null,
          weekdays: [],
          interval: null,
          startDate: null,
          endDate: null,
          startTime: null,
          endTime: null,
          memberIds: [],
          assigneeMemberId: null,
          category: row.category,
          affectsAvailability: row.affectsAvailability,
          status: 'missing' as const,
        });
      }
    }
    return c.json(routineListResponseSchema.parse({ routines: results }), 200);
  } catch (err) {
    return err instanceof GoogleCalendarError
      ? responseForGoogleFailure(c, err)
      : errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

routinesRoute.delete('/:id/routines/:routineId', async (c) => {
  try {
    const access = await authorizeFamily(c);
    if ('response' in access) return access.response;
    const rawId = c.req.param('routineId');
    try {
      validatePathSegment('routineId', rawId);
    } catch {
      return errorResponse(c, 400, 'INVALID_INPUT');
    }
    const row = (
      await access.db
        .select()
        .from(routineSettings)
        .where(
          and(
            eq(routineSettings.id, rawId),
            eq(routineSettings.familyId, access.family.id),
            eq(routineSettings.calendarId, access.calendarId),
          ),
        )
    )[0];
    if (!row) return errorResponse(c, 404, 'NOT_FOUND');
    const client = createGoogleCalendarClient(c.env, access.session.user.id);
    try {
      await client.events.delete(access.calendarId, row.recurringEventId, { sendUpdates: 'none' });
    } catch (err) {
      if (!isGoogleMissing(err)) return responseForGoogleFailure(c, err);
    }
    try {
      await access.db
        .delete(routineSettings)
        .where(
          and(
            eq(routineSettings.id, row.id),
            eq(routineSettings.familyId, access.family.id),
            eq(routineSettings.calendarId, access.calendarId),
          ),
        );
    } catch {
      return errorResponse(c, 500, 'INTERNAL_ERROR');
    }
    return c.json(routineDeleteResponseSchema.parse({ ok: true }), 200);
  } catch (err) {
    return err instanceof GoogleCalendarError
      ? responseForGoogleFailure(c, err)
      : errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});
