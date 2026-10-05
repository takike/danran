import { familyIdSchema } from '@shared/schemas/family';
import type {
  GooglePersonalCalendarListEntry,
  GooglePersonalEvent,
} from '@shared/schemas/google-calendar';
import {
  personalCalendarListResponseSchema,
  personalEventsErrorResponseSchema,
  personalWeekResponseSchema,
  updatePersonalCalendarsInputSchema,
  updatePersonalCalendarsResponseSchema,
} from '@shared/schemas/personal';
import { weekQuerySchema } from '@shared/schemas/week';
import { getTodayDateKey, getWeekRange, toTokyoIsoString } from '@shared/time';
import { PERSONAL_EVENTS_SCOPE, getAuthConfig } from '@worker/auth/config';
import { initiateOAuthFlow } from '@worker/auth/oauth';
import { getSessionUser } from '@worker/auth/session';
import { createDb } from '@worker/db';
import { families, googleTokens, memberCalendars, members } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { GoogleCalendarError, createGoogleCalendarClient } from '@worker/google/calendar';
import { ReauthNeededError } from '@worker/google/oauth';
import { and, eq, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { familySecurityMiddleware } from './families';

const PAGE_SIZE = 250;
const MAX_PAGES = 10;
const MAX_SELECTED_CALENDARS = 10;

type RouteContext = Context<{ Bindings: WorkerEnv }>;
type RouteErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'REAUTH_REQUIRED'
  | 'CALENDAR_ACCESS_DENIED'
  | 'GOOGLE_TEMPORARY_ERROR'
  | 'GOOGLE_ERROR'
  | 'INTERNAL_ERROR'
  | 'CALENDAR_PAGE_LIMIT';
type RouteStatus = 400 | 401 | 403 | 404 | 413 | 500 | 502 | 503;

const ERROR_MESSAGES: Record<RouteErrorCode, string> = {
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Family not found',
  INVALID_INPUT: 'Invalid personal calendar request',
  REAUTH_REQUIRED: 'Google re-authentication required',
  CALENDAR_ACCESS_DENIED: 'Personal calendar access denied',
  GOOGLE_TEMPORARY_ERROR: 'Google Calendar is temporarily unavailable',
  GOOGLE_ERROR: 'Google Calendar request failed',
  INTERNAL_ERROR: 'Internal server error',
  CALENDAR_PAGE_LIMIT: 'Google Calendar returned too many pages',
};

const bodyLimit16KiB = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) =>
    c.json(
      personalEventsErrorResponseSchema.parse({
        error: 'Payload Too Large',
        code: 'INVALID_INPUT',
      }),
      413,
    ),
});

export const personalRoute = new Hono<{ Bindings: WorkerEnv }>();
personalRoute.use('*', familySecurityMiddleware);
personalRoute.onError((_err, c) => errorResponse(c, 500, 'INTERNAL_ERROR'));

function errorResponse(c: RouteContext, status: RouteStatus, code: RouteErrorCode) {
  return c.json(
    personalEventsErrorResponseSchema.parse({ error: ERROR_MESSAGES[code], code }),
    status,
  );
}

async function authorizePersonalMember(c: RouteContext) {
  const db = createDb(c.env.DB);
  const config = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) return { response: errorResponse(c, 401, 'UNAUTHORIZED') } as const;

  const parsedFamilyId = familyIdSchema.safeParse(c.req.param('id'));
  if (!parsedFamilyId.success) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  const familyRows = await db.select().from(families).where(eq(families.id, parsedFamilyId.data));
  const family = familyRows[0];
  if (!family) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;

  const memberRows = await db
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
  const member = memberRows[0];
  if (!member) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;

  const tokenRows = await db
    .select()
    .from(googleTokens)
    .where(eq(googleTokens.userId, session.user.id));
  const token = tokenRows[0];
  const scopes = new Set((token?.scopes ?? '').split(/\s+/).filter(Boolean));
  return { db, config, session, family, member, scopes } as const;
}

function pageLimitError(): GoogleCalendarError {
  return new GoogleCalendarError({
    message: 'Google Calendar pagination limit exceeded',
    code: 'INVALID_RESPONSE',
    status: 502,
  });
}

function pageTokenIsInvalid(value: string): boolean {
  return value.trim().length === 0;
}

