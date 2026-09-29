import { env } from 'cloudflare:test';
import type {
  FreeBusyQueryInput,
  FreeBusyQueryResponse,
  GoogleAclRule,
  GoogleCalendar,
  GoogleCalendarListPage,
  GoogleEvent,
  GoogleEventsPage,
  InsertAclRuleInput,
  InsertEventInput,
  PatchEventInput,
} from '@shared/schemas/google-calendar';
import {
  isValidIanaTimeZone,
  isValidIsoDateString,
  isValidRfc3339String,
} from '@shared/schemas/google-calendar';
import { encryptAesGcm } from '@worker/auth/crypto';
import { createDb } from '@worker/db';
import { googleTokens, users } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import {
  GOOGLE_CALENDAR_API_BASE,
  GoogleCalendarError,
  createGoogleCalendarClient,
  validatePathSegment,
} from '@worker/google/calendar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_AES_KEY_BASE64 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';

const TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: 'http://localhost:5173',
  GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret-12345',
  SESSION_SECRET: 'test-session-secret-at-least-32-chars-long-secure-entropy',
  TOKEN_ENC_KEY: TEST_AES_KEY_BASE64,
};

interface MockRequestRecord {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyJson?: unknown;
  redirect?: string;
}

describe('Task 1-2: Google Calendar REST Client', () => {
  const db = createDb(env.DB);
  const testUserId = 'usr_calendar_test_01';
  let recordedRequests: MockRequestRecord[] = [];
  let tokenCounter = 0;

  async function seedTestUser(userId = testUserId, refreshToken = 'mock-refresh-token-01') {
    await db.insert(users).values({
      id: userId,
      googleSub: `sub_${userId}`,
      email: `${userId}@example.test`,
      displayName: `User ${userId}`,
    });

    const encrypted = await encryptAesGcm(
      refreshToken,
      TEST_ENV.TOKEN_ENC_KEY ?? '',
      `google-refresh:${userId}`,
    );

    await db.insert(googleTokens).values({
      userId,
      refreshTokenEnc: encrypted,
      scopes:
        'openid email profile https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      updatedAt: Math.floor(Date.now() / 1000),
    });
  }

  function setupMockFetch(
    calendarHandler?: (
      req: Request,
      record: MockRequestRecord,
    ) => Promise<Response> | Response | undefined,
  ) {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = req.url;

      if (url === 'https://oauth2.googleapis.com/token') {
        tokenCounter += 1;
        return new Response(
          JSON.stringify({
            access_token: `mock-access-token-${tokenCounter}`,
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.startsWith(GOOGLE_CALENDAR_API_BASE)) {
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });

        let bodyText: string | undefined;
        let bodyJson: unknown;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          bodyText = await req.clone().text();
          if (bodyText) {
            try {
              bodyJson = JSON.parse(bodyText);
            } catch {
              // not json
            }
          }
        }

        const record: MockRequestRecord = {
          url,
          method: req.method,
          headers,
          bodyText,
          bodyJson,
          redirect: req.redirect,
        };
        recordedRequests.push(record);

        if (calendarHandler) {
          const customRes = await calendarHandler(req, record);
          if (customRes) return customRes;
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected outgoing network call intercepted: ${url}`);
    });
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    recordedRequests = [];
    tokenCounter = 0;
    await db.delete(googleTokens);
    await db.delete(users);
    await seedTestUser();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await db.delete(googleTokens);
    await db.delete(users);
  });

  describe('1. Individual Scoped Methods (Exact 10 Methods)', () => {
    it('1. calendars.insert: creates calendar with default timeZone Asia/Tokyo', async () => {
      const expectedCalendar: GoogleCalendar = {
        id: 'cal_family_123',
        summary: 'Danran Family Calendar',
        description: 'Family shared calendar',
        timeZone: 'Asia/Tokyo',
        etag: '"etag123"',
      };

      setupMockFetch((_req, record) => {
        expect(record.method).toBe('POST');
        expect(record.url).toBe(`${GOOGLE_CALENDAR_API_BASE}/calendars`);
        expect(record.headers.authorization).toBe('Bearer mock-access-token-1');
        expect(record.headers['content-type']).toContain('application/json');
        expect(record.bodyJson).toEqual({
          summary: 'Danran Family Calendar',
          description: 'Family shared calendar',
          timeZone: 'Asia/Tokyo',
        });
        return new Response(JSON.stringify(expectedCalendar), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const result = await client.calendars.insert({
        summary: 'Danran Family Calendar',
        description: 'Family shared calendar',
      });

      expect(result).toEqual(expectedCalendar);
      expect(recordedRequests.length).toBe(1);
    });

    it('2. acl.insert: shares calendar with writer role and encodes path segment', async () => {
      const calendarId = 'family#cal@group.calendar.google.com';
      const expectedAcl: GoogleAclRule = {
        id: 'user:partner@example.test',
        role: 'writer',
        scope: {
          type: 'user',
          value: 'partner@example.test',
        },
        etag: '"etagAcl"',
      };

      setupMockFetch((_req, record) => {
        expect(record.method).toBe('POST');
        const expectedPath = encodeURIComponent(calendarId);
        expect(record.url).toBe(
          `${GOOGLE_CALENDAR_API_BASE}/calendars/${expectedPath}/acl?sendNotifications=false`,
        );
        expect(record.headers.authorization).toBe('Bearer mock-access-token-1');
        expect(record.bodyJson).toEqual({
          role: 'writer',
          scope: {
            type: 'user',
            value: 'partner@example.test',
          },
        });
        return new Response(JSON.stringify(expectedAcl), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const result = await client.acl.insert(
        calendarId,
        {
          role: 'writer',
          scope: { type: 'user', value: 'partner@example.test' },
        },
        { sendNotifications: false },
      );

      expect(result).toEqual(expectedAcl);
      expect(recordedRequests.length).toBe(1);
    });

    it('3. events.list: queries paginated events with time range and singleEvents', async () => {
      const calendarId = 'cal_list_test';
      const expectedPage: GoogleEventsPage = {
        items: [
          {
            id: 'evt_01',
            status: 'confirmed',
            summary: 'Weekend Trip',
            start: { dateTime: '2026-10-10T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
            end: { dateTime: '2026-10-10T12:00:00+09:00', timeZone: 'Asia/Tokyo' },
          },
        ],
        nextPageToken: 'token_next_page_1',
        nextSyncToken: 'token_next_sync_1',
        timeZone: 'Asia/Tokyo',
      };

      setupMockFetch((_req, record) => {
        expect(record.method).toBe('GET');
        const urlObj = new URL(record.url);
        expect(urlObj.pathname).toBe(`/calendar/v3/calendars/${calendarId}/events`);
        expect(urlObj.searchParams.get('timeMin')).toBe('2026-10-01T00:00:00Z');
        expect(urlObj.searchParams.get('timeMax')).toBe('2026-10-31T23:59:59Z');
        expect(urlObj.searchParams.get('singleEvents')).toBe('true');
        expect(urlObj.searchParams.get('orderBy')).toBe('startTime');
        expect(urlObj.searchParams.get('maxResults')).toBe('100');
        expect(urlObj.searchParams.get('timeZone')).toBe('Asia/Tokyo');
        return new Response(JSON.stringify(expectedPage), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const result = await client.events.list(calendarId, {
        timeMin: '2026-10-01T00:00:00Z',
        timeMax: '2026-10-31T23:59:59Z',
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 100,
      });

      expect(result).toEqual(expectedPage);
    });

    it('4. events.get: retrieves single event by ID with default timeZone query', async () => {
      const calendarId = 'cal_get_test';
      const eventId = 'evt_get_123';
      const expectedEvent: GoogleEvent = {
        id: eventId,
        status: 'confirmed',
        summary: 'Dentist Appointment',
        start: { dateTime: '2026-10-05T15:00:00+09:00' },
        end: { dateTime: '2026-10-05T16:00:00+09:00' },
      };

      setupMockFetch((_req, record) => {
        expect(record.method).toBe('GET');
        expect(record.url).toBe(
          `${GOOGLE_CALENDAR_API_BASE}/calendars/${calendarId}/events/${eventId}?timeZone=Asia%2FTokyo`,
        );
        return new Response(JSON.stringify(expectedEvent), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const result = await client.events.get(calendarId, eventId);
      expect(result).toEqual(expectedEvent);
    });

    it('5. events.insert: inserts event with client-generated stable ID and sendUpdates query', async () => {
      const calendarId = 'cal_insert_test';
      const inputEvent: InsertEventInput = {
        summary: 'Piano Lesson',
        start: { dateTime: '2026-10-06T16:00:00+09:00' },
        end: { dateTime: '2026-10-06T17:00:00+09:00' },
        extendedProperties: {
          private: { danran: '1', assignee: 'm_papa' },
        },
      };

      let insertedId = '';
      setupMockFetch((_req, record) => {
        expect(record.method).toBe('POST');
        expect(record.url).toBe(
          `${GOOGLE_CALENDAR_API_BASE}/calendars/${calendarId}/events?sendUpdates=all`,
        );
        const parsedBody = record.bodyJson as { id: string; summary: string };
        expect(parsedBody.summary).toBe('Piano Lesson');
        expect(parsedBody.id).toMatch(/^[a-v0-9]{32}$/);
        insertedId = parsedBody.id;

        return new Response(
          JSON.stringify({
            ...parsedBody,
            status: 'confirmed',
            start: inputEvent.start,
            end: inputEvent.end,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const result = await client.events.insert(calendarId, inputEvent, { sendUpdates: 'all' });

      expect(result.id).toBe(insertedId);
      expect(result.summary).toBe('Piano Lesson');
    });

    it('6. events.patch: applies partial updates without injecting default fields', async () => {
      const calendarId = 'cal_patch_test';
      const eventId = 'evt_patch_123';

      setupMockFetch((_req, record) => {
        expect(record.method).toBe('PATCH');
        expect(record.url).toBe(
          `${GOOGLE_CALENDAR_API_BASE}/calendars/${calendarId}/events/${eventId}?sendUpdates=none`,
        );
        // Assert start/end and defaults were NOT injected into patch
        expect(record.bodyJson).toEqual({
          summary: 'Updated Lesson Title',
          description: null,
        });

        return new Response(
          JSON.stringify({
            id: eventId,
            status: 'confirmed',
            summary: 'Updated Lesson Title',
            start: { dateTime: '2026-10-06T16:00:00+09:00' },
            end: { dateTime: '2026-10-06T17:00:00+09:00' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const result = await client.events.patch(
        calendarId,
        eventId,
        {
          summary: 'Updated Lesson Title',
          description: null,
        },
        { sendUpdates: 'none' },
      );

      expect(result.summary).toBe('Updated Lesson Title');
    });

    it('7. events.delete: deletes event and returns void on 204 No Content without JSON parsing', async () => {
      const calendarId = 'cal_del_test';
      const eventId = 'evt_del_123';

      setupMockFetch((_req, record) => {
        expect(record.method).toBe('DELETE');
        expect(record.url).toBe(
          `${GOOGLE_CALENDAR_API_BASE}/calendars/${calendarId}/events/${eventId}?sendUpdates=all`,
        );
        return new Response(null, { status: 204 });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const deleteResult = await client.events.delete(calendarId, eventId, { sendUpdates: 'all' });
      expect(deleteResult).toBeUndefined();
    });

    it('8. events.instances: retrieves recurring event instances page', async () => {
      const calendarId = 'cal_instances_test';
      const eventId = 'evt_recurring_parent';
      const expectedInstances: GoogleEventsPage = {
        items: [
          {
            id: `${eventId}_20261006T070000Z`,
            status: 'confirmed',
            recurringEventId: eventId,
            originalStartTime: { dateTime: '2026-10-06T16:00:00+09:00' },
            start: { dateTime: '2026-10-06T16:00:00+09:00' },
            end: { dateTime: '2026-10-06T17:00:00+09:00' },
          },
        ],
        timeZone: 'Asia/Tokyo',
      };

      setupMockFetch((_req, record) => {
        expect(record.method).toBe('GET');
        const urlObj = new URL(record.url);
        expect(urlObj.pathname).toBe(
          `/calendar/v3/calendars/${calendarId}/events/${eventId}/instances`,
        );
        expect(urlObj.searchParams.get('maxResults')).toBe('50');
        expect(urlObj.searchParams.get('timeZone')).toBe('Asia/Tokyo');
        return new Response(JSON.stringify(expectedInstances), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const result = await client.events.instances(calendarId, eventId, { maxResults: 50 });
      expect(result).toEqual(expectedInstances);
    });

    it('9. calendarList.list: retrieves calendar entries including deletion tombstones', async () => {
      const expectedCalendarList: GoogleCalendarListPage = {
        items: [
          {
            id: 'primary',
            summary: 'Personal Calendar',
            primary: true,
            accessRole: 'owner',
            timeZone: 'Asia/Tokyo',
          },
          {
            id: 'deleted_cal_123',
            deleted: true,
          },
        ],
        nextPageToken: 'cal_page_token_2',
      };

      setupMockFetch((_req, record) => {
        expect(record.method).toBe('GET');
        expect(record.url).toBe(
          `${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList?maxResults=20&showDeleted=true`,
        );
        return new Response(JSON.stringify(expectedCalendarList), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const result = await client.calendarList.list({ maxResults: 20, showDeleted: true });
      expect(result).toEqual(expectedCalendarList);
    });

    it('10. freeBusy.query: posts query with time bounds and returns busy intervals', async () => {
      const expectedFreeBusy: FreeBusyQueryResponse = {
        timeMin: '2026-10-10T00:00:00Z',
        timeMax: '2026-10-11T00:00:00Z',
        calendars: {
          'user1@example.test': {
            busy: [
              {
                start: '2026-10-10T09:00:00Z',
                end: '2026-10-10T11:00:00Z',
              },
            ],
          },
        },
      };

      setupMockFetch((_req, record) => {
        expect(record.method).toBe('POST');
        expect(record.url).toBe(`${GOOGLE_CALENDAR_API_BASE}/freeBusy`);
        expect(record.bodyJson).toEqual({
          timeMin: '2026-10-10T00:00:00Z',
          timeMax: '2026-10-11T00:00:00Z',
          timeZone: 'Asia/Tokyo',
          items: [{ id: 'user1@example.test' }],
        });
        return new Response(JSON.stringify(expectedFreeBusy), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const result = await client.freeBusy.query({
        timeMin: '2026-10-10T00:00:00Z',
        timeMax: '2026-10-11T00:00:00Z',
        items: [{ id: 'user1@example.test' }],
      });

      expect(result).toEqual(expectedFreeBusy);
    });
  });

  describe('2. Datetime Boundaries, Leap Dates, Offset Validation & ACL Enums', () => {
    it('validates leap years and rejects impossible calendar dates like 2026-02-29 and 2026-02-30', () => {
      expect(isValidIsoDateString('2024-02-29')).toBe(true); // 2024 is leap year
      expect(isValidIsoDateString('2026-02-28')).toBe(true);
      expect(isValidIsoDateString('2026-02-29')).toBe(false); // 2026 not leap
      expect(isValidIsoDateString('2026-02-30')).toBe(false);
      expect(isValidIsoDateString('2026-04-31')).toBe(false); // April has 30 days
      expect(isValidIsoDateString('2026-13-01')).toBe(false);
      expect(isValidIsoDateString('garbage')).toBe(false);
    });

    it('requires explicit RFC3339 offset/Z and rejects garbageZ or out-of-range offsets', () => {
      expect(isValidRfc3339String('2026-10-05T10:00:00Z')).toBe(true);
      expect(isValidRfc3339String('2026-10-05T10:00:00+09:00')).toBe(true);
      expect(isValidRfc3339String('2026-10-05T10:00:00-07:00')).toBe(true);
      expect(isValidRfc3339String('garbageZ')).toBe(false);
      expect(isValidRfc3339String('2026-10-05T10:00:00')).toBe(false); // missing offset
      expect(isValidRfc3339String('2026-10-05T25:00:00Z')).toBe(false); // hour 25
      expect(isValidRfc3339String('2026-10-05T10:00:00+25:00')).toBe(false); // offset hour 25
      expect(isValidRfc3339String('2026-10-05T10:00:00+09:65')).toBe(false); // offset minute 65
      expect(isValidRfc3339String('2026-02-30T10:00:00Z')).toBe(false); // invalid date component
    });

    it('validates IANA time zone identifier with Intl.DateTimeFormat', () => {
      expect(isValidIanaTimeZone('Asia/Tokyo')).toBe(true);
      expect(isValidIanaTimeZone('UTC')).toBe(true);
      expect(isValidIanaTimeZone('America/New_York')).toBe(true);
      expect(isValidIanaTimeZone('Mars/Phobos')).toBe(false);
      expect(isValidIanaTimeZone('')).toBe(false);
    });

    it('strictly requires end > start on event creation (equal times rejected)', async () => {
      let networkCalled = false;
      setupMockFetch(() => {
        networkCalled = true;
        return new Response(JSON.stringify({ id: 'evt_1' }));
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);

      // Equal datetimes
      await expect(
        client.events.insert('cal_1', {
          summary: 'Equal times',
          start: { dateTime: '2026-10-10T10:00:00Z' },
          end: { dateTime: '2026-10-10T10:00:00Z' },
        }),
      ).rejects.toThrow(GoogleCalendarError);

      // Equal dates
      await expect(
        client.events.insert('cal_1', {
          summary: 'Equal dates',
          start: { date: '2026-10-10' },
          end: { date: '2026-10-10' },
        }),
      ).rejects.toThrow(GoogleCalendarError);

      // Mixed all-day / timed
      await expect(
        client.events.insert('cal_1', {
          summary: 'Mixed formats',
          start: { date: '2026-10-10' },
          end: { dateTime: '2026-10-11T10:00:00Z' },
        }),
      ).rejects.toThrow(GoogleCalendarError);

      expect(networkCalled).toBe(false);
    });

    it('supports Google writerWithoutPrivateAccess ACL role in response', async () => {
      const aclResponse: GoogleAclRule = {
        id: 'user:restricted@example.test',
        role: 'writerWithoutPrivateAccess',
        scope: { type: 'user', value: 'restricted@example.test' },
      };

      setupMockFetch(() => {
        return new Response(JSON.stringify(aclResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const result = await client.acl.insert('cal_1', {
        role: 'writer',
        scope: { type: 'user', value: 'restricted@example.test' },
      });

      expect(result.role).toBe('writerWithoutPrivateAccess');
    });

    it('rejects domain ACL scope with empty string and user ACL scope with non-email', async () => {
      let networkCalled = false;
      setupMockFetch(() => {
        networkCalled = true;
        return new Response(JSON.stringify({ ok: true }));
      });
      const client = createGoogleCalendarClient(TEST_ENV, testUserId);

      await expect(
        client.acl.insert('cal_1', {
          role: 'reader',
          scope: { type: 'domain', value: '' },
        }),
      ).rejects.toThrow(GoogleCalendarError);

      await expect(
        client.acl.insert('cal_1', {
          role: 'reader',
          scope: { type: 'user', value: 'not-an-email' },
        }),
      ).rejects.toThrow(GoogleCalendarError);

      expect(networkCalled).toBe(false);
      expect(tokenCounter).toBe(0);
    });

    it('roundtrips all-day events with date fields preserved and end > start verified', async () => {
      const allDayEvent = {
        id: 'evt_allday_1',
        status: 'confirmed' as const,
        summary: 'School Holiday',
        start: { date: '2026-10-10' },
        end: { date: '2026-10-12' },
      };

      setupMockFetch((_req, record) => {
        expect(record.bodyJson).toEqual({
          id: expect.any(String),
          summary: 'School Holiday',
          start: { date: '2026-10-10' },
          end: { date: '2026-10-12' },
        });
        return new Response(JSON.stringify(allDayEvent), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const res = await client.events.insert('cal_1', {
        summary: 'School Holiday',
        start: { date: '2026-10-10' },
        end: { date: '2026-10-12' },
      });

      expect(res.start?.date).toBe('2026-10-10');
      expect(res.end?.date).toBe('2026-10-12');
      expect(res.start?.dateTime).toBeUndefined();
    });

    it('parses cancelled tombstone event with id and status only', async () => {
      setupMockFetch(() => {
        return new Response(JSON.stringify({ id: 'evt_tombstone_123', status: 'cancelled' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const res = await client.events.get('cal_1', 'evt_tombstone_123');
      expect(res.id).toBe('evt_tombstone_123');
      expect(res.status).toBe('cancelled');
      expect(res.start).toBeUndefined();
      expect(res.end).toBeUndefined();
    });

    it('parses recurrence cancelled exception with originalStartTime', async () => {
      setupMockFetch(() => {
        return new Response(
          JSON.stringify({
            id: 'evt_rec_parent_20261010T000000Z',
            status: 'cancelled',
            recurringEventId: 'evt_rec_parent',
            originalStartTime: { dateTime: '2026-10-10T10:00:00Z' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const res = await client.events.get('cal_1', 'evt_rec_parent_20261010T000000Z');
      expect(res.id).toBe('evt_rec_parent_20261010T000000Z');
      expect(res.status).toBe('cancelled');
      expect(res.recurringEventId).toBe('evt_rec_parent');
      expect(res.originalStartTime?.dateTime).toBe('2026-10-10T10:00:00Z');
    });

    it('strips unknown fields nested inside start, end, and extendedProperties from response', async () => {
      setupMockFetch(() => {
        return new Response(
          JSON.stringify({
            id: 'evt_strip_nested',
            status: 'confirmed',
            summary: 'Nested Strip Test',
            start: { dateTime: '2026-10-10T10:00:00Z', leakedStartMeta: 'leak' },
            end: { dateTime: '2026-10-10T11:00:00Z', leakedEndMeta: 'leak' },
            extendedProperties: {
              private: { internalId: 'p1' },
              shared: { sharedNote: 's1' },
              leakedPropertiesBucket: { secret: 'leak' },
            },
            unknownTopLevelMetadata: 'leak',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const res = await client.events.get('cal_1', 'evt_strip_nested');

      expect(res.id).toBe('evt_strip_nested');
      expect(res.start).toEqual({ dateTime: '2026-10-10T10:00:00Z' });
      expect(res.end).toEqual({ dateTime: '2026-10-10T11:00:00Z' });
      expect(res.extendedProperties).toEqual({
        private: { internalId: 'p1' },
        shared: { sharedNote: 's1' },
      });
      expect(res).not.toHaveProperty('unknownTopLevelMetadata');
      expect(res.start).not.toHaveProperty('leakedStartMeta');
      expect(res.end).not.toHaveProperty('leakedEndMeta');
      expect(res.extendedProperties).not.toHaveProperty('leakedPropertiesBucket');
    });

    it('rejects normal active event missing start or end', async () => {
      setupMockFetch(() => {
        return new Response(
          JSON.stringify({
            id: 'evt_missing_bounds',
            status: 'confirmed',
            summary: 'Missing Bounds',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      await expect(client.events.get('cal_1', 'evt_missing_bounds')).rejects.toThrow(
        GoogleCalendarError,
      );
    });
  });

  describe('3. Pre-Validation of Outgoing Options and Strict Inputs', () => {
    it('validates outgoing options before token fetch: sendNotifications, timeZone, sendUpdates', async () => {
      let networkCalled = false;
      setupMockFetch(() => {
        networkCalled = true;
        return new Response(JSON.stringify({ ok: true }));
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);

      // 1. acl.insert with invalid sendNotifications option
      await expect(
        client.acl.insert(
          'cal_1',
          { role: 'reader', scope: { type: 'user', value: 'user@example.test' } },
          // @ts-expect-error - testing invalid primitive option at runtime
          { sendNotifications: 'not-a-bool' },
        ),
      ).rejects.toThrow(GoogleCalendarError);

      // 2. events.get with invalid IANA timeZone
      await expect(
        client.events.get('cal_1', 'evt_1', { timeZone: 'Mars/Phobos' }),
      ).rejects.toThrow(GoogleCalendarError);

      // 3. events.insert with invalid sendUpdates
      await expect(
        client.events.insert(
          'cal_1',
          {
            summary: 'Test',
            start: { dateTime: '2026-10-10T10:00:00Z' },
            end: { dateTime: '2026-10-10T11:00:00Z' },
          },
          // @ts-expect-error - testing invalid enum option at runtime
          { sendUpdates: 'invalid-choice' },
        ),
      ).rejects.toThrow(GoogleCalendarError);

      // 4. events.delete with unknown extra option key (strict rejected)
      const unknownDeleteOpts = {
        sendUpdates: 'all' as const,
        unknownKey: 'forbidden',
      };
      await expect(client.events.delete('cal_1', 'evt_1', unknownDeleteOpts)).rejects.toThrow(
        GoogleCalendarError,
      );

      // 5. freeBusy query item with unknown extra key
      const unknownItemInput = {
        timeMin: '2026-10-10T00:00:00Z',
        timeMax: '2026-10-11T00:00:00Z',
        items: [{ id: 'user@example.test', leakedProperty: 'leaked' }],
      };
      await expect(client.freeBusy.query(unknownItemInput)).rejects.toThrow(GoogleCalendarError);

      // 6. insert event with unknown extendedProperties key
      const unknownExtProp = {
        summary: 'Test',
        start: { dateTime: '2026-10-10T10:00:00Z' },
        end: { dateTime: '2026-10-10T11:00:00Z' },
        extendedProperties: {
          private: { k: 'v' },
          forbiddenScope: { k: 'v' },
        },
      };
      await expect(client.events.insert('cal_1', unknownExtProp)).rejects.toThrow(
        GoogleCalendarError,
      );

      expect(networkCalled).toBe(false);
      expect(tokenCounter).toBe(0);
    });

    it('events.list, events.instances, and freeBusy.query validate bounds and ordering before token or network calls', async () => {
      let networkCalled = false;
      setupMockFetch(() => {
        networkCalled = true;
        return new Response(JSON.stringify({ ok: true }));
      });
      const client = createGoogleCalendarClient(TEST_ENV, testUserId);

      // 1. events.list invalid bounds: garbage, equal, reversed
      await expect(client.events.list('cal_1', { timeMin: 'garbageZ' })).rejects.toThrow(
        GoogleCalendarError,
      );
      await expect(
        client.events.list('cal_1', {
          timeMin: '2026-10-10T10:00:00Z',
          timeMax: '2026-10-10T10:00:00Z',
        }),
      ).rejects.toThrow(GoogleCalendarError);
      await expect(
        client.events.list('cal_1', {
          timeMin: '2026-10-10T12:00:00Z',
          timeMax: '2026-10-10T10:00:00Z',
        }),
      ).rejects.toThrow(GoogleCalendarError);

      // 2. events.list orderBy='startTime' without singleEvents=true
      await expect(client.events.list('cal_1', { orderBy: 'startTime' })).rejects.toThrow(
        GoogleCalendarError,
      );
      await expect(
        client.events.list('cal_1', { orderBy: 'startTime', singleEvents: false }),
      ).rejects.toThrow(GoogleCalendarError);

      // 3. events.instances invalid bounds: garbage, equal, reversed
      await expect(
        client.events.instances('cal_1', 'evt_1', { timeMin: 'garbageZ' }),
      ).rejects.toThrow(GoogleCalendarError);
      await expect(
        client.events.instances('cal_1', 'evt_1', {
          timeMin: '2026-10-10T10:00:00Z',
          timeMax: '2026-10-10T10:00:00Z',
        }),
      ).rejects.toThrow(GoogleCalendarError);
      await expect(
        client.events.instances('cal_1', 'evt_1', {
          timeMin: '2026-10-10T12:00:00Z',
          timeMax: '2026-10-10T10:00:00Z',
        }),
      ).rejects.toThrow(GoogleCalendarError);

      // 4. freeBusy.query invalid bounds: garbage, equal, reversed
      await expect(
        client.freeBusy.query({
          timeMin: 'garbageZ',
          timeMax: '2026-10-10T10:00:00Z',
          items: [{ id: 'cal_1' }],
        }),
      ).rejects.toThrow(GoogleCalendarError);
      await expect(
        client.freeBusy.query({
          timeMin: '2026-10-10T10:00:00Z',
          timeMax: '2026-10-10T10:00:00Z',
          items: [{ id: 'cal_1' }],
        }),
      ).rejects.toThrow(GoogleCalendarError);
      await expect(
        client.freeBusy.query({
          timeMin: '2026-10-10T12:00:00Z',
          timeMax: '2026-10-10T10:00:00Z',
          items: [{ id: 'cal_1' }],
        }),
      ).rejects.toThrow(GoogleCalendarError);

      expect(networkCalled).toBe(false);
      expect(tokenCounter).toBe(0);
    });

    it('rejects path segment boundary whitespace or lone surrogate Unicode without throwing unhandled URIError', () => {
      expect(validatePathSegment('calendarId', 'valid_cal_id')).toBe('valid_cal_id');
      expect(validatePathSegment('calendarId', 'user@example.test')).toBe('user%40example.test');

      // Boundary whitespace rejected
      expect(() => validatePathSegment('calendarId', ' leading_space')).toThrow(
        GoogleCalendarError,
      );
      expect(() => validatePathSegment('calendarId', 'trailing_space ')).toThrow(
        GoogleCalendarError,
      );
      expect(() => validatePathSegment('calendarId', 'tab\t')).toThrow(GoogleCalendarError);

      // Empty, dot, dotdot rejected
      expect(() => validatePathSegment('calendarId', '')).toThrow(GoogleCalendarError);
      expect(() => validatePathSegment('calendarId', '.')).toThrow(GoogleCalendarError);
      expect(() => validatePathSegment('calendarId', '..')).toThrow(GoogleCalendarError);
      expect(() => validatePathSegment('calendarId', 12345 as unknown)).toThrow(
        GoogleCalendarError,
      );

      // Lone surrogate character caught as typed INVALID_INPUT
      expect(() => validatePathSegment('calendarId', '\uD800')).toThrow(GoogleCalendarError);
    });
  });

  describe('4. 204 No Content Handling & Ambiguous Creation Safety', () => {
    it('rejects 204 No Content for JSON methods (events.get) with INVALID_RESPONSE', async () => {
      setupMockFetch(() => {
        return new Response(null, { status: 204 });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      let caught: GoogleCalendarError | undefined;

      try {
        await client.events.get('cal_1', 'evt_1');
      } catch (e) {
        if (e instanceof GoogleCalendarError) caught = e;
      }

      expect(caught?.code).toBe('INVALID_RESPONSE');
      expect(caught?.status).toBe(204);
    });

    it('rejects unexpected 200 with JSON for events.delete with INVALID_RESPONSE', async () => {
      setupMockFetch(() => {
        return new Response(JSON.stringify({ unexpected: 'body' }), { status: 200 });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      await expect(client.events.delete('cal_1', 'evt_1')).rejects.toThrow(GoogleCalendarError);
    });

    it('calendars.insert: marks outcome uncertain (UNCERTAIN_MUTATION) when 204 No Content is returned', async () => {
      let attempts = 0;
      setupMockFetch(() => {
        attempts += 1;
        return new Response(null, { status: 204 });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      let caught: GoogleCalendarError | undefined;

      try {
        await client.calendars.insert({ summary: 'Ambiguous 204 Calendar' });
      } catch (e) {
        if (e instanceof GoogleCalendarError) caught = e;
      }

      expect(attempts).toBe(1); // No retry
      expect(caught?.code).toBe('UNCERTAIN_MUTATION');
      expect(caught?.outcome).toBe('uncertain');
      expect(caught?.status).toBe(204);
    });

    it('calendars.insert: marks outcome uncertain when 200 response contains malformed non-JSON body', async () => {
      let attempts = 0;
      setupMockFetch(() => {
        attempts += 1;
        return new Response('<html><body>Malformed Google Response</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      let caught: GoogleCalendarError | undefined;

      try {
        await client.calendars.insert({ summary: 'Malformed Body Calendar' });
      } catch (e) {
        if (e instanceof GoogleCalendarError) caught = e;
      }

      expect(attempts).toBe(1);
      expect(caught?.code).toBe('UNCERTAIN_MUTATION');
      expect(caught?.outcome).toBe('uncertain');
      expect(caught?.status).toBe(200);
    });

    it('calendars.insert: marks outcome uncertain when 200 response fails schema validation', async () => {
      let attempts = 0;
      setupMockFetch(() => {
        attempts += 1;
        return new Response(JSON.stringify({ missingIdAndSummary: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      let caught: GoogleCalendarError | undefined;

      try {
        await client.calendars.insert({ summary: 'Bad Schema Calendar' });
      } catch (e) {
        if (e instanceof GoogleCalendarError) caught = e;
      }

      expect(attempts).toBe(1);
      expect(caught?.code).toBe('UNCERTAIN_MUTATION');
      expect(caught?.outcome).toBe('uncertain');
    });

    it('calendars.insert: halts immediately on 500 server error after exactly 1 attempt with UNCERTAIN_MUTATION', async () => {
      let attempts = 0;
      setupMockFetch(() => {
        attempts += 1;
        return new Response(
          JSON.stringify({ error: { code: 500, message: 'Internal Server Error' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      let caught: GoogleCalendarError | undefined;

      try {
        await client.calendars.insert({ summary: '5xx Server Error Calendar' });
      } catch (e) {
        if (e instanceof GoogleCalendarError) caught = e;
      }

      expect(attempts).toBe(1);
      expect(caught?.code).toBe('UNCERTAIN_MUTATION');
      expect(caught?.outcome).toBe('uncertain');
      expect(caught?.status).toBe(500);
    });

    it('acl.insert: halts immediately on network transport failure after exactly 1 attempt with UNCERTAIN_MUTATION', async () => {
      let attempts = 0;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return new Response(
            JSON.stringify({ access_token: 'mock-token', expires_in: 3600, token_type: 'Bearer' }),
          );
        }
        attempts += 1;
        throw new TypeError('Connection reset / transport failure');
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      let caught: GoogleCalendarError | undefined;

      try {
        await client.acl.insert('cal_1', {
          role: 'writer',
          scope: { type: 'user', value: 'user@example.test' },
        });
      } catch (e) {
        if (e instanceof GoogleCalendarError) caught = e;
      }

      expect(attempts).toBe(1);
      expect(caught?.code).toBe('UNCERTAIN_MUTATION');
      expect(caught?.outcome).toBe('uncertain');
      expect(caught?.status).toBe(500);
    });

    it('events.insert: throws CONFLICT error on 409 without retry and does not treat as success', async () => {
      let attempts = 0;
      setupMockFetch(() => {
        attempts += 1;
        return new Response(
          JSON.stringify({
            error: {
              code: 409,
              message: 'The requested identifier already exists',
              errors: [{ domain: 'calendar', reason: 'conflict' }],
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      let caught: GoogleCalendarError | undefined;

      try {
        await client.events.insert('cal_1', {
          summary: 'Duplicate Event',
          start: { dateTime: '2026-10-10T10:00:00Z' },
          end: { dateTime: '2026-10-10T11:00:00Z' },
        });
      } catch (e) {
        if (e instanceof GoogleCalendarError) caught = e;
      }

      expect(attempts).toBe(1);
      expect(caught?.code).toBe('CONFLICT');
      expect(caught?.status).toBe(409);
    });

    it('sanitizes upstream error responses containing private sentinels', async () => {
      const sensitiveLeak = 'CONFIDENTIAL_FAMILY_MEMBER_PII_12345';
      setupMockFetch(() => {
        return new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: `Internal validation failed for ${sensitiveLeak}`,
              errors: [{ domain: 'calendar', reason: 'invalid', message: sensitiveLeak }],
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      let caught: GoogleCalendarError | undefined;

      try {
        await client.events.get('cal_1', 'evt_1');
      } catch (e) {
        if (e instanceof GoogleCalendarError) caught = e;
      }

      expect(caught?.code).toBe('INVALID_INPUT');
      expect(caught?.status).toBe(400);
      expect(caught?.message).not.toContain(sensitiveLeak);
      expect(caught?.reason).toBe('invalid');
    });
  });

  describe('5. Robust Retry Delays, FakeTimers, and Mixed Status Scenarios', () => {
    it('retries 429 using vi.waitFor and stubbed jitter, reaching max 4 attempts and acquiring token only once', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // 0ms jitter -> delays are exactly 1000ms, 2000ms, 4000ms
      let attempts = 0;

      setupMockFetch(() => {
        attempts += 1;
        return new Response(
          JSON.stringify({
            error: {
              code: 429,
              errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }],
            },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const promise = client.events.get('cal_1', 'evt_retry');
      let rejectedError: GoogleCalendarError | undefined;
      promise.catch((e: unknown) => {
        if (e instanceof GoogleCalendarError) rejectedError = e;
      });

      // Wait for initial attempt and advance through bounded delays
      await vi.waitFor(() => expect(attempts).toBe(1));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(attempts).toBe(2));
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(attempts).toBe(3));
      await vi.advanceTimersByTimeAsync(4000);
      await vi.waitFor(() => expect(attempts).toBe(4));

      await expect(promise).rejects.toThrow(GoogleCalendarError);
      expect(attempts).toBe(4);
      expect(tokenCounter).toBe(1); // Token acquired once and reused across 429 retries
      expect(rejectedError?.code).toBe('RATE_LIMITED');
    });

    it('retries calendars.insert on explicit 429 rate limit (unlike 5xx) and succeeds', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      let attempts = 0;

      setupMockFetch(() => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 429,
                errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }],
              },
            }),
            { status: 429, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            id: 'cal_ratelimit_success',
            summary: 'Rate limit recovered',
            timeZone: 'Asia/Tokyo',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const promise = client.calendars.insert({ summary: 'Rate limit recovered' });

      await vi.waitFor(() => expect(attempts).toBe(1));
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(attempts).toBe(2);
      expect(result.id).toBe('cal_ratelimit_success');
    });

    it('handles mixed 401 refresh, 429 backoff, and 500 error within max 4 attempts total', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      let attempts = 0;

      setupMockFetch(() => {
        attempts += 1;
        if (attempts === 1) {
          // Attempt 1: 401 Unauthorized -> immediate token refresh and retry
          return new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 });
        }
        if (attempts === 2) {
          // Attempt 2: 429 Rate limited -> backoff delay 2000ms
          return new Response(
            JSON.stringify({
              error: {
                code: 429,
                errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }],
              },
            }),
            { status: 429, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (attempts === 3) {
          // Attempt 3: 503 Service Unavailable -> backoff delay 4000ms
          return new Response('Unavailable', { status: 503 });
        }
        // Attempt 4: Success
        return new Response(
          JSON.stringify({
            id: 'evt_mixed_ok',
            status: 'confirmed',
            start: { dateTime: '2026-10-10T10:00:00Z' },
            end: { dateTime: '2026-10-10T11:00:00Z' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const promise = client.events.get('cal_1', 'evt_mixed_ok');

      // Attempt 1 (401) triggers immediate refresh -> attempt 2 (429)
      await vi.waitFor(() => expect(attempts).toBe(2));
      expect(tokenCounter).toBe(2); // 1 initial + 1 refreshed

      // Advance through 429 backoff (attempt count was 2, delay 2000ms)
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(attempts).toBe(3));

      // Advance through 503 backoff (attempt count was 3, delay 4000ms)
      await vi.advanceTimersByTimeAsync(4000);
      const result = await promise;

      expect(attempts).toBe(4);
      expect(result.id).toBe('evt_mixed_ok');
    });

    it('bounds network transport failures on read operations and throws API_ERROR after 4 attempts', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      let attempts = 0;

      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return new Response(
            JSON.stringify({ access_token: 'mock-token', expires_in: 3600, token_type: 'Bearer' }),
          );
        }
        attempts += 1;
        throw new TypeError('Connection reset by peer');
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const promise = client.events.get('cal_1', 'evt_network');
      promise.catch(() => {});

      await vi.waitFor(() => expect(attempts).toBe(1));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(attempts).toBe(2));
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(attempts).toBe(3));
      await vi.advanceTimersByTimeAsync(4000);
      await vi.waitFor(() => expect(attempts).toBe(4));

      await expect(promise).rejects.toThrow(GoogleCalendarError);
      expect(attempts).toBe(4);
    });

    it('events.insert: reuses the exact same auto-generated base32hex ID and full body across 5xx retry', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      let attempts = 0;
      const sentBodies: string[] = [];

      setupMockFetch((_req, record) => {
        attempts += 1;
        if (record.bodyText) sentBodies.push(record.bodyText);

        if (attempts === 1) {
          return new Response(JSON.stringify({ error: { code: 503, message: 'Backend Error' } }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(
          JSON.stringify({
            ...(record.bodyJson as Record<string, unknown>),
            status: 'confirmed',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const promise = client.events.insert('cal_1', {
        summary: 'Retryable Event',
        start: { dateTime: '2026-10-10T10:00:00Z' },
        end: { dateTime: '2026-10-10T11:00:00Z' },
        extendedProperties: { private: { key: 'val' } },
      });

      await vi.waitFor(() => expect(attempts).toBe(1));
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(attempts).toBe(2);
      expect(sentBodies.length).toBe(2);
      expect(sentBodies[0]).toBe(sentBodies[1]);
      expect(result.id).toMatch(/^[a-v0-9]{32}$/);
    });

    it('events.insert: preserves caller-provided ID across retry', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      let attempts = 0;
      const sentIds: string[] = [];

      setupMockFetch((_req, record) => {
        attempts += 1;
        const parsed = record.bodyJson as { id?: string };
        if (parsed.id) sentIds.push(parsed.id);

        if (attempts === 1) {
          return new Response(JSON.stringify({ error: { code: 500 } }), { status: 500 });
        }
        return new Response(JSON.stringify({ ...parsed, status: 'confirmed' }), { status: 200 });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const promise = client.events.insert('cal_1', {
        id: 'abcdef0123456789caller123',
        summary: 'Custom ID Event',
        start: { dateTime: '2026-10-10T10:00:00Z' },
        end: { dateTime: '2026-10-10T11:00:00Z' },
      });

      await vi.waitFor(() => expect(attempts).toBe(1));
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(attempts).toBe(2);
      expect(sentIds).toEqual(['abcdef0123456789caller123', 'abcdef0123456789caller123']);
      expect(result.id).toBe('abcdef0123456789caller123');
    });

    it('retries 403 with userRateLimitExceeded reason and succeeds', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      let attempts = 0;
      setupMockFetch(() => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded' }],
              },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            id: 'evt_user_ratelimit_ok',
            status: 'confirmed',
            start: { dateTime: '2026-10-10T10:00:00Z' },
            end: { dateTime: '2026-10-10T11:00:00Z' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const promise = client.events.get('cal_1', 'evt_user_ratelimit_ok');

      await vi.waitFor(() => expect(attempts).toBe(1));
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(attempts).toBe(2);
      expect(result.id).toBe('evt_user_ratelimit_ok');
    });

    it.each([
      { status: 403, reason: 'forbidden', expectedCode: 'API_ERROR' },
      { status: 404, reason: 'notFound', expectedCode: 'NOT_FOUND' },
      { status: 410, reason: 'deleted', expectedCode: 'API_ERROR' },
      { status: 412, reason: 'conditionNotMet', expectedCode: 'API_ERROR' },
    ])(
      'does NOT retry non-retryable status $status ($reason)',
      async ({ status, reason, expectedCode }) => {
        let attempts = 0;
        setupMockFetch(() => {
          attempts += 1;
          return new Response(
            JSON.stringify({
              error: { code: status, errors: [{ domain: 'calendar', reason }] },
            }),
            { status, headers: { 'Content-Type': 'application/json' } },
          );
        });

        const client = createGoogleCalendarClient(TEST_ENV, testUserId);
        let caught: GoogleCalendarError | undefined;
        try {
          await client.events.get('cal_1', 'evt_test');
        } catch (e) {
          if (e instanceof GoogleCalendarError) caught = e;
        }

        expect(attempts).toBe(1);
        expect(caught?.status).toBe(status);
        expect(caught?.code).toBe(expectedCode);
      },
    );

    it('repeated 401 stops after exactly 2 API attempts and 2 token acquisitions with AUTH_ERROR', async () => {
      let attempts = 0;
      setupMockFetch(() => {
        attempts += 1;
        return new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      let caught: GoogleCalendarError | undefined;
      try {
        await client.events.get('cal_1', 'evt_repeat_401');
      } catch (e) {
        if (e instanceof GoogleCalendarError) caught = e;
      }

      expect(attempts).toBe(2);
      expect(tokenCounter).toBe(2);
      expect(caught?.code).toBe('AUTH_ERROR');
      expect(caught?.status).toBe(401);
    });

    it('mixed 401 / 429 / 5xx exhausts maximum 4 attempts and halts without making a 5th request', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      let attempts = 0;

      setupMockFetch(() => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 });
        }
        if (attempts === 2) {
          return new Response(
            JSON.stringify({
              error: {
                code: 429,
                errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }],
              },
            }),
            { status: 429, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (attempts === 3) {
          return new Response('Unavailable', { status: 503 });
        }
        return new Response('Still Unavailable', { status: 503 });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const promise = client.events.get('cal_1', 'evt_exhaust');
      let caught: GoogleCalendarError | undefined;
      promise.catch((e: unknown) => {
        if (e instanceof GoogleCalendarError) caught = e;
      });

      // Attempt 1 (401) triggers immediate token refresh -> attempt 2 (429)
      await vi.waitFor(() => expect(attempts).toBe(2));
      // Backoff delay for attempt 2 (2000ms) -> attempt 3 (503)
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(attempts).toBe(3));
      // Backoff delay for attempt 3 (4000ms) -> attempt 4 (503)
      await vi.advanceTimersByTimeAsync(4000);
      await vi.waitFor(() => expect(attempts).toBe(4));

      await expect(promise).rejects.toThrow(GoogleCalendarError);
      expect(attempts).toBe(4);
      expect(caught?.code).toBe('API_ERROR');
      expect(caught?.status).toBe(503);
    });
  });

  describe('6. Workerd Compatibility & Redirect Rejection', () => {
    it('constructs Request with redirect: manual and rejects 3xx redirects without leaking credentials', async () => {
      let inspectedRedirect: string | undefined;

      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return new Response(
            JSON.stringify({ access_token: 'mock-token', expires_in: 3600, token_type: 'Bearer' }),
          );
        }

        // Verify that production code constructed Request with redirect: 'manual'
        inspectedRedirect = req.redirect;
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://evil-redirect.example.test/steal' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      let caught: GoogleCalendarError | undefined;

      try {
        await client.events.get('cal_1', 'evt_1');
      } catch (e) {
        if (e instanceof GoogleCalendarError) caught = e;
      }

      expect(inspectedRedirect).toBe('manual');
      expect(caught?.code).toBe('REDIRECT_REJECTED');
      expect(caught?.status).toBe(302);
    });
  });

  describe('7. FreeBusy Privacy, Error Retention & Empty Busy', () => {
    it('strips private titles, locations, descriptions, and attendees from freebusy busy intervals', async () => {
      const responseWithSentinels = {
        timeMin: '2026-10-10T00:00:00Z',
        timeMax: '2026-10-10T23:59:59Z',
        calendars: {
          'partner@example.test': {
            busy: [
              {
                start: '2026-10-10T13:00:00Z',
                end: '2026-10-10T15:00:00Z',
                title: 'TOP SECRET DOCTOR APPOINTMENT',
                summary: 'LEAKED_SUMMARY_SENTINEL',
                location: 'Hospital Room 4B',
                description: 'Sensitive private diagnosis',
                attendees: ['doctor@example.test'],
              },
            ],
          },
        },
      };

      setupMockFetch(() => {
        return new Response(JSON.stringify(responseWithSentinels), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const result = await client.freeBusy.query({
        timeMin: '2026-10-10T00:00:00Z',
        timeMax: '2026-10-10T23:59:59Z',
        items: [{ id: 'partner@example.test' }],
      });

      const busyItems = result.calendars['partner@example.test']?.busy ?? [];
      expect(busyItems.length).toBe(1);
      const firstBusy = busyItems[0] as Record<string, unknown>;

      expect(firstBusy.start).toBe('2026-10-10T13:00:00Z');
      expect(firstBusy.end).toBe('2026-10-10T15:00:00Z');
      expect(firstBusy.title).toBeUndefined();
      expect(firstBusy.summary).toBeUndefined();
      expect(firstBusy.location).toBeUndefined();
      expect(firstBusy.description).toBeUndefined();
      expect(firstBusy.attendees).toBeUndefined();
    });

    it('accepts empty busy: [] as valid success (0 busy intervals without errors)', async () => {
      const emptyFreeBusy = {
        timeMin: '2026-10-10T00:00:00Z',
        timeMax: '2026-10-10T23:59:59Z',
        calendars: {
          'free_user@example.test': {
            busy: [], // Valid success: user has no busy blocks
          },
        },
      };

      setupMockFetch(() => {
        return new Response(JSON.stringify(emptyFreeBusy), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const result = await client.freeBusy.query({
        timeMin: '2026-10-10T00:00:00Z',
        timeMax: '2026-10-10T23:59:59Z',
        items: [{ id: 'free_user@example.test' }],
      });

      expect(result.calendars['free_user@example.test']?.busy).toEqual([]);
    });

    it('preserves calendar errors and does NOT mask errors as free time', async () => {
      const errorFreeBusy = {
        timeMin: '2026-10-10T00:00:00Z',
        timeMax: '2026-10-10T23:59:59Z',
        calendars: {
          'unauthorized@example.test': {
            errors: [{ domain: 'calendar', reason: 'notFound' }],
          },
        },
      };

      setupMockFetch(() => {
        return new Response(JSON.stringify(errorFreeBusy), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const result = await client.freeBusy.query({
        timeMin: '2026-10-10T00:00:00Z',
        timeMax: '2026-10-10T23:59:59Z',
        items: [{ id: 'unauthorized@example.test' }],
      });

      const calResult = result.calendars['unauthorized@example.test'];
      expect(calResult?.errors).toEqual([{ domain: 'calendar', reason: 'notFound' }]);
      expect(calResult?.busy).toBeUndefined();
    });

    it('rejects calendar response with neither busy nor errors to prevent false free-time interpretation', async () => {
      const malformedFreeBusy = {
        timeMin: '2026-10-10T00:00:00Z',
        timeMax: '2026-10-10T23:59:59Z',
        calendars: {
          'invalid@example.test': {}, // Missing both busy and errors
        },
      };

      setupMockFetch(() => {
        return new Response(JSON.stringify(malformedFreeBusy), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      await expect(
        client.freeBusy.query({
          timeMin: '2026-10-10T00:00:00Z',
          timeMax: '2026-10-10T23:59:59Z',
          items: [{ id: 'invalid@example.test' }],
        }),
      ).rejects.toThrow(GoogleCalendarError);
    });

    it('rejects malformed freebusy interval in response where start >= end with INVALID_RESPONSE', async () => {
      const malformedInterval = {
        timeMin: '2026-10-10T00:00:00Z',
        timeMax: '2026-10-10T23:59:59Z',
        calendars: {
          'user@example.test': {
            busy: [
              {
                start: '2026-10-10T15:00:00Z',
                end: '2026-10-10T13:00:00Z', // Reversed interval
              },
            ],
          },
        },
      };

      setupMockFetch(() => {
        return new Response(JSON.stringify(malformedInterval), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      let caught: GoogleCalendarError | undefined;
      try {
        await client.freeBusy.query({
          timeMin: '2026-10-10T00:00:00Z',
          timeMax: '2026-10-10T23:59:59Z',
          items: [{ id: 'user@example.test' }],
        });
      } catch (e) {
        if (e instanceof GoogleCalendarError) caught = e;
      }

      expect(caught?.code).toBe('INVALID_RESPONSE');
    });

    it('retains missing requested calendar as missing without fabricating empty busy array', async () => {
      const partialCalendarResponse = {
        timeMin: '2026-10-10T00:00:00Z',
        timeMax: '2026-10-10T23:59:59Z',
        calendars: {
          'present@example.test': {
            busy: [],
          },
          // 'missing@example.test' is omitted from upstream Google response
        },
      };

      setupMockFetch(() => {
        return new Response(JSON.stringify(partialCalendarResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = createGoogleCalendarClient(TEST_ENV, testUserId);
      const res = await client.freeBusy.query({
        timeMin: '2026-10-10T00:00:00Z',
        timeMax: '2026-10-10T23:59:59Z',
        items: [{ id: 'present@example.test' }, { id: 'missing@example.test' }],
      });

      expect(res.calendars['present@example.test']?.busy).toEqual([]);
      expect(res.calendars['missing@example.test']).toBeUndefined(); // Crucial: NOT fabricated as busy: []
    });
  });

  describe('8. Real D1 Encrypted Refresh Token Integration', () => {
    it('authenticates through actual D1 decrypted refresh token and mock token endpoint', async () => {
      const liveUserId = 'usr_d1_live_integration';
      const liveRefreshToken = 'live-decrypted-refresh-token-val-999';

      await seedTestUser(liveUserId, liveRefreshToken);

      let tokenEndpointReceivedRefreshToken = '';
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          const bodyBuffer = await req.clone().arrayBuffer();
          const body = new TextDecoder().decode(bodyBuffer);
          const params = new URLSearchParams(body);
          tokenEndpointReceivedRefreshToken = params.get('refresh_token') ?? '';

          return new Response(
            JSON.stringify({
              access_token: 'live-generated-access-token-777',
              expires_in: 3600,
              token_type: 'Bearer',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (req.url.startsWith(GOOGLE_CALENDAR_API_BASE)) {
          expect(req.headers.get('authorization')).toBe('Bearer live-generated-access-token-777');
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'primary',
                  summary: 'Real Integration Cal',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        throw new Error(`Unexpected url: ${req.url}`);
      });

      const client = createGoogleCalendarClient(TEST_ENV, liveUserId);
      const res = await client.calendarList.list();

      expect(tokenEndpointReceivedRefreshToken).toBe(liveRefreshToken);
      expect(res.items[0]?.summary).toBe('Real Integration Cal');
    });
  });
});
