import { env } from 'cloudflare:test';
import { routineListResponseSchema } from '@shared/schemas/routines';
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
import { Hono } from 'hono';
import { setSignedCookie } from 'hono/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'http://localhost:5173';
const SESSION_SECRET = 'routine-conflicts-test-session-secret';
const AES_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const CALENDAR_ID = 'routine_conflicts_calendar';
const TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'routine-conflicts-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'routine-conflicts-google-client-secret',
  SESSION_SECRET,
  TOKEN_ENC_KEY: AES_KEY,
};
const db = createDb(env.DB);

describe('Task 3-4 routine conflict API', () => {
  const events = new Map<string, Record<string, unknown>>();
  const listRequests: URL[] = [];
  const calendarMethods: string[] = [];
  const authorizations: string[] = [];
  let listFailure = false;
  let pagination: 'none' | 'two-pages' | 'over-limit' | 'loop' | 'second-failure' = 'none';
  let callerCookie = '';
  let masterId = '';

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T03:00:00.000Z'));
    events.clear();
    listRequests.length = 0;
    calendarMethods.length = 0;
    authorizations.length = 0;
    listFailure = false;
    pagination = 'none';
    masterId = '';
    await db.delete(routineSettings);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);
    callerCookie = await makeCaller();
    vi.stubGlobal('fetch', async (source: RequestInfo | URL, init?: RequestInit) => {
      const request = source instanceof Request ? source : new Request(source, init);
      if (request.url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'routine-conflicts-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`/calendar/v3/calendars/${CALENDAR_ID}/events`)) {
        throw new Error(`Unexpected calendar request: ${url.pathname}`);
      }
      calendarMethods.push(request.method);
      authorizations.push(request.headers.get('Authorization') ?? '');
      if (request.method === 'POST' && url.pathname.endsWith('/events')) {
        const body = (await request.json()) as Record<string, unknown>;
        masterId = String(body.id);
        events.set(masterId, { ...body, id: masterId });
        return Response.json(events.get(masterId));
      }
      if (request.method === 'GET' && url.pathname.endsWith('/instances')) {
        const requestedMaster = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
        return Response.json({
          items: [...events.values()].filter((event) => event.recurringEventId === requestedMaster),
        });
      }
      if (request.method === 'GET' && url.pathname.endsWith('/events')) {
        listRequests.push(url);
        if (listFailure) {
          return Response.json({ error: { code: 500, message: 'Unavailable' } }, { status: 500 });
        }
        const items = [...events.values()].filter((event) => !Array.isArray(event.recurrence));
        const token = url.searchParams.get('pageToken');
        if (pagination === 'over-limit') {
          return Response.json({
            items: [],
            nextPageToken: `p${token ? Number(token.slice(1)) + 1 : 1}`,
          });
        }
        if (pagination === 'loop') return Response.json({ items: [], nextPageToken: 'p1' });
        if (pagination === 'second-failure' && token === 'p1') {
          return Response.json({ error: { code: 500, message: 'Unavailable' } }, { status: 500 });
        }
        if (pagination === 'second-failure') {
          return Response.json({ items: items.slice(0, 2), nextPageToken: 'p1' });
        }
        if (pagination === 'two-pages') {
          return token
            ? Response.json({ items: items.slice(2) })
            : Response.json({ items: items.slice(0, 2), nextPageToken: 'p1' });
        }
        return Response.json({ items });
      }
      if (request.method === 'GET') {
        const eventId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
        const event = events.get(eventId);
        return event
          ? Response.json(event)
          : Response.json({ error: { code: 404, message: 'Not Found' } }, { status: 404 });
      }
      throw new Error(`Unexpected Google request: ${request.method} ${url.pathname}`);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    try {
      await db.delete(routineSettings);
      await db.delete(members);
      await db.delete(families);
      await db.delete(googleTokens);
      await db.delete(sessions);
      await db.delete(users);
    } catch {
      // The next test starts with clean database rows.
    }
  });

  async function makeCaller() {
    await db.insert(users).values({
      id: 'routine_conflicts_owner',
      googleSub: 'routine-conflicts-sub',
      email: 'owner@example.test',
      displayName: 'Owner',
    });
    const tokenEnc = await encryptAesGcm(
      'routine-conflicts-refresh-token',
      AES_KEY,
      'google-refresh:routine_conflicts_owner',
    );
    await db.insert(googleTokens).values({
      userId: 'routine_conflicts_owner',
      refreshTokenEnc: tokenEnc,
      scopes: 'openid email profile https://www.googleapis.com/auth/calendar.app.created',
    });
    await db.insert(families).values({
      id: 'routine_conflicts_family',
      name: 'テスト家族',
      ownerUserId: 'routine_conflicts_owner',
      familyCalendarId: CALENDAR_ID,
      creationStatus: 'ready',
    });
    await db.insert(members).values([
      {
        id: 'routine_conflicts_adult',
        familyId: 'routine_conflicts_family',
        userId: 'routine_conflicts_owner',
        kind: 'adult',
        name: '大人',
        color: 'indigo',
        status: 'active',
      },
      {
        id: 'routine_conflicts_child',
        familyId: 'routine_conflicts_family',
        userId: null,
        kind: 'child',
        name: '子ども',
        color: 'green',
        status: 'active',
      },
    ]);
    const { rawToken } = await createSession(db, 'routine_conflicts_owner');
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

  async function request(method: 'GET' | 'POST', path: string, body?: unknown) {
    return app.request(
      `${ORIGIN}${path}`,
      {
        method,
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: callerCookie,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      TEST_ENV,
    );
  }

  async function createRoutine(
    title = 'ピアノ',
    date = '2026-10-10',
    startTime = '10:00',
    endTime = '11:00',
    clientRequestId = '123e4567-e89b-42d3-a456-426614174000',
  ) {
    const response = await request('POST', '/api/families/routine_conflicts_family/routines', {
      title,
      weekdays: [date === '2026-10-10' ? 'SA' : 'SU'],
      interval: 1,
      startDate: date,
      startTime,
      endTime,
      endDate: null,
      memberIds: ['routine_conflicts_child'],
      assigneeMemberId: null,
      category: 'lesson',
      affectsAvailability: false,
      clientRequestId,
    });
    expect(response.status).toBe(200);
    const master = events.get(masterId);
    expect(master).toBeDefined();
    const occurrence = {
      id: `routine_occurrence_${date.replaceAll('-', '')}`,
      recurringEventId: masterId,
      originalStartTime: { dateTime: `${date}T${startTime}:00+09:00`, timeZone: 'Asia/Tokyo' },
      start: { dateTime: `${date}T${startTime}:00+09:00`, timeZone: 'Asia/Tokyo' },
      end: { dateTime: `${date}T${endTime}:00+09:00`, timeZone: 'Asia/Tokyo' },
      status: 'confirmed',
      extendedProperties: {
        private: { danran: '1', members: 'routine_conflicts_child', status: 'confirmed' },
      },
    };
    events.set(occurrence.id, occurrence);
    events.set('routine_conflicts_event', {
      id: 'routine_conflicts_event',
      summary: '運動会',
      start: { dateTime: '2026-10-10T10:30:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-10-10T12:00:00+09:00', timeZone: 'Asia/Tokyo' },
      status: 'confirmed',
      description: 'private description fixture',
      location: 'private location fixture',
      creator: { email: 'creator-private@example.test' },
      attendees: [{ email: 'attendee-private@example.test' }],
      extendedProperties: { private: { danran: '1', members: 'routine_conflicts_child' } },
    });
  }

  it('lists multiple series in one paginated Tokyo-bounded events.list chain and returns only conflict details', async () => {
    await createRoutine();
    await createRoutine(
      '水泳',
      '2026-10-11',
      '13:00',
      '14:00',
      '123e4567-e89b-42d3-a456-426614174001',
    );
    pagination = 'two-pages';
    calendarMethods.length = 0;
    const response = await request('GET', '/api/families/routine_conflicts_family/routines');
    expect(response.status).toBe(200);
    const body = routineListResponseSchema.parse(await response.json());
    expect(listRequests).toHaveLength(2);
    expect(listRequests[1]?.searchParams.get('pageToken')).toBe('p1');
    expect(listRequests[0]?.searchParams.get('singleEvents')).toBe('true');
    expect(listRequests[0]?.searchParams.get('showDeleted')).toBe('false');
    expect(listRequests[0]?.searchParams.get('timeZone')).toBe('Asia/Tokyo');
    expect(listRequests[0]?.searchParams.get('timeMin')).toBe('2026-10-10T00:00:00+09:00');
    expect(listRequests[0]?.searchParams.get('timeMax')).toBe('2026-10-12T00:00:00+09:00');
    expect(body.routines[0]?.upcoming.conflictsStatus).toBe('ready');
    expect(body.routines[0]?.upcoming.instances[0]).toMatchObject({
      id: 'routine_occurrence_20261010',
      conflicts: [
        {
          id: 'routine_conflicts_event',
          title: '運動会',
          time: {
            kind: 'timed',
            start: '2026-10-10T10:30:00+09:00',
            endExclusive: '2026-10-10T12:00:00+09:00',
          },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('private description fixture');
    expect(JSON.stringify(body)).not.toContain('private location fixture');
    expect(JSON.stringify(body)).not.toContain('creator-private@example.test');
    expect(JSON.stringify(body)).not.toContain('attendee-private@example.test');
    expect(calendarMethods).not.toContain('POST');
    expect(calendarMethods).not.toContain('PATCH');
    expect(calendarMethods).not.toContain('DELETE');
    expect(authorizations.every((value) => value === 'Bearer routine-conflicts-access-token')).toBe(
      true,
    );
  });

  it('keeps the routine list when the shared calendar conflict lookup fails', async () => {
    await createRoutine();
    listFailure = true;
    const response = await request('GET', '/api/families/routine_conflicts_family/routines');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      routines: Array<{
        upcoming: { conflictsStatus: string; instances: Array<{ conflicts: unknown[] }> };
      }>;
    };
    expect(body.routines).toHaveLength(1);
    expect(body.routines[0]?.upcoming.conflictsStatus).toBe('unavailable');
    expect(body.routines[0]?.upcoming.instances[0]?.conflicts).toEqual([]);
  }, 15000);

  it('marks conflicts unavailable on pagination loops, page caps, and later-page failures', async () => {
    for (const mode of ['loop', 'over-limit', 'second-failure'] as const) {
      await db.delete(routineSettings);
      events.clear();
      masterId = '';
      pagination = 'none';
      await createRoutine(
        `ピアノ-${mode}`,
        '2026-10-10',
        '10:00',
        '11:00',
        mode === 'loop'
          ? '123e4567-e89b-42d3-a456-426614174002'
          : mode === 'over-limit'
            ? '123e4567-e89b-42d3-a456-426614174003'
            : '123e4567-e89b-42d3-a456-426614174004',
      );
      pagination = mode;
      const response = await request('GET', '/api/families/routine_conflicts_family/routines');
      const body = (await response.json()) as {
        routines: Array<{ upcoming: { conflictsStatus: string; instances: unknown[] } }>;
      };
      expect(response.status).toBe(200);
      expect(body.routines[0]?.upcoming.conflictsStatus).toBe('unavailable');
      expect(body.routines[0]?.upcoming.instances).toHaveLength(1);
    }
  }, 20000);

  it('does not start a conflict lookup for an unauthenticated request', async () => {
    const validCookie = callerCookie;
    callerCookie = '';
    const response = await request('GET', '/api/families/routine_conflicts_family/routines');
    expect(response.status).toBe(401);
    expect(listRequests).toHaveLength(0);
    callerCookie = validCookie;
    const foreignFamily = await request('GET', '/api/families/foreign_family/routines');
    expect(foreignFamily.status).toBe(404);
    expect(listRequests).toHaveLength(0);
    await db.insert(users).values({
      id: 'routine_conflicts_foreign_owner',
      googleSub: 'routine-conflicts-foreign-sub',
      email: 'foreign-owner@example.test',
      displayName: 'Foreign owner',
    });
    await db.insert(families).values({
      id: 'routine_conflicts_foreign_family',
      name: '別の家族',
      ownerUserId: 'routine_conflicts_foreign_owner',
      familyCalendarId: 'foreign_family_calendar',
      creationStatus: 'ready',
    });
    await db.insert(members).values({
      id: 'routine_conflicts_foreign_adult',
      familyId: 'routine_conflicts_foreign_family',
      userId: 'routine_conflicts_foreign_owner',
      kind: 'adult',
      name: '別の大人',
      color: 'purple',
      status: 'active',
    });
    const existingForeignFamily = await request(
      'GET',
      '/api/families/routine_conflicts_foreign_family/routines',
    );
    expect(existingForeignFamily.status).toBe(404);
    expect(listRequests).toHaveLength(0);
  });
});
