import { mergeBusyIntervals } from '@shared/domain/busyIntervals';
import { compareFamilyMembers } from '@shared/domain/memberOrder';
import { familyIdSchema } from '@shared/schemas/family';
import { weekQuerySchema } from '@shared/schemas/week';
import {
  type BusyWeekResponse,
  busyWeekErrorResponseSchema,
  busyWeekResponseSchema,
} from '@shared/schemas/week-busy';
import { getTodayDateKey, getWeekRange, parseIsoInstantMilliseconds } from '@shared/time';
import { FREE_BUSY_SCOPE, getAuthConfig } from '@worker/auth/config';
import { getSessionUser } from '@worker/auth/session';
import { createDb } from '@worker/db';
import { families, googleTokens, memberCalendars, members } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { GoogleCalendarError, createGoogleCalendarClient } from '@worker/google/calendar';
import { ReauthNeededError } from '@worker/google/oauth';
import { and, eq, isNotNull } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { ZodError } from 'zod';
import { familySecurityMiddleware } from './families';

type RouteContext = Context<{ Bindings: WorkerEnv }>;
type ErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_INPUT' | 'INTERNAL_ERROR';
type ErrorStatus = 400 | 401 | 403 | 404 | 500;

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Family not found',
  INVALID_INPUT: 'Invalid week request',
  INTERNAL_ERROR: 'Internal server error',
};

export const weekBusyRoute = new Hono<{ Bindings: WorkerEnv }>();
weekBusyRoute.use('*', familySecurityMiddleware);
weekBusyRoute.onError((_err, c) => errorResponse(c, 500, 'INTERNAL_ERROR'));

function errorResponse(c: RouteContext, status: ErrorStatus, code: ErrorCode) {
  return c.json(busyWeekErrorResponseSchema.parse({ error: ERROR_MESSAGES[code], code }), status);
}

function isSupportedWeekYear(date: string): boolean {
  const year = Number(date.slice(0, 4));
  return year >= 1970 && year <= 2050;
}

function isKnownGoogleFailure(error: unknown): boolean {
  return error instanceof GoogleCalendarError || error instanceof ReauthNeededError;
}

async function getMemberBusy(
  c: RouteContext,
  member: typeof members.$inferSelect,
  familyCalendarId: string | null,
  timeMin: string,
  timeMax: string,
): Promise<BusyWeekResponse['members'][number]> {
  if (!member.userId) return { memberId: member.id, status: 'not_shared', busy: [] };

  const db = createDb(c.env.DB);
  const [tokenRows, selectionRows] = await Promise.all([
    db.select().from(googleTokens).where(eq(googleTokens.userId, member.userId)),
    db
      .select()
      .from(memberCalendars)
      .where(and(eq(memberCalendars.memberId, member.id), eq(memberCalendars.includeInBusy, true))),
  ]);
  const scopes = new Set((tokenRows[0]?.scopes ?? '').split(/\s+/).filter(Boolean));
  const selectedCalendarIds = selectionRows
    .map((selection) => selection.calendarId)
    .filter((calendarId) => calendarId !== familyCalendarId)
    .sort();
  if (!scopes.has(FREE_BUSY_SCOPE) || selectedCalendarIds.length === 0) {
    return { memberId: member.id, status: 'not_shared', busy: [] };
  }

  try {
    const client = createGoogleCalendarClient(c.env, member.userId);
    const response = await client.freeBusy.query({
      timeMin,
      timeMax,
      timeZone: 'Asia/Tokyo',
      items: selectedCalendarIds.map((id) => ({ id })),
    });
    let responseHasExpectedRange: boolean;
    try {
      responseHasExpectedRange =
        parseIsoInstantMilliseconds(response.timeMin) === parseIsoInstantMilliseconds(timeMin) &&
        parseIsoInstantMilliseconds(response.timeMax) === parseIsoInstantMilliseconds(timeMax);
    } catch (error) {
      if (error instanceof ZodError) {
        return { memberId: member.id, status: 'unavailable', busy: [] };
      }
      throw error;
    }
    if (!responseHasExpectedRange) {
      return { memberId: member.id, status: 'unavailable', busy: [] };
    }

    const intervals = [];
    for (const calendarId of selectedCalendarIds) {
      if (!Object.hasOwn(response.calendars, calendarId)) {
        return { memberId: member.id, status: 'unavailable', busy: [] };
      }
      const calendar = response.calendars[calendarId];
      if (!calendar || (calendar.errors?.length ?? 0) > 0 || !Array.isArray(calendar.busy)) {
        return { memberId: member.id, status: 'unavailable', busy: [] };
      }
      intervals.push(...calendar.busy);
    }

    let busy: BusyWeekResponse['members'][number]['busy'];
    try {
      busy = mergeBusyIntervals(intervals, { start: timeMin, end: timeMax });
    } catch (error) {
      if (error instanceof ZodError || error instanceof RangeError || error instanceof TypeError) {
        return { memberId: member.id, status: 'unavailable', busy: [] };
      }
      throw error;
    }
    return { memberId: member.id, status: 'ready', busy };
  } catch (error) {
    if (isKnownGoogleFailure(error)) {
      return { memberId: member.id, status: 'unavailable', busy: [] };
    }
    throw error;
  }
}

weekBusyRoute.get('/:id/week/busy', async (c) => {
  const db = createDb(c.env.DB);
  const config = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) return errorResponse(c, 401, 'UNAUTHORIZED');

  const familyIdResult = familyIdSchema.safeParse(c.req.param('id'));
  if (!familyIdResult.success) return errorResponse(c, 404, 'NOT_FOUND');
  const familyId = familyIdResult.data;

  const familyRows = await db.select().from(families).where(eq(families.id, familyId));
  const family = familyRows[0];
  if (!family) return errorResponse(c, 404, 'NOT_FOUND');

  const callerMembership = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.familyId, familyId),
        eq(members.userId, session.user.id),
        eq(members.status, 'active'),
        eq(members.kind, 'adult'),
      ),
    );
  if (!callerMembership[0]) return errorResponse(c, 404, 'NOT_FOUND');

  const queryParams = new URL(c.req.url).searchParams;
  if (queryParams.getAll('start').length > 1) return errorResponse(c, 400, 'INVALID_INPUT');
  const queryResult = weekQuerySchema.safeParse(Object.fromEntries(queryParams.entries()));
  if (!queryResult.success) return errorResponse(c, 400, 'INVALID_INPUT');

  const today = getTodayDateKey();
  let range: ReturnType<typeof getWeekRange>;
  try {
    range = getWeekRange(queryResult.data.start ?? today);
    if (!range.days.every(isSupportedWeekYear)) return errorResponse(c, 400, 'INVALID_INPUT');
  } catch {
    return errorResponse(c, 400, 'INVALID_INPUT');
  }

  const activeAdults = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.familyId, familyId),
        eq(members.status, 'active'),
        eq(members.kind, 'adult'),
        isNotNull(members.userId),
      ),
    );
  activeAdults.sort(compareFamilyMembers);

  const week = {
    start: range.start,
    endInclusive: range.endInclusive,
    prevWeekStart: range.prevWeekStart,
    nextWeekStart: range.nextWeekStart,
    today,
  };
  const memberResults = await Promise.all(
    activeAdults.map((member) =>
      getMemberBusy(c, member, family.familyCalendarId, range.timeMin, range.timeMax),
    ),
  );
  return c.json(
    busyWeekResponseSchema.parse({
      family: { id: family.id },
      week,
      members: memberResults,
    }),
    200,
  );
});
