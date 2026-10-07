import { env } from 'cloudflare:test';
import { busyWeekResponseSchema } from '@shared/schemas/week-busy';
import { getTodayDateKey, getWeekRange } from '@shared/time';
import { FREE_BUSY_SCOPE, PHASE1_SCOPES, SESSION_COOKIE_NAME } from '@worker/auth/config';
import { encryptAesGcm } from '@worker/auth/crypto';
import { createSession } from '@worker/auth/session';
import { createDb } from '@worker/db';
import {
  eventMeta,
  families,
  googleTokens,
  memberCalendars,
  members,
  sessions,
  users,
} from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { GOOGLE_CALENDAR_API_BASE } from '@worker/google/calendar';
import { app } from '@worker/index';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { setSignedCookie } from 'hono/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'http://localhost:5173';
const AES_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const SESSION_SECRET = 'busy-week-test-session-secret-with-enough-entropy';
const TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'busy-week-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'busy-week-test-google-secret',
  SESSION_SECRET,
  TOKEN_ENC_KEY: AES_KEY,
};

const FAMILY_ID = 'busy_week_family';
const MEMBER_A = 'busy_week_member_a';
const MEMBER_B = 'busy_week_member_b';
const MEMBER_C = 'busy_week_member_c';
const MEMBER_CHILD = 'busy_week_child';
const MEMBER_PENDING = 'busy_week_pending';
const FAMILY_CALENDAR_ID = 'danran-calendar-private';
const CALENDAR_A_PRIMARY = 'primary-a@example.test';
const CALENDAR_A_WORK = 'work-a@example.test';
const CALENDAR_A_DISPLAY_ONLY = 'display-only-a@example.test';
const CALENDAR_B = 'private-b@example.test';
const CALENDAR_B_SECOND = 'private-b-secondary@example.test';
const UNSELECTED_RESPONSE_CALENDAR = 'unselected-calendar@example.test';
const PRIVATE_TITLE = 'PRIVATE_EVENT_TITLE_7c31';
const PRIVATE_LOCATION = 'PRIVATE_LOCATION_94bd';
const PRIVATE_DESCRIPTION = 'PRIVATE_DESCRIPTION_2a8e';
const PRIVATE_EMAIL = 'private-attendee-3@example.test';

type BusyMode =
  | 'ok'
  | 'b-token-revoked'
  | 'b-google-403'
  | 'b-google-500'
  | 'b-calendar-errors'
  | 'b-calendar-missing'
  | 'b-busy-missing'
  | 'b-malformed-interval'
  | 'b-wrong-time-bounds'
  | 'b-empty-busy'
  | 'z-time-bounds';

type GoogleRequest = {
  url: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
};