async function fetchCalendarList(client: ReturnType<typeof createGoogleCalendarClient>) {
  const entries: GooglePersonalCalendarListEntry[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.calendarList.listPersonal({
      maxResults: PAGE_SIZE,
      pageToken,
      showDeleted: false,
      showHidden: false,
    });
    entries.push(...result.items);
    const next = result.nextPageToken;
    if (next === undefined) return entries;
    if (pageTokenIsInvalid(next) || seenTokens.has(next) || page === MAX_PAGES - 1) {
      throw pageLimitError();
    }
    seenTokens.add(next);
    pageToken = next;
  }
  throw pageLimitError();
}

async function fetchPersonalEvents(
  client: ReturnType<typeof createGoogleCalendarClient>,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<GooglePersonalEvent[]> {
  const items: GooglePersonalEvent[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.events.listPersonal(calendarId, {
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      showDeleted: false,
      maxResults: 2500,
      pageToken,
      timeZone: 'Asia/Tokyo',
    });
    items.push(...result.items);
    const next = result.nextPageToken;
    if (next === undefined) return items;
    if (pageTokenIsInvalid(next) || seenTokens.has(next) || page === MAX_PAGES - 1) {
      throw pageLimitError();
    }
    seenTokens.add(next);
    pageToken = next;
  }
  throw pageLimitError();
}

function makeCalendarList(
  entries: GooglePersonalCalendarListEntry[],
  familyCalendarId: string | null,
  savedRows: Array<typeof memberCalendars.$inferSelect>,
) {
  const savedSelection = new Map(savedRows.map((row) => [row.calendarId, row.displayEnabled]));
  return entries
    .filter((entry) => entry.id !== familyCalendarId)
    .map((entry) => ({
      id: entry.id,
      name: entry.summary?.trim() || '（名前のないカレンダー）',
      isPrimary: entry.primary === true,
      selected: savedSelection.get(entry.id) === true,
    }));
}

function getRouteError(err: unknown): { status: RouteStatus; code: RouteErrorCode } {
  if (err instanceof ReauthNeededError) return { status: 401, code: 'REAUTH_REQUIRED' };
  if (!(err instanceof GoogleCalendarError)) return { status: 500, code: 'INTERNAL_ERROR' };
  if (err.code === 'AUTH_ERROR') return { status: 401, code: 'REAUTH_REQUIRED' };
  if (err.code === 'RATE_LIMITED' || (err.code === 'API_ERROR' && err.status >= 500)) {
    return { status: 503, code: 'GOOGLE_TEMPORARY_ERROR' };
  }
  if (err.googleStatus === 403 || err.googleStatus === 404) {
    return { status: 403, code: 'CALENDAR_ACCESS_DENIED' };
  }
  if (err.code === 'INVALID_RESPONSE' && err.message.includes('pagination limit')) {
    return { status: 502, code: 'CALENDAR_PAGE_LIMIT' };
  }
  return { status: 502, code: 'GOOGLE_ERROR' };
}

function responseForGoogleFailure(c: RouteContext, err: unknown) {
  const failure = getRouteError(err);
  return errorResponse(c, failure.status, failure.code);
}

async function googleCalendarsFor(
  c: RouteContext,
  auth: Awaited<ReturnType<typeof authorizePersonalMember>> & { db: ReturnType<typeof createDb> },
) {
  const client = createGoogleCalendarClient(c.env, auth.session.user.id);
  const [entries, savedRows] = await Promise.all([
    fetchCalendarList(client),
    auth.db.select().from(memberCalendars).where(eq(memberCalendars.memberId, auth.member.id)),
  ]);
  return {
    calendars: makeCalendarList(entries, auth.family.familyCalendarId, savedRows),
    hasSavedSelection: savedRows.some((row) => row.displayEnabled),
  };
}

personalRoute.get('/:id/personal-calendars', async (c) => {
  const auth = await authorizePersonalMember(c);
  if ('response' in auth) return auth.response;
  if (!auth.scopes.has(PERSONAL_EVENTS_SCOPE)) {
    return c.json(
      personalCalendarListResponseSchema.parse({
        status: 'authorization_required',
        memberId: auth.member.id,
        calendars: [],
      }),
      200,
    );
  }
  try {
    const { calendars, hasSavedSelection } = await googleCalendarsFor(c, auth);
    return c.json(
      personalCalendarListResponseSchema.parse({
        status: 'ready',
        memberId: auth.member.id,
        hasSavedSelection,
        calendars,
      }),
      200,
    );
  } catch (err) {
    return responseForGoogleFailure(c, err);
  }
});

personalRoute.put('/:id/personal-calendars', bodyLimit16KiB, async (c) => {
  const auth = await authorizePersonalMember(c);
  if ('response' in auth) return auth.response;
  const parsed = updatePersonalCalendarsInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return errorResponse(c, 400, 'INVALID_INPUT');

  if (!auth.scopes.has(PERSONAL_EVENTS_SCOPE)) {
    try {
      const { authUrl } = await initiateOAuthFlow(c, auth.db, auth.config, {
        purpose: 'personal-events',
        userId: auth.session.user.id,
        sessionId: auth.session.sessionId,
        familyId: auth.family.id,
        memberId: auth.member.id,
        loginHint: auth.session.user.googleSub,
      });
      return c.json(
        updatePersonalCalendarsResponseSchema.parse({
          authorizationRequired: true,
          authorizationUrl: authUrl,
        }),
        200,
      );
    } catch {
      return errorResponse(c, 500, 'INTERNAL_ERROR');
    }
  }

  try {
    const client = createGoogleCalendarClient(c.env, auth.session.user.id);
    const entries = await fetchCalendarList(client);
    const eligible = entries.filter((entry) => entry.id !== auth.family.familyCalendarId);
    const requestedIds = new Set(parsed.data.calendarIds);
    const eligibleIds = new Set(eligible.map((entry) => entry.id));
    if ([...requestedIds].some((id) => !eligibleIds.has(id))) {
      return errorResponse(c, 400, 'INVALID_INPUT');
    }

    const sessionId = auth.session.sessionId;
    const userId = auth.session.user.id;
    const memberId = auth.member.id;
    const familyId = auth.family.id;
    const writeGuard = sql`EXISTS (
      SELECT 1 FROM sessions WHERE id = ${sessionId} AND user_id = ${userId} AND expires_at > unixepoch()
    ) AND EXISTS (
      SELECT 1 FROM members WHERE id = ${memberId} AND family_id = ${familyId}
        AND user_id = ${userId} AND kind = 'adult' AND status = 'active'
    ) AND EXISTS (
      SELECT 1 FROM families WHERE id = ${familyId}
    )`;
    const deleteStatement = auth.db
      .delete(memberCalendars)
      .where(and(eq(memberCalendars.memberId, memberId), writeGuard));
    const selectedEntries = eligible.filter((entry) => requestedIds.has(entry.id));
    const selectedRowQueries = selectedEntries.map((entry, index) =>
      index === 0
        ? sql`SELECT ${memberId}, ${entry.id}, 1`
        : sql`UNION ALL SELECT ${memberId}, ${entry.id}, 1`,
    );
    const insertStatements =
      selectedEntries.length === 0
        ? []
        : [
            auth.db
              .insert(memberCalendars)
              .select(
                sql`SELECT * FROM (${sql.join(selectedRowQueries, sql` `)}) AS incoming WHERE (${writeGuard})`,
              ),
          ];

    const currentSession = await getSessionUser(c, auth.db, auth.config.sessionSecret);
    if (
      !currentSession ||
      currentSession.sessionId !== sessionId ||
      currentSession.user.id !== userId
    ) {
      return errorResponse(c, 401, 'UNAUTHORIZED');
    }
    const activeMembers = await auth.db
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          eq(members.id, memberId),
          eq(members.familyId, familyId),
          eq(members.userId, userId),
          eq(members.kind, 'adult'),
          eq(members.status, 'active'),
        ),
      );
    if (!activeMembers[0]) return errorResponse(c, 404, 'NOT_FOUND');
    const batchStatements = [deleteStatement, ...insertStatements];
    await auth.db.batch(
      batchStatements as [(typeof batchStatements)[number], ...typeof batchStatements],
    );
    const sessionAfterWrite = await getSessionUser(c, auth.db, auth.config.sessionSecret);
    if (
      !sessionAfterWrite ||
      sessionAfterWrite.sessionId !== sessionId ||
      sessionAfterWrite.user.id !== userId
    ) {
      return errorResponse(c, 401, 'UNAUTHORIZED');
    }
    const memberAfterWrite = await auth.db
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          eq(members.id, memberId),
          eq(members.familyId, familyId),
          eq(members.userId, userId),
          eq(members.kind, 'adult'),
          eq(members.status, 'active'),
        ),
      );
    if (!memberAfterWrite[0]) return errorResponse(c, 404, 'NOT_FOUND');

    const savedRows = await auth.db
      .select()
      .from(memberCalendars)
      .where(eq(memberCalendars.memberId, memberId));
    const calendars = makeCalendarList(eligible, auth.family.familyCalendarId, savedRows);
    return c.json(
      updatePersonalCalendarsResponseSchema.parse({
        authorizationRequired: false,
        status: 'ready',
        memberId,
        hasSavedSelection: savedRows.some((row) => row.displayEnabled),
        calendars,
      }),
      200,
    );
  } catch (err) {
    return responseForGoogleFailure(c, err);
  }
});

