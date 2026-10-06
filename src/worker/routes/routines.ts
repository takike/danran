import {
  getRoutineAutoSkipCandidateReason,
  getRoutineAutoSkipHorizon,
  getRoutineAutoSkipReason,
} from '@shared/domain/routineAutoSkips';
import { getRoutineInstanceStatus } from '@shared/domain/routineInstances';
import {
  buildRoutineRecurrence,
  getFirstRoutineDate,
  parseGoogleRoutineRule,
} from '@shared/domain/routines';
import { familyIdSchema } from '@shared/schemas/family';
import type { GoogleEvent, InsertEventInput } from '@shared/schemas/google-calendar';
import {
  type RoutineInput,
  type RoutineInstance,
  type RoutineMoveInput,
  createRoutineInputSchema,
  routineAutoSkipResponseSchema,
  routineCreateResponseSchema,
  routineDeleteResponseSchema,
  routineErrorResponseSchema,
  routineInstanceActionInputSchema,
  routineInstanceMutationResponseSchema,
  routineInstanceSchema,
  routineListResponseSchema,
  routineMoveInputSchema,
  routineSettingsInputSchema,
} from '@shared/schemas/routines';
import {
  addCalendarDays,
  getDayBounds,
  getTodayDateKey,
  toTokyoDateKey,
  toTokyoIsoString,
} from '@shared/time';
import { parseIsoInstantMilliseconds } from '@shared/time/interval';
import { type AuthConfig, getAuthConfig } from '@worker/auth/config';
import { getSessionUser } from '@worker/auth/session';
import { createDb } from '@worker/db';
import { families, members, routineAutoSkips, routineSettings } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import {
  type GoogleCalendarClient,
  GoogleCalendarError,
  createGoogleCalendarClient,
  validatePathSegment,
} from '@worker/google/calendar';
import { ReauthNeededError } from '@worker/google/oauth';
import { and, eq, inArray, lt } from 'drizzle-orm';
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

const INSTANCE_PAGE_SIZE = 250;
const INSTANCE_PAGE_LIMIT = 4;
const AUTO_SKIP_CHANGE_LIMIT = 20;

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

function instant(value: GoogleEvent['start']): string | null {
  return value?.dateTime ? toTokyoIsoString(value.dateTime) : null;
}

function masterDurationMs(master: GoogleEvent): number | null {
  const start = instant(master.start);
  const end = instant(master.end);
  if (!start || !end) return null;
  const duration = parseIsoInstantMilliseconds(end) - parseIsoInstantMilliseconds(start);
  return duration > 0 ? duration : null;
}

function addDuration(start: string, duration: number): string {
  return toTokyoIsoString(parseIsoInstantMilliseconds(start) + duration);
}

function originalTimes(
  event: GoogleEvent,
  duration: number,
): { originalStart: string; originalEnd: string } | null {
  const start = instant(event.originalStartTime);
  if (!start) return null;
  return { originalStart: start, originalEnd: addDuration(start, duration) };
}

function routineInstanceFromGoogle(
  event: GoogleEvent,
  duration: number,
  autoSkipReason: 'holiday' | 'new_year' | null = null,
) {
  const original = originalTimes(event, duration);
  if (!original) return null;
  if (event.status === 'cancelled') {
    return {
      id: event.id,
      ...original,
      start: null,
      end: null,
      status: 'skipped' as const,
      autoSkipReason,
    };
  }
  const start = instant(event.start);
  const end = instant(event.end);
  if (!start || !end) return null;
  return {
    id: event.id,
    ...original,
    start,
    end,
    status: getRoutineInstanceStatus({ ...original, start, end }),
    autoSkipReason: null,
  };
}