describe('family busy week API', () => {
  const db = createDb(env.DB);
  let cookieA = '';
  let cookieB = '';
  let mode: BusyMode = 'ok';
  let googleRequests: GoogleRequest[] = [];
  let refreshes: string[] = [];

  async function makeCookie(rawToken: string): Promise<string> {
    const helper = new Hono();
    helper.get('/cookie', async (c) => {
      await setSignedCookie(c, SESSION_COOKIE_NAME, rawToken, SESSION_SECRET, {
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: 3600,
      });
      return c.text('ok');
    });
    const response = await helper.request('http://localhost/cookie');
    return response.headers.get('set-cookie')?.split(';')[0] ?? '';
  }

  async function request(path: string, sessionCookie: string) {
    return app.request(
      `${ORIGIN}${path}`,
      { method: 'GET', headers: { Cookie: sessionCookie } },
      TEST_ENV,
    );
  }

  async function seedToken(userId: string, refreshToken: string, scopes: readonly string[]) {
    await db.insert(googleTokens).values({
      userId,
      refreshTokenEnc: await encryptAesGcm(refreshToken, AES_KEY, `google-refresh:${userId}`),
      scopes: scopes.join(' '),
      updatedAt: Math.floor(Date.now() / 1000),
    });
  }

  function busyResponse(
    rawBody: Record<string, unknown> | null,
    authorization: string | null,
  ): Response {
    if (!rawBody) throw new Error('Expected a freeBusy request body');
    const body = rawBody as unknown as {
      timeMin: string;
      timeMax: string;
      items: Array<{ id: string }>;
    };
    const isA = authorization === 'Bearer access-a';
    const isB = authorization === 'Bearer access-b';
    if (mode === 'b-google-403' && isB) {
      return Response.json(
        { error: { code: 403, message: 'private upstream details' } },
        { status: 403 },
      );
    }
    if (mode === 'b-google-500' && isB) {
      return Response.json(
        { error: { code: 500, message: 'private upstream details' } },
        { status: 500 },
      );
    }

    const calendars: Record<string, unknown> = {};
    for (const { id } of body.items) {
      if (mode === 'b-calendar-missing' && isB) continue;
      if (mode === 'b-calendar-errors' && isB && id === CALENDAR_B_SECOND) {
        calendars[id] = {
          busy: [{ start: '2026-10-06T10:00:00+09:00', end: '2026-10-06T11:00:00+09:00' }],
          errors: [{ domain: 'calendar', reason: 'private-error-reason' }],
          summary: PRIVATE_TITLE,
        };
        continue;
      }
      if (mode === 'b-busy-missing' && isB) {
        calendars[id] = { summary: PRIVATE_TITLE };
        continue;
      }
      if (mode === 'b-malformed-interval' && isB) {
        calendars[id] = { busy: [{ start: 'not-an-instant', end: 'also-invalid' }] };
        continue;
      }

      const intervals =
        mode === 'b-empty-busy' && isB
          ? []
          : isA && id === CALENDAR_A_PRIMARY
            ? [
                { start: '2026-10-04T14:00:00Z', end: '2026-10-04T15:30:00Z' },
                { start: '2026-10-05T09:00:00+09:00', end: '2026-10-05T10:00:00+09:00' },
                { start: '2026-10-05T10:00:00+09:00', end: '2026-10-05T11:00:00+09:00' },
                { start: '2026-10-06T00:00:00+09:00', end: '2026-10-06T01:00:00+09:00' },
                { start: '2026-10-12T22:30:00+09:00', end: '2026-10-13T00:30:00+09:00' },
              ]
            : isA && id === CALENDAR_A_WORK
              ? [
                  { start: '2026-10-05T10:30:00+09:00', end: '2026-10-05T12:00:00+09:00' },
                  { start: '2026-10-06T00:30:00+09:00', end: '2026-10-06T02:00:00+09:00' },
                ]
              : isB
                ? [{ start: '2026-10-07T13:15:00+09:00', end: '2026-10-07T14:00:00+09:00' }]
                : [];
      calendars[id] = {
        busy: intervals.map((interval) => ({
          ...interval,
          title: PRIVATE_TITLE,
          location: PRIVATE_LOCATION,
          description: PRIVATE_DESCRIPTION,
          attendees: [{ email: PRIVATE_EMAIL }],
          calendarId: id,
          calendarName: `PRIVATE_CALENDAR_NAME_${id}`,
        })),
        title: PRIVATE_TITLE,
        location: PRIVATE_LOCATION,
        description: PRIVATE_DESCRIPTION,
        attendees: [{ email: PRIVATE_EMAIL }],
        calendarName: `PRIVATE_CALENDAR_NAME_${id}`,
      };
    }

    const sameInstantZ = mode === 'z-time-bounds' && isA;
    const responseTimeMin = sameInstantZ ? '2026-10-04T15:00:00Z' : body.timeMin;
    const responseTimeMax = sameInstantZ
      ? '2026-10-12T15:00:00Z'
      : mode === 'b-wrong-time-bounds' && isB
        ? '2026-10-13T00:01:00+09:00'
        : body.timeMax;
    calendars[UNSELECTED_RESPONSE_CALENDAR] = {
      busy: [{ start: '2026-10-05T09:00:00+09:00', end: '2026-10-05T10:00:00+09:00' }],
      summary: PRIVATE_TITLE,
    };
    return Response.json({
      timeMin: responseTimeMin,
      timeMax: responseTimeMax,
      calendars,
      title: PRIVATE_TITLE,
      summary: PRIVATE_TITLE,
      location: PRIVATE_LOCATION,
      description: PRIVATE_DESCRIPTION,
      attendees: [{ email: PRIVATE_EMAIL }],
      email: PRIVATE_EMAIL,
    });
  }

  beforeEach(async () => {
    mode = 'ok';
    googleRequests = [];
    refreshes = [];
    await db.delete(eventMeta);
    await db.delete(memberCalendars);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);
    await db.insert(users).values([
      { id: 'busy_user_a', googleSub: 'busy-google-a', email: 'a@example.test', displayName: 'A' },
      { id: 'busy_user_b', googleSub: 'busy-google-b', email: 'b@example.test', displayName: 'B' },
      { id: 'busy_user_c', googleSub: 'busy-google-c', email: 'c@example.test', displayName: 'C' },
      {
        id: 'busy_user_pending',
        googleSub: 'busy-google-p',
        email: 'p@example.test',
        displayName: 'P',
      },
    ]);
    await db.insert(families).values({
      id: FAMILY_ID,
      name: 'Private Test Family',
      ownerUserId: 'busy_user_a',
      familyCalendarId: FAMILY_CALENDAR_ID,
      creationStatus: 'ready',
      calendarCreationId: 'busy-week-test-creation',
    });
    await db.insert(members).values([
      {
        id: MEMBER_A,
        familyId: FAMILY_ID,
        userId: 'busy_user_a',
        kind: 'adult',
        name: 'A',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      },
      {
        id: MEMBER_B,
        familyId: FAMILY_ID,
        userId: 'busy_user_b',
        kind: 'adult',
        name: 'B',
        color: 'teal',
        sortOrder: 1,
        status: 'active',
      },
      {
        id: MEMBER_C,
        familyId: FAMILY_ID,
        userId: 'busy_user_c',
        kind: 'adult',
        name: 'C',
        color: 'rose',
        sortOrder: 2,
        status: 'active',
      },
      {
        id: MEMBER_CHILD,
        familyId: FAMILY_ID,
        userId: null,
        kind: 'child',
        name: 'Child',
        color: 'ochre',
        sortOrder: 3,
        status: 'active',
      },
      {
        id: MEMBER_PENDING,
        familyId: FAMILY_ID,
        userId: 'busy_user_pending',
        kind: 'adult',
        name: 'Pending',
        color: 'purple',
        sortOrder: 4,
        status: 'pending',
      },
    ]);
    const scopes = [...PHASE1_SCOPES, FREE_BUSY_SCOPE];
    await seedToken('busy_user_a', 'refresh-a', scopes);
    await seedToken('busy_user_b', 'refresh-b', scopes);
    await seedToken('busy_user_c', 'refresh-c', scopes);
    await seedToken('busy_user_pending', 'refresh-pending', scopes);
    const sessionA = await createSession(db, 'busy_user_a');
    const sessionB = await createSession(db, 'busy_user_b');
    cookieA = await makeCookie(sessionA.rawToken);
    cookieB = await makeCookie(sessionB.rawToken);

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        const body = await req.clone().formData();
        const refresh = body.get('refresh_token')?.toString() ?? '';
        refreshes.push(refresh);
        if (mode === 'b-token-revoked' && refresh === 'refresh-b') {
          return Response.json(
            { error: 'invalid_grant', error_description: 'private refresh failure' },
            { status: 400 },
          );
        }
        const accessToken =
          refresh === 'refresh-a'
            ? 'access-a'
            : refresh === 'refresh-b'
              ? 'access-b'
              : refresh === 'refresh-c'
                ? 'access-c'
                : 'access-pending';
        return Response.json({ access_token: accessToken, expires_in: 3600, token_type: 'Bearer' });
      }
      const url = new URL(req.url);
      const record: GoogleRequest = {
        url: req.url,
        method: req.method,
        authorization: req.headers.get('Authorization'),
        body:
          req.method === 'POST' ? ((await req.clone().json()) as Record<string, unknown>) : null,
      };
      googleRequests.push(record);
      if (
        url.pathname !==
        `${GOOGLE_CALENDAR_API_BASE.replace('https://www.googleapis.com', '')}/freeBusy`
      ) {
        throw new Error(`Unexpected busy week request: ${req.method} ${req.url}`);
      }
      return busyResponse(record.body, record.authorization);
    });

    await db.insert(memberCalendars).values([
      {
        memberId: MEMBER_A,
        calendarId: CALENDAR_A_PRIMARY,
        displayEnabled: true,
        includeInBusy: true,
      },
      {
        memberId: MEMBER_A,
        calendarId: CALENDAR_A_WORK,
        displayEnabled: false,
        includeInBusy: true,
      },
      {
        memberId: MEMBER_A,
        calendarId: CALENDAR_A_DISPLAY_ONLY,
        displayEnabled: true,
        includeInBusy: false,
      },
      {
        memberId: MEMBER_A,
        calendarId: FAMILY_CALENDAR_ID,
        displayEnabled: false,
        includeInBusy: true,
      },
      { memberId: MEMBER_B, calendarId: CALENDAR_B, displayEnabled: false, includeInBusy: true },
      {
        memberId: MEMBER_B,
        calendarId: CALENDAR_B_SECOND,
        displayEnabled: false,
        includeInBusy: true,
      },
      {
        memberId: MEMBER_PENDING,
        calendarId: 'pending-calendar@example.test',
        displayEnabled: false,
        includeInBusy: true,
      },
    ]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await db.delete(eventMeta);
    await db.delete(memberCalendars);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);
  });

  it('queries each adult with their own token and selected calendars, then returns only merged Tokyo busy intervals', async () => {
    const before = {
      families: await db.select().from(families),
      members: await db.select().from(members),
      memberCalendars: await db.select().from(memberCalendars),
      googleTokens: await db.select().from(googleTokens),
    };
    const response = await request(
      `/api/families/${FAMILY_ID}/week/busy?start=2026-10-08`,
      cookieA,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    const raw: unknown = await response.json();
    const parsed = busyWeekResponseSchema.parse(raw);
    const rawObject = raw as {
      family: Record<string, unknown>;
      week: Record<string, unknown>;
      members: Array<Record<string, unknown>>;
    };
    expect(parsed.family).toEqual({ id: FAMILY_ID });
    expect(parsed.week).toMatchObject({
      start: '2026-10-05',
      endInclusive: '2026-10-12',
      prevWeekStart: '2026-09-28',
      nextWeekStart: '2026-10-12',
    });
    expect(parsed.members.map(({ memberId }) => memberId)).toEqual([MEMBER_A, MEMBER_B, MEMBER_C]);
    expect(parsed.members.map(({ status }) => status)).toEqual(['ready', 'ready', 'not_shared']);
    expect(parsed.members[0]?.busy).toEqual([
      { start: '2026-10-05T00:00:00+09:00', end: '2026-10-05T00:30:00+09:00' },
      { start: '2026-10-05T09:00:00+09:00', end: '2026-10-05T12:00:00+09:00' },
      { start: '2026-10-06T00:00:00+09:00', end: '2026-10-06T02:00:00+09:00' },
      { start: '2026-10-12T22:30:00+09:00', end: '2026-10-13T00:00:00+09:00' },
    ]);
    expect(parsed.members[1]?.busy).toEqual([
      { start: '2026-10-07T13:15:00+09:00', end: '2026-10-07T14:00:00+09:00' },
    ]);

    expect(googleRequests).toHaveLength(2);
    const aRequest = googleRequests.find(
      ({ authorization }) => authorization === 'Bearer access-a',
    );
    const bRequest = googleRequests.find(
      ({ authorization }) => authorization === 'Bearer access-b',
    );
    expect(aRequest?.method).toBe('POST');
    expect(aRequest?.body).toMatchObject({
      timeMin: '2026-10-05T00:00:00+09:00',
      timeMax: '2026-10-13T00:00:00+09:00',
      items: [{ id: CALENDAR_A_PRIMARY }, { id: CALENDAR_A_WORK }],
    });
    expect(bRequest?.body).toMatchObject({
      timeMin: '2026-10-05T00:00:00+09:00',
      timeMax: '2026-10-13T00:00:00+09:00',
      items: expect.arrayContaining([{ id: CALENDAR_B }, { id: CALENDAR_B_SECOND }]),
    });
    expect(bRequest?.body?.items).toHaveLength(2);
    expect(JSON.stringify(googleRequests)).not.toContain(CALENDAR_A_DISPLAY_ONLY);
    expect(JSON.stringify(googleRequests)).not.toContain(FAMILY_CALENDAR_ID);
    expect(JSON.stringify(googleRequests)).not.toContain(UNSELECTED_RESPONSE_CALENDAR);
    expect(refreshes.filter((token) => token === 'refresh-a')).toHaveLength(1);
    expect(refreshes.filter((token) => token === 'refresh-b')).toHaveLength(1);

    const json = JSON.stringify(rawObject);
    for (const secret of [
      PRIVATE_TITLE,
      PRIVATE_LOCATION,
      PRIVATE_DESCRIPTION,
      PRIVATE_EMAIL,
      CALENDAR_A_PRIMARY,
      CALENDAR_A_WORK,
      CALENDAR_B,
      FAMILY_CALENDAR_ID,
      UNSELECTED_RESPONSE_CALENDAR,
      'PRIVATE_CALENDAR_NAME_',
      'busy_user_a',
      'busy_user_b',
      'busy_user_c',
      'Pending',
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(Object.keys(rawObject).sort()).toEqual(['family', 'members', 'week']);
    expect(Object.keys(rawObject.family).sort()).toEqual(['id']);
    expect(Object.keys(rawObject.week).sort()).toEqual([
      'endInclusive',
      'nextWeekStart',
      'prevWeekStart',
      'start',
      'today',
    ]);
    for (const member of rawObject.members) {
      expect(Object.keys(member).sort()).toEqual(['busy', 'memberId', 'status']);
      for (const interval of member.busy as Array<Record<string, unknown>>) {
        expect(Object.keys(interval).sort()).toEqual(['end', 'start']);
      }
    }

    expect(await db.select().from(eventMeta)).toEqual([]);
    expect(await db.select().from(families)).toEqual(before.families);
    expect(await db.select().from(members)).toEqual(before.members);
    expect(await db.select().from(memberCalendars)).toEqual(before.memberCalendars);
    expect(await db.select().from(googleTokens)).toEqual(before.googleTokens);
    expect(await db.select().from(memberCalendars)).toHaveLength(7);
  });

  it('does not refresh tokens or call Google for adults without consent or a busy selection', async () => {
    await db
      .update(googleTokens)
      .set({ scopes: PHASE1_SCOPES.join(' ') })
      .where(eq(googleTokens.userId, 'busy_user_b'));
    await db.delete(memberCalendars).where(eq(memberCalendars.memberId, MEMBER_C));
    const response = await request(
      `/api/families/${FAMILY_ID}/week/busy?start=2026-10-05`,
      cookieA,
    );
    expect(response.status).toBe(200);
    const parsed = busyWeekResponseSchema.parse(await response.json());
    expect(parsed.members.map(({ status }) => status)).toEqual([
      'ready',
      'not_shared',
      'not_shared',
    ]);
    expect(googleRequests).toHaveLength(1);
    expect(googleRequests[0]?.authorization).toBe('Bearer access-a');
    expect(refreshes).toEqual(['refresh-a']);
    expect(parsed.members[1]?.busy).toEqual([]);
    expect(parsed.members[2]?.busy).toEqual([]);
  });

  it.each([
    ['b-token-revoked', 'unavailable'],
    ['b-google-403', 'unavailable'],
    ['b-google-500', 'unavailable'],
    ['b-calendar-errors', 'unavailable'],
    ['b-calendar-missing', 'unavailable'],
    ['b-busy-missing', 'unavailable'],
    ['b-malformed-interval', 'unavailable'],
    ['b-wrong-time-bounds', 'unavailable'],
  ] as const)(
    'isolates member B as unavailable for %s and preserves member A',
    async (selectedMode, expectedStatus) => {
      mode = selectedMode;
      const response = await request(
        `/api/families/${FAMILY_ID}/week/busy?start=2026-10-05`,
        cookieA,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      const body = busyWeekResponseSchema.parse(await response.json());
      expect(body.members[0]?.status).toBe('ready');
      expect(body.members[0]?.busy.length).toBeGreaterThan(0);
      expect(body.members[1]).toEqual({ memberId: MEMBER_B, status: expectedStatus, busy: [] });
      expect(body.members[2]).toEqual({ memberId: MEMBER_C, status: 'not_shared', busy: [] });
      expect(JSON.stringify(body)).not.toContain('private upstream details');
      expect(JSON.stringify(body)).not.toContain('private-error-reason');
    },
    15_000,
  );

  it('accepts equivalent Z response bounds and keeps an empty successful calendar distinct from not shared', async () => {
    mode = 'b-empty-busy';
    const response = await request(
      `/api/families/${FAMILY_ID}/week/busy?start=2026-10-05`,
      cookieA,
    );
    expect(response.status).toBe(200);
    const parsed = busyWeekResponseSchema.parse(await response.json());
    expect(parsed.members[1]).toEqual({ memberId: MEMBER_B, status: 'ready', busy: [] });
    expect(parsed.members[2]).toEqual({ memberId: MEMBER_C, status: 'not_shared', busy: [] });

    mode = 'z-time-bounds';
    const equivalentBounds = await request(
      `/api/families/${FAMILY_ID}/week/busy?start=2026-10-05`,
      cookieA,
    );
    expect(equivalentBounds.status).toBe(200);
    expect(busyWeekResponseSchema.parse(await equivalentBounds.json()).members[0]?.status).toBe(
      'ready',
    );
  });

  it('requires an authenticated active family adult and omits child and pending members', async () => {
    const anonymous = await request(`/api/families/${FAMILY_ID}/week/busy`, '');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('Cache-Control')).toContain('no-store');

    await db.update(members).set({ status: 'pending' }).where(eq(members.id, MEMBER_B));
    const pending = await request(`/api/families/${FAMILY_ID}/week/busy`, cookieB);
    expect(pending.status).toBe(404);
    expect(pending.headers.get('Cache-Control')).toContain('no-store');
    expect(googleRequests).toHaveLength(0);

    await db
      .update(members)
      .set({ status: 'active', kind: 'child', userId: null })
      .where(eq(members.id, MEMBER_B));
    const childSession = await createSession(db, 'busy_user_b');
    const childCookie = await makeCookie(childSession.rawToken);
    const child = await request(`/api/families/${FAMILY_ID}/week/busy`, childCookie);
    expect(child.status).toBe(404);
    expect(googleRequests).toHaveLength(0);

    await db.delete(members).where(eq(members.id, MEMBER_B));
    const nonmember = await request(`/api/families/${FAMILY_ID}/week/busy`, cookieB);
    expect(nonmember.status).toBe(404);
    const nonmemberInvalidStart = await request(
      `/api/families/${FAMILY_ID}/week/busy?start=invalid`,
      cookieB,
    );
    expect(nonmemberInvalidStart.status).toBe(404);
    expect(googleRequests).toHaveLength(0);
  });

  it('rejects malformed, repeated, and out-of-range start values without contacting Google', async () => {
    for (const query of [
      '?start=not-a-date',
      '?start=2026-02-30',
      '?start=1969-12-31',
      '?start=1970-01-01',
      '?start=2050-12-29',
      '?start=2026-09-28&start=2026-10-05',
    ]) {
      const response = await request(`/api/families/${FAMILY_ID}/week/busy${query}`, cookieA);
      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
    }
    expect(googleRequests).toHaveLength(0);
    expect(refreshes).toHaveLength(0);
  });

  it('normalizes an accepted date to Monday and uses the current Tokyo week when start is omitted', async () => {
    const Thursday = await request(
      `/api/families/${FAMILY_ID}/week/busy?start=2026-10-08`,
      cookieA,
    );
    expect(Thursday.status).toBe(200);
    expect(busyWeekResponseSchema.parse(await Thursday.json()).week.start).toBe('2026-10-05');
    googleRequests = [];
    const omitted = await request(`/api/families/${FAMILY_ID}/week/busy`, cookieA);
    expect(omitted.status).toBe(200);
    const today = busyWeekResponseSchema.parse(await omitted.json());
    expect(today.week.start).toBe(getWeekRange(getTodayDateKey()).start);
  });

  it('accepts the first in-range week even when its previous anchor is in 1969', async () => {
    const response = await request(
      `/api/families/${FAMILY_ID}/week/busy?start=1970-01-05`,
      cookieA,
    );
    expect(response.status).toBe(200);
    const week = busyWeekResponseSchema.parse(await response.json()).week;
    expect(week.start).toBe('1970-01-05');
    expect(week.prevWeekStart).toBe('1969-12-29');
  });
});
