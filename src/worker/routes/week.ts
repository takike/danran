import { compareFamilyMembers } from '@shared/domain/memberOrder';
import { buildWeekDays } from '@shared/domain/week';
import { type ClosureDay, closureDaySchema } from '@shared/schemas/closure';
import { familyIdSchema } from '@shared/schemas/family';
import type { GoogleEvent } from '@shared/schemas/google-calendar';
import {
  type WeekEvent,
  type WeekResponse,
  eventItemsSchema,
  weekErrorResponseSchema,
  weekQuerySchema,
  weekResponseSchema,
} from '@shared/schemas/week';
import { getTodayDateKey, getWeekRange, toTokyoIsoString } from '@shared/time';
import { getAuthConfig } from '@worker/auth/config';
import { getSessionUser } from '@worker/auth/session';
import { createDb } from '@worker/db';
import { eventMeta, families, members } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { GoogleCalendarError, createGoogleCalendarClient } from '@worker/google/calendar';
import { ReauthNeededError } from '@worker/google/oauth';
import { and, eq } from 'drizzle-orm';
import type { Context, Handler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const PAGE_SIZE = 2500;
const MAX_EVENT_PAGES = 10;

type WeekContext = Context<{ Bindings: WorkerEnv }>;
type WeekStatusCode = 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503;

type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'FAMILY_NOT_READY'
  | 'REAUTH_REQUIRED'
  | 'CALENDAR_ACCESS_DENIED'
  | 'GOOGLE_TEMPORARY_ERROR'
  | 'GOOGLE_ERROR'
  | 'INTERNAL_ERROR'
  | 'CALENDAR_PAGE_LIMIT';

const ERROR_TEXT: Record<ErrorCode, string> = {
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Family not found',
  INVALID_INPUT: 'Invalid week request',
  FAMILY_NOT_READY: 'Family calendar is not ready',
  REAUTH_REQUIRED: 'Google re-authentication required',
  CALENDAR_ACCESS_DENIED: 'Family calendar access denied',
  GOOGLE_TEMPORARY_ERROR: 'Google Calendar is temporarily unavailable',
  GOOGLE_ERROR: 'Google Calendar request failed',
  INTERNAL_ERROR: 'Internal server error',
  CALENDAR_PAGE_LIMIT: 'Google Calendar returned too many event pages',
};

function errorResponse(c: WeekContext, status: WeekStatusCode, code: ErrorCode) {
  const validatedStatus: ContentfulStatusCode = status;
  return c.json(weekErrorResponseSchema.parse({ error: ERROR_TEXT[code], code }), validatedStatus);
}

function getGoogleFailure(err: unknown): { status: WeekStatusCode; code: ErrorCode } {
  if (err instanceof ReauthNeededError) return { status: 401, code: 'REAUTH_REQUIRED' };
  if (!(err instanceof GoogleCalendarError)) return { status: 502, code: 'GOOGLE_ERROR' };
  if (err.code === 'AUTH_ERROR') return { status: 401, code: 'REAUTH_REQUIRED' };
  if (err.code === 'RATE_LIMITED') {
    return { status: 503, code: 'GOOGLE_TEMPORARY_ERROR' };
  }
  if (err.code === 'API_ERROR' && (err.googleStatus ?? err.status) >= 500) {
    return { status: 503, code: 'GOOGLE_TEMPORARY_ERROR' };
  }
  if (err.googleStatus === 403 || err.googleStatus === 404) {
    return { status: 403, code: 'CALENDAR_ACCESS_DENIED' };
  }
  return { status: 502, code: 'GOOGLE_ERROR' };
}

function isSupportedDateKey(value: string): boolean {
  const year = Number(value.slice(0, 4));
  return year >= 1970 && year <= 2050;
}

function toGoogleDateTime(value: { date?: string; dateTime?: string }):
  | { kind: 'all-day'; start: string }
  | { kind: 'timed'; start: string } {
  if (value.date) return { kind: 'all-day', start: value.date };
  if (value.dateTime) return { kind: 'timed', start: value.dateTime };
  throw new TypeError('Google event is missing a start time');
}

function eventIsInRange(event: GoogleEvent, timeMin: string, timeMax: string): boolean {
  if (!event.start || !event.end) return false;
  const start = toGoogleDateTime(event.start);
  const end = toGoogleDateTime(event.end);
  if (start.kind !== end.kind) return false;
  if (start.kind === 'all-day' && end.kind === 'all-day') {
    const firstDate = timeMin.slice(0, 10);
    const endDateExclusive = timeMax.slice(0, 10);
    return start.start < endDateExclusive && end.start > firstDate;
  }
  if (start.kind === 'timed' && end.kind === 'timed') {
    return (
      Date.parse(end.start) > Date.parse(timeMin) && Date.parse(start.start) < Date.parse(timeMax)
    );
  }
  return false;
}

function toComparableStart(value: string | { date?: string; dateTime?: string }): string | null {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    try {
      return toTokyoIsoString(value);
    } catch {
      return null;
    }
  }
  if (value.date) return value.date;
  if (value.dateTime) {
    try {
      return toTokyoIsoString(value.dateTime);
    } catch {
      return null;
    }
  }
  return null;
}

