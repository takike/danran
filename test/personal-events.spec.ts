import { env } from 'cloudflare:test';
import {
  personalCalendarListResponseSchema,
  personalWeekResponseSchema,
  updatePersonalCalendarsResponseSchema,
} from '@shared/schemas/personal';
import { weekResponseSchema } from '@shared/schemas/week';
import { PERSONAL_EVENTS_SCOPE, PHASE1_SCOPES, SESSION_COOKIE_NAME } from '@worker/auth/config';
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
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { setSignedCookie } from 'hono/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'http://localhost:5173';
const AES_KEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';
const SESSION_SECRET = 'personal-events-test-session-secret-with-enough-entropy';
const TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'personal-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'personal-test-google-secret',
  SESSION_SECRET,
  TOKEN_ENC_KEY: AES_KEY,
};

type CalendarMode =
  | 'ok'
  | 'bad-page'
  | 'many-pages'
  | 'calendar-pages'
  | 'events-pages'
  | 'secondary-403'
  | 'google-403'
  | 'google-404'
  | 'google-500'
  | '401-once';
type RequestRecord = { url: string; method: string; authorization: string | null };

describe('personal calendar APIs', () => {
  const db = createDb(env.DB);
  let cookieA = '';
  let cookieB = '';
  const familyId = 'personal_family';
  const memberA = 'personal_member_a';
  const memberB = 'personal_member_b';
  let calendarMode: CalendarMode = 'ok';
  let googleRequests: RequestRecord[] = [];
  let tokenRefreshes: string[] = [];
  let aEventTitle = 'A confidential appointment';
  let eventsListCount = 0;

  async function cookie(rawToken: string): Promise<string> {
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

  async function request(path: string, sessionCookie: string, method = 'GET', body?: unknown) {
    return app.request(
      `${ORIGIN}${path}`,
      {
        method,
        headers: {
          Cookie: sessionCookie,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(method === 'GET' ? {} : { Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      TEST_ENV,
    );
  }

  async function seedToken(userId: string, refresh: string, scopes: string[]) {
    await db.insert(googleTokens).values({
      userId,
      refreshTokenEnc: await encryptAesGcm(refresh, AES_KEY, `google-refresh:${userId}`),
      scopes: scopes.join(' '),
      updatedAt: Math.floor(Date.now() / 1000),
    });
  }

  beforeEach(async () => {
    calendarMode = 'ok';
    googleRequests = [];
    tokenRefreshes = [];
    aEventTitle = 'A confidential appointment';
    eventsListCount = 0;
    await db.delete(eventMeta);
    await db.delete(memberCalendars);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);
    await db.insert(users).values([
      {
        id: 'personal_user_a',
        googleSub: 'personal-google-a',
        email: 'a@example.test',
        displayName: 'A',
      },
      {
        id: 'personal_user_b',
        googleSub: 'personal-google-b',
        email: 'b@example.test',
        displayName: 'B',
      },
    ]);
    await db.insert(families).values({
      id: familyId,
      name: 'Private Family',
      ownerUserId: 'personal_user_a',
      familyCalendarId: 'family-calendar-private',
      creationStatus: 'ready',
      calendarCreationId: 'personal-family-creation',
    });
    await db.insert(members).values([
      {
        id: memberA,
        familyId,
        userId: 'personal_user_a',
        kind: 'adult',
        name: 'A',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      },
      {
        id: memberB,
        familyId,
        userId: 'personal_user_b',
        kind: 'adult',
        name: 'B',
        color: 'teal',
        sortOrder: 1,
        status: 'active',
      },
    ]);
    const scopes = [...PHASE1_SCOPES, PERSONAL_EVENTS_SCOPE];
    await seedToken('personal_user_a', 'refresh-a', scopes);
    await seedToken('personal_user_b', 'refresh-b', scopes);
    const sessionA = await createSession(db, 'personal_user_a');
    const sessionB = await createSession(db, 'personal_user_b');
    cookieA = await cookie(sessionA.rawToken);
    cookieB = await cookie(sessionB.rawToken);

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        const body = await req.clone().formData();
        const refresh = body.get('refresh_token')?.toString() ?? '';
        tokenRefreshes.push(refresh);
        const accessToken = refresh === 'refresh-a' ? 'access-a' : 'access-b';
        return Response.json({ access_token: accessToken, expires_in: 3600, token_type: 'Bearer' });
      }

      const url = new URL(req.url);
      const authorization = req.headers.get('Authorization');
      googleRequests.push({ url: req.url, method: req.method, authorization });
      if (
        url.pathname ===
        `${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList`.replace(
          'https://www.googleapis.com',
          '',
        )
      ) {
        const primaryId =
          authorization === 'Bearer access-a' ? 'calendar-a-primary' : 'calendar-b-primary';
        if (calendarMode === 'bad-page') return Response.json({ items: [], nextPageToken: 'loop' });
        const pageToken = url.searchParams.get('pageToken');
        if (pageToken === 'loop') return Response.json({ items: [], nextPageToken: 'loop' });
        if (calendarMode === 'many-pages') {
          const page = Number(pageToken?.replace('page-', '') ?? '0');
          return Response.json({ items: [], nextPageToken: `page-${page + 1}` });
        }
        if (calendarMode === 'calendar-pages') {
          return pageToken
            ? Response.json({ items: [{ id: 'calendar-secondary', summary: 'Secondary' }] })
            : Response.json({ nextPageToken: 'calendar-page-2' });
        }
        return Response.json({
          items: pageToken
            ? [{ id: 'calendar-secondary', summary: 'Secondary' }]
            : [
                {
                  id: primaryId,
                  summary: authorization === 'Bearer access-a' ? 'A Primary' : 'B Primary',
                  primary: true,
                },
                { id: 'calendar-secondary', summary: 'Secondary', primary: false },
                { id: 'family-calendar-private', summary: 'Danran family', primary: false },
              ],
        });
      }

      if (url.pathname.includes('/events')) {
        eventsListCount += 1;
        const calendarId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
        if (calendarMode === 'secondary-403' && calendarId === 'calendar-secondary') {
          return Response.json(
            { error: { code: 403, message: 'private upstream text' } },
            { status: 403 },
          );
        }
        if (
          calendarMode === 'google-403' ||
          calendarMode === 'google-404' ||
          calendarMode === 'google-500'
        ) {
          const status =
            calendarMode === 'google-403' ? 403 : calendarMode === 'google-404' ? 404 : 500;
          return Response.json(
            { error: { code: status, message: 'private upstream text' } },
            { status },
          );
        }
        if (calendarMode === '401-once' && eventsListCount === 1) {
          return Response.json({ error: { code: 401, message: 'expired' } }, { status: 401 });
        }
        if (calendarMode === 'events-pages') {
          return url.searchParams.has('pageToken')
            ? Response.json({
                items: [
                  {
                    id: 'event-a-page-two',
                    summary: 'Page two',
                    status: 'confirmed',
                    start: { dateTime: '2026-10-02T12:30:00+09:00' },
                    end: { dateTime: '2026-10-02T13:30:00+09:00' },
                  },
                ],
              })
            : Response.json({ nextPageToken: 'event-page-2' });
        }
        if (calendarId === 'family-calendar-private') return Response.json({ items: [] });
        if (calendarId === 'calendar-b-primary') {
          return Response.json({
            items: [
              {
                id: 'event-b-secret',
                summary: 'B private',
                status: 'confirmed',
                start: { date: '2026-10-02' },
                end: { date: '2026-10-03' },
              },
            ],
          });
        }
        if (calendarId === 'calendar-secondary') return Response.json({ items: [] });
        return Response.json({
          items: [
            {
              id: 'event-a-timed',
              summary: aEventTitle,
              description: 'SECRET_DESCRIPTION',
              location: 'SECRET_LOCATION',
              status: 'confirmed',
              start: { dateTime: '2026-10-02T09:30:00+09:00' },
              end: { dateTime: '2026-10-02T10:30:00+09:00' },
              attendees: [
                { self: true, responseStatus: 'accepted', email: 'a@example.test' },
                { self: false, responseStatus: 'accepted', email: 'attendee-secret@example.test' },
              ],
            },
            {
              id: 'event-a-all-day',
              summary: 'Long day',
              status: 'confirmed',
              start: { date: '2026-10-03' },
              end: { date: '2026-10-05' },
            },
            {
              id: 'event-a-declined',
              summary: 'Do not show',
              status: 'confirmed',
              start: { date: '2026-10-02' },
              end: { date: '2026-10-03' },
              attendees: [{ self: true, responseStatus: 'declined', email: 'a@example.test' }],
            },
            { id: 'event-a-cancelled', summary: 'Cancelled', status: 'cancelled' },
          ],
        });
      }
      throw new Error(`Unexpected personal test request: ${req.method} ${req.url}`);
    });
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

  it('keeps personal event details on the requesting adult only and never persists event content', async () => {
    const aCalendarsResponse = await request(
      `/api/families/${familyId}/personal-calendars`,
      cookieA,
    );
    const aCalendars = personalCalendarListResponseSchema.parse(await aCalendarsResponse.json());
    expect(aCalendarsResponse.status).toBe(200);
    expect(aCalendars).toMatchObject({ status: 'ready', memberId: memberA });
    if (aCalendars.status !== 'ready') throw new Error('Expected ready calendar list');
    expect(aCalendars.calendars.map(({ id, selected }) => ({ id, selected }))).toEqual([
      { id: 'calendar-a-primary', selected: true },
      { id: 'calendar-secondary', selected: false },
    ]);
    expect(JSON.stringify(aCalendars)).not.toContain('family-calendar-private');

    const save = await request(`/api/families/${familyId}/personal-calendars`, cookieA, 'PUT', {
      calendarIds: ['calendar-a-primary'],
    });
    expect(save.status).toBe(200);
    expect(updatePersonalCalendarsResponseSchema.parse(await save.json())).toMatchObject({
      authorizationRequired: false,
      status: 'ready',
      memberId: memberA,
    });
    expect(
      await db.select().from(memberCalendars).where(eq(memberCalendars.memberId, memberA)),
    ).toEqual([
      expect.objectContaining({
        memberId: memberA,
        calendarId: 'calendar-a-primary',
        displayEnabled: true,
      }),
      expect.objectContaining({
        memberId: memberA,
        calendarId: 'calendar-secondary',
        displayEnabled: false,
      }),
    ]);

    const week = await request(`/api/families/${familyId}/week/personal?start=2026-10-02`, cookieA);
    expect(week.status).toBe(200);
    const ownWeek = personalWeekResponseSchema.parse(await week.json());
    expect(ownWeek.status).toBe('ready');
    expect(ownWeek.week.start).toBe('2026-09-28');
    expect(ownWeek.events).toHaveLength(2);
    expect(ownWeek.events.find((event) => event.id.endsWith('event-a-timed'))).toMatchObject({
      calendarId: 'calendar-a-primary',
      title: aEventTitle,
      time: { kind: 'timed', start: '2026-10-02T09:30:00+09:00' },
    });
    expect(ownWeek.events.find((event) => event.id.endsWith('event-a-all-day'))).toMatchObject({
      time: { kind: 'all-day', start: '2026-10-03', endExclusive: '2026-10-05' },
    });
    const ownWeekText = JSON.stringify(ownWeek);
    for (const secret of [
      'SECRET_DESCRIPTION',
      'SECRET_LOCATION',
      'attendee-secret@example.test',
      'a@example.test',
      'Do not show',
      'Cancelled',
    ]) {
      expect(ownWeekText).not.toContain(secret);
    }
    expect(
      googleRequests
        .filter((entry) => entry.url.includes('/events'))
        .every((entry) => entry.authorization === 'Bearer access-a'),
    ).toBe(true);
    expect(
      googleRequests
        .filter((entry) => entry.url.includes('/events'))
        .every((entry) =>
          new URL(entry.url).searchParams.get('fields')?.includes('attendees(self,responseStatus)'),
        ),
    ).toBe(true);

    const bCalendars = personalCalendarListResponseSchema.parse(
      await (await request(`/api/families/${familyId}/personal-calendars`, cookieB)).json(),
    );
    expect(JSON.stringify(bCalendars)).not.toContain(aEventTitle);
    const bPersonalWeek = personalWeekResponseSchema.parse(
      await (
        await request(`/api/families/${familyId}/week/personal?start=2026-09-28`, cookieB)
      ).json(),
    );
    expect(bPersonalWeek.status).toBe('unselected');
    expect(JSON.stringify(bPersonalWeek)).not.toContain(aEventTitle);

    await db.insert(memberCalendars).values({
      memberId: memberB,
      calendarId: 'calendar-b-primary',
      displayEnabled: true,
    });
    const bOwnWeek = personalWeekResponseSchema.parse(
      await (
        await request(`/api/families/${familyId}/week/personal?start=2026-09-28`, cookieB)
      ).json(),
    );
    expect(bOwnWeek.events).toHaveLength(1);
    expect(bOwnWeek.events[0]?.title).toBe('B private');
    expect(JSON.stringify(bOwnWeek)).not.toContain(aEventTitle);
    expect(
      googleRequests
        .filter(
          (entry) => entry.url.includes('/events') && entry.url.includes('calendar-b-primary'),
        )
        .every((entry) => entry.authorization === 'Bearer access-b'),
    ).toBe(true);

    const familyWeek = await request(`/api/families/${familyId}/week?start=2026-09-28`, cookieB);
    expect(familyWeek.status).toBe(200);
    const familyWeekBody = weekResponseSchema.parse(await familyWeek.json());
    expect(JSON.stringify(familyWeekBody)).not.toContain(aEventTitle);
    expect(JSON.stringify(familyWeekBody)).not.toContain('SECRET_DESCRIPTION');
    expect(await db.select().from(eventMeta)).toHaveLength(0);
    expect(
      (await db.select().from(memberCalendars)).some((row) =>
        JSON.stringify(row).includes(aEventTitle),
      ),
    ).toBe(false);
    expect(tokenRefreshes).toContain('refresh-a');
    expect(tokenRefreshes).toContain('refresh-b');
  });

  it('returns authorization-required without Google calls when scope is missing and preserves explicit all-off selection', async () => {
    await db
      .update(googleTokens)
      .set({ scopes: PHASE1_SCOPES.join(' ') })
      .where(eq(googleTokens.userId, 'personal_user_a'));
    const listResponse = await request(`/api/families/${familyId}/personal-calendars`, cookieA);
    expect(personalCalendarListResponseSchema.parse(await listResponse.json())).toEqual({
      status: 'authorization_required',
      memberId: memberA,
      calendars: [],
    });
    const weekResponse = await request(`/api/families/${familyId}/week/personal`, cookieA);
    expect(personalWeekResponseSchema.parse(await weekResponse.json()).status).toBe(
      'authorization_required',
    );
    expect(googleRequests).toHaveLength(0);

    const put = await request(`/api/families/${familyId}/personal-calendars`, cookieA, 'PUT', {
      calendarIds: [],
    });
    const result = updatePersonalCalendarsResponseSchema.parse(await put.json());
    expect(result.authorizationRequired).toBe(true);
    if (!result.authorizationRequired) throw new Error('Expected incremental authorization');
    const authorizationUrl = new URL(result.authorizationUrl);
    expect(authorizationUrl.searchParams.get('include_granted_scopes')).toBe('true');
    expect(authorizationUrl.searchParams.get('scope')?.split(' ')).toContain(PERSONAL_EVENTS_SCOPE);
    const weekAfterPut = await request(`/api/families/${familyId}/week/personal`, cookieA);
    expect(personalWeekResponseSchema.parse(await weekAfterPut.json()).status).toBe(
      'authorization_required',
    );
  });

  it('enforces active-adult family access, same-origin writes, body limits, and week bounds', async () => {
    const anonymous = await request(`/api/families/${familyId}/personal-calendars`, '');
    expect(anonymous.status).toBe(401);

    await db.update(members).set({ status: 'pending' }).where(eq(members.id, memberB));
    const pending = await request(`/api/families/${familyId}/personal-calendars`, cookieB);
    expect(pending.status).toBe(404);
    await db
      .update(members)
      .set({ status: 'active', kind: 'child', userId: null })
      .where(eq(members.id, memberB));
    const child = await request(`/api/families/${familyId}/week/personal`, cookieB);
    expect(child.status).toBe(404);
    await db.delete(members).where(eq(members.id, memberB));
    const nonmember = await request(`/api/families/${familyId}/week/personal`, cookieB);
    expect(nonmember.status).toBe(404);
    expect(googleRequests).toHaveLength(0);

    const noCsrf = await app.request(
      `${ORIGIN}/api/families/${familyId}/personal-calendars`,
      {
        method: 'PUT',
        headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
        body: '{}',
      },
      TEST_ENV,
    );
    expect(noCsrf.status).toBe(403);

    const tooLarge = await request(`/api/families/${familyId}/personal-calendars`, cookieA, 'PUT', {
      calendarIds: Array.from(
        { length: 100 },
        (_, index) => `calendar-${index}-${'x'.repeat(200)}`,
      ),
    });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get('Cache-Control')).toContain('no-store');

    for (const query of [
      '?start=not-a-date',
      '?start=1969-12-31',
      '?start=2050-12-29',
      '?start=2026-09-28&start=2026-10-05',
    ]) {
      expect(
        (await request(`/api/families/${familyId}/week/personal${query}`, cookieA)).status,
      ).toBe(400);
    }
  });

  it('pages calendar and event lists, handles omitted items, and fails closed on a partial calendar error', async () => {
    calendarMode = 'calendar-pages';
    const pages = personalCalendarListResponseSchema.parse(
      await (await request(`/api/families/${familyId}/personal-calendars`, cookieA)).json(),
    );
    expect(pages.status).toBe('ready');
    if (pages.status === 'ready')
      expect(pages.calendars.map((item) => item.id)).toContain('calendar-secondary');

    await db
      .insert(memberCalendars)
      .values([{ memberId: memberA, calendarId: 'calendar-a-primary', displayEnabled: true }]);
    calendarMode = 'events-pages';
    const pagedWeek = personalWeekResponseSchema.parse(
      await (
        await request(`/api/families/${familyId}/week/personal?start=2026-09-28`, cookieA)
      ).json(),
    );
    expect(pagedWeek.events.map((event) => event.id)).toContain(
      'calendar-a-primary::event-a-page-two',
    );

    await db.delete(memberCalendars).where(eq(memberCalendars.memberId, memberA));
    await db.insert(memberCalendars).values([
      { memberId: memberA, calendarId: 'calendar-a-primary', displayEnabled: true },
      { memberId: memberA, calendarId: 'calendar-secondary', displayEnabled: true },
    ]);
    calendarMode = 'secondary-403';
    const partial = await request(
      `/api/families/${familyId}/week/personal?start=2026-09-28`,
      cookieA,
    );
    expect(partial.status).toBe(403);
    expect(await partial.text()).not.toContain('Page two');
  });

  it('rejects invalid and unknown calendar selections and treats full-off as saved unselected state', async () => {
    const invalidBodies = [
      { calendarIds: Array.from({ length: 11 }, (_, index) => `calendar-${index}`) },
      { calendarIds: ['calendar-a-primary', 'calendar-a-primary'] },
      { calendarIds: ['calendar-b-primary'] },
      { calendarIds: [], extra: true },
      { calendarIds: [], memberId: memberB },
    ];
    for (const body of invalidBodies) {
      const response = await request(
        `/api/families/${familyId}/personal-calendars`,
        cookieA,
        'PUT',
        body,
      );
      expect(response.status).toBe(400);
    }
    expect(await db.select().from(memberCalendars)).toHaveLength(0);

    const saved = await request(`/api/families/${familyId}/personal-calendars`, cookieA, 'PUT', {
      calendarIds: [],
    });
    expect(saved.status).toBe(200);
    const rows = await db
      .select()
      .from(memberCalendars)
      .where(eq(memberCalendars.memberId, memberA));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.displayEnabled)).toBe(true);
    const calendars = personalCalendarListResponseSchema.parse(
      await (await request(`/api/families/${familyId}/personal-calendars`, cookieA)).json(),
    );
    expect(calendars.status).toBe('ready');
    if (calendars.status === 'ready')
      expect(calendars.calendars.every((calendar) => !calendar.selected)).toBe(true);
    const personalWeek = personalWeekResponseSchema.parse(
      await (await request(`/api/families/${familyId}/week/personal`, cookieA)).json(),
    );
    expect(personalWeek.status).toBe('unselected');
    expect(personalWeek.events).toEqual([]);
  });

  it('rejects pagination loops and sanitizes Google permission and server failures', async () => {
    calendarMode = 'bad-page';
    const loopResponse = await request(`/api/families/${familyId}/personal-calendars`, cookieA);
    expect(loopResponse.status).toBe(502);
    expect(((await loopResponse.json()) as { code: string }).code).toBe('CALENDAR_PAGE_LIMIT');
    calendarMode = 'many-pages';
    const tooManyPages = await request(`/api/families/${familyId}/personal-calendars`, cookieA);
    expect(tooManyPages.status).toBe(502);
    expect(((await tooManyPages.json()) as { code: string }).code).toBe('CALENDAR_PAGE_LIMIT');
    for (const [mode, expectedStatus] of [
      ['google-403', 403],
      ['google-404', 403],
      ['google-500', 503],
    ] as const) {
      calendarMode = 'ok';
      await request(`/api/families/${familyId}/personal-calendars`, cookieA);
      await db
        .insert(memberCalendars)
        .values({ memberId: memberA, calendarId: 'calendar-a-primary', displayEnabled: true });
      calendarMode = mode;
      const response = await request(
        `/api/families/${familyId}/week/personal?start=2026-09-28`,
        cookieA,
      );
      expect(response.status).toBe(expectedStatus);
      const body = await response.text();
      expect(body).not.toContain('private upstream text');
      await db.delete(memberCalendars).where(eq(memberCalendars.memberId, memberA));
    }
  }, 15_000);

  it('refreshes after Google 401 and fails the full selection instead of returning partial events', async () => {
    await db.insert(memberCalendars).values([
      { memberId: memberA, calendarId: 'calendar-a-primary', displayEnabled: true },
      { memberId: memberA, calendarId: 'calendar-secondary', displayEnabled: true },
    ]);
    calendarMode = '401-once';
    const recovered = await request(
      `/api/families/${familyId}/week/personal?start=2026-09-28`,
      cookieA,
    );
    expect(recovered.status).toBe(200);
    expect(tokenRefreshes.filter((token) => token === 'refresh-a').length).toBeGreaterThanOrEqual(
      2,
    );

    calendarMode = 'google-403';
    const failed = await request(
      `/api/families/${familyId}/week/personal?start=2026-09-28`,
      cookieA,
    );
    expect(failed.status).toBe(403);
    expect(personalWeekResponseSchema.safeParse(await failed.clone().json()).success).toBe(false);
  });
});
