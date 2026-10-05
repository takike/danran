import {
  busyCalendarListResponseSchema,
  busyCalendarsErrorResponseSchema,
  updateBusyCalendarsInputSchema,
  updateBusyCalendarsResponseSchema,
} from '@shared/schemas/busy';
import { familyIdSchema } from '@shared/schemas/family';
import { FREE_BUSY_SCOPE, getAuthConfig } from '@worker/auth/config';
import { initiateOAuthFlow } from '@worker/auth/oauth';
import { getSessionUser } from '@worker/auth/session';
import { createDb } from '@worker/db';
import { families, googleTokens, memberCalendars, members } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { createGoogleCalendarClient } from '@worker/google/calendar';
import { and, eq, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { familySecurityMiddleware } from './families';
import { fetchCalendarList, getRouteError } from './personal';

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
  INVALID_INPUT: 'Invalid busy calendar request',
  REAUTH_REQUIRED: 'Google re-authentication required',
  CALENDAR_ACCESS_DENIED: 'Busy calendar access denied',
  GOOGLE_TEMPORARY_ERROR: 'Google Calendar is temporarily unavailable',
  GOOGLE_ERROR: 'Google Calendar request failed',
  INTERNAL_ERROR: 'Internal server error',
  CALENDAR_PAGE_LIMIT: 'Google Calendar returned too many pages',
};

const bodyLimit16KiB = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) =>
    c.json(
      busyCalendarsErrorResponseSchema.parse({ error: 'Payload Too Large', code: 'INVALID_INPUT' }),
      413,
    ),
});

export const busyRoute = new Hono<{ Bindings: WorkerEnv }>();
busyRoute.use('*', familySecurityMiddleware);
busyRoute.onError((_err, c) => errorResponse(c, 500, 'INTERNAL_ERROR'));

function errorResponse(c: RouteContext, status: RouteStatus, code: RouteErrorCode) {
  return c.json(
    busyCalendarsErrorResponseSchema.parse({ error: ERROR_MESSAGES[code], code }),
    status,
  );
}

async function authorizeBusyMember(c: RouteContext) {
  const db = createDb(c.env.DB);
  const config = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) return { response: errorResponse(c, 401, 'UNAUTHORIZED') } as const;

  const familyId = familyIdSchema.safeParse(c.req.param('id'));
  if (!familyId.success) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  const familyRows = await db.select().from(families).where(eq(families.id, familyId.data));
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

function makeBusyCalendarList(
  entries: Awaited<ReturnType<typeof fetchCalendarList>>,
  familyCalendarId: string | null,
  savedRows: Array<typeof memberCalendars.$inferSelect>,
) {
  const savedSelection = new Map(savedRows.map((row) => [row.calendarId, row.includeInBusy]));
  return entries
    .filter((entry) => entry.id !== familyCalendarId)
    .map((entry) => ({
      id: entry.id,
      name: entry.summary?.trim() || '（名前のないカレンダー）',
      isPrimary: entry.primary === true,
      selected: savedSelection.get(entry.id) === true,
    }));
}

function responseForGoogleFailure(c: RouteContext, err: unknown) {
  const failure = getRouteError(err);
  return errorResponse(c, failure.status, failure.code);
}

busyRoute.get('/:id/busy-calendars', async (c) => {
  const auth = await authorizeBusyMember(c);
  if ('response' in auth) return auth.response;
  if (!auth.scopes.has(FREE_BUSY_SCOPE)) {
    return c.json(
      busyCalendarListResponseSchema.parse({
        status: 'authorization_required',
        memberId: auth.member.id,
        calendars: [],
      }),
      200,
    );
  }

  try {
    const client = createGoogleCalendarClient(c.env, auth.session.user.id);
    const [entries, savedRows] = await Promise.all([
      fetchCalendarList(client),
      auth.db.select().from(memberCalendars).where(eq(memberCalendars.memberId, auth.member.id)),
    ]);
    const calendars = makeBusyCalendarList(entries, auth.family.familyCalendarId, savedRows);
    return c.json(
      busyCalendarListResponseSchema.parse({
        status: 'ready',
        memberId: auth.member.id,
        hasSavedSelection: savedRows.some((row) => row.includeInBusy),
        calendars,
      }),
      200,
    );
  } catch (err) {
    return responseForGoogleFailure(c, err);
  }
});

busyRoute.put('/:id/busy-calendars', bodyLimit16KiB, async (c) => {
  const auth = await authorizeBusyMember(c);
  if ('response' in auth) return auth.response;
  const parsed = updateBusyCalendarsInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return errorResponse(c, 400, 'INVALID_INPUT');

  if (!auth.scopes.has(FREE_BUSY_SCOPE)) {
    try {
      const { authUrl } = await initiateOAuthFlow(c, auth.db, auth.config, {
        purpose: 'free-busy',
        userId: auth.session.user.id,
        sessionId: auth.session.sessionId,
        familyId: auth.family.id,
        memberId: auth.member.id,
        loginHint: auth.session.user.googleSub,
      });
      return c.json(
        updateBusyCalendarsResponseSchema.parse({
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
    const selectedEntries = eligible.filter((entry) => requestedIds.has(entry.id));
    const notSelectedCondition =
      selectedEntries.length === 0
        ? sql`1 = 1`
        : sql`${memberCalendars.calendarId} NOT IN (${sql.join(
            selectedEntries.map((entry) => sql`${entry.id}`),
            sql`, `,
          )})`;
    const clearBusySelection = auth.db
      .update(memberCalendars)
      .set({ includeInBusy: false })
      .where(
        and(
          eq(memberCalendars.memberId, memberId),
          eq(memberCalendars.includeInBusy, true),
          notSelectedCondition,
          writeGuard,
        ),
      );
    const upsertBusySelections = selectedEntries.map((entry) =>
      auth.db
        .insert(memberCalendars)
        .select(sql`SELECT ${memberId}, ${entry.id}, 0, 1 WHERE (${writeGuard})`)
        .onConflictDoUpdate({
          target: [memberCalendars.memberId, memberCalendars.calendarId],
          set: { includeInBusy: true },
        }),
    );
    const deleteUnusedRows = auth.db
      .delete(memberCalendars)
      .where(
        and(
          eq(memberCalendars.memberId, memberId),
          eq(memberCalendars.displayEnabled, false),
          eq(memberCalendars.includeInBusy, false),
          writeGuard,
        ),
      );

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

    const batchStatements = [clearBusySelection, ...upsertBusySelections, deleteUnusedRows];
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
    const calendars = makeBusyCalendarList(eligible, auth.family.familyCalendarId, savedRows);
    return c.json(
      updateBusyCalendarsResponseSchema.parse({
        authorizationRequired: false,
        status: 'ready',
        memberId,
        hasSavedSelection: savedRows.some((row) => row.includeInBusy),
        calendars,
      }),
      200,
    );
  } catch (err) {
    return responseForGoogleFailure(c, err);
  }
});