function mapPersonalTime(event: GooglePersonalEvent) {
  if (!event.start || !event.end) return null;
  if (event.start.date && event.end.date) {
    return { kind: 'all-day' as const, start: event.start.date, endExclusive: event.end.date };
  }
  if (event.start.dateTime && event.end.dateTime) {
    return {
      kind: 'timed' as const,
      start: toTokyoIsoString(event.start.dateTime),
      endExclusive: toTokyoIsoString(event.end.dateTime),
    };
  }
  return null;
}

function eventStartValue(
  time: { kind: 'all-day'; start: string } | { kind: 'timed'; start: string },
) {
  return time.kind === 'all-day' ? `${time.start}T00:00:00+09:00` : time.start;
}

function eventOverlapsRange(
  event: GooglePersonalEvent,
  range: ReturnType<typeof getWeekRange>,
): boolean {
  const time = mapPersonalTime(event);
  if (!time || !event.start || !event.end) return false;
  if (time.kind === 'all-day') {
    return time.start < range.endExclusive && time.endExclusive > range.start;
  }
  return (
    Date.parse(time.endExclusive) > Date.parse(range.timeMin) &&
    Date.parse(time.start) < Date.parse(range.timeMax)
  );
}

personalRoute.get('/:id/week/personal', async (c) => {
  const auth = await authorizePersonalMember(c);
  if ('response' in auth) return auth.response;
  const queryValues = new URL(c.req.url).searchParams.getAll('start');
  if (queryValues.length > 1) return errorResponse(c, 400, 'INVALID_INPUT');
  const queryResult = weekQuerySchema.safeParse(c.req.query());
  if (!queryResult.success) return errorResponse(c, 400, 'INVALID_INPUT');
  const today = getTodayDateKey();
  let range: ReturnType<typeof getWeekRange>;
  try {
    range = getWeekRange(queryResult.data.start ?? today);
  } catch {
    return errorResponse(c, 400, 'INVALID_INPUT');
  }
  if (range.days.some((day) => Number(day.slice(0, 4)) < 1970 || Number(day.slice(0, 4)) > 2050)) {
    return errorResponse(c, 400, 'INVALID_INPUT');
  }
  const week = {
    start: range.start,
    endInclusive: range.endInclusive,
    prevWeekStart: range.prevWeekStart,
    nextWeekStart: range.nextWeekStart,
    today,
  };
  const empty = (status: 'authorization_required' | 'unselected') =>
    c.json(
      personalWeekResponseSchema.parse({
        family: { id: auth.family.id },
        memberId: auth.member.id,
        week,
        status,
        events: [],
      }),
      200,
    );

  if (!auth.scopes.has(PERSONAL_EVENTS_SCOPE)) return empty('authorization_required');
  const selections = await auth.db
    .select()
    .from(memberCalendars)
    .where(
      and(eq(memberCalendars.memberId, auth.member.id), eq(memberCalendars.displayEnabled, true)),
    );
  if (selections.length === 0) return empty('unselected');

  try {
    const client = createGoogleCalendarClient(c.env, auth.session.user.id);
    const allEvents = await Promise.all(
      selections.map((selection) =>
        fetchPersonalEvents(client, selection.calendarId, range.timeMin, range.timeMax).then(
          (events) => events.map((event) => ({ calendarId: selection.calendarId, event })),
        ),
      ),
    );
    const seen = new Set<string>();
    const events = allEvents
      .flat()
      .filter(
        ({ event }) =>
          event.status !== 'cancelled' &&
          event.selfResponseStatus !== 'declined' &&
          eventOverlapsRange(event, range),
      )
      .flatMap(({ calendarId, event }) => {
        const time = mapPersonalTime(event);
        if (!time) return [];
        const id = `${calendarId}::${event.id}`;
        if (seen.has(id)) return [];
        seen.add(id);
        return [
          {
            id,
            calendarId,
            title: event.summary ?? '',
            time,
            isRoutine: Boolean(event.recurringEventId || event.recurrence?.length),
          },
        ];
      })
      .sort((a, b) => {
        const left = eventStartValue(a.time);
        const right = eventStartValue(b.time);
        return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
      });
    return c.json(
      personalWeekResponseSchema.parse({
        family: { id: auth.family.id },
        memberId: auth.member.id,
        week,
        status: 'ready',
        events,
      }),
      200,
    );
  } catch (err) {
    return responseForGoogleFailure(c, err);
  }
});
