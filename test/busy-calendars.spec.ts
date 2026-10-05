import { env } from 'cloudflare:test';
import {
  busyCalendarListResponseSchema,
  updateBusyCalendarsResponseSchema,
} from '@shared/schemas/busy';
import {
  personalCalendarListResponseSchema,
  personalWeekResponseSchema,
} from '@shared/schemas/personal';
import { weekResponseSchema } from '@shared/schemas/week';
import {
  FREE_BUSY_SCOPE,
  PERSONAL_EVENTS_SCOPE,
  PHASE1_SCOPES,
  SESSION_COOKIE_NAME,
} from '@worker/auth/config';
import { encryptAesGcm } from '@worker/auth/crypto';
import { createSession } from '@worker/auth/session';
import { createDb } from '@worker/db';
import {
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
const AES_KEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';
const SESSION_SECRET = 'busy-calendar-test-session-secret-with-enough-entropy';
const TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'busy-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'busy-test-google-secret',
  SESSION_SECRET,
  TOKEN_ENC_KEY: AES_KEY,
};

type GoogleRequest = { url: string; authorization: string | null };

describe('busy calendar selection APIs', () => {
  const db = createDb(env.DB);
  const familyId = 'busy_family';
  const memberA = 'busy_member_a';
  const memberB = 'busy_member_b';
  let cookieA = '';
  let cookieB = '';
  let cookieC = '';
  let googleRequests: GoogleRequest[] = [];
  let refreshTokens: string[] = [];
  let calendarListStatus: number | null = null;

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

  async function request(path: string, cookie: string, method = 'GET', body?: unknown) {
    return app.request(
      `${ORIGIN}${path}`,
      {
        method,
        headers: {
          Cookie: cookie,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(method === 'GET' ? {} : { Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      TEST_ENV,
    );
  }

  beforeEach(async () => {
    googleRequests = [];
    refreshTokens = [];
    calendarListStatus = null;
    await db.delete(memberCalendars);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);
    await db.insert(users).values([
      {
        id: 'busy_user_a',
        googleSub: 'busy-google-a',
        email: 'busy-a@example.test',
        displayName: 'A',
      },
      {
        id: 'busy_user_b',
        googleSub: 'busy-google-b',
        email: 'busy-b@example.test',
        displayName: 'B',
      },
      {
        id: 'busy_user_c',
        googleSub: 'busy-google-c',
        email: 'busy-c@example.test',
        displayName: 'C',
      },
    ]);
    await db.insert(families).values({
      id: familyId,
      name: 'Busy Family',
      ownerUserId: 'busy_user_a',
      familyCalendarId: 'family-calendar-private',
      creationStatus: 'ready',
    });
    await db.insert(members).values([
      {
        id: memberA,
        familyId,
        userId: 'busy_user_a',
        kind: 'adult',
        name: 'A',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      },
      {
        id: 'busy_member_c_pending',
        familyId,
        userId: 'busy_user_c',
        kind: 'adult',
        name: 'C pending',
        color: 'rose',
        sortOrder: 2,
        status: 'pending',
      },
      {
        id: memberB,
        familyId,
        userId: 'busy_user_b',
        kind: 'adult',
        name: 'B',
        color: 'teal',
        sortOrder: 1,
        status: 'active',
      },
    ]);
    const scopes = [...PHASE1_SCOPES, PERSONAL_EVENTS_SCOPE, FREE_BUSY_SCOPE];
    for (const { userId, refreshToken } of [
      { userId: 'busy_user_a', refreshToken: 'busy-refresh-a' },
      { userId: 'busy_user_b', refreshToken: 'busy-refresh-b' },
      { userId: 'busy_user_c', refreshToken: 'busy-refresh-c' },
    ]) {
      await db.insert(googleTokens).values({
        userId,
        refreshTokenEnc: await encryptAesGcm(refreshToken, AES_KEY, `google-refresh:${userId}`),
        scopes: scopes.join(' '),
        updatedAt: Math.floor(Date.now() / 1000),
      });
    }
    const sessionA = await createSession(db, 'busy_user_a');
    const sessionB = await createSession(db, 'busy_user_b');
    const sessionC = await createSession(db, 'busy_user_c');
    cookieA = await makeCookie(sessionA.rawToken);
    cookieB = await makeCookie(sessionB.rawToken);
    cookieC = await makeCookie(sessionC.rawToken);

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        const body = await req.clone().formData();
        refreshTokens.push(body.get('refresh_token')?.toString() ?? '');
        const refreshToken = refreshTokens.at(-1);
        return Response.json({
          access_token: refreshToken === 'busy-refresh-a' ? 'access-a' : 'access-b',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }

      const url = new URL(req.url);
      const authorization = req.headers.get('Authorization');
      googleRequests.push({ url: req.url, authorization });
      if (
        url.pathname ===
        `${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList`.replace(
          'https://www.googleapis.com',
          '',
        )
      ) {
        if (calendarListStatus !== null) {
          return Response.json(
            { error: { message: 'synthetic failure' } },
            { status: calendarListStatus },
          );
        }
        const isA = authorization === 'Bearer access-a';
        return Response.json({
          items: [
            {
              id: isA ? 'calendar-a-primary' : 'calendar-b-primary',
              summary: isA ? 'A Primary' : 'B Primary',
              primary: true,
            },
            {
              id: isA ? 'work-a@example.test' : 'work-b@example.test',
              summary: isA ? 'A private work calendar' : 'B work calendar',
              primary: false,
            },
            { id: 'family-calendar-private', summary: 'Family calendar', primary: false },
          ],
        });
      }
      if (url.pathname.includes('/events')) return Response.json({ items: [] });
      throw new Error(`Unexpected Google request: ${req.method} ${req.url}`);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await db.delete(memberCalendars);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);
  });

  it('keeps a member’s busy calendar IDs and names private from every other member API', async () => {
    const initial = busyCalendarListResponseSchema.parse(
      await (await request(`/api/families/${familyId}/busy-calendars`, cookieA)).json(),
    );
    expect(initial).toMatchObject({ status: 'ready', memberId: memberA, hasSavedSelection: false });
    if (initial.status !== 'ready') throw new Error('Expected ready busy calendar list');
    expect(initial.calendars.every((calendar) => !calendar.selected)).toBe(true);

    const saved = await request(`/api/families/${familyId}/busy-calendars`, cookieA, 'PUT', {
      calendarIds: ['work-a@example.test'],
    });
    expect(saved.status).toBe(200);
    const saveResult = updateBusyCalendarsResponseSchema.parse(await saved.json());
    expect(saveResult).toMatchObject({ authorizationRequired: false, hasSavedSelection: true });
    expect(
      await db.select().from(memberCalendars).where(eq(memberCalendars.memberId, memberA)),
    ).toEqual([
      expect.objectContaining({
        memberId: memberA,
        calendarId: 'work-a@example.test',
        displayEnabled: false,
        includeInBusy: true,
      }),
    ]);

    const bGoogleRequestStart = googleRequests.length;
    const bResponses = await Promise.all([
      request(`/api/families/${familyId}/busy-calendars`, cookieB),
      request(`/api/families/${familyId}/personal-calendars`, cookieB),
      request(`/api/families/${familyId}/week?start=2026-10-05`, cookieB),
      request(`/api/families/${familyId}/week/personal?start=2026-10-05`, cookieB),
    ]);
    const bBodies = await Promise.all(bResponses.map((response) => response.text()));
    expect(bResponses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    for (const body of bBodies) {
      expect(body).not.toContain('work-a@example.test');
      expect(body).not.toContain('A private work calendar');
    }
    const bBusyCalendars = busyCalendarListResponseSchema.parse(JSON.parse(bBodies[0] ?? 'null'));
    if (bBusyCalendars.status === 'ready') {
      expect(bBusyCalendars.calendars.map(({ id }) => id)).toContain('work-b@example.test');
      expect(bBusyCalendars.calendars.map(({ id }) => id)).not.toContain('work-a@example.test');
    } else {
      throw new Error('Expected ready B busy calendar list');
    }
    expect(
      personalCalendarListResponseSchema.safeParse(JSON.parse(bBodies[1] ?? 'null')).success,
    ).toBe(true);
    expect(weekResponseSchema.safeParse(JSON.parse(bBodies[2] ?? 'null')).success).toBe(true);
    expect(personalWeekResponseSchema.parse(JSON.parse(bBodies[3] ?? 'null')).status).toBe(
      'unselected',
    );
    const bCalendarListRequests = googleRequests
      .slice(bGoogleRequestStart)
      .filter(({ url }) => url.includes('/users/me/calendarList'));
    expect(bCalendarListRequests).toHaveLength(2);
    expect(
      bCalendarListRequests.every(({ authorization }) => authorization === 'Bearer access-b'),
    ).toBe(true);
    expect(googleRequests.some(({ url }) => url.includes('/freeBusy'))).toBe(false);
  });

  it('keeps display and busy flags independent and deletes only rows with both flags off', async () => {
    const busySave = await request(`/api/families/${familyId}/busy-calendars`, cookieA, 'PUT', {
      calendarIds: ['calendar-a-primary'],
    });
    expect(busySave.status).toBe(200);
    let rows = await db.select().from(memberCalendars).where(eq(memberCalendars.memberId, memberA));
    expect(rows).toEqual([
      expect.objectContaining({
        calendarId: 'calendar-a-primary',
        displayEnabled: false,
        includeInBusy: true,
      }),
    ]);
    const personalListAfterBusySave = personalCalendarListResponseSchema.parse(
      await (await request(`/api/families/${familyId}/personal-calendars`, cookieA)).json(),
    );
    expect(personalListAfterBusySave).toMatchObject({ status: 'ready', hasSavedSelection: false });
    if (personalListAfterBusySave.status === 'ready') {
      expect(personalListAfterBusySave.calendars.every((calendar) => !calendar.selected)).toBe(
        true,
      );
    }
    expect(
      personalWeekResponseSchema.parse(
        await (
          await request(`/api/families/${familyId}/week/personal?start=2026-10-05`, cookieA)
        ).json(),
      ).status,
    ).toBe('unselected');

    const displaySave = await request(
      `/api/families/${familyId}/personal-calendars`,
      cookieA,
      'PUT',
      {
        calendarIds: ['calendar-a-primary'],
      },
    );
    expect(displaySave.status).toBe(200);
    rows = await db.select().from(memberCalendars).where(eq(memberCalendars.memberId, memberA));
    expect(rows).toEqual([
      expect.objectContaining({
        calendarId: 'calendar-a-primary',
        displayEnabled: true,
        includeInBusy: true,
      }),
    ]);

    const displayClear = await request(
      `/api/families/${familyId}/personal-calendars`,
      cookieA,
      'PUT',
      {
        calendarIds: [],
      },
    );
    expect(displayClear.status).toBe(200);
    rows = await db.select().from(memberCalendars).where(eq(memberCalendars.memberId, memberA));
    expect(rows).toEqual([
      expect.objectContaining({
        calendarId: 'calendar-a-primary',
        displayEnabled: false,
        includeInBusy: true,
      }),
    ]);
    const busyListAfterDisplayClear = busyCalendarListResponseSchema.parse(
      await (await request(`/api/families/${familyId}/busy-calendars`, cookieA)).json(),
    );
    expect(busyListAfterDisplayClear).toMatchObject({ status: 'ready', hasSavedSelection: true });
    if (busyListAfterDisplayClear.status === 'ready') {
      expect(
        busyListAfterDisplayClear.calendars.find((calendar) => calendar.id === 'calendar-a-primary')
          ?.selected,
      ).toBe(true);
    }

    const busyClear = await request(`/api/families/${familyId}/busy-calendars`, cookieA, 'PUT', {
      calendarIds: [],
    });
    expect(busyClear.status).toBe(200);
    rows = await db.select().from(memberCalendars).where(eq(memberCalendars.memberId, memberA));
    expect(rows).toHaveLength(0);
    expect(updateBusyCalendarsResponseSchema.parse(await busyClear.json())).toMatchObject({
      authorizationRequired: false,
      hasSavedSelection: false,
    });

    const displayOnlySave = await request(
      `/api/families/${familyId}/personal-calendars`,
      cookieA,
      'PUT',
      { calendarIds: ['calendar-a-primary'] },
    );
    expect(displayOnlySave.status).toBe(200);
    const bothSelected = await request(`/api/families/${familyId}/busy-calendars`, cookieA, 'PUT', {
      calendarIds: ['calendar-a-primary'],
    });
    expect(bothSelected.status).toBe(200);
    rows = await db.select().from(memberCalendars).where(eq(memberCalendars.memberId, memberA));
    expect(rows).toEqual([
      expect.objectContaining({
        calendarId: 'calendar-a-primary',
        displayEnabled: true,
        includeInBusy: true,
      }),
    ]);
    const keepDisplayOnly = await request(
      `/api/families/${familyId}/busy-calendars`,
      cookieA,
      'PUT',
      { calendarIds: [] },
    );
    expect(keepDisplayOnly.status).toBe(200);
    rows = await db.select().from(memberCalendars).where(eq(memberCalendars.memberId, memberA));
    expect(rows).toEqual([
      expect.objectContaining({
        calendarId: 'calendar-a-primary',
        displayEnabled: true,
        includeInBusy: false,
      }),
    ]);
  });

  it('prevents one member from changing or selecting another member’s busy calendars', async () => {
    const aSaved = await request(`/api/families/${familyId}/busy-calendars`, cookieA, 'PUT', {
      calendarIds: ['work-a@example.test'],
    });
    expect(aSaved.status).toBe(200);
    const aRowsBefore = await db
      .select()
      .from(memberCalendars)
      .where(eq(memberCalendars.memberId, memberA));
    expect(aRowsBefore).toHaveLength(1);

    const bCannotSelectA = await request(
      `/api/families/${familyId}/busy-calendars`,
      cookieB,
      'PUT',
      {
        calendarIds: ['work-a@example.test'],
      },
    );
    expect(bCannotSelectA.status).toBe(400);

    const bSaved = await request(`/api/families/${familyId}/busy-calendars`, cookieB, 'PUT', {
      calendarIds: ['work-b@example.test'],
    });
    expect(bSaved.status).toBe(200);
    const bCleared = await request(`/api/families/${familyId}/busy-calendars`, cookieB, 'PUT', {
      calendarIds: [],
    });
    expect(bCleared.status).toBe(200);

    const aRowsAfter = await db
      .select()
      .from(memberCalendars)
      .where(eq(memberCalendars.memberId, memberA));
    expect(aRowsAfter).toEqual(aRowsBefore);
    expect(
      await db.select().from(memberCalendars).where(eq(memberCalendars.memberId, memberB)),
    ).toHaveLength(0);
  });

  it('validates selection limits and maps Google calendar-list failures to fixed errors', async () => {
    const duplicateIds = await request(`/api/families/${familyId}/busy-calendars`, cookieA, 'PUT', {
      calendarIds: ['calendar-a-primary', 'calendar-a-primary'],
    });
    expect(duplicateIds.status).toBe(400);

    const tooManyIds = await request(`/api/families/${familyId}/busy-calendars`, cookieA, 'PUT', {
      calendarIds: Array.from({ length: 11 }, (_, index) => `calendar-${index}`),
    });
    expect(tooManyIds.status).toBe(400);
    const oversizedBody = await app.request(
      `${ORIGIN}/api/families/${familyId}/busy-calendars`,
      {
        method: 'PUT',
        headers: {
          Cookie: cookieA,
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ extra: 'x'.repeat(17 * 1024) }),
      },
      TEST_ENV,
    );
    expect(oversizedBody.status).toBe(413);

    const familyCalendar = await request(
      `/api/families/${familyId}/busy-calendars`,
      cookieA,
      'PUT',
      {
        calendarIds: ['family-calendar-private'],
      },
    );
    expect(familyCalendar.status).toBe(400);

    for (const [googleStatus, status, code] of [
      [403, 403, 'CALENDAR_ACCESS_DENIED'],
      [404, 403, 'CALENDAR_ACCESS_DENIED'],
      [500, 503, 'GOOGLE_TEMPORARY_ERROR'],
    ] as const) {
      calendarListStatus = googleStatus;
      const response = await request(`/api/families/${familyId}/busy-calendars`, cookieA);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    }
  }, 15000);

  it('returns the fixed missing-scope state and incremental authorization URL', async () => {
    await db
      .update(googleTokens)
      .set({ scopes: [...PHASE1_SCOPES, PERSONAL_EVENTS_SCOPE].join(' ') })
      .where(eq(googleTokens.userId, 'busy_user_a'));

    const listResponse = await request(`/api/families/${familyId}/busy-calendars`, cookieA);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      status: 'authorization_required',
      memberId: memberA,
      calendars: [],
    });

    const saveResponse = await request(`/api/families/${familyId}/busy-calendars`, cookieA, 'PUT', {
      calendarIds: [],
    });
    expect(saveResponse.status).toBe(200);
    const body = (await saveResponse.json()) as {
      authorizationRequired: boolean;
      authorizationUrl: string;
    };
    expect(body.authorizationRequired).toBe(true);
    const authUrl = new URL(body.authorizationUrl);
    expect(authUrl.searchParams.get('login_hint')).toBe('busy-google-a');
    expect(authUrl.searchParams.get('include_granted_scopes')).toBe('true');
    expect(authUrl.searchParams.get('scope')?.split(' ')).toEqual([
      ...PHASE1_SCOPES,
      FREE_BUSY_SCOPE,
    ]);
  });

  it('requires authentication and an active adult family member for GET and PUT', async () => {
    const path = `/api/families/${familyId}/busy-calendars`;
    async function expectGetAndPutStatus(cookie: string, status: number) {
      const getResponse = await request(path, cookie);
      const putResponse = await request(path, cookie, 'PUT', { calendarIds: [] });
      expect(getResponse.status).toBe(status);
      expect(putResponse.status).toBe(status);
    }

    await expectGetAndPutStatus('', 401);

    await expectGetAndPutStatus(cookieC, 404);
    await db
      .update(members)
      .set({ kind: 'child', userId: null, status: 'active' })
      .where(eq(members.id, 'busy_member_c_pending'));
    await expectGetAndPutStatus(cookieC, 404);

    await db.delete(members).where(eq(members.id, 'busy_member_c_pending'));
    await expectGetAndPutStatus(cookieC, 404);
  });
});
