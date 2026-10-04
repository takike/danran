import { env } from 'cloudflare:test';
import { eventMutationResponseSchema } from '@shared/schemas/events';
import { weekResponseSchema } from '@shared/schemas/week';
import { SESSION_COOKIE_NAME } from '@worker/auth/config';
import { encryptAesGcm } from '@worker/auth/crypto';
import { createSession } from '@worker/auth/session';
import { createDb } from '@worker/db';
import { eventMeta, families, googleTokens, members, sessions, users } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { app } from '@worker/index';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { setSignedCookie } from 'hono/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'http://localhost:5173';
const SESSION_SECRET = 'events-test-session-secret-with-enough-entropy';
const AES_KEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';
const CALENDAR_ID = 'family_calendar_test';
const EVENT_ID = '0123456789abcdefghijklmnopqrstuv0123456789abcdefghijklmnopqrstuv';
const TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'events-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'events-google-client-secret',
  SESSION_SECRET,
  TOKEN_ENC_KEY: AES_KEY,
};

const input = {
  title: '運動会',
  time: {
    kind: 'timed',
    start: '2026-10-05T09:00:00+09:00',
    endExclusive: '2026-10-05T10:00:00+09:00',
  },
  memberIds: ['mem_child'],
  assigneeMemberId: 'mem_adult',
  items: ['水筒'],
  status: 'tentative',
};