async function listUpcomingInstances(
  client: GoogleCalendarClient,
  calendarId: string,
  master: GoogleEvent,
  autoSkipReasons: ReadonlyMap<string, 'holiday' | 'new_year'> = new Map(),
): Promise<{ status: 'ready' | 'unavailable'; instances: RoutineInstance[] }> {
  const duration = masterDurationMs(master);
  if (duration === null) return { status: 'unavailable', instances: [] };
  const today = getTodayDateKey();
  const rangeStart = getDayBounds(addCalendarDays(today, -31)).startIso;
  const rangeEnd = getDayBounds(addCalendarDays(today, 120)).startIso;
  const topInstances: RoutineInstance[] = [];
  const seenInstanceIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < INSTANCE_PAGE_LIMIT; page += 1) {
      const result = await client.events.instances(calendarId, master.id, {
        timeMin: rangeStart,
        timeMax: rangeEnd,
        showDeleted: true,
        maxResults: INSTANCE_PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const event of result.items) {
        if (event.recurringEventId !== master.id) continue;
        if (seenInstanceIds.has(event.id)) continue;
        seenInstanceIds.add(event.id);
        const originalStart = instant(event.originalStartTime);
        if (!originalStart) return { status: 'unavailable', instances: [] };
        const originalDate = toTokyoDateKey(originalStart);
        if (originalDate < today || originalDate > '2050-12-31') continue;
        const instance = routineInstanceFromGoogle(
          event,
          duration,
          event.status === 'cancelled' ? (autoSkipReasons.get(originalStart) ?? null) : null,
        );
        if (!instance) return { status: 'unavailable', instances: [] };
        const parsedInstance = routineInstanceSchema.safeParse(instance);
        if (!parsedInstance.success) return { status: 'unavailable', instances: [] };
        topInstances.push(parsedInstance.data);
        topInstances.sort((a, b) => a.originalStart.localeCompare(b.originalStart));
        topInstances.splice(4);
      }
      pageToken = result.nextPageToken;
      if (!pageToken) break;
      if (seenPageTokens.has(pageToken)) return { status: 'unavailable', instances: [] };
      seenPageTokens.add(pageToken);
    }
    if (pageToken) return { status: 'unavailable', instances: [] };
    return { status: 'ready', instances: topInstances };
  } catch {
    return { status: 'unavailable', instances: [] };
  }
}

async function withConcurrency<T, U>(
  items: readonly T[],
  limit: number,
  operation: (item: T) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item !== undefined) output[index] = await operation(item);
      }
    }),
  );
  return output;
}

type InstanceMutation = 'skip' | 'restore' | 'move';

