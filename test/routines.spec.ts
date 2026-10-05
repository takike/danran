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
  let deleteStatus = 204;
  let refreshTokenValues: string[] = [];
  let calendarAuthorization: string[] = [];

  beforeEach(async () => {
    events.clear();
    insertCount = 0;
    deleteCount = 0;
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
        return Response.json({ items: [...events.values()] });
      }
      if (request.method === 'GET' && url.pathname.includes('/events/')) {
        const event = events.get(eventId);
        return event
          ? Response.json(event)
          : Response.json(
              { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } },
              { status: 404 },
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
    expect(refreshTokenValues).toEqual([
      'routine-refresh-token',
      'routine-refresh-token',
      'routine-refresh-token',
    ]);
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
});
