import { env } from 'cloudflare:test';
import { SESSION_COOKIE_NAME } from '@worker/auth/config';
import { encryptAesGcm } from '@worker/auth/crypto';
import { createSession } from '@worker/auth/session';
import { createDb } from '@worker/db';
import {
  families,
  googleTokens,
  members,
  routineSettings,
  sessions,
  users,
} from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { app } from '@worker/index';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { setSignedCookie } from 'hono/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'http://localhost:5173';
const SESSION_SECRET = 'routine-test-session-secret-with-enough-entropy';
const AES_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const CALENDAR_ID = 'routine_family_calendar';
const TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'routine-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'routine-google-client-secret',
  SESSION_SECRET,
  TOKEN_ENC_KEY: AES_KEY,
};

const db = createDb(env.DB);

describe('Task 3-1 routine API', () => {
  const events = new Map<string, Record<string, unknown>>();
  let insertCount = 0;
  let deleteCount = 0;
  let patchCount = 0;
  let patchBodies: Record<string, unknown>[] = [];
  let patchUrls: URL[] = [];
  let instanceFailures = new Set<string>();
  let instanceRequests: URL[] = [];
  let conflictRequests: URL[] = [];
  let conflictPagination = false;
  let eventGetCount = 0;
  let eventGetUnauthorizedOnce = false;
  let instancePageItems = new Map<string, Record<string, unknown>[][]>();
  let deleteStatus = 204;
  let refreshTokenValues: string[] = [];
  let calendarAuthorization: string[] = [];

  beforeEach(async () => {
    events.clear();
    insertCount = 0;
    deleteCount = 0;
    patchCount = 0;
    patchBodies = [];
    patchUrls = [];
    instanceFailures = new Set();
    instanceRequests = [];
    conflictRequests = [];
    conflictPagination = false;
    eventGetCount = 0;
    eventGetUnauthorizedOnce = false;
    instancePageItems = new Map();
    deleteStatus = 204;
    refreshTokenValues = [];
    calendarAuthorization = [];
    await db.delete(routineSettings);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);
    vi.stubGlobal('fetch', async (source: RequestInfo | URL, init?: RequestInit) => {
      const request = source instanceof Request ? source : new Request(source, init);
      if (request.url === 'https://oauth2.googleapis.com/token') {
        const formData = await request.clone().formData();
        refreshTokenValues.push(formData.get('refresh_token')?.toString() ?? '');
        return Response.json({
          access_token: 'routine-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`/calendar/v3/calendars/${CALENDAR_ID}/events`)) {
        throw new Error(`Unexpected family calendar ${url.pathname}`);
      }
      calendarAuthorization.push(request.headers.get('Authorization') ?? '');
      const eventId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      if (request.method === 'GET' && url.pathname.endsWith('/instances')) {
        const masterId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
        instanceRequests.push(url);
        if (instanceFailures.has(masterId)) {
          return Response.json(
            { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } },
            { status: 404 },
          );
        }
        const timeMin = Date.parse(url.searchParams.get('timeMin') ?? '');
        const timeMax = Date.parse(url.searchParams.get('timeMax') ?? '');
        const allInstances = [...events.values()].filter((event) => {
          if (event.recurringEventId !== masterId) return false;
          const instanceBounds =
            event.status === 'cancelled'
              ? (event.originalStartTime as { dateTime?: string; date?: string } | undefined)
              : undefined;
          const startBounds =
            instanceBounds ?? (event.start as { dateTime?: string; date?: string } | undefined);
          const endBounds =
            instanceBounds ?? (event.end as { dateTime?: string; date?: string } | undefined);
          const start =
            startBounds?.dateTime ??
            (startBounds?.date ? `${startBounds.date}T00:00:00+09:00` : null);
          const end =
            endBounds?.dateTime ?? (endBounds?.date ? `${endBounds.date}T00:00:00+09:00` : null);
          if (!start || !end) return false;
          const startTime = Date.parse(start);
          const endTime = Date.parse(end);
          return startTime < timeMax && endTime >= timeMin;
        });
        const pages = instancePageItems.get(masterId);
        const pageIndex = Number(url.searchParams.get('pageToken')?.slice(4) ?? '0');
        const instances = pages ? (pages[pageIndex] ?? []) : allInstances;
        return Response.json({
          items: instances,
          ...(pages && pageIndex + 1 < pages.length
            ? { nextPageToken: `page${pageIndex + 1}` }
            : {}),
        });
      }
      if (request.method === 'POST' && url.pathname.endsWith('/events')) {
        insertCount += 1;
        const body = (await request.json()) as Record<string, unknown>;
        const id = String(body.id);
        if (events.has(id))
          return Response.json(
            { error: { code: 409, message: 'Conflict', errors: [{ reason: 'conflict' }] } },
            { status: 409 },
          );
        events.set(id, { ...body, id });
        return Response.json(events.get(id));
      }
      if (request.method === 'GET' && url.pathname.endsWith('/events')) {
        conflictRequests.push(url);
        const pageIndex = Number(url.searchParams.get('pageToken')?.slice(4) ?? '0');
        return Response.json({
          items: [...events.values()],
          ...(conflictPagination ? { nextPageToken: `page${pageIndex + 1}` } : {}),
        });
      }
      if (request.method === 'GET' && url.pathname.includes('/events/')) {
        eventGetCount += 1;
        if (eventGetUnauthorizedOnce) {
          eventGetUnauthorizedOnce = false;
          return Response.json(
            { error: { code: 401, message: 'Unauthorized', errors: [{ reason: 'authError' }] } },
            { status: 401 },
          );
        }
        const event = events.get(eventId);
        return event
          ? Response.json(
              event.status === 'cancelled'
                ? {
                    id: event.id,
                    recurringEventId: event.recurringEventId,
                    originalStartTime: event.originalStartTime,
                    status: 'cancelled',
                  }
                : event,
            )
          : Response.json(
              { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } },
              { status: 404 },
            );
      }
      if (request.method === 'PATCH' && url.pathname.includes('/events/')) {
        patchCount += 1;
        patchUrls.push(url);
        const body = (await request.json()) as Record<string, unknown>;
        patchBodies.push(body);
        const current = events.get(eventId);
        if (!current) {
          return Response.json(
            { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } },
            { status: 404 },
          );
        }
        const start = body.start as Record<string, unknown> | undefined;
        const end = body.end as Record<string, unknown> | undefined;
        const updated: Record<string, unknown> = {
          ...current,
          ...(typeof body.status === 'string' ? { status: body.status } : {}),
          ...(start ? { start: { dateTime: start.dateTime, timeZone: start.timeZone } } : {}),
          ...(end ? { end: { dateTime: end.dateTime, timeZone: end.timeZone } } : {}),
        };
        events.set(eventId, updated);
        return Response.json(
          updated.status === 'cancelled'
            ? {
                id: updated.id,
                recurringEventId: updated.recurringEventId,
                originalStartTime: updated.originalStartTime,
                status: 'cancelled',
              }
            : updated,
        );
      }
      if (request.method === 'DELETE' && url.pathname.includes('/events/')) {
        deleteCount += 1;
        if (deleteStatus !== 204) {
          return Response.json(
            {
              error: { code: deleteStatus, message: 'Not Found', errors: [{ reason: 'notFound' }] },
            },
            { status: deleteStatus },
          );
        }
        events.delete(eventId);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected Google request ${request.method} ${request.url}`);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    try {
      await env.DB.prepare('DROP TRIGGER IF EXISTS fail_routine_insert').run();
      await env.DB.prepare('DROP TRIGGER IF EXISTS fail_routine_delete').run();
      await db.delete(routineSettings);
      await db.delete(members);
      await db.delete(families);
      await db.delete(googleTokens);
      await db.delete(sessions);
      await db.delete(users);
    } catch {
      /* Next test clears D1 again. */
    }
  });

  async function makeCaller() {
    await db.insert(users).values({
      id: 'routine_owner',
      googleSub: 'routine-sub',
      email: 'owner@example.test',
      displayName: 'Owner',
    });
    const tokenEnc = await encryptAesGcm(
      'routine-refresh-token',
      AES_KEY,
      'google-refresh:routine_owner',
    );
    await db.insert(googleTokens).values({
      userId: 'routine_owner',
      refreshTokenEnc: tokenEnc,
      scopes: 'openid email profile https://www.googleapis.com/auth/calendar.app.created',
    });
    await db.insert(families).values({
      id: 'routine_family',
      name: 'テスト家族',
      ownerUserId: 'routine_owner',
      familyCalendarId: CALENDAR_ID,
      creationStatus: 'ready',
    });
    await db.insert(members).values({
      id: 'routine_adult',
      familyId: 'routine_family',
      userId: 'routine_owner',
      kind: 'adult',
      name: '大人',
      color: 'indigo',
      status: 'active',
    });
    await db.insert(members).values({
      id: 'routine_child',
      familyId: 'routine_family',
      userId: null,
      kind: 'child',
      name: '子ども',
      color: 'green',
      status: 'active',
    });
    const { rawToken } = await createSession(db, 'routine_owner');
    const cookieApp = new Hono();
    cookieApp.get('/', async (c) => {
      await setSignedCookie(c, SESSION_COOKIE_NAME, rawToken, SESSION_SECRET, {
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      });
      return c.text('ok');
    });
    return (
      (await cookieApp.request('http://localhost/')).headers.get('set-cookie')?.split(';')[0] ?? ''
    );
  }

  async function makeInviteeCaller() {
    const cookie = await makeCaller();
    await db.insert(users).values({
      id: 'routine_invitee',
      googleSub: 'routine-invitee-sub',
      email: 'invitee@example.test',
      displayName: 'Invitee',
    });
    const tokenEnc = await encryptAesGcm(
      'routine-invitee-refresh',
      AES_KEY,
      'google-refresh:routine_invitee',
    );
    await db.insert(googleTokens).values({
      userId: 'routine_invitee',
      refreshTokenEnc: tokenEnc,
      scopes: 'openid email profile https://www.googleapis.com/auth/calendar.app.created',
    });
    await db.insert(members).values({
      id: 'routine_invitee_member',
      familyId: 'routine_family',
      userId: 'routine_invitee',
      kind: 'adult',
      name: '招待された大人',
      color: 'purple',
      status: 'active',
    });
    const { rawToken } = await createSession(db, 'routine_invitee');
    const cookieApp = new Hono();
    cookieApp.get('/', async (c) => {
      await setSignedCookie(c, SESSION_COOKIE_NAME, rawToken, SESSION_SECRET, {
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      });
      return c.text('ok');
    });
    return (
      (await cookieApp.request('http://localhost/')).headers.get('set-cookie')?.split(';')[0] ??
      cookie
    );
  }

  function request(
    method: 'POST' | 'GET' | 'DELETE',
    path: string,
    cookie: string,
    body?: unknown,
  ) {
    return app.request(
      `${ORIGIN}${path}`,
      {
        method,
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: cookie,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      TEST_ENV,
    );
  }

  const payload = {
    title: 'ピアノ',
    weekdays: ['TU', 'TH'],
    interval: 2,
    startDate: '2026-10-05',
    startTime: '17:00',
    endTime: '18:00',
    endDate: '2026-12-31',
    memberIds: ['routine_child'],
    assigneeMemberId: 'routine_adult',
    category: 'lesson',
    affectsAvailability: false,
    clientRequestId: '123e4567-e89b-42d3-a456-426614174000',
  };

  function addInstance(
    id: string,
    recurringEventId: string,
    originalDate: string,
    startDate = originalDate,
    startTime = '17:00',
    endTime = '18:00',
    status = 'confirmed',
  ) {
    events.set(id, {
      id,
      recurringEventId,
      originalStartTime: { dateTime: `${originalDate}T17:00:00+09:00`, timeZone: 'Asia/Tokyo' },
      start: { dateTime: `${startDate}T${startTime}:00+09:00`, timeZone: 'Asia/Tokyo' },
      end: { dateTime: `${startDate}T${endTime}:00+09:00`, timeZone: 'Asia/Tokyo' },
      status,
      extendedProperties: { private: { opaque: 'keep-me' } },
    });
  }

  async function seedRoutineSeries(index: number, withInstance: boolean): Promise<string> {
    const routineId = `routine_budget_${index}`;
    const eventId = `routine_master_budget_${index}`;
    await db.insert(routineSettings).values({
      id: routineId,
      familyId: 'routine_family',
      calendarId: CALENDAR_ID,
      recurringEventId: eventId,
      category: 'lesson',
      defaultAssigneeMemberId: 'routine_adult',
    });
    events.set(eventId, {
      id: eventId,
      summary: `Routine ${index}`,
      start: { dateTime: '2026-10-06T17:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-10-06T18:00:00+09:00', timeZone: 'Asia/Tokyo' },
      recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU'],
      status: 'confirmed',
      extendedProperties: {
        private: {
          danran: '1',
          members: 'routine_child',
          assignee: 'routine_adult',
          status: 'confirmed',
        },
      },
    });
    if (withInstance) addInstance(`routine_instance_budget_${index}`, eventId, '2026-10-13');
    return routineId;
  }

  it('creates a Tokyo-time recurring master and recovers D1 failure on the same request', async () => {
    const cookie = await makeCaller();
    await env.DB.prepare(
      "CREATE TRIGGER fail_routine_insert BEFORE INSERT ON routine_settings BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    ).run();
    expect(
      (await request('POST', '/api/families/routine_family/routines', cookie, payload)).status,
    ).toBe(500);
    expect(events.size).toBe(1);
    await env.DB.prepare('DROP TRIGGER fail_routine_insert').run();
    const response = await request(
      'POST',
      '/api/families/routine_family/routines',
      cookie,
      payload,
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { routineId: string; eventId: string };
    expect(insertCount).toBe(2);
    expect(events.size).toBe(1);
    const googleEvent = events.get(result.eventId);
    expect(googleEvent).toMatchObject({
      summary: 'ピアノ',
      start: { dateTime: '2026-10-06T17:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-10-06T18:00:00+09:00', timeZone: 'Asia/Tokyo' },
      recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261231T145959Z'],
      extendedProperties: {
        private: {
          danran: '1',
          members: 'routine_child',
          assignee: 'routine_adult',
          status: 'confirmed',
        },
      },
    });
    const rows = await db
      .select()
      .from(routineSettings)
      .where(eq(routineSettings.id, result.routineId));
    expect(rows[0]).toMatchObject({
      category: 'lesson',
      affectsAvailability: false,
      defaultAssigneeMemberId: 'routine_adult',
    });
    expect(calendarAuthorization).toEqual([
      'Bearer routine-access-token',
      'Bearer routine-access-token',
      'Bearer routine-access-token',
    ]);
    expect(refreshTokenValues).toEqual(['routine-refresh-token', 'routine-refresh-token']);
  });

  it('uses the invited adult caller token and ignores client calendar IDs', async () => {
    const cookie = await makeInviteeCaller();
    const invalid = await request('POST', '/api/families/routine_family/routines', cookie, {
      ...payload,
      calendarId: 'attacker-calendar',
    });
    expect(invalid.status).toBe(400);
    expect(events.size).toBe(0);
    const response = await request(
      'POST',
      '/api/families/routine_family/routines',
      cookie,
      payload,
    );
    expect(response.status).toBe(200);
    expect(refreshTokenValues).toEqual(['routine-invitee-refresh']);
    expect(calendarAuthorization).toEqual(['Bearer routine-access-token']);
  });

  it.each([
    ['empty weekdays', { weekdays: [] }],
    ['end time before start', { endTime: '17:00' }],
    ['end date before first chosen weekday', { endDate: '2026-10-05' }],
    ['title over 200 characters', { title: 'あ'.repeat(201) }],
    ['unknown member', { memberIds: ['unknown_member'] }],
    ['child assignee', { assigneeMemberId: 'routine_child' }],
    ['client calendar id', { calendarId: 'attacker-calendar' }],
  ])('rejects invalid routine input: %s', async (_label, changes) => {
    const cookie = await makeCaller();
    const response = await request('POST', '/api/families/routine_family/routines', cookie, {
      ...payload,
      ...changes,
    });
    expect(response.status).toBe(400);
    expect(events.size).toBe(0);
    expect(refreshTokenValues).toHaveLength(0);
  });

  it('rejects requests with no session, a nonmember, a nonready family, or an unsafe origin', async () => {
    const cookie = await makeCaller();
    expect(
      (await request('POST', '/api/families/routine_family/routines', '', payload)).status,
    ).toBe(401);
    await db.insert(users).values({
      id: 'routine_stranger',
      googleSub: 'routine-stranger-sub',
      email: 'stranger@example.test',
      displayName: 'Stranger',
    });
    const { rawToken } = await createSession(db, 'routine_stranger');
    const cookieApp = new Hono();
    cookieApp.get('/', async (c) => {
      await setSignedCookie(c, SESSION_COOKIE_NAME, rawToken, SESSION_SECRET, {
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      });
      return c.text('ok');
    });
    const strangerCookie =
      (await cookieApp.request('http://localhost/')).headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(
      (await request('POST', '/api/families/routine_family/routines', strangerCookie, payload))
        .status,
    ).toBe(404);
    await db
      .update(families)
      .set({ creationStatus: 'creating' })
      .where(eq(families.id, 'routine_family'));
    expect(
      (await request('POST', '/api/families/routine_family/routines', cookie, payload)).status,
    ).toBe(409);
    const badOrigin = await app.request(
      `${ORIGIN}/api/families/routine_family/routines`,
      {
        method: 'POST',
        headers: {
          Origin: 'https://attacker.example',
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      TEST_ENV,
    );
    expect(badOrigin.status).toBe(403);
  });

  it('rejects mutation bodies over the shared 16 KiB limit', async () => {
    const cookie = await makeCaller();
    const response = await request('POST', '/api/families/routine_family/routines', cookie, {
      ...payload,
      title: 'あ'.repeat(17000),
    });
    expect(response.status).toBe(413);
  });

  it('reuses the same row on an identical retry and rejects changed input for a reused request id', async () => {
    const cookie = await makeCaller();
    const first = await request('POST', '/api/families/routine_family/routines', cookie, payload);
    const firstBody = (await first.json()) as { routineId: string; eventId: string };
    const retry = await request('POST', '/api/families/routine_family/routines', cookie, payload);
    expect(await retry.json()).toEqual(firstBody);
    expect((await db.select().from(routineSettings)).map((row) => row.id)).toEqual([
      firstBody.routineId,
    ]);
    const changed = await request('POST', '/api/families/routine_family/routines', cookie, {
      ...payload,
      category: 'other',
    });
    expect(changed.status).toBe(400);
    expect((await db.select().from(routineSettings)).length).toBe(1);
  });

  it('lists masters, treats a removed master as missing, and deletes the full series idempotently', async () => {
    const cookie = await makeCaller();
    const created = await request('POST', '/api/families/routine_family/routines', cookie, payload);
    const result = (await created.json()) as { routineId: string; eventId: string };
    const list = await request('GET', '/api/families/routine_family/routines', cookie);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      routines: [
        {
          id: result.routineId,
          title: 'ピアノ',
          status: 'ready',
          weekdays: ['TU', 'TH'],
          startDate: '2026-10-06',
          endDate: '2026-12-31',
          affectsAvailability: false,
        },
      ],
    });
    events.delete(result.eventId);
    expect(
      await (await request('GET', '/api/families/routine_family/routines', cookie)).json(),
    ).toMatchObject({ routines: [{ status: 'missing' }] });
    const deleted = await request(
      'DELETE',
      `/api/families/routine_family/routines/${result.routineId}`,
      cookie,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(deleteCount).toBe(1);
    expect((await db.select().from(routineSettings)).length).toBe(0);
  });

  it('uses one token per list request across parallel routines and the single conflict scan', async () => {
    const cookie = await makeCaller();
    const firstResponse = await request(
      'POST',
      '/api/families/routine_family/routines',
      cookie,
      payload,
    );
    const first = (await firstResponse.json()) as { eventId: string };
    const secondResponse = await request('POST', '/api/families/routine_family/routines', cookie, {
      ...payload,
      title: '英語',
      clientRequestId: '123e4567-e89b-42d3-a456-426614174001',
    });
    const second = (await secondResponse.json()) as { eventId: string };
    addInstance('routine_instance_first', first.eventId, '2026-10-13');
    addInstance('routine_instance_second', second.eventId, '2026-10-13');

    const tokenCountBeforeFirstList = refreshTokenValues.length;
    const firstList = await request('GET', '/api/families/routine_family/routines', cookie);
    expect(firstList.status).toBe(200);
    expect(refreshTokenValues).toHaveLength(tokenCountBeforeFirstList + 1);
    expect(instanceRequests).toHaveLength(2);
    expect(conflictRequests).toHaveLength(1);

    const tokenCountBeforeSecondList = refreshTokenValues.length;
    const secondList = await request('GET', '/api/families/routine_family/routines', cookie);
    expect(secondList.status).toBe(200);
    expect(refreshTokenValues).toHaveLength(tokenCountBeforeSecondList + 1);
    expect(conflictRequests).toHaveLength(2);
  });

  it('refreshes once and retries a routine list Calendar request after 401', async () => {
    const cookie = await makeCaller();
    const created = await request('POST', '/api/families/routine_family/routines', cookie, payload);
    expect(created.status).toBe(200);
    eventGetUnauthorizedOnce = true;
    const tokenCountBeforeList = refreshTokenValues.length;
    const eventGetCountBeforeList = eventGetCount;

    const response = await request('GET', '/api/families/routine_family/routines', cookie);
    expect(response.status).toBe(200);
    expect(refreshTokenValues).toHaveLength(tokenCountBeforeList + 2);
    expect(eventGetCount).toBe(eventGetCountBeforeList + 2);
  });

  it('fits ten one-page routine series and one conflict scan inside the shared budget', async () => {
    const cookie = await makeCaller();
    for (let index = 0; index < 10; index += 1) {
      await seedRoutineSeries(index, true);
    }
    const tokenCountBeforeList = refreshTokenValues.length;
    const calendarCallCountBeforeList = calendarAuthorization.length;

    const response = await request('GET', '/api/families/routine_family/routines', cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      routines: Array<{ status: string; upcoming: { status: string; conflictsStatus: string } }>;
    };
    expect(body.routines).toHaveLength(10);
    expect(
      body.routines.every(
        (routine) =>
          routine.status === 'ready' &&
          routine.upcoming.status === 'ready' &&
          routine.upcoming.conflictsStatus === 'ready',
      ),
    ).toBe(true);
    expect(refreshTokenValues).toHaveLength(tokenCountBeforeList + 1);
    expect(calendarAuthorization).toHaveLength(calendarCallCountBeforeList + 21);
    expect(conflictRequests).toHaveLength(1);
  });

  it('does not expose or delete another family routine', async () => {
    const cookie = await makeCaller();
    const created = await request('POST', '/api/families/routine_family/routines', cookie, payload);
    const own = (await created.json()) as { routineId: string };
    await db.insert(users).values({
      id: 'routine_other_owner',
      googleSub: 'routine-other-sub',
      email: 'other@example.test',
      displayName: 'Other',
    });
    await db.insert(families).values({
      id: 'routine_other_family',
      name: '別の家族',
      ownerUserId: 'routine_other_owner',
      familyCalendarId: 'other_family_calendar',
      creationStatus: 'ready',
    });
    await db.insert(members).values({
      id: 'routine_other_adult',
      familyId: 'routine_other_family',
      userId: 'routine_other_owner',
      kind: 'adult',
      name: 'Other',
      color: 'teal',
      status: 'active',
    });
    await db.insert(routineSettings).values({
      id: 'routine_other_row',
      familyId: 'routine_other_family',
      calendarId: 'other_family_calendar',
      recurringEventId: 'other_family_master',
      category: 'other',
    });
    const getCountBeforeForeignRow = eventGetCount;
    expect(
      (
        await request(
          'POST',
          '/api/families/routine_family/routines/other_family_routine/instances/foreign_instance/skip',
          cookie,
        )
      ).status,
    ).toBe(404);
    expect(eventGetCount).toBe(getCountBeforeForeignRow);
    const list = await request('GET', '/api/families/routine_family/routines', cookie);
    expect(await list.json()).toMatchObject({ routines: [{ id: own.routineId }] });
    const deleteCountBefore = deleteCount;
    const response = await request(
      'DELETE',
      '/api/families/routine_family/routines/routine_other_row',
      cookie,
    );
    expect(response.status).toBe(404);
    expect(deleteCount).toBe(deleteCountBefore);
  });

  it.each([404, 410])(
    'treats an already removed Google series (%s) as a successful delete',
    async (status) => {
      const cookie = await makeCaller();
      const created = await request(
        'POST',
        '/api/families/routine_family/routines',
        cookie,
        payload,
      );
      const { routineId } = (await created.json()) as { routineId: string };
      deleteStatus = status;
      const response = await request(
        'DELETE',
        `/api/families/routine_family/routines/${routineId}`,
        cookie,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect((await db.select().from(routineSettings)).length).toBe(0);
    },
  );

  it('recovers when Google deletes the master but D1 deletion fails', async () => {
    const cookie = await makeCaller();
    const created = await request('POST', '/api/families/routine_family/routines', cookie, payload);
    const { routineId } = (await created.json()) as { routineId: string };
    await env.DB.prepare(
      "CREATE TRIGGER fail_routine_delete BEFORE DELETE ON routine_settings BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    ).run();
    expect(
      (await request('DELETE', `/api/families/routine_family/routines/${routineId}`, cookie))
        .status,
    ).toBe(500);
    await env.DB.prepare('DROP TRIGGER fail_routine_delete').run();
    deleteStatus = 404;
    expect(
      (await request('DELETE', `/api/families/routine_family/routines/${routineId}`, cookie))
        .status,
    ).toBe(200);
    expect((await db.select().from(routineSettings)).length).toBe(0);
  });

  it('returns four instances by original Tokyo date, including ended-today, skipped, and moved rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T16:30:00.000Z'));
    try {
      const cookie = await makeCaller();
      const created = await request(
        'POST',
        '/api/families/routine_family/routines',
        cookie,
        payload,
      );
      const { routineId, eventId } = (await created.json()) as {
        routineId: string;
        eventId: string;
      };
      addInstance('instance_today', eventId, '2026-10-06', '2026-10-06', '00:05', '01:05');
      const todayInstance = events.get('instance_today');
      if (todayInstance) {
        todayInstance.originalStartTime = {
          dateTime: '2026-10-06T00:05:00+09:00',
          timeZone: 'Asia/Tokyo',
        };
      }
      addInstance('instance_yesterday', eventId, '2026-10-05');
      addInstance(
        'instance_skipped',
        eventId,
        '2026-10-13',
        '2026-10-13',
        '17:00',
        '18:00',
        'cancelled',
      );
      const cancelled = events.get('instance_skipped');
      if (cancelled) {
        cancelled.start = undefined;
        cancelled.end = undefined;
      }
      addInstance('instance_moved', eventId, '2026-10-20', '2026-10-05', '18:00', '19:00');
      addInstance('instance_fourth', eventId, '2026-10-27');
      addInstance('instance_fifth', eventId, '2026-11-03');
      const response = await request('GET', '/api/families/routine_family/routines', cookie);
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        routines: Array<{
          id: string;
          upcoming: {
            status: string;
            instances: Array<{
              id: string;
              status: string;
              originalStart: string;
              start: string | null;
            }>;
          };
        }>;
      };
      const upcoming = result.routines.find((routine) => routine.id === routineId)?.upcoming;
      expect(upcoming).toMatchObject({
        status: 'ready',
        instances: [
          { id: 'instance_today', status: 'normal', start: '2026-10-06T00:05:00+09:00' },
          { id: 'instance_skipped', status: 'skipped', start: null },
          { id: 'instance_moved', status: 'moved', start: '2026-10-05T18:00:00+09:00' },
          { id: 'instance_fourth', status: 'normal' },
        ],
      });
      expect(upcoming?.instances).toHaveLength(4);
      expect(upcoming?.instances.some((instance) => instance.id === 'instance_fifth')).toBe(false);
      expect(upcoming?.instances.some((instance) => instance.id === 'instance_yesterday')).toBe(
        false,
      );
      expect(instanceRequests).toHaveLength(1);
      expect(instanceRequests[0]?.searchParams.get('showDeleted')).toBe('true');
      expect(instanceRequests[0]?.searchParams.get('timeMin')).toBe('2026-09-05T00:00:00+09:00');
      expect(instanceRequests[0]?.searchParams.get('timeMax')).toBe('2027-02-03T00:00:00+09:00');
      expect(instanceRequests[0]?.searchParams.get('maxResults')).toBe('250');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks only the failed series unavailable and rejects a truncated page sequence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T15:30:00.000Z'));
    try {
      const cookie = await makeCaller();
      const first = await request('POST', '/api/families/routine_family/routines', cookie, payload);
      const firstBody = (await first.json()) as { routineId: string; eventId: string };
      const second = await request('POST', '/api/families/routine_family/routines', cookie, {
        ...payload,
        title: '英語',
        clientRequestId: '123e4567-e89b-42d3-a456-426614174001',
      });
      const secondBody = (await second.json()) as { routineId: string; eventId: string };
      instanceFailures.add(firstBody.eventId);
      const list = await request('GET', '/api/families/routine_family/routines', cookie);
      expect(await list.json()).toMatchObject({
        routines: [
          { id: firstBody.routineId, upcoming: { status: 'unavailable', instances: [] } },
          { id: secondBody.routineId, upcoming: { status: 'ready', instances: [] } },
        ],
      });
      instanceFailures.clear();
      instancePageItems.set(firstBody.eventId, [[], [], [], [], []]);
      addInstance('instance_for_ready_series', secondBody.eventId, '2026-10-13');
      const previousRequestCount = instanceRequests.length;
      const truncated = await request('GET', '/api/families/routine_family/routines', cookie);
      const truncatedBody = (await truncated.json()) as {
        routines: Array<{ id: string; upcoming: { status: string; instances: unknown[] } }>;
      };
      expect(truncatedBody.routines).toMatchObject([
        { id: firstBody.routineId, upcoming: { status: 'unavailable', instances: [] } },
        {
          id: secondBody.routineId,
          upcoming: { status: 'ready', instances: [{ id: 'instance_for_ready_series' }] },
        },
      ]);
      const paginatedRequests = instanceRequests
        .slice(previousRequestCount)
        .filter((url) => url.pathname.endsWith('/instances'));
      expect(paginatedRequests).toHaveLength(5);
      expect(
        paginatedRequests.filter((url) =>
          url.pathname.includes(encodeURIComponent(firstBody.eventId)),
        ),
      ).toHaveLength(4);
      expect(
        paginatedRequests.filter((url) =>
          url.pathname.includes(encodeURIComponent(secondBody.eventId)),
        ),
      ).toHaveLength(1);
      expect(
        paginatedRequests
          .filter((url) => url.pathname.includes(encodeURIComponent(firstBody.eventId)))
          .map((url) => url.searchParams.get('pageToken')),
      ).toEqual([null, 'page1', 'page2', 'page3']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns partial routines when the shared budget expires on master or instance reads', async () => {
    const cookie = await makeCaller();
    for (let index = 0; index < 25; index += 1) {
      await seedRoutineSeries(index, false);
    }

    const response = await request('GET', '/api/families/routine_family/routines', cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      routines: Array<{ status: string; upcoming: { status: string } }>;
    };
    expect(body.routines).toHaveLength(25);
    expect(body.routines.some((routine) => routine.status === 'unsupported')).toBe(true);
    expect(
      body.routines.some(
        (routine) => routine.status === 'unsupported' && routine.upcoming.status === 'unavailable',
      ),
    ).toBe(true);
    expect(
      body.routines.some(
        (routine) => routine.status === 'ready' && routine.upcoming.status === 'unavailable',
      ),
    ).toBe(true);
  });

  it('keeps the list and marks conflict verification unavailable when its budget runs out', async () => {
    const cookie = await makeCaller();
    conflictPagination = true;
    for (let index = 0; index < 22; index += 1) {
      await seedRoutineSeries(index, true);
    }

    const response = await request('GET', '/api/families/routine_family/routines', cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      routines: Array<{ upcoming: { status: string; conflictsStatus: string } }>;
    };
    expect(body.routines).toHaveLength(22);
    expect(body.routines.every((routine) => routine.upcoming.status === 'ready')).toBe(true);
    expect(
      body.routines.every((routine) => routine.upcoming.conflictsStatus === 'unavailable'),
    ).toBe(true);
    expect(conflictRequests).toHaveLength(3);
  });

  it('sorts instances from every page by their original date even when actual dates reorder them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T03:00:00.000Z'));
    try {
      const cookie = await makeCaller();
      const created = await request(
        'POST',
        '/api/families/routine_family/routines',
        cookie,
        payload,
      );
      const { routineId, eventId } = (await created.json()) as {
        routineId: string;
        eventId: string;
      };
      addInstance('paged_later', eventId, '2026-10-20', '2026-10-07');
      addInstance('paged_earlier', eventId, '2026-10-13', '2026-10-30');
      instancePageItems.set(eventId, [
        [events.get('paged_later') as Record<string, unknown>],
        [events.get('paged_earlier') as Record<string, unknown>],
      ]);
      const response = await request('GET', '/api/families/routine_family/routines', cookie);
      const body = (await response.json()) as {
        routines: Array<{ id: string; upcoming: { instances: Array<{ id: string }> } }>;
      };
      expect(body.routines.find((routine) => routine.id === routineId)?.upcoming.instances).toEqual(
        [
          expect.objectContaining({ id: 'paged_earlier' }),
          expect.objectContaining({ id: 'paged_later' }),
        ],
      );
      expect(instanceRequests).toHaveLength(2);
      expect(instanceRequests[0]?.searchParams.get('pageToken')).toBeNull();
      expect(instanceRequests[1]?.searchParams.get('pageToken')).toBe('page1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips, moves a cancelled instance, and restores it while preserving private properties', async () => {
    const cookie = await makeCaller();
    const created = await request('POST', '/api/families/routine_family/routines', cookie, payload);
    const { routineId, eventId } = (await created.json()) as { routineId: string; eventId: string };
    addInstance('instance_owned', eventId, '2026-10-13');
    const path = `/api/families/routine_family/routines/${routineId}/instances/instance_owned`;

    const tokenCountBeforeSkip = refreshTokenValues.length;
    const firstSkip = await request('POST', `${path}/skip`, cookie);
    expect(firstSkip.status).toBe(200);
    expect(refreshTokenValues).toHaveLength(tokenCountBeforeSkip + 1);
    expect(await firstSkip.json()).toMatchObject({
      instance: {
        id: 'instance_owned',
        status: 'skipped',
        originalStart: '2026-10-13T17:00:00+09:00',
        originalEnd: '2026-10-13T18:00:00+09:00',
        start: null,
        end: null,
      },
    });
    expect((await request('POST', `${path}/skip`, cookie)).status).toBe(200);
    expect(patchBodies[0]).toEqual({ status: 'cancelled' });

    const moved = await request('POST', `${path}/move`, cookie, {
      date: '2026-10-15',
      startTime: '18:30',
      endTime: '19:30',
    });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({
      instance: {
        status: 'moved',
        start: '2026-10-15T18:30:00+09:00',
        end: '2026-10-15T19:30:00+09:00',
      },
    });
    expect(patchBodies[2]).toEqual({
      status: 'confirmed',
      start: { date: null, dateTime: '2026-10-15T18:30:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { date: null, dateTime: '2026-10-15T19:30:00+09:00', timeZone: 'Asia/Tokyo' },
    });
    expect(
      (
        await request('POST', `${path}/move`, cookie, {
          date: '2026-10-15',
          startTime: '18:30',
          endTime: '19:30',
        })
      ).status,
    ).toBe(200);
    expect(patchBodies[3]).toEqual(patchBodies[2]);
    expect(patchUrls.every((url) => url.searchParams.get('sendUpdates') === 'none')).toBe(true);

    const restored = await request('POST', `${path}/restore`, cookie);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      instance: {
        status: 'normal',
        start: '2026-10-13T17:00:00+09:00',
        end: '2026-10-13T18:00:00+09:00',
      },
    });
    expect(patchBodies[4]).toEqual({
      status: 'confirmed',
      start: { date: null, dateTime: '2026-10-13T17:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { date: null, dateTime: '2026-10-13T18:00:00+09:00', timeZone: 'Asia/Tokyo' },
    });
    expect(events.get('instance_owned')?.extendedProperties).toEqual({
      private: { opaque: 'keep-me' },
    });
    expect(patchBodies.every((body) => !('extendedProperties' in body))).toBe(true);
  });

  it('rejects foreign, other-series, single, and missing instance IDs before patching', async () => {
    const cookie = await makeCaller();
    const created = await request('POST', '/api/families/routine_family/routines', cookie, payload);
    const own = (await created.json()) as { routineId: string; eventId: string };
    const second = await request('POST', '/api/families/routine_family/routines', cookie, {
      ...payload,
      clientRequestId: '123e4567-e89b-42d3-a456-426614174001',
    });
    const otherSeries = (await second.json()) as { eventId: string };
    addInstance('other_series_instance', otherSeries.eventId, '2026-10-13');
    events.set('single_instance', {
      id: 'single_instance',
      start: { dateTime: '2026-10-13T17:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-10-13T18:00:00+09:00', timeZone: 'Asia/Tokyo' },
    });
    addInstance('foreign_instance', 'another_family_master', '2026-10-13');
    await db.insert(users).values({
      id: 'routine_other_owner',
      googleSub: 'routine-other-sub',
      email: 'other@example.test',
      displayName: 'Other',
    });
    await db.insert(families).values({
      id: 'routine_other_family',
      name: '別の家族',
      ownerUserId: 'routine_other_owner',
      familyCalendarId: 'other_family_calendar',
      creationStatus: 'ready',
    });
    await db.insert(routineSettings).values({
      id: 'other_family_routine',
      familyId: 'routine_other_family',
      calendarId: 'other_family_calendar',
      recurringEventId: 'another_family_master',
      category: 'other',
    });
    for (const id of [
      'other_series_instance',
      'foreign_instance',
      'single_instance',
      'missing_instance',
    ]) {
      const before = patchCount;
      const response = await request(
        'POST',
        `/api/families/routine_family/routines/${own.routineId}/instances/${id}/skip`,
        cookie,
      );
      expect(response.status).toBe(404);
      expect(patchCount).toBe(before);
    }
  });

  it.each([
    ['end before start', { date: '2026-10-15', startTime: '18:30', endTime: '18:00' }],
    ['invalid date', { date: '2026-02-30', startTime: '18:30', endTime: '19:30' }],
    ['date before supported range', { date: '1969-12-31', startTime: '18:30', endTime: '19:30' }],
    ['date after supported range', { date: '2051-01-01', startTime: '18:30', endTime: '19:30' }],
    [
      'unknown action field',
      { date: '2026-10-15', startTime: '18:30', endTime: '19:30', status: 'cancelled' },
    ],
  ])('rejects invalid instance moves: %s', async (_label, body) => {
    const cookie = await makeCaller();
    const created = await request('POST', '/api/families/routine_family/routines', cookie, payload);
    const { routineId, eventId } = (await created.json()) as { routineId: string; eventId: string };
    addInstance('instance_owned', eventId, '2026-10-13');
    const response = await request(
      'POST',
      `/api/families/routine_family/routines/${routineId}/instances/instance_owned/move`,
      cookie,
      body,
    );
    expect(response.status).toBe(400);
    expect(patchCount).toBe(0);
  });

  it('applies session, family membership, origin, request header, and body-size protections to instance routes', async () => {
    const cookie = await makeCaller();
    const created = await request('POST', '/api/families/routine_family/routines', cookie, payload);
    const { routineId, eventId } = (await created.json()) as { routineId: string; eventId: string };
    addInstance('instance_owned', eventId, '2026-10-13');
    const path = `/api/families/routine_family/routines/${routineId}/instances/instance_owned/skip`;
    expect(
      (
        await request(
          'POST',
          `/api/families/routine_family/routines/${routineId}/instances/instance_owned/skip`,
          '',
        )
      ).status,
    ).toBe(401);

    await db.insert(users).values({
      id: 'routine_stranger',
      googleSub: 'routine-stranger-sub',
      email: 'stranger@example.test',
      displayName: 'Stranger',
    });
    const { rawToken } = await createSession(db, 'routine_stranger');
    const cookieApp = new Hono();
    cookieApp.get('/', async (c) => {
      await setSignedCookie(c, SESSION_COOKIE_NAME, rawToken, SESSION_SECRET, {
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      });
      return c.text('ok');
    });
    const strangerCookie =
      (await cookieApp.request('http://localhost/')).headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(
      (
        await request(
          'POST',
          `/api/families/routine_family/routines/${routineId}/instances/instance_owned/skip`,
          strangerCookie,
        )
      ).status,
    ).toBe(404);

    const badOrigin = await app.request(
      `${ORIGIN}${path}`,
      {
        method: 'POST',
        headers: {
          Origin: 'https://attacker.example',
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: cookie,
        },
      },
      TEST_ENV,
    );
    expect(badOrigin.status).toBe(403);
    const missingRequestedWith = await app.request(
      `${ORIGIN}${path}`,
      {
        method: 'POST',
        headers: { Origin: ORIGIN, Cookie: cookie },
      },
      TEST_ENV,
    );
    expect(missingRequestedWith.status).toBe(403);
    const oversized = await app.request(
      `${ORIGIN}/api/families/routine_family/routines/${routineId}/instances/instance_owned/move`,
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          date: '2026-10-15',
          startTime: '18:00',
          endTime: '19:00',
          extra: 'x'.repeat(17000),
        }),
      },
      TEST_ENV,
    );
    expect(oversized.status).toBe(413);
    expect(patchCount).toBe(0);
  });
});