async function mutateRoutineInstance(c: RouteContext, action: InstanceMutation): Promise<Response> {
  const access = await authorizeFamily(c);
  if ('response' in access && access.response) return access.response;
  const rawRoutineId = c.req.param('routineId');
  const rawInstanceId = c.req.param('instanceId');
  if (!rawRoutineId || !rawInstanceId) return errorResponse(c, 404, 'NOT_FOUND');
  try {
    validatePathSegment('routineId', rawRoutineId);
    validatePathSegment('instanceId', rawInstanceId);
  } catch {
    return errorResponse(c, 400, 'INVALID_INPUT');
  }
  let move: RoutineMoveInput | undefined;
  if (action === 'move') {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_INPUT');
    }
    const parsed = routineMoveInputSchema.safeParse(body);
    if (!parsed.success) return errorResponse(c, 400, 'INVALID_INPUT');
    move = parsed.data;
  } else {
    let body: unknown;
    try {
      const text = await c.req.text();
      body = text.trim() === '' ? {} : JSON.parse(text);
    } catch {
      return errorResponse(c, 400, 'INVALID_INPUT');
    }
    if (!routineInstanceActionInputSchema.safeParse(body).success) {
      return errorResponse(c, 400, 'INVALID_INPUT');
    }
  }
  const row = (
    await access.db
      .select()
      .from(routineSettings)
      .where(
        and(
          eq(routineSettings.id, rawRoutineId),
          eq(routineSettings.familyId, access.family.id),
          eq(routineSettings.calendarId, access.calendarId),
        ),
      )
  )[0];
  if (!row) return errorResponse(c, 404, 'NOT_FOUND');
  const client = createGoogleCalendarClient(c.env, access.session.user.id);
  let instance: GoogleEvent;
  let master: GoogleEvent;
  try {
    instance = await client.events.get(access.calendarId, rawInstanceId);
    if (instance.id !== rawInstanceId || instance.recurringEventId !== row.recurringEventId) {
      return errorResponse(c, 404, 'NOT_FOUND');
    }
    master = await client.events.get(access.calendarId, row.recurringEventId);
  } catch (err) {
    if (isGoogleMissing(err)) return errorResponse(c, 404, 'NOT_FOUND');
    return responseForGoogleFailure(c, err);
  }
  if (
    master.id !== row.recurringEventId ||
    master.status === 'cancelled' ||
    !master.recurrence?.length
  ) {
    return errorResponse(c, 404, 'NOT_FOUND');
  }
  const duration = masterDurationMs(master);
  const original = duration === null ? null : originalTimes(instance, duration);
  if (!original) return errorResponse(c, 404, 'NOT_FOUND');

  const autoSkip = (
    await access.db
      .select()
      .from(routineAutoSkips)
      .where(
        and(
          eq(routineAutoSkips.routineSettingsId, row.id),
          eq(routineAutoSkips.originalStart, original.originalStart),
        ),
      )
  )[0];
  const shouldRollbackOverride = autoSkip?.status === 'applied';
  if (shouldRollbackOverride) {
    await access.db
      .update(routineAutoSkips)
      .set({ status: 'overridden' })
      .where(and(eq(routineAutoSkips.id, autoSkip.id), eq(routineAutoSkips.status, 'applied')));
  }

  let patch: Parameters<typeof client.events.patch>[2];
  let resulting: {
    start: string | null;
    end: string | null;
    status: 'normal' | 'skipped' | 'moved';
  };
  if (action === 'skip') {
    patch = { status: 'cancelled' };
    resulting = { start: null, end: null, status: 'skipped' };
  } else {
    const start =
      action === 'restore' ? original.originalStart : `${move?.date}T${move?.startTime}:00+09:00`;
    const end =
      action === 'restore' ? original.originalEnd : `${move?.date}T${move?.endTime}:00+09:00`;
    patch = {
      status: 'confirmed',
      start: { date: null, dateTime: start, timeZone: 'Asia/Tokyo' },
      end: { date: null, dateTime: end, timeZone: 'Asia/Tokyo' },
    };
    resulting = {
      start,
      end,
      status: getRoutineInstanceStatus({ ...original, start, end }),
    };
  }
  let patched: GoogleEvent;
  try {
    patched = await client.events.patch(access.calendarId, rawInstanceId, patch, {
      sendUpdates: 'none',
    });
  } catch (err) {
    if (shouldRollbackOverride) {
      try {
        const latest = await client.events.get(access.calendarId, rawInstanceId);
        const signature = (event: GoogleEvent) =>
          JSON.stringify({
            status: event.status,
            start: event.status === 'cancelled' ? null : instant(event.start),
            end: event.status === 'cancelled' ? null : instant(event.end),
          });
        if (
          latest.id === rawInstanceId &&
          latest.recurringEventId === row.recurringEventId &&
          signature(instance) === signature(latest)
        ) {
          await access.db
            .update(routineAutoSkips)
            .set({ status: 'applied' })
            .where(
              and(eq(routineAutoSkips.id, autoSkip.id), eq(routineAutoSkips.status, 'overridden')),
            );
        }
      } catch {
        // Keep the override when the Google state cannot be confirmed.
      }
    }
    if (isGoogleMissing(err)) return errorResponse(c, 404, 'NOT_FOUND');
    return responseForGoogleFailure(c, err);
  }
  if (
    patched.id !== rawInstanceId ||
    (patched.recurringEventId !== undefined && patched.recurringEventId !== row.recurringEventId)
  ) {
    return errorResponse(c, 502, 'GOOGLE_ERROR');
  }
  if (action === 'skip') {
    if (patched.status !== 'cancelled') return errorResponse(c, 502, 'GOOGLE_ERROR');
    resulting = { start: null, end: null, status: 'skipped' };
  } else {
    if (patched.status === 'cancelled') return errorResponse(c, 502, 'GOOGLE_ERROR');
    const start = instant(patched.start);
    const end = instant(patched.end);
    if (!start || !end) return errorResponse(c, 502, 'GOOGLE_ERROR');
    resulting = {
      start,
      end,
      status: getRoutineInstanceStatus({ ...original, start, end }),
    };
  }
  const parsedResponse = routineInstanceMutationResponseSchema.safeParse({
    instance: { id: rawInstanceId, ...original, ...resulting, autoSkipReason: null },
  });
  if (!parsedResponse.success) return errorResponse(c, 502, 'GOOGLE_ERROR');
  return c.json(parsedResponse.data, 200);
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
    skipHolidays: row.skipHolidays,
    skipNewYear: row.skipNewYear,
    autoSkipDue: isRoutineAutoSkipDue(row),
    status: parsedRule.status === 'ready' && timeSupported ? 'ready' : 'unsupported',
  };
}

function isRoutineAutoSkipDue(row: typeof routineSettings.$inferSelect): boolean {
  return (
    (row.skipHolidays || row.skipNewYear) &&
    (row.autoSkipAppliedUntil === null ||
      row.autoSkipAppliedUntil < addCalendarDays(getTodayDateKey(), 150))
  );
}