type MetadataIndex = {
  exact: Map<string, typeof eventMeta.$inferSelect>;
  occurrence: Map<string, typeof eventMeta.$inferSelect>;
  series: Map<string, typeof eventMeta.$inferSelect>;
};

function createMetadataIndex(rows: (typeof eventMeta.$inferSelect)[]): MetadataIndex {
  const exact = new Map<string, typeof eventMeta.$inferSelect>();
  const occurrence = new Map<string, typeof eventMeta.$inferSelect>();
  const series = new Map<string, typeof eventMeta.$inferSelect>();
  for (const row of rows) {
    if (!exact.has(row.eventId)) exact.set(row.eventId, row);
    if (row.recurringEventId && row.originalStart) {
      const originalStart = toComparableStart(row.originalStart);
      if (originalStart) {
        const key = `${row.recurringEventId}\u0000${originalStart}`;
        if (!occurrence.has(key)) occurrence.set(key, row);
      }
    }
    if (!series.has(row.eventId)) series.set(row.eventId, row);
  }
  return { exact, occurrence, series };
}

function getMetadataForEvent(event: GoogleEvent, metadata: MetadataIndex) {
  const exact = metadata.exact.get(event.id);
  if (exact) return exact;

  if (event.recurringEventId && event.originalStartTime) {
    const originalStart = toComparableStart(event.originalStartTime);
    const occurrence = originalStart
      ? metadata.occurrence.get(`${event.recurringEventId}\u0000${originalStart}`)
      : undefined;
    if (occurrence) return occurrence;
  }

  if (event.recurringEventId) {
    return metadata.series.get(event.recurringEventId);
  }
  return undefined;
}

function parsePrivateMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    return typeof entry[1] === 'string';
  });
  return Object.fromEntries(entries);
}