describe('Task 1-8 event API', () => {
  const db = createDb(env.DB);
  const requests: Array<{
    url: string;
    method: string;
    body: unknown;
    authorization: string | null;
  }> = [];
  const storedGoogleEvents = new Map<string, Record<string, unknown>>();
  const refreshTokens: string[] = [];
  let insertCount = 0;
  let deleteStatus = 204;
  let forcedCalendarStatus: number | null = null;

  beforeEach(async () => {
    requests.length = 0;
    refreshTokens.length = 0;
    storedGoogleEvents.clear();
    insertCount = 0;
    deleteStatus = 204;
    forcedCalendarStatus = null;
    await db.delete(eventMeta);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);

    vi.stubGlobal('fetch', async (source: RequestInfo | URL, init?: RequestInit) => {
      const request = source instanceof Request ? source : new Request(source, init);
      if (request.url === 'https://oauth2.googleapis.com/token') {
        const formData = await request.clone().formData();
        refreshTokens.push(formData.get('refresh_token')?.toString() ?? '');
        return Response.json({
          access_token: 'events-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      const url = new URL(request.url);
      const body =
        request.method === 'GET' || request.method === 'DELETE'
          ? undefined
          : (JSON.parse(await request.clone().text()) as unknown);
      requests.push({
        url: request.url,
        method: request.method,
        body,
        authorization: request.headers.get('Authorization'),
      });
      if (forcedCalendarStatus !== null && url.pathname.includes('/events')) {
        return Response.json(
          {
            error: {
              code: forcedCalendarStatus,
              message: 'private upstream detail',
              errors: [
                { reason: forcedCalendarStatus === 429 ? 'rateLimitExceeded' : 'backendError' },
              ],
            },
          },
          { status: forcedCalendarStatus },
        );
      }
      if (
        url.pathname === `/calendar/v3/calendars/${CALENDAR_ID}/events` &&
        request.method === 'POST'
      ) {
        insertCount += 1;
        const eventBody = body as Record<string, unknown>;
        const eventId = String(eventBody.id);
        if (storedGoogleEvents.has(eventId)) {
          return Response.json(
            { error: { code: 409, message: 'Conflict', errors: [{ reason: 'conflict' }] } },
            { status: 409 },
          );
        }
        const saved = { ...eventBody, id: eventId };
        storedGoogleEvents.set(eventId, saved);
        return Response.json(saved);
      }
      if (
        url.pathname === `/calendar/v3/calendars/${CALENDAR_ID}/events` &&
        request.method === 'GET'
      ) {
        return Response.json({ items: [...storedGoogleEvents.values()] });
      }
      const eventMatch = url.pathname.match(
        new RegExp(`/calendar/v3/calendars/${CALENDAR_ID}/events/([^/]+)$`),
      );
      if (eventMatch) {
        const eventId = decodeURIComponent(eventMatch[1] ?? '');
        if (request.method === 'GET') {
          const event = storedGoogleEvents.get(eventId);
          return event
            ? Response.json(event)
            : Response.json(
                { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } },
                { status: 404 },
              );
        }
        if (request.method === 'PATCH') {
          const current = storedGoogleEvents.get(eventId);
          if (!current)
            return Response.json(
              { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } },
              { status: 404 },
            );
          const patchBody = body as Record<string, unknown>;
          const updated = { ...current, ...patchBody };
          for (const key of ['start', 'end']) {
            const value = patchBody[key];
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
              updated[key] = Object.fromEntries(
                Object.entries(value).filter(([, fieldValue]) => fieldValue !== null),
              );
            }
          }
          storedGoogleEvents.set(eventId, updated);
          return Response.json(updated);
        }
        if (request.method === 'DELETE') {
          if (deleteStatus === 204) storedGoogleEvents.delete(eventId);
          return new Response(null, { status: deleteStatus });
        }
      }
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    try {
      await env.DB.prepare('DROP TRIGGER IF EXISTS fail_event_meta_insert').run();
      await db.delete(eventMeta);
      await db.delete(members);
      await db.delete(families);
      await db.delete(googleTokens);
      await db.delete(sessions);
      await db.delete(users);
    } catch {
      /* D1 is cleaned again by the next test */
    }
  });

  async function createCaller() {
    await db.insert(users).values({
      id: 'usr_owner',
      googleSub: 'sub-owner',
      email: 'owner@example.test',
      displayName: 'Owner',
    });
    await db.insert(users).values({
      id: 'usr_caller',
      googleSub: 'sub-caller',
      email: 'caller@example.test',
      displayName: 'Caller',
    });
    const refreshTokenEnc = await encryptAesGcm(
      'caller-refresh-token',
      AES_KEY,
      'google-refresh:usr_caller',
    );
    await db.insert(googleTokens).values({
      userId: 'usr_caller',
      refreshTokenEnc,
      scopes: 'openid email profile https://www.googleapis.com/auth/calendar.app.created',
    });
    await db.insert(families).values({
      id: 'fam_events',
      name: 'テスト家族',
      ownerUserId: 'usr_owner',
      familyCalendarId: CALENDAR_ID,
      creationStatus: 'ready',
    });
    await db.insert(members).values([
      {
        id: 'mem_owner',
        familyId: 'fam_events',
        userId: 'usr_owner',
        kind: 'adult',
        name: 'オーナー',
        color: 'purple',
        sortOrder: 0,
        status: 'active',
      },
      {
        id: 'mem_adult',
        familyId: 'fam_events',
        userId: 'usr_caller',
        kind: 'adult',
        name: '大人',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      },
      {
        id: 'mem_child',
        familyId: 'fam_events',
        userId: null,
        kind: 'child',
        name: '子ども',
        color: 'green',
        sortOrder: 1,
        status: 'active',
      },
    ]);
    const { rawToken } = await createSession(db, 'usr_caller');
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
    const cookieResponse = await cookieApp.request('http://localhost/');
    return cookieResponse.headers.get('set-cookie')?.split(';')[0] ?? '';
  }

  async function request(
    method: 'POST' | 'PATCH' | 'DELETE',
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

  it('creates a family event with only the caller token and private metadata', async () => {
    const cookie = await createCaller();
    const response = await request('POST', '/api/families/fam_events/events', cookie, {
      ...input,
      clientRequestId: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(response.status).toBe(200);
    const result = eventMutationResponseSchema.parse(await response.json());
    expect(Object.keys(result)).toEqual(['eventId']);
    expect(result.eventId).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(insertCount).toBe(1);
    expect(requests.map((entry) => entry.url)).toEqual([
      `https://www.googleapis.com/calendar/v3/calendars/${CALENDAR_ID}/events?sendUpdates=none`,
    ]);
    expect(requests[0]?.authorization).toBe('Bearer events-access-token');
    expect(refreshTokens).toEqual(['caller-refresh-token']);
    expect(requests.every((entry) => entry.url.includes(`/calendars/${CALENDAR_ID}/`))).toBe(true);
    const googleEvent = storedGoogleEvents.get(result.eventId) as Record<string, unknown>;
    expect(googleEvent.extendedProperties).toEqual({
      private: {
        danran: '1',
        members: 'mem_child',
        assignee: 'mem_adult',
        status: 'tentative',
        source: 'manual',
      },
    });
    const [meta] = await db
      .select()
      .from(eventMeta)
      .where(and(eq(eventMeta.calendarId, CALENDAR_ID), eq(eventMeta.eventId, result.eventId)));
    expect(meta?.itemsJson).toBe('["水筒"]');
  });

  it('completes D1 persistence on retry without inserting a duplicate Google event', async () => {
    const cookie = await createCaller();
    await env.DB.prepare(
      "CREATE TRIGGER fail_event_meta_insert BEFORE INSERT ON event_meta BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    ).run();
    const payload = { ...input, clientRequestId: '123e4567-e89b-42d3-a456-426614174001' };
    expect((await request('POST', '/api/families/fam_events/events', cookie, payload)).status).toBe(
      500,
    );
    await env.DB.prepare('DROP TRIGGER fail_event_meta_insert').run();
    const retry = await request('POST', '/api/families/fam_events/events', cookie, payload);
    expect(retry.status).toBe(200);
    expect(insertCount).toBe(2); // second attempt gets 409, then fetches the same deterministic event
    expect(storedGoogleEvents.size).toBe(1);
    expect((await db.select().from(eventMeta)).length).toBe(1);
  });

  it('does not let a delayed POST replay overwrite metadata saved by a later edit', async () => {
    const cookie = await createCaller();
    const payload = { ...input, clientRequestId: '123e4567-e89b-42d3-a456-426614174013' };
    const created = await request('POST', '/api/families/fam_events/events', cookie, payload);
    const eventId = ((await created.json()) as { eventId: string }).eventId;
    await request('PATCH', `/api/families/fam_events/events/${eventId}`, cookie, {
      ...input,
      title: '編集後',
      items: ['上履き'],
    });

    const replay = await request('POST', '/api/families/fam_events/events', cookie, payload);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ eventId });
    expect(storedGoogleEvents.get(eventId)).toMatchObject({
      summary: '編集後',
      extendedProperties: { private: { members: 'mem_child', status: 'tentative' } },
    });
    const [metadata] = await db.select().from(eventMeta).where(eq(eventMeta.eventId, eventId));
    expect(metadata?.itemsJson).toBe('["上履き"]');
  });

  it('preserves unknown private/shared metadata when editing and updates event_meta items', async () => {
    const cookie = await createCaller();
    const created = await request('POST', '/api/families/fam_events/events', cookie, {
      ...input,
      clientRequestId: '123e4567-e89b-42d3-a456-426614174002',
    });
    const eventId = ((await created.json()) as { eventId: string }).eventId;
    const stored = storedGoogleEvents.get(eventId) as Record<string, unknown>;
    stored.extendedProperties = {
      private: {
        ...(stored.extendedProperties as { private: Record<string, string> }).private,
        externalKey: 'preserve-me',
      },
      shared: { sharedKey: 'also-preserve' },
    };
    const edit = await request('PATCH', `/api/families/fam_events/events/${eventId}`, cookie, {
      ...input,
      title: '変更後',
      items: ['上履き'],
    });
    expect(edit.status).toBe(200);
    expect(storedGoogleEvents.get(eventId)?.extendedProperties).toEqual({
      private: {
        danran: '1',
        members: 'mem_child',
        assignee: 'mem_adult',
        status: 'tentative',
        source: 'manual',
        externalKey: 'preserve-me',
      },
      shared: { sharedKey: 'also-preserve' },
    });
    const [meta] = await db.select().from(eventMeta).where(eq(eventMeta.eventId, eventId));
    expect(meta?.itemsJson).toBe('["上履き"]');

    const editedEvent = storedGoogleEvents.get(eventId) as Record<string, unknown>;
    editedEvent.start = { dateTime: '2026-10-05T11:00:00+09:00', timeZone: 'Asia/Tokyo' };
    editedEvent.end = { dateTime: '2026-10-05T12:00:00+09:00', timeZone: 'Asia/Tokyo' };
    const week = await app.request(
      `${ORIGIN}/api/families/fam_events/week?start=2026-10-05`,
      { headers: { Cookie: cookie } },
      TEST_ENV,
    );
    const weekBody = weekResponseSchema.parse(await week.json());
    expect(weekBody.events.find((event) => event.id === eventId)).toMatchObject({
      time: {
        kind: 'timed',
        start: '2026-10-05T11:00:00+09:00',
        endExclusive: '2026-10-05T12:00:00+09:00',
      },
      memberIds: ['mem_child'],
      assigneeMemberId: 'mem_adult',
      status: 'tentative',
      source: 'manual',
      items: ['上履き'],
    });
  });

  it('clears unused Google date fields when switching between timed and all-day events', async () => {
    const cookie = await createCaller();
    const created = await request('POST', '/api/families/fam_events/events', cookie, {
      ...input,
      clientRequestId: '123e4567-e89b-42d3-a456-426614174014',
    });
    const eventId = ((await created.json()) as { eventId: string }).eventId;

    const allDay = await request('PATCH', `/api/families/fam_events/events/${eventId}`, cookie, {
      ...input,
      time: { kind: 'all-day', start: '2026-10-10', endExclusive: '2026-10-12' },
    });
    expect(allDay.status).toBe(200);
    const allDayPatch = requests.filter((entry) => entry.method === 'PATCH').at(-1)?.body as Record<
      string,
      unknown
    >;
    expect(allDayPatch.start).toEqual({ date: '2026-10-10', dateTime: null, timeZone: null });
    expect(allDayPatch.end).toEqual({ date: '2026-10-12', dateTime: null, timeZone: null });

    const backToTimed = await request(
      'PATCH',
      `/api/families/fam_events/events/${eventId}`,
      cookie,
      input,
    );
    expect(backToTimed.status).toBe(200);
    const timedPatch = requests.filter((entry) => entry.method === 'PATCH').at(-1)?.body as Record<
      string,
      unknown
    >;
    expect(timedPatch.start).toEqual({
      date: null,
      dateTime: input.time.start,
      timeZone: 'Asia/Tokyo',
    });
    expect(timedPatch.end).toEqual({
      date: null,
      dateTime: input.time.endExclusive,
      timeZone: 'Asia/Tokyo',
    });
  });

  it('rejects foreign member IDs, children as assignee, invalid times, and blank titles', async () => {
    const cookie = await createCaller();
    const payload = { ...input, clientRequestId: '123e4567-e89b-42d3-a456-426614174004' };
    for (const invalid of [
      { ...payload, memberIds: ['from_another_family'] },
      { ...payload, assigneeMemberId: 'mem_child' },
      { ...payload, title: '   ' },
      { ...payload, time: { ...payload.time, endExclusive: payload.time.start } },
    ]) {
      const response = await request('POST', '/api/families/fam_events/events', cookie, invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(insertCount).toBe(0);
  });

  it('validates login, active membership, family readiness, CSRF headers, and request size', async () => {
    const cookie = await createCaller();
    const payload = { ...input, clientRequestId: '123e4567-e89b-42d3-a456-426614174008' };
    expect((await request('POST', '/api/families/fam_events/events', '', payload)).status).toBe(
      401,
    );

    const csrf = await app.request(
      `${ORIGIN}/api/families/fam_events/events`,
      {
        method: 'POST',
        headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      TEST_ENV,
    );
    expect(csrf.status).toBe(403);

    const oversized = await app.request(
      `${ORIGIN}/api/families/fam_events/events`,
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...payload, padding: 'x'.repeat(17 * 1024) }),
      },
      TEST_ENV,
    );
    expect(oversized.status).toBe(413);

    await db.update(members).set({ status: 'pending' }).where(eq(members.id, 'mem_adult'));
    for (const [method, path, body] of [
      ['POST', '/api/families/fam_events/events', payload],
      ['PATCH', `/api/families/fam_events/events/${EVENT_ID}`, input],
      ['DELETE', `/api/families/fam_events/events/${EVENT_ID}`, undefined],
    ] as const) {
      expect((await request(method, path, cookie, body)).status).toBe(404);
    }
    await db.update(members).set({ status: 'active' }).where(eq(members.id, 'mem_adult'));
    await db
      .update(families)
      .set({ creationStatus: 'creating' })
      .where(eq(families.id, 'fam_events'));
    for (const [method, path, body] of [
      ['POST', '/api/families/fam_events/events', payload],
      ['PATCH', `/api/families/fam_events/events/${EVENT_ID}`, input],
      ['DELETE', `/api/families/fam_events/events/${EVENT_ID}`, undefined],
    ] as const) {
      const response = await request(method, path, cookie, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'FAMILY_NOT_READY' });
    }
    expect(requests).toHaveLength(0);
  });

  it.each([
    [403, 403, 'CALENDAR_ACCESS_DENIED'],
    [404, 403, 'CALENDAR_ACCESS_DENIED'],
    [401, 401, 'REAUTH_REQUIRED'],
  ] as const)(
    'sanitizes Google status %s to its fixed event API error',
    async (googleStatus, expectedStatus, code) => {
      const cookie = await createCaller();
      forcedCalendarStatus = googleStatus;
      const response = await request('POST', '/api/families/fam_events/events', cookie, {
        ...input,
        clientRequestId: `123e4567-e89b-42d3-a456-42661417400${googleStatus === 401 ? '9' : googleStatus === 403 ? '8' : '7'}`,
      });
      expect(response.status).toBe(expectedStatus);
      const body = await response.text();
      expect(body).toContain(code);
      expect(body).not.toContain('private upstream detail');
    },
  );

  it.each([429, 500])(
    'maps exhausted Google status %s to a fixed temporary error',
    async (googleStatus) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const cookie = await createCaller();
      forcedCalendarStatus = googleStatus;
      const pending = request('POST', '/api/families/fam_events/events', cookie, {
        ...input,
        clientRequestId:
          googleStatus === 429
            ? '123e4567-e89b-42d3-a456-426614174010'
            : '123e4567-e89b-42d3-a456-426614174012',
      });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      for (const [index, delay] of [1000, 2000, 4000].entries()) {
        await vi.advanceTimersByTimeAsync(delay);
        await vi.waitFor(() => expect(requests).toHaveLength(index + 2));
      }
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'GOOGLE_TEMPORARY_ERROR' });
      vi.useRealTimers();
    },
  );

  it('creates a Google all-day event using an exclusive end date', async () => {
    const cookie = await createCaller();
    const response = await request('POST', '/api/families/fam_events/events', cookie, {
      ...input,
      time: { kind: 'all-day', start: '2026-10-10', endExclusive: '2026-10-12' },
      assigneeMemberId: null,
      clientRequestId: '123e4567-e89b-42d3-a456-426614174011',
    });
    expect(response.status).toBe(200);
    const { eventId } = (await response.json()) as { eventId: string };
    expect(storedGoogleEvents.get(eventId)).toMatchObject({
      start: { date: '2026-10-10' },
      end: { date: '2026-10-12' },
    });
  });

  it('adds Danran metadata when editing an external family-calendar event', async () => {
    const cookie = await createCaller();
    const external = {
      id: EVENT_ID,
      summary: '外部の予定',
      status: 'confirmed',
      start: { date: '2026-10-10' },
      end: { date: '2026-10-11' },
      extendedProperties: { private: { vendor: 'preserve' } },
    };
    storedGoogleEvents.set(EVENT_ID, external);
    const response = await request(
      'PATCH',
      `/api/families/fam_events/events/${EVENT_ID}`,
      cookie,
      input,
    );
    expect(response.status).toBe(200);
    expect(storedGoogleEvents.get(EVENT_ID)?.extendedProperties).toMatchObject({
      private: { vendor: 'preserve', danran: '1', source: 'manual' },
    });
  });

  it('returns 404 for an inactive-family membership and cleans metadata when Google already deleted an event', async () => {
    const cookie = await createCaller();
    expect(
      (
        await request('POST', '/api/families/fam_missing/events', cookie, {
          ...input,
          clientRequestId: '123e4567-e89b-42d3-a456-426614174005',
        })
      ).status,
    ).toBe(404);
    await db.insert(users).values({
      id: 'usr_other_owner',
      googleSub: 'sub-other-owner',
      email: 'other@example.test',
      displayName: 'Other',
    });
    await db.insert(families).values({
      id: 'fam_other',
      name: '別の家族',
      ownerUserId: 'usr_other_owner',
      familyCalendarId: 'other_family_calendar',
      creationStatus: 'ready',
    });
    await db.insert(members).values({
      id: 'mem_other_owner',
      familyId: 'fam_other',
      userId: 'usr_other_owner',
      kind: 'adult',
      name: 'Other',
      color: 'teal',
      sortOrder: 0,
      status: 'active',
    });
    expect(
      (
        await request('POST', '/api/families/fam_other/events', cookie, {
          ...input,
          clientRequestId: '123e4567-e89b-42d3-a456-426614174007',
        })
      ).status,
    ).toBe(404);
    const created = await request('POST', '/api/families/fam_events/events', cookie, {
      ...input,
      clientRequestId: '123e4567-e89b-42d3-a456-426614174006',
    });
    const eventId = ((await created.json()) as { eventId: string }).eventId;
    storedGoogleEvents.delete(eventId);
    const deleted = await request('DELETE', `/api/families/fam_events/events/${eventId}`, cookie);
    expect(deleted.status).toBe(200);
    expect(await db.select().from(eventMeta).where(eq(eventMeta.eventId, eventId))).toEqual([]);
  });

  it('rejects recurring events and treats Google 410 delete as successful metadata cleanup', async () => {
    const cookie = await createCaller();
    const created = await request('POST', '/api/families/fam_events/events', cookie, {
      ...input,
      clientRequestId: '123e4567-e89b-42d3-a456-426614174003',
    });
    const eventId = ((await created.json()) as { eventId: string }).eventId;
    const event = storedGoogleEvents.get(eventId) as Record<string, unknown>;
    event.recurrence = [];
    expect(
      (await request('DELETE', `/api/families/fam_events/events/${eventId}`, cookie)).status,
    ).toBe(409);
    expect(
      (await request('PATCH', `/api/families/fam_events/events/${eventId}`, cookie, input)).status,
    ).toBe(409);
    event.recurrence = undefined;
    event.recurringEventId = 'series_1';
    expect(
      (await request('DELETE', `/api/families/fam_events/events/${eventId}`, cookie)).status,
    ).toBe(409);
    expect(
      (await request('PATCH', `/api/families/fam_events/events/${eventId}`, cookie, input)).status,
    ).toBe(409);
    event.recurringEventId = undefined;
    deleteStatus = 410;
    const deleted = await request('DELETE', `/api/families/fam_events/events/${eventId}`, cookie);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(await db.select().from(eventMeta).where(eq(eventMeta.eventId, eventId))).toEqual([]);
    deleteStatus = 404;
    expect(
      (await request('DELETE', `/api/families/fam_events/events/${eventId}`, cookie)).status,
    ).toBe(200);
  });
});