interface AutoSkipOccurrence {
  event: GoogleEvent;
  originalStart: string;
  originalDate: string;
  status: 'normal' | 'skipped' | 'moved';
  originalEnd: string;
}

function autoSkipOccurrence(event: GoogleEvent, duration: number): AutoSkipOccurrence | null {
  const times = originalTimes(event, duration);
  if (!times) return null;
  const status =
    event.status === 'cancelled'
      ? 'skipped'
      : (() => {
          const start = instant(event.start);
          const end = instant(event.end);
          if (!start || !end) return null;
          return getRoutineInstanceStatus({ ...times, start, end });
        })();
  if (status === null) return null;
  return {
    event,
    originalStart: times.originalStart,
    originalDate: toTokyoDateKey(times.originalStart),
    originalEnd: times.originalEnd,
    status,
  };
}

async function applyRoutineAutoSkips(
  c: RouteContext,
  access: Exclude<Awaited<ReturnType<typeof authorizeFamily>>, { response: Response }>,
  row: typeof routineSettings.$inferSelect,
  client: GoogleCalendarClient,
) {
  let master: GoogleEvent;
  try {
    master = await client.events.get(access.calendarId, row.recurringEventId);
  } catch (err) {
    return isGoogleMissing(err)
      ? errorResponse(c, 404, 'NOT_FOUND')
      : responseForGoogleFailure(c, err);
  }
  if (
    master.id !== row.recurringEventId ||
    master.status === 'cancelled' ||
    !master.recurrence?.length
  ) {
    return errorResponse(c, 404, 'NOT_FOUND');
  }
  const duration = masterDurationMs(master);
  if (duration === null) return errorResponse(c, 502, 'GOOGLE_ERROR');

  const today = getTodayDateKey();
  const through = getRoutineAutoSkipHorizon(today);
  const tomorrow = addCalendarDays(through, 1);
  const occurrences = new Map<string, AutoSkipOccurrence>();
  let pageToken: string | undefined;
  let truncatedPages = false;
  const seenPageTokens = new Set<string>();
  try {
    for (let page = 0; page < INSTANCE_PAGE_LIMIT; page += 1) {
      const result = await client.events.instances(access.calendarId, master.id, {
        timeMin: getDayBounds(today).startIso,
        timeMax: getDayBounds(tomorrow).startIso,
        showDeleted: true,
        maxResults: INSTANCE_PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const event of result.items) {
        if (event.recurringEventId !== master.id) return errorResponse(c, 502, 'GOOGLE_ERROR');
        const occurrence = autoSkipOccurrence(event, duration);
        if (!occurrence) return errorResponse(c, 502, 'GOOGLE_ERROR');
        if (occurrence.originalDate < today || occurrence.originalDate > through) continue;
        occurrences.set(occurrence.originalStart, occurrence);
      }
      const nextPageToken = result.nextPageToken;
      if (!nextPageToken) break;
      if (seenPageTokens.has(nextPageToken)) return errorResponse(c, 502, 'GOOGLE_ERROR');
      seenPageTokens.add(nextPageToken);
      if (page + 1 === INSTANCE_PAGE_LIMIT) truncatedPages = true;
      else pageToken = nextPageToken;
    }
  } catch (err) {
    return responseForGoogleFailure(c, err);
  }
  if (truncatedPages) return errorResponse(c, 503, 'GOOGLE_TEMPORARY_ERROR');

  const ledgerRows = await access.db
    .select()
    .from(routineAutoSkips)
    .where(eq(routineAutoSkips.routineSettingsId, row.id));
  const ledgerByStart = new Map(ledgerRows.map((skip) => [skip.originalStart, skip]));
  const appliedRows = ledgerRows
    .filter((skip) => skip.status === 'applied')
    .sort((a, b) => a.originalStart.localeCompare(b.originalStart));

  // Resolve pending records by original start, even when a user moved the actual instance outside the horizon.
  let unresolvedFetches = 0;
  const unresolvedStarts = new Set<string>();
  for (const skip of appliedRows) {
    if (occurrences.has(skip.originalStart)) continue;
    const originalDate = toTokyoDateKey(skip.originalStart);
    const desired = getRoutineAutoSkipReason(originalDate, row);
    if (originalDate < today) continue;
    if (originalDate > through && desired !== null) continue;
    if (desired !== null) continue;
    if (unresolvedFetches >= AUTO_SKIP_CHANGE_LIMIT) {
      unresolvedStarts.add(skip.originalStart);
      continue;
    }
    unresolvedFetches += 1;
    try {
      const page = await client.events.instances(access.calendarId, master.id, {
        originalStart: skip.originalStart,
        showDeleted: true,
        maxResults: 1,
      });
      if (page.nextPageToken) return errorResponse(c, 502, 'GOOGLE_ERROR');
      if (
        page.items.some(
          (item) =>
            item.recurringEventId !== master.id ||
            instant(item.originalStartTime) !== skip.originalStart,
        )
      )
        return errorResponse(c, 502, 'GOOGLE_ERROR');
      const event = page.items.find(
        (item) =>
          item.recurringEventId === master.id &&
          instant(item.originalStartTime) === skip.originalStart,
      );
      if (event) {
        const occurrence = autoSkipOccurrence(event, duration);
        if (!occurrence) return errorResponse(c, 502, 'GOOGLE_ERROR');
        occurrences.set(skip.originalStart, occurrence);
      }
    } catch (err) {
      return responseForGoogleFailure(c, err);
    }
  }

  type Plan =
    | { kind: 'delete'; key: string; ledger: (typeof ledgerRows)[number] }
    | { kind: 'override'; key: string; ledger: (typeof ledgerRows)[number] }
    | {
        kind: 'reason';
        key: string;
        ledger: (typeof ledgerRows)[number];
        reason: 'holiday' | 'new_year';
      }
    | {
        kind: 'restore';
        key: string;
        ledger: (typeof ledgerRows)[number];
        occurrence: AutoSkipOccurrence;
      }
    | {
        kind: 'cancel';
        key: string;
        ledger: (typeof ledgerRows)[number];
        occurrence: AutoSkipOccurrence;
        reason?: 'holiday' | 'new_year';
      }
    | { kind: 'new'; key: string; occurrence: AutoSkipOccurrence; reason: 'holiday' | 'new_year' };
  const plans: Plan[] = [];
  for (const skip of appliedRows) {
    if (unresolvedStarts.has(skip.originalStart)) continue;
    const originalDate = toTokyoDateKey(skip.originalStart);
    const desired = getRoutineAutoSkipReason(originalDate, row);
    const occurrence = occurrences.get(skip.originalStart);
    if (originalDate < today) {
      if (desired === null) plans.push({ kind: 'delete', key: skip.originalStart, ledger: skip });
      continue;
    }
    if (desired === null) {
      if (!occurrence || occurrence.status === 'normal') {
        plans.push({ kind: 'delete', key: skip.originalStart, ledger: skip });
      } else if (occurrence.status === 'skipped') {
        plans.push({ kind: 'restore', key: skip.originalStart, ledger: skip, occurrence });
      } else {
        plans.push({ kind: 'override', key: skip.originalStart, ledger: skip });
      }
      continue;
    }
    if (!occurrence) continue;
    if (occurrence.status === 'normal') {
      plans.push({
        kind: 'cancel',
        key: skip.originalStart,
        ledger: skip,
        occurrence,
        ...(skip.reason !== desired ? { reason: desired } : {}),
      });
    } else if (occurrence.status === 'moved') {
      plans.push({ kind: 'override', key: skip.originalStart, ledger: skip });
    } else if (skip.reason !== desired) {
      plans.push({ kind: 'reason', key: skip.originalStart, ledger: skip, reason: desired });
    }
  }

  for (const occurrence of [...occurrences.values()].sort((a, b) =>
    a.originalStart.localeCompare(b.originalStart),
  )) {
    if (ledgerByStart.has(occurrence.originalStart) || occurrence.status !== 'normal') continue;
    const reason = getRoutineAutoSkipCandidateReason({
      originalStart: occurrence.originalStart,
      status: occurrence.status,
      today,
      through,
      skipHolidays: row.skipHolidays,
      skipNewYear: row.skipNewYear,
    });
    if (reason) plans.push({ kind: 'new', key: occurrence.originalStart, occurrence, reason });
  }

  plans.sort((a, b) => a.key.localeCompare(b.key));
  const hasMore = plans.length > AUTO_SKIP_CHANGE_LIMIT || unresolvedStarts.size > 0;
  const selectedPlans = plans.slice(0, AUTO_SKIP_CHANGE_LIMIT);
  let pendingConcurrentWork = false;
  for (const plan of selectedPlans) {
    const currentFlags = (
      await access.db
        .select({
          skipHolidays: routineSettings.skipHolidays,
          skipNewYear: routineSettings.skipNewYear,
        })
        .from(routineSettings)
        .where(eq(routineSettings.id, row.id))
    )[0];
    if (!currentFlags) return errorResponse(c, 404, 'NOT_FOUND');
    if (
      currentFlags.skipHolidays !== row.skipHolidays ||
      currentFlags.skipNewYear !== row.skipNewYear
    ) {
      return c.json(routineAutoSkipResponseSchema.parse({ ...currentFlags, hasMore: true }), 200);
    }
    if ('ledger' in plan) {
      const currentLedger = (
        await access.db
          .select({ status: routineAutoSkips.status })
          .from(routineAutoSkips)
          .where(eq(routineAutoSkips.id, plan.ledger.id))
      )[0];
      if (!currentLedger || currentLedger.status !== 'applied') continue;
    }
    if (plan.kind === 'delete') {
      await access.db
        .delete(routineAutoSkips)
        .where(
          and(eq(routineAutoSkips.id, plan.ledger.id), eq(routineAutoSkips.status, 'applied')),
        );
      continue;
    }
    if (plan.kind === 'override') {
      await access.db
        .update(routineAutoSkips)
        .set({ status: 'overridden' })
        .where(
          and(eq(routineAutoSkips.id, plan.ledger.id), eq(routineAutoSkips.status, 'applied')),
        );
      continue;
    }
    if (plan.kind === 'reason') {
      await access.db
        .update(routineAutoSkips)
        .set({ reason: plan.reason })
        .where(
          and(eq(routineAutoSkips.id, plan.ledger.id), eq(routineAutoSkips.status, 'applied')),
        );
      continue;
    }
    if (plan.kind === 'restore') {
      const patch: Parameters<typeof client.events.patch>[2] = {
        status: 'confirmed',
        start: { date: null, dateTime: plan.occurrence.originalStart, timeZone: 'Asia/Tokyo' },
        end: { date: null, dateTime: plan.occurrence.originalEnd, timeZone: 'Asia/Tokyo' },
      };
      try {
        const restored = await client.events.patch(
          access.calendarId,
          plan.occurrence.event.id,
          patch,
          {
            sendUpdates: 'none',
          },
        );
        if (
          restored.id !== plan.occurrence.event.id ||
          restored.recurringEventId !== master.id ||
          restored.status === 'cancelled' ||
          instant(restored.start) !== plan.occurrence.originalStart ||
          instant(restored.end) !== plan.occurrence.originalEnd
        )
          return errorResponse(c, 502, 'GOOGLE_ERROR');
      } catch (err) {
        return responseForGoogleFailure(c, err);
      }
      await access.db
        .delete(routineAutoSkips)
        .where(
          and(eq(routineAutoSkips.id, plan.ledger.id), eq(routineAutoSkips.status, 'applied')),
        );
      continue;
    }
    const ledgerId = plan.kind === 'cancel' ? plan.ledger.id : crypto.randomUUID();
    if (plan.kind === 'new') {
      const inserted = await access.db
        .insert(routineAutoSkips)
        .values({
          id: ledgerId,
          routineSettingsId: row.id,
          originalStart: plan.occurrence.originalStart,
          reason: plan.reason,
          status: 'applied',
        })
        .onConflictDoNothing()
        .returning({ id: routineAutoSkips.id });
      if (inserted.length === 0) {
        const concurrent = (
          await access.db
            .select()
            .from(routineAutoSkips)
            .where(
              and(
                eq(routineAutoSkips.routineSettingsId, row.id),
                eq(routineAutoSkips.originalStart, plan.occurrence.originalStart),
              ),
            )
        )[0];
        if (!concurrent || concurrent.status === 'overridden') continue;
        pendingConcurrentWork = true;
        continue;
      }
    }
    if (plan.kind === 'cancel' && plan.reason) {
      await access.db
        .update(routineAutoSkips)
        .set({ reason: plan.reason })
        .where(
          and(eq(routineAutoSkips.id, plan.ledger.id), eq(routineAutoSkips.status, 'applied')),
        );
    }
    const cancellationLedger = (
      await access.db
        .select({ status: routineAutoSkips.status })
        .from(routineAutoSkips)
        .where(eq(routineAutoSkips.id, ledgerId))
    )[0];
    if (!cancellationLedger || cancellationLedger.status !== 'applied') continue;
    try {
      const cancelled = await client.events.patch(
        access.calendarId,
        plan.occurrence.event.id,
        { status: 'cancelled' },
        { sendUpdates: 'none' },
      );
      if (
        cancelled.id !== plan.occurrence.event.id ||
        cancelled.recurringEventId !== master.id ||
        cancelled.status !== 'cancelled'
      )
        return errorResponse(c, 502, 'GOOGLE_ERROR');
    } catch (err) {
      try {
        const latest = await client.events.get(access.calendarId, plan.occurrence.event.id);
        const actual = autoSkipOccurrence(latest, duration);
        if (
          latest.id === plan.occurrence.event.id &&
          latest.recurringEventId === master.id &&
          actual?.originalStart === plan.occurrence.originalStart &&
          actual.originalEnd === plan.occurrence.originalEnd &&
          actual.status === 'normal'
        ) {
          if (plan.kind === 'new') {
            await access.db
              .delete(routineAutoSkips)
              .where(
                and(eq(routineAutoSkips.id, ledgerId), eq(routineAutoSkips.status, 'applied')),
              );
          }
        } else if (
          latest.id === plan.occurrence.event.id &&
          latest.recurringEventId === master.id &&
          actual?.originalStart === plan.occurrence.originalStart &&
          actual.status === 'moved'
        ) {
          await access.db
            .update(routineAutoSkips)
            .set({ status: 'overridden' })
            .where(and(eq(routineAutoSkips.id, ledgerId), eq(routineAutoSkips.status, 'applied')));
        }
      } catch {
        // Keep the ledger intent when Google cannot confirm the mutation outcome.
      }
      return responseForGoogleFailure(c, err);
    }
  }

  const moreAfterSelection = plans.length > selectedPlans.length;
  const responseHasMore = hasMore || moreAfterSelection || pendingConcurrentWork;
  if (!responseHasMore) {
    await access.db
      .update(routineSettings)
      .set({ autoSkipAppliedUntil: through })
      .where(
        and(
          eq(routineSettings.id, row.id),
          eq(routineSettings.skipHolidays, row.skipHolidays),
          eq(routineSettings.skipNewYear, row.skipNewYear),
        ),
      );
  }
  return c.json(
    routineAutoSkipResponseSchema.parse({
      skipHolidays: row.skipHolidays,
      skipNewYear: row.skipNewYear,
      hasMore: responseHasMore,
    }),
    200,
  );
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
    const appliedSkipRows = await access.db
      .select()
      .from(routineAutoSkips)
      .where(
        and(
          eq(routineAutoSkips.status, 'applied'),
          inArray(
            routineAutoSkips.routineSettingsId,
            rows.map((row) => row.id),
          ),
        ),
      );
    const autoSkipReasonsByRoutine = new Map<string, Map<string, 'holiday' | 'new_year'>>();
    for (const row of appliedSkipRows) {
      const routineReasons = autoSkipReasonsByRoutine.get(row.routineSettingsId) ?? new Map();
      routineReasons.set(row.originalStart, row.reason);
      autoSkipReasonsByRoutine.set(row.routineSettingsId, routineReasons);
    }
    const client = createGoogleCalendarClient(c.env, access.session.user.id);
    const results = await withConcurrency(rows, 4, async (row) => {
      try {
        const event = await client.events.get(access.calendarId, row.recurringEventId);
        if (event.status === 'cancelled') {
          return {
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
            skipHolidays: row.skipHolidays,
            skipNewYear: row.skipNewYear,
            autoSkipDue: isRoutineAutoSkipDue(row),
            status: 'missing' as const,
            upcoming: { status: 'ready' as const, instances: [] },
          };
        }
        if (!event.recurrence?.length) {
          return {
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
            skipHolidays: row.skipHolidays,
            skipNewYear: row.skipNewYear,
            autoSkipDue: isRoutineAutoSkipDue(row),
            status: 'unsupported' as const,
            upcoming: { status: 'ready' as const, instances: [] },
          };
        }
        const routine = routineFromGoogle(
          row,
          event,
          new Set(access.activeMembers.map((member) => member.id)),
        );
        return {
          ...routine,
          upcoming:
            routine.status === 'ready'
              ? await listUpcomingInstances(
                  client,
                  access.calendarId,
                  event,
                  autoSkipReasonsByRoutine.get(row.id),
                )
              : { status: 'ready' as const, instances: [] },
        };
      } catch (err) {
        if (!isGoogleMissing(err)) throw err;
        return {
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
          skipHolidays: row.skipHolidays,
          skipNewYear: row.skipNewYear,
          autoSkipDue: isRoutineAutoSkipDue(row),
          status: 'missing' as const,
          upcoming: { status: 'ready' as const, instances: [] },
        };
      }
    });
    return c.json(routineListResponseSchema.parse({ routines: results }), 200);
  } catch (err) {
    return err instanceof GoogleCalendarError
      ? responseForGoogleFailure(c, err)
      : errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

routinesRoute.patch('/:id/routines/:routineId/settings', async (c) => {
  try {
    const access = await authorizeFamily(c);
    if ('response' in access) return access.response;
    const routineId = c.req.param('routineId');
    try {
      validatePathSegment('routineId', routineId);
    } catch {
      return errorResponse(c, 400, 'INVALID_INPUT');
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_INPUT');
    }
    const parsed = routineSettingsInputSchema.safeParse(body);
    if (!parsed.success) return errorResponse(c, 400, 'INVALID_INPUT');
    const current = (
      await access.db
        .select()
        .from(routineSettings)
        .where(
          and(
            eq(routineSettings.id, routineId),
            eq(routineSettings.familyId, access.family.id),
            eq(routineSettings.calendarId, access.calendarId),
          ),
        )
    )[0];
    if (!current) return errorResponse(c, 404, 'NOT_FOUND');
    const changed =
      current.skipHolidays !== parsed.data.skipHolidays ||
      current.skipNewYear !== parsed.data.skipNewYear;
    await access.db
      .update(routineSettings)
      .set({
        skipHolidays: parsed.data.skipHolidays,
        skipNewYear: parsed.data.skipNewYear,
        ...(changed ? { autoSkipAppliedUntil: null } : {}),
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(routineSettings.id, current.id));
    const saved = (
      await access.db.select().from(routineSettings).where(eq(routineSettings.id, current.id))
    )[0];
    if (!saved) return errorResponse(c, 500, 'INTERNAL_ERROR');
    const client = createGoogleCalendarClient(c.env, access.session.user.id, {
      reuseAccessToken: true,
      maxExternalRequests: 48,
    });
    return await applyRoutineAutoSkips(c, access, saved, client);
  } catch (err) {
    return err instanceof GoogleCalendarError
      ? responseForGoogleFailure(c, err)
      : errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

routinesRoute.post('/:id/routines/:routineId/auto-skips/apply', async (c) => {
  try {
    const access = await authorizeFamily(c);
    if ('response' in access) return access.response;
    const routineId = c.req.param('routineId');
    try {
      validatePathSegment('routineId', routineId);
    } catch {
      return errorResponse(c, 400, 'INVALID_INPUT');
    }
    let body: unknown;
    try {
      const text = await c.req.text();
      body = text.trim() === '' ? {} : JSON.parse(text);
    } catch {
      return errorResponse(c, 400, 'INVALID_INPUT');
    }
    if (!routineInstanceActionInputSchema.safeParse(body).success) {
      return errorResponse(c, 400, 'INVALID_INPUT');
    }
    const row = (
      await access.db
        .select()
        .from(routineSettings)
        .where(
          and(
            eq(routineSettings.id, routineId),
            eq(routineSettings.familyId, access.family.id),
            eq(routineSettings.calendarId, access.calendarId),
          ),
        )
    )[0];
    if (!row) return errorResponse(c, 404, 'NOT_FOUND');
    const client = createGoogleCalendarClient(c.env, access.session.user.id, {
      reuseAccessToken: true,
      maxExternalRequests: 48,
    });
    return await applyRoutineAutoSkips(c, access, row, client);
  } catch (err) {
    return err instanceof GoogleCalendarError
      ? responseForGoogleFailure(c, err)
      : errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

routinesRoute.post('/:id/routines/:routineId/instances/:instanceId/skip', async (c) => {
  try {
    return await mutateRoutineInstance(c, 'skip');
  } catch (err) {
    return err instanceof GoogleCalendarError
      ? responseForGoogleFailure(c, err)
      : errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

routinesRoute.post('/:id/routines/:routineId/instances/:instanceId/restore', async (c) => {
  try {
    return await mutateRoutineInstance(c, 'restore');
  } catch (err) {
    return err instanceof GoogleCalendarError
      ? responseForGoogleFailure(c, err)
      : errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

routinesRoute.post('/:id/routines/:routineId/instances/:instanceId/move', async (c) => {
  try {
    return await mutateRoutineInstance(c, 'move');
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
