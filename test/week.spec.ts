import { env } from 'cloudflare:test';
import { weekErrorResponseSchema, weekResponseSchema } from '@shared/schemas/week';
import { SESSION_COOKIE_NAME } from '@worker/auth/config';
import { encryptAesGcm } from '@worker/auth/crypto';
import { createSession } from '@worker/auth/session';
import { createDb } from '@worker/db';
import {
  closureDays,
  eventMeta,
  families,
  googleTokens,
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

const TEST_ORIGIN = 'http://localhost:5173';
const TEST_AES_KEY_BASE64 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';
const TEST_SESSION_SECRET = 'test-session-secret-at-least-32-chars-long-secure-entropy';
const TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: TEST_ORIGIN,
  GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret-12345',
  SESSION_SECRET: TEST_SESSION_SECRET,
  TOKEN_ENC_KEY: TEST_AES_KEY_BASE64,
};
const SESSION_COOKIE_OPTIONS = {
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax' as const,
  maxAge: 30 * 24 * 60 * 60,
};

type CalendarResponder = (requestUrl: string) => Response | Promise<Response>;
type CalendarRequestRecord = { url: string; method: string };

describe('Task 1-6: family week API', () => {
  const db = createDb(env.DB);
  let calendarResponder: CalendarResponder;
  let tokenErrorResponse: Response | null;
  let refreshTokenValues: string[];
  let calendarRequests: CalendarRequestRecord[];
  let fixtureNumber = 0;

  async function createCookieHeader(rawToken: string): Promise<string> {
    const cookieApp = new Hono();
    cookieApp.get('/test', async (c) => {
      await setSignedCookie(
        c,
        SESSION_COOKIE_NAME,
        rawToken,
        TEST_SESSION_SECRET,
        SESSION_COOKIE_OPTIONS,
      );
      return c.text('ok');
    });
    const response = await cookieApp.request('http://localhost/test');
    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) throw new Error('Expected a signed session cookie');
    return setCookie.split(';')[0] ?? '';
  }

  async function seedUser(userId: string, refreshToken: string) {
    await db.insert(users).values({
      id: userId,
      googleSub: `sub_${userId}`,
      email: `${userId}@example.test`,
      displayName: userId,
    });
    await db.insert(googleTokens).values({
      userId,
      refreshTokenEnc: await encryptAesGcm(
        refreshToken,
        TEST_AES_KEY_BASE64,
        `google-refresh:${userId}`,
      ),
      scopes:
        'openid email profile https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      updatedAt: Math.floor(Date.now() / 1000),
    });
  }

  async function seedFamily(options?: { ready?: boolean; calendarId?: string | null }) {
    fixtureNumber += 1;
    const suffix = `week_${fixtureNumber}`;
    const ownerId = `usr_owner_${suffix}`;
    const callerId = `usr_caller_${suffix}`;
    const familyId = `fam_${suffix}`;
    const ownerMemberId = `mem_owner_${suffix}`;
    const callerMemberId = `mem_caller_${suffix}`;
    const calendarId =
      options?.calendarId === undefined ? `calendar_${suffix}` : options.calendarId;
    await seedUser(ownerId, `owner-refresh-${suffix}`);
    await seedUser(callerId, `caller-refresh-${suffix}`);
    await db.insert(families).values({
      id: familyId,
      name: 'テスト家族',
      familyCalendarId: calendarId,
      ownerUserId: ownerId,
      creationStatus: options?.ready === false ? 'creating' : 'ready',
      calendarCreationId: `creation_${suffix}`,
      dayStartHour: 8,
      dayEndHour: 20,
    });
    await db.insert(members).values([
      {
        id: ownerMemberId,
        familyId,
        userId: ownerId,
        kind: 'adult',
        name: 'Owner',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      },
      {
        id: callerMemberId,
        familyId,
        userId: callerId,
        kind: 'adult',
        name: 'Caller',
        color: 'teal',
        sortOrder: 1,
        status: 'active',
      },
      {
        id: `mem_child_${suffix}`,
        familyId,
        userId: null,
        kind: 'child',
        name: 'Child',
        color: 'ochre',
        sortOrder: 2,
        status: 'active',
      },
    ]);
    const session = await createSession(db, callerId);
    return {
      familyId,
      calendarId,
      ownerId,
      callerId,
      callerMemberId,
      cookie: await createCookieHeader(session.rawToken),
    };
  }

  async function requestWeek(path: string, cookie?: string): Promise<Response> {
    const response = await app.request(
      `${TEST_ORIGIN}${path}`,
      {
        method: 'GET',
        headers: cookie ? { Cookie: cookie } : {},
      },
      TEST_ENV,
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    return response;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    calendarResponder = () =>
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    refreshTokenValues = [];
    tokenErrorResponse = null;
    calendarRequests = [];
    await db.delete(eventMeta);
    await db.delete(closureDays);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url === 'https://oauth2.googleapis.com/token') {
        const tokenBody = new TextDecoder().decode(await request.clone().arrayBuffer());
        const form = new URLSearchParams(tokenBody);
        refreshTokenValues.push(form.get('refresh_token') ?? '');
        if (tokenErrorResponse) return tokenErrorResponse.clone();
        return new Response(
          JSON.stringify({
            access_token: 'mock-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (request.url.startsWith(GOOGLE_CALENDAR_API_BASE)) {
        const url = new URL(request.url);
        if (
          request.method !== 'GET' ||
          !/^\/calendar\/v3\/calendars\/[^/]+\/events$/.test(url.pathname)
        ) {
          throw new Error(`Unexpected Google Calendar request: ${request.method} ${url.pathname}`);
        }
        calendarRequests.push({ url: request.url, method: request.method });
        return calendarResponder(request.url);
      }
      throw new Error(`Unexpected outbound request: ${request.url}`);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await db.delete(eventMeta);
    await db.delete(closureDays);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);
  });

  it('returns the joined non-owner member week with strict privacy-safe event fields', async () => {
    const fixture = await seedFamily();
    const event = {
      id: 'family_event_01',
      status: 'confirmed',
      summary: '公園へ行く',
      description: 'private description',
      location: 'private location',
      htmlLink: 'https://calendar.google.test/private',
      etag: 'private-etag',
      creator: { email: 'private-creator@example.test' },
      organizer: { email: 'private-organizer@example.test' },
      attendees: [{ email: 'private-attendee@example.test' }],
      start: { date: '2026-10-10' },
      end: { date: '2026-10-11' },
      extendedProperties: {
        private: {
          danran: '1',
          members: `${fixture.callerMemberId},unknown,${fixture.callerMemberId}`,
          assignee: 'unknown',
          status: 'broken',
          source: 'unknown',
        },
      },
    };
    calendarResponder = () =>
      new Response(JSON.stringify({ items: [event] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    await db.insert(eventMeta).values({
      id: 'meta_week_01',
      familyId: fixture.familyId,
      calendarId: fixture.calendarId ?? '',
      eventId: event.id,
      itemsJson: JSON.stringify(['水筒']),
    });
    await db.insert(closureDays).values({
      id: 'closure_week_01',
      familyId: fixture.familyId,
      date: '2026-10-10',
      label: '園の休み',
      memberIds: [],
    });
    await db.insert(closureDays).values({
      id: 'closure_week_unknown_target',
      familyId: fixture.familyId,
      date: '2026-10-07',
      label: '対象外の休園',
      memberIds: ['unknown-member'],
    });
    await db.insert(closureDays).values({
      id: 'closure_week_targeted',
      familyId: fixture.familyId,
      date: '2026-10-06',
      label: '本人対象の休園',
      memberIds: [fixture.callerMemberId],
    });
    await env.DB.prepare(
      'INSERT INTO closure_days (id, family_id, date, label, member_ids) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('closure_week_corrupt', fixture.familyId, '2026-10-08', '破損データ', '{bad json')
      .run();

    const response = await requestWeek(
      `/api/families/${fixture.familyId}/week?start=2026-10-05`,
      fixture.cookie,
    );
    expect(response.status).toBe(200);
    const json: unknown = await response.json();
    const body = weekResponseSchema.parse(json);
    expect(body.family).toEqual({ id: fixture.familyId, name: 'テスト家族' });
    expect(body.members.map(({ id }) => id)).toEqual([
      `mem_owner_week_${fixtureNumber}`,
      fixture.callerMemberId,
      `mem_child_week_${fixtureNumber}`,
    ]);
    expect(body.members[0]).not.toHaveProperty('userId');
    expect(body.week).toEqual({
      start: '2026-10-05',
      endInclusive: '2026-10-12',
      prevWeekStart: '2026-09-28',
      nextWeekStart: '2026-10-12',
      today: expect.any(String),
    });
    expect(body.days.find((day) => day.date === '2026-10-10')).toMatchObject({
      layout: 'weekend-card',
      closures: [{ label: '園の休み', memberIds: [] }],
      eventIds: [event.id],
    });
    expect(body.days.find((day) => day.date === '2026-10-06')).toMatchObject({
      layout: 'weekend-card',
      closures: [{ label: '本人対象の休園', memberIds: [fixture.callerMemberId] }],
    });
    expect(body.days.find((day) => day.date === '2026-10-07')).toMatchObject({
      layout: 'compact',
      closures: [],
    });
    expect(body.days.find((day) => day.date === '2026-10-08')).toMatchObject({
      layout: 'compact',
      closures: [],
    });
    expect(body.events).toEqual([
      {
        id: event.id,
        title: '公園へ行く',
        time: { kind: 'all-day', start: '2026-10-10', endExclusive: '2026-10-11' },
        memberIds: [fixture.callerMemberId],
        assigneeMemberId: null,
        status: 'confirmed',
        isRoutine: false,
        source: 'manual',
        items: ['水筒'],
      },
    ]);
    const output = JSON.stringify(body);
    expect(output).not.toContain('private description');
    expect(output).not.toContain('private location');
    expect(output).not.toContain('calendar.google.test');
    expect(output).not.toContain('private-etag');
    expect(output).not.toContain('private-creator@example.test');
    expect(output).not.toContain('private-organizer@example.test');
    expect(output).not.toContain('private-attendee@example.test');
    expect(refreshTokenValues).toEqual([`caller-refresh-week_${fixtureNumber}`]);
    expect(calendarRequests).toHaveLength(1);
    expect(calendarRequests.every(({ method }) => method === 'GET')).toBe(true);
    expect(new URL(calendarRequests[0]?.url ?? '').pathname).toBe(
      `/calendar/v3/calendars/${encodeURIComponent(fixture.calendarId ?? '')}/events`,
    );
    const requestUrl = new URL(calendarRequests[0]?.url ?? '');
    expect(requestUrl.searchParams.get('singleEvents')).toBe('true');
    expect(requestUrl.searchParams.get('orderBy')).toBe('startTime');
    expect(requestUrl.searchParams.get('showDeleted')).toBe('false');
    expect(requestUrl.searchParams.get('maxResults')).toBe('2500');
    expect(requestUrl.searchParams.get('timeMin')).toBe('2026-10-05T00:00:00+09:00');
    expect(requestUrl.searchParams.get('timeMax')).toBe('2026-10-13T00:00:00+09:00');
  });

  it('authenticates before validating query parameters and hides missing/non-member families', async () => {
    const noSession = await requestWeek('/api/families/fam_missing/week?unexpected=x');
    expect(noSession.status).toBe(401);
    expect(weekErrorResponseSchema.parse(await noSession.json()).code).toBe('UNAUTHORIZED');

    const fixture = await seedFamily();
    const invalid = await requestWeek(
      `/api/families/${fixture.familyId}/week?start=2026-02-30`,
      fixture.cookie,
    );
    expect(invalid.status).toBe(400);
    expect(weekErrorResponseSchema.parse(await invalid.json()).code).toBe('INVALID_INPUT');

    const missing = await requestWeek('/api/families/fam_missing/week', fixture.cookie);
    expect(missing.status).toBe(404);
    const outsiderId = `usr_outsider_week_${fixtureNumber}`;
    await seedUser(outsiderId, `outsider-refresh-week_${fixtureNumber}`);
    await db.insert(families).values({
      id: 'fam_not_member',
      name: 'Other',
      familyCalendarId: 'other_calendar',
      ownerUserId: outsiderId,
      creationStatus: 'ready',
      calendarCreationId: 'other_creation',
    });
    const nonMember = await requestWeek('/api/families/fam_not_member/week', fixture.cookie);
    expect(nonMember.status).toBe(404);

    await db.delete(members).where(eq(members.userId, fixture.ownerId));
    const ownerSession = await createSession(db, fixture.ownerId);
    const ownerCookie = await createCookieHeader(ownerSession.rawToken);
    const ownerWithoutMembership = await requestWeek(
      `/api/families/${fixture.familyId}/week`,
      ownerCookie,
    );
    expect(ownerWithoutMembership.status).toBe(404);
    expect(calendarRequests).toHaveLength(0);
  });

  it.each(['1970-01-01', '2050-12-31'])(
    'rejects unsupported displayed week around %s before contacting Google',
    async (date) => {
      const fixture = await seedFamily();
      const response = await requestWeek(
        `/api/families/${fixture.familyId}/week?start=${date}`,
        fixture.cookie,
      );
      expect(response.status).toBe(400);
      expect(weekErrorResponseSchema.parse(await response.json()).code).toBe('INVALID_INPUT');
      expect(refreshTokenValues).toHaveLength(0);
      expect(calendarRequests).toHaveLength(0);
    },
  );

  it.each(['1969-12-31', '2051-01-01', 'not-a-date'])(
    'rejects unsupported or malformed start %s before contacting Google',
    async (date) => {
      const fixture = await seedFamily();
      const response = await requestWeek(
        `/api/families/${fixture.familyId}/week?start=${date}`,
        fixture.cookie,
      );
      expect(response.status).toBe(400);
      expect(weekErrorResponseSchema.parse(await response.json()).code).toBe('INVALID_INPUT');
      expect(refreshTokenValues).toHaveLength(0);
      expect(calendarRequests).toHaveLength(0);
    },
  );

  it('returns 404 to a pending member and 409 for a ready member whose family calendar is not ready', async () => {
    const fixture = await seedFamily({ ready: false });
    await db
      .update(members)
      .set({ status: 'pending' })
      .where(eq(members.id, fixture.callerMemberId));
    const pending = await requestWeek(`/api/families/${fixture.familyId}/week`, fixture.cookie);
    expect(pending.status).toBe(404);

    await db
      .update(members)
      .set({ status: 'active' })
      .where(eq(members.id, fixture.callerMemberId));
    const notReady = await requestWeek(`/api/families/${fixture.familyId}/week`, fixture.cookie);
    expect(notReady.status).toBe(409);
    expect(weekErrorResponseSchema.parse(await notReady.json()).code).toBe('FAMILY_NOT_READY');
    expect(calendarRequests).toHaveLength(0);

    const nullCalendar = await seedFamily({ ready: true, calendarId: null });
    const noCalendar = await requestWeek(
      `/api/families/${nullCalendar.familyId}/week`,
      nullCalendar.cookie,
    );
    expect(noCalendar.status).toBe(409);
    expect(weekErrorResponseSchema.parse(await noCalendar.json()).code).toBe('FAMILY_NOT_READY');
  });

  it('returns 401 when the authenticated family member has no Google grant', async () => {
    const fixture = await seedFamily();
    await db.delete(googleTokens).where(eq(googleTokens.userId, fixture.callerId));
    const response = await requestWeek(
      `/api/families/${fixture.familyId}/week?start=2026-10-05`,
      fixture.cookie,
    );
    expect(response.status).toBe(401);
    expect(weekErrorResponseSchema.parse(await response.json()).code).toBe('REAUTH_REQUIRED');
    expect(calendarRequests).toHaveLength(0);
  });

  it('maps an invalid refresh grant to 401 REAUTH_REQUIRED', async () => {
    const fixture = await seedFamily();
    tokenErrorResponse = new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await requestWeek(`/api/families/${fixture.familyId}/week`, fixture.cookie);
    expect(response.status).toBe(401);
    expect(weekErrorResponseSchema.parse(await response.json()).code).toBe('REAUTH_REQUIRED');
    expect(calendarRequests).toHaveLength(0);
  });

  it('rejects repeated pagination tokens and later-page failures without returning partial events', async () => {
    const fixture = await seedFamily();
    calendarResponder = (requestUrl) => {
      const token = new URL(requestUrl).searchParams.get('pageToken');
      return new Response(
        JSON.stringify({
          items: token
            ? [
                {
                  id: 'later_event',
                  summary: 'later',
                  start: { date: '2026-10-10' },
                  end: { date: '2026-10-11' },
                },
              ]
            : [],
          nextPageToken: 'same-token',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const repeated = await requestWeek(
      `/api/families/${fixture.familyId}/week?start=2026-10-05`,
      fixture.cookie,
    );
    expect(repeated.status).toBe(502);
    expect(weekErrorResponseSchema.parse(await repeated.json()).code).toBe('CALENDAR_PAGE_LIMIT');
    expect(calendarRequests).toHaveLength(2);

    calendarRequests = [];
    calendarResponder = (requestUrl) => {
      const token = new URL(requestUrl).searchParams.get('pageToken');
      if (token)
        return new Response(JSON.stringify({ error: { message: 'private upstream detail' } }), {
          status: 500,
        });
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'first_event',
              summary: 'partial',
              start: { date: '2026-10-10' },
              end: { date: '2026-10-11' },
            },
          ],
          nextPageToken: 'page-2',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const pending = requestWeek(
      `/api/families/${fixture.familyId}/week?start=2026-10-05`,
      fixture.cookie,
    );
    await vi.waitFor(() => expect(calendarRequests).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(calendarRequests).toHaveLength(3));
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(calendarRequests).toHaveLength(4));
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(calendarRequests).toHaveLength(5));
    const failedPage = await pending;
    expect(failedPage.status).toBe(503);
    const failureBody = weekErrorResponseSchema.parse(await failedPage.json());
    expect(failureBody.code).toBe('GOOGLE_TEMPORARY_ERROR');
    expect(JSON.stringify(failureBody)).not.toContain('private upstream detail');
    expect(calendarRequests).toHaveLength(5);
  });

  it('stops at ten pages and does not return a partial week', async () => {
    const fixture = await seedFamily();
    calendarResponder = (requestUrl) => {
      const token = new URL(requestUrl).searchParams.get('pageToken');
      const page = token ? Number(token.slice('page-'.length)) : 1;
      return new Response(
        JSON.stringify({
          items:
            page === 1
              ? [
                  {
                    id: 'first_page_event',
                    summary: 'partial',
                    start: { date: '2026-10-10' },
                    end: { date: '2026-10-11' },
                  },
                ]
              : [],
          ...(page < 10 ? { nextPageToken: `page-${page + 1}` } : { nextPageToken: 'page-11' }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const response = await requestWeek(
      `/api/families/${fixture.familyId}/week?start=2026-10-05`,
      fixture.cookie,
    );
    expect(response.status).toBe(502);
    expect(weekErrorResponseSchema.parse(await response.json()).code).toBe('CALENDAR_PAGE_LIMIT');
    expect(calendarRequests).toHaveLength(10);
  });

  it('rejects an empty page token as an invalid Google response without partial events', async () => {
    const fixture = await seedFamily();
    calendarResponder = () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: 'partial_event',
              summary: 'partial',
              start: { date: '2026-10-10' },
              end: { date: '2026-10-11' },
            },
          ],
          nextPageToken: '',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    const response = await requestWeek(
      `/api/families/${fixture.familyId}/week?start=2026-10-05`,
      fixture.cookie,
    );
    expect(response.status).toBe(502);
    expect(weekErrorResponseSchema.parse(await response.json()).code).toBe('GOOGLE_ERROR');
    expect(calendarRequests).toHaveLength(1);
  });

  it('collects events from every successful page and emits the complete strict response', async () => {
    const fixture = await seedFamily();
    calendarResponder = (requestUrl) => {
      const token = new URL(requestUrl).searchParams.get('pageToken');
      const eventId = token ? 'event_page_2' : 'event_page_1';
      return new Response(
        JSON.stringify({
          items: [
            {
              id: eventId,
              summary: eventId,
              start: { date: '2026-10-10' },
              end: { date: '2026-10-11' },
            },
          ],
          ...(!token ? { nextPageToken: 'page-2' } : {}),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const response = await requestWeek(
      `/api/families/${fixture.familyId}/week?start=2026-10-05`,
      fixture.cookie,
    );
    expect(response.status).toBe(200);
    const body = weekResponseSchema.parse(await response.json());
    expect(body.events.map((event) => event.id).sort()).toEqual(['event_page_1', 'event_page_2']);
    expect(calendarRequests).toHaveLength(2);
    expect(new URL(calendarRequests[1]?.url ?? '').searchParams.get('pageToken')).toBe('page-2');
  });

  it('matches occurrence metadata by canonical start, prefers exact metadata, and tolerates corrupt metadata', async () => {
    const fixture = await seedFamily();
    const validOccurrence = {
      id: 'instance_event_01',
      status: 'confirmed',
      summary: 'Occurrence',
      recurringEventId: 'series_one',
      originalStartTime: { dateTime: '2026-10-09T15:30:00Z' },
      start: { dateTime: '2026-10-09T15:30:00Z' },
      end: { dateTime: '2026-10-09T16:00:00Z' },
      extendedProperties: {
        private: {
          danran: '1',
          members: `${fixture.callerMemberId},unknown,${fixture.callerMemberId}`,
          assignee: fixture.callerMemberId,
          status: 'tentative',
          source: 'import',
        },
      },
    };
    const invalidExact = {
      id: 'invalid_exact_event',
      status: 'tentative',
      summary: 'Invalid exact items',
      recurringEventId: 'series_two',
      originalStartTime: { dateTime: '2026-10-10T03:00:00+09:00' },
      start: { date: '2026-10-10' },
      end: { date: '2026-10-11' },
      extendedProperties: {
        private: { danran: '1', members: 99, assignee: 7, status: 'bad', source: 'bad' },
      },
    };
    const allDayOccurrence = {
      id: 'all_day_instance_01',
      status: 'confirmed',
      summary: 'All day occurrence',
      recurringEventId: 'series_three',
      originalStartTime: { date: '2026-10-10' },
      start: { date: '2026-10-10' },
      end: { date: '2026-10-11' },
    };
    const seriesFallback = {
      id: 'series_fallback_event',
      status: 'confirmed',
      summary: 'Series fallback',
      recurringEventId: 'series_one',
      originalStartTime: { dateTime: '2026-10-10T15:00:00+09:00' },
      start: { dateTime: '2026-10-10T15:00:00+09:00' },
      end: { dateTime: '2026-10-10T16:00:00+09:00' },
    };
    const invalidArrayItems = {
      id: 'invalid_array_items_event',
      status: 'confirmed',
      summary: 'Invalid array items',
      start: { date: '2026-10-10' },
      end: { date: '2026-10-11' },
    };
    const externalEvent = {
      id: 'external_event_01',
      status: 'tentative',
      summary: 'External event',
      start: { dateTime: '2026-10-10T02:00:00Z' },
      end: { dateTime: '2026-10-10T03:00:00Z' },
      extendedProperties: {
        private: {
          members: fixture.callerMemberId,
          assignee: fixture.callerMemberId,
          status: 'confirmed',
          source: 'publish',
        },
      },
    };
    const cancelled = { id: 'cancelled_event_01', status: 'cancelled', summary: 'Cancelled' };
    calendarResponder = () =>
      new Response(
        JSON.stringify({
          items: [
            validOccurrence,
            invalidExact,
            allDayOccurrence,
            seriesFallback,
            invalidArrayItems,
            externalEvent,
            cancelled,
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    await db.insert(eventMeta).values([
      {
        id: 'meta_occurrence',
        familyId: fixture.familyId,
        calendarId: fixture.calendarId ?? '',
        eventId: 'meta_only_instance_id',
        recurringEventId: 'series_one',
        originalStart: '2026-10-10T00:30:00+09:00',
        itemsJson: JSON.stringify(['発表資料']),
      },
      {
        id: 'meta_series_one',
        familyId: fixture.familyId,
        calendarId: fixture.calendarId ?? '',
        eventId: 'series_one',
        itemsJson: JSON.stringify(['series item']),
      },
      {
        id: 'meta_exact_invalid_items',
        familyId: fixture.familyId,
        calendarId: fixture.calendarId ?? '',
        eventId: invalidExact.id,
        recurringEventId: invalidExact.recurringEventId,
        originalStart: '2026-10-10T03:00:00+09:00',
        itemsJson: '{bad json',
      },
      {
        id: 'meta_occurrence_fallback',
        familyId: fixture.familyId,
        calendarId: fixture.calendarId ?? '',
        eventId: 'different_exact_id',
        recurringEventId: invalidExact.recurringEventId,
        originalStart: '2026-10-10T03:00:00+09:00',
        itemsJson: JSON.stringify(['must not fall back']),
      },
      {
        id: 'meta_series_two',
        familyId: fixture.familyId,
        calendarId: fixture.calendarId ?? '',
        eventId: invalidExact.recurringEventId,
        itemsJson: JSON.stringify(['series must not win']),
      },
      {
        id: 'meta_invalid_array_items',
        familyId: fixture.familyId,
        calendarId: fixture.calendarId ?? '',
        eventId: invalidArrayItems.id,
        itemsJson: JSON.stringify([123]),
      },
      {
        id: 'meta_all_day_occurrence',
        familyId: fixture.familyId,
        calendarId: fixture.calendarId ?? '',
        eventId: 'meta_only_all_day_id',
        recurringEventId: allDayOccurrence.recurringEventId,
        originalStart: '2026-10-10',
        itemsJson: JSON.stringify(['日付メモ']),
      },
      {
        id: 'meta_other_calendar',
        familyId: fixture.familyId,
        calendarId: 'other_calendar',
        eventId: externalEvent.id,
        itemsJson: JSON.stringify(['must not leak']),
      },
    ]);

    const response = await requestWeek(
      `/api/families/${fixture.familyId}/week?start=2026-10-05`,
      fixture.cookie,
    );
    expect(response.status).toBe(200);
    const body = weekResponseSchema.parse(await response.json());
    expect(body.events).toHaveLength(6);
    const occurrence = body.events.find((event) => event.id === validOccurrence.id);
    expect(occurrence).toMatchObject({
      time: {
        kind: 'timed',
        start: '2026-10-10T00:30:00+09:00',
        endExclusive: '2026-10-10T01:00:00+09:00',
      },
      memberIds: [fixture.callerMemberId],
      assigneeMemberId: fixture.callerMemberId,
      status: 'tentative',
      source: 'import',
      items: ['発表資料'],
    });
    expect(body.events.find((event) => event.id === invalidExact.id)).toMatchObject({
      memberIds: [],
      assigneeMemberId: null,
      status: 'tentative',
      source: 'manual',
      items: [],
    });
    expect(body.events.find((event) => event.id === allDayOccurrence.id)).toMatchObject({
      time: { kind: 'all-day', start: '2026-10-10', endExclusive: '2026-10-11' },
      items: ['日付メモ'],
    });
    expect(body.events.find((event) => event.id === seriesFallback.id)).toMatchObject({
      items: ['series item'],
    });
    expect(body.events.find((event) => event.id === invalidArrayItems.id)).toMatchObject({
      items: [],
    });
    expect(body.events.find((event) => event.id === externalEvent.id)).toMatchObject({
      memberIds: [],
      assigneeMemberId: null,
      status: 'tentative',
      source: 'external',
      items: [],
    });
    expect(body.events.some((event) => event.id === cancelled.id)).toBe(false);
  });

  it('normalizes a midweek start and defaults to JST today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T15:00:00Z'));
    const fixture = await seedFamily();
    const midweek = await requestWeek(
      `/api/families/${fixture.familyId}/week?start=2026-10-08`,
      fixture.cookie,
    );
    expect(midweek.status).toBe(200);
    expect(weekResponseSchema.parse(await midweek.json()).week.start).toBe('2026-10-05');

    const defaultWeek = await requestWeek(`/api/families/${fixture.familyId}/week`, fixture.cookie);
    expect(defaultWeek.status).toBe(200);
    expect(weekResponseSchema.parse(await defaultWeek.json()).week).toMatchObject({
      start: '2026-10-05',
      today: '2026-10-05',
    });
  });

  it('reacquires an access token after Google returns 401 and validates the retry response', async () => {
    const fixture = await seedFamily();
    let requestCount = 0;
    calendarResponder = () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(
          JSON.stringify({ error: { message: 'private expired token detail' } }),
          { status: 401 },
        );
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const response = await requestWeek(
      `/api/families/${fixture.familyId}/week?start=2026-10-05`,
      fixture.cookie,
    );
    expect(response.status).toBe(200);
    weekResponseSchema.parse(await response.json());
    expect(refreshTokenValues).toEqual([
      `caller-refresh-week_${fixtureNumber}`,
      `caller-refresh-week_${fixtureNumber}`,
    ]);
    expect(calendarRequests).toHaveLength(2);
  });

  it('maps malformed Google event pages to sanitized 502 GOOGLE_ERROR', async () => {
    const fixture = await seedFamily();
    calendarResponder = () =>
      new Response(
        JSON.stringify({ items: [{ id: 'malformed_event', summary: 'private malformed data' }] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    const response = await requestWeek(`/api/families/${fixture.familyId}/week`, fixture.cookie);
    expect(response.status).toBe(502);
    const body = weekErrorResponseSchema.parse(await response.json());
    expect(body.code).toBe('GOOGLE_ERROR');
    expect(JSON.stringify(body)).not.toContain('private malformed data');
  });

  it('maps exhausted 429 retries to sanitized 503 GOOGLE_TEMPORARY_ERROR', async () => {
    const fixture = await seedFamily();
    calendarResponder = () =>
      new Response(JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    const pending = requestWeek(`/api/families/${fixture.familyId}/week`, fixture.cookie);
    await vi.waitFor(() => expect(calendarRequests).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(calendarRequests).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(calendarRequests).toHaveLength(3));
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(calendarRequests).toHaveLength(4));
    const response = await pending;
    expect(response.status).toBe(503);
    expect(weekErrorResponseSchema.parse(await response.json()).code).toBe(
      'GOOGLE_TEMPORARY_ERROR',
    );
    expect(calendarRequests).toHaveLength(4);
  });

  it('returns the strict week error envelope when the request origin is rejected', async () => {
    const fixture = await seedFamily();
    const response = await app.request(
      `https://attacker.example/api/families/${fixture.familyId}/week`,
      {
        method: 'GET',
        headers: { Cookie: fixture.cookie },
      },
      TEST_ENV,
    );
    expect(response.status).toBe(403);
    expect(weekErrorResponseSchema.parse(await response.json()).code).toBe('FORBIDDEN');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(calendarRequests).toHaveLength(0);
  });

  it.each([403, 404])(
    'maps Google calendar access status %s to a sanitized 403',
    async (googleStatus) => {
      const fixture = await seedFamily();
      calendarResponder = () =>
        new Response(JSON.stringify({ error: { message: 'private google detail' } }), {
          status: googleStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      const response = await requestWeek(`/api/families/${fixture.familyId}/week`, fixture.cookie);
      expect(response.status).toBe(403);
      const body = weekErrorResponseSchema.parse(await response.json());
      expect(body.code).toBe('CALENDAR_ACCESS_DENIED');
      expect(JSON.stringify(body)).not.toContain('private google detail');
    },
  );
});