function safeItems(itemsJson: string | null | undefined): string[] {
  if (typeof itemsJson !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(itemsJson);
    const result = eventItemsSchema.safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

function mapEvent(
  googleEvent: GoogleEvent,
  metadataIndex: MetadataIndex,
  activeMemberIds: ReadonlySet<string>,
): WeekEvent {
  if (!googleEvent.start || !googleEvent.end) {
    throw new TypeError('Google event is missing a time range');
  }
  const start = toGoogleDateTime(googleEvent.start);
  const end = toGoogleDateTime(googleEvent.end);
  const meta = getMetadataForEvent(googleEvent, metadataIndex);
  const privateProperties = parsePrivateMetadata(googleEvent.extendedProperties?.private);
  const isDanranEvent = privateProperties.danran === '1';
  const memberIds = isDanranEvent
    ? [
        ...new Set(
          (privateProperties.members ?? '').split(',').filter((id) => activeMemberIds.has(id)),
        ),
      ]
    : [];
  const rawAssignee = isDanranEvent ? privateProperties.assignee : undefined;
  const assigneeMemberId = rawAssignee && activeMemberIds.has(rawAssignee) ? rawAssignee : null;
  const rawStatus = isDanranEvent ? privateProperties.status : undefined;
  const status =
    rawStatus === 'confirmed' || rawStatus === 'tentative'
      ? rawStatus
      : googleEvent.status === 'tentative'
        ? 'tentative'
        : 'confirmed';
  const rawSource = isDanranEvent ? privateProperties.source : undefined;
  const source =
    isDanranEvent && (rawSource === 'manual' || rawSource === 'import' || rawSource === 'publish')
      ? rawSource
      : isDanranEvent
        ? 'manual'
        : 'external';

  const time =
    start.kind === 'all-day' && end.kind === 'all-day'
      ? { kind: 'all-day' as const, start: start.start, endExclusive: end.start }
      : start.kind === 'timed' && end.kind === 'timed'
        ? {
            kind: 'timed' as const,
            start: toTokyoIsoString(start.start),
            endExclusive: toTokyoIsoString(end.start),
          }
        : (() => {
            throw new TypeError('Google event mixes all-day and timed values');
          })();

  return {
    id: googleEvent.id,
    title: googleEvent.summary?.trim() || '（無題）',
    time,
    memberIds,
    assigneeMemberId,
    status,
    isRoutine: Boolean(googleEvent.recurringEventId),
    source,
    items: safeItems(meta?.itemsJson),
  };
}

async function fetchAllEvents(
  env: WorkerEnv,
  userId: string,
  calendarId: string,
  range: ReturnType<typeof getWeekRange>,
): Promise<GoogleEvent[]> {
  const client = createGoogleCalendarClient(env, userId);
  const events: GoogleEvent[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_EVENT_PAGES; pageNumber += 1) {
    const page = await client.events.list(calendarId, {
      singleEvents: true,
      orderBy: 'startTime',
      showDeleted: false,
      maxResults: PAGE_SIZE,
      pageToken,
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      timeZone: 'Asia/Tokyo',
    });
    events.push(...page.items);

    const nextPageToken = page.nextPageToken;
    if (nextPageToken === undefined) return events;
    if (!nextPageToken.trim()) {
      throw new GoogleCalendarError({
        message: 'Google Calendar returned an invalid page token',
        code: 'INVALID_RESPONSE',
        status: 502,
      });
    }
    if (seenPageTokens.has(nextPageToken)) {
      throw new Error('CALENDAR_PAGE_LIMIT');
    }
    seenPageTokens.add(nextPageToken);
    if (pageNumber === MAX_EVENT_PAGES - 1) {
      throw new Error('CALENDAR_PAGE_LIMIT');
    }
    pageToken = nextPageToken;
  }
  return events;
}

async function handleFamilyWeek(c: WeekContext) {
  const db = createDb(c.env.DB);
  const config = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) return errorResponse(c, 401, 'UNAUTHORIZED');

  const familyIdResult = familyIdSchema.safeParse(c.req.param('id'));
  if (!familyIdResult.success) return errorResponse(c, 404, 'NOT_FOUND');
  const familyId = familyIdResult.data;

  const queryParams = new URL(c.req.url).searchParams;
  const queryValues = Object.fromEntries(queryParams.entries());
  if (queryParams.getAll('start').length > 1) return errorResponse(c, 400, 'INVALID_INPUT');
  const queryResult = weekQuerySchema.safeParse(queryValues);
  if (!queryResult.success) return errorResponse(c, 400, 'INVALID_INPUT');

  const familyRows = await db.select().from(families).where(eq(families.id, familyId));
  const family = familyRows[0];
  if (!family) return errorResponse(c, 404, 'NOT_FOUND');

  const membershipRows = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.familyId, familyId),
        eq(members.userId, session.user.id),
        eq(members.status, 'active'),
      ),
    );
  if (membershipRows.length === 0) return errorResponse(c, 404, 'NOT_FOUND');
  if (family.creationStatus !== 'ready' || !family.familyCalendarId) {
    return errorResponse(c, 409, 'FAMILY_NOT_READY');
  }

  const anchorDate = queryResult.data.start ?? getTodayDateKey();
  let range: ReturnType<typeof getWeekRange>;
  try {
    range = getWeekRange(anchorDate);
    if (!range.days.every(isSupportedDateKey)) return errorResponse(c, 400, 'INVALID_INPUT');
  } catch {
    return errorResponse(c, 400, 'INVALID_INPUT');
  }

  let fetchedEvents: GoogleEvent[];
  try {
    fetchedEvents = await fetchAllEvents(c.env, session.user.id, family.familyCalendarId, range);
  } catch (err) {
    if (err instanceof Error && err.message === 'CALENDAR_PAGE_LIMIT') {
      return errorResponse(c, 502, 'CALENDAR_PAGE_LIMIT');
    }
    const failure = getGoogleFailure(err);
    return errorResponse(c, failure.status, failure.code);
  }

  const activeMembers = await db
    .select()
    .from(members)
    .where(and(eq(members.familyId, familyId), eq(members.status, 'active')));
  activeMembers.sort(compareFamilyMembers);
  const activeMemberIds = new Set(activeMembers.map((member) => member.id));

  const metaRows = await db
    .select()
    .from(eventMeta)
    .where(
      and(eq(eventMeta.familyId, familyId), eq(eventMeta.calendarId, family.familyCalendarId)),
    );

  const seenEventIds = new Set<string>();
  const events: WeekEvent[] = [];
  const metadataIndex = createMetadataIndex(metaRows);
  try {
    for (const googleEvent of fetchedEvents) {
      if (googleEvent.status === 'cancelled' || seenEventIds.has(googleEvent.id)) continue;
      if (!eventIsInRange(googleEvent, range.timeMin, range.timeMax)) continue;
      seenEventIds.add(googleEvent.id);
      events.push(mapEvent(googleEvent, metadataIndex, activeMemberIds));
    }
  } catch {
    return errorResponse(c, 502, 'GOOGLE_ERROR');
  }

  const closureRows = await c.env.DB.prepare(
    'SELECT id, family_id, date, label, member_ids FROM closure_days WHERE family_id = ? AND date >= ? AND date <= ?',
  )
    .bind(familyId, range.start, range.endInclusive)
    .all<{ id: string; family_id: string; date: string; label: string; member_ids: unknown }>();
  const closures: ClosureDay[] = [];
  for (const row of closureRows.results ?? []) {
    let parsedMemberIds: unknown;
    try {
      parsedMemberIds =
        typeof row.member_ids === 'string' ? JSON.parse(row.member_ids) : row.member_ids;
    } catch {
      continue;
    }
    const result = closureDaySchema.safeParse({
      id: row.id,
      familyId: row.family_id,
      date: row.date,
      label: row.label,
      memberIds: parsedMemberIds,
    });
    if (result.success) closures.push(result.data);
  }

  let response: WeekResponse;
  try {
    const today = getTodayDateKey();
    const days = buildWeekDays(
      range,
      events,
      closures,
      activeMembers.map((member) => member.id),
    );
    response = weekResponseSchema.parse({
      family: { id: family.id, name: family.name },
      members: activeMembers.map((member) => ({
        id: member.id,
        name: member.name,
        color: member.color,
        kind: member.kind,
        sortOrder: member.sortOrder,
      })),
      week: {
        start: range.start,
        endInclusive: range.endInclusive,
        prevWeekStart: range.prevWeekStart,
        nextWeekStart: range.nextWeekStart,
        today,
      },
      days,
      events,
    });
  } catch {
    return errorResponse(c, 500, 'INTERNAL_ERROR');
  }

  return c.json(response, 200);
}

export const getFamilyWeek: Handler<{ Bindings: WorkerEnv }> = async (c) => {
  try {
    return await handleFamilyWeek(c);
  } catch {
    return errorResponse(c, 500, 'INTERNAL_ERROR');
  }
};
