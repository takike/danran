import { env } from 'cloudflare:test';
import { apiErrorResponseSchema } from '@shared/schemas/errors';
import {
  type SpikeOperationRequest,
  spikeMetadataResponseSchema,
  spikeOperationResponseSchema,
} from '@shared/schemas/spike';
import { PHASE1_SCOPES, SESSION_COOKIE_NAME } from '@worker/auth/config';
import { encryptAesGcm, sha256Hex } from '@worker/auth/crypto';
import { createDb } from '@worker/db';
import { googleTokens, sessions, users } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { createApp } from '@worker/index';
import { issueSpikeReceipt } from '@worker/spike/receipt';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_APP_ORIGIN = 'http://localhost:5173';
const TEST_AES_KEY_BASE64 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';
const TEST_SESSION_SECRET = 'test-session-secret-at-least-32-chars-long-secure-entropy';

const BASE_TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: TEST_APP_ORIGIN,
  GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret-12345',
  SESSION_SECRET: TEST_SESSION_SECRET,
  TOKEN_ENC_KEY: TEST_AES_KEY_BASE64,
  ENABLE_SPIKES: 'true',
};

function required<T>(value: T | null | undefined, message = 'Required value missing'): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

interface RecordedFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyJson?: unknown;
}

describe('Task 1-3: Calendar Sharing Spike', () => {
  const db = createDb(env.DB);
  const app = createApp();

  const userA = {
    id: 'usr_spike_a',
    displayName: 'ユーザーA',
    email: 'user-a@example.test',
    refreshToken: 'mock-refresh-token-a',
    accessToken: 'mock-access-token-a',
  };

  const userB = {
    id: 'usr_spike_b',
    displayName: 'ユーザーB',
    email: 'user-b@example.test',
    refreshToken: 'mock-refresh-token-b',
    accessToken: 'mock-access-token-b',
  };

  let recordedRequests: RecordedFetchRequest[] = [];
  let customFetchHandler:
    | ((req: Request, record: RecordedFetchRequest) => Promise<Response | null>)
    | null = null;

  beforeEach(async () => {
    recordedRequests = [];
    customFetchHandler = null;

    // Seed User A with all PHASE1_SCOPES
    await db
      .insert(users)
      .values({
        id: userA.id,
        googleSub: `sub_${userA.id}`,
        email: userA.email,
        displayName: userA.displayName,
      })
      .onConflictDoNothing();

    const encryptedTokenA = await encryptAesGcm(
      userA.refreshToken,
      TEST_AES_KEY_BASE64,
      `google-refresh:${userA.id}`,
    );
    await db
      .insert(googleTokens)
      .values({
        userId: userA.id,
        refreshTokenEnc: encryptedTokenA,
        scopes: PHASE1_SCOPES.join(' '),
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .onConflictDoNothing();

    // Seed User B with all PHASE1_SCOPES
    await db
      .insert(users)
      .values({
        id: userB.id,
        googleSub: `sub_${userB.id}`,
        email: userB.email,
        displayName: userB.displayName,
      })
      .onConflictDoNothing();

    const encryptedTokenB = await encryptAesGcm(
      userB.refreshToken,
      TEST_AES_KEY_BASE64,
      `google-refresh:${userB.id}`,
    );
    await db
      .insert(googleTokens)
      .values({
        userId: userB.id,
        refreshTokenEnc: encryptedTokenB,
        scopes: PHASE1_SCOPES.join(' '),
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .onConflictDoNothing();

    // Global fetch mock handling token refresh and Google Calendar REST API
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = req.url;
      const method = req.method;
      const headers: Record<string, string> = {};
      req.headers.forEach((val, key) => {
        headers[key.toLowerCase()] = val;
      });

      let bodyText: string | undefined;
      let bodyJson: unknown | undefined;

      if (method !== 'GET' && method !== 'HEAD') {
        try {
          const buffer = await req.clone().arrayBuffer();
          if (buffer.byteLength > 0) {
            bodyText = new TextDecoder().decode(buffer);
            try {
              bodyJson = JSON.parse(bodyText);
            } catch {
              // Not JSON; might be URLSearchParams or form data
            }
          }
        } catch {
          // ignore
        }
      }

      const record: RecordedFetchRequest = { url, method, headers, bodyText, bodyJson };
      recordedRequests.push(record);

      if (customFetchHandler) {
        const customRes = await customFetchHandler(req, record);
        if (customRes) return customRes;
      }

      // Handle OAuth token refresh
      if (url === 'https://oauth2.googleapis.com/token') {
        const isUserB = bodyText?.includes(userB.refreshToken);
        const accessToken = isUserB ? userB.accessToken : userA.accessToken;
        return new Response(
          JSON.stringify({
            access_token: accessToken,
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Default mock for Google Calendar API
      if (
        url.includes('/calendars') &&
        method === 'POST' &&
        !url.includes('/events') &&
        !url.includes('/acl')
      ) {
        return new Response(
          JSON.stringify({
            id: 'mock_calendar_id_12345@group.calendar.google.com',
            summary: 'Danran spike',
            timeZone: 'Asia/Tokyo',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.includes('/acl') && method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'user:user-b@example.test',
            role: 'writer',
            scope: { type: 'user', value: userB.email },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.includes('/users/me/calendarList') && method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'mock_calendar_id_12345@group.calendar.google.com',
            summary: 'Danran spike',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.includes('/events') && method === 'GET') {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'evt_1',
                summary: 'Sensitive Event Title That Must Never Leak',
                description: 'Private confidential description',
                start: { dateTime: '2030-01-01T12:00:00+09:00' },
                end: { dateTime: '2030-01-01T12:15:00+09:00' },
              },
            ],
            timeZone: 'Asia/Tokyo',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.includes('/events') && method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'mock_event_id_67890',
            summary: 'Danran spike test',
            start: { dateTime: '2030-01-01T12:00:00+09:00' },
            end: { dateTime: '2030-01-01T12:15:00+09:00' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'DELETE') {
        return new Response(null, { status: 204 });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function createSessionCookie(
    userId: string,
    secret: string = TEST_SESSION_SECRET,
  ): Promise<string> {
    const rawToken = crypto.randomUUID().replaceAll('-', '');
    const sessionId = await sha256Hex(rawToken);
    const now = Math.floor(Date.now() / 1000);

    await db.insert(sessions).values({
      id: sessionId,
      userId,
      expiresAt: now + 86400,
      createdAt: now,
    });

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawToken));
    const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
    const signedValue = `${rawToken}.${sigBase64}`;

    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(signedValue)}`;
  }

  describe('1. Runtime Flag Disabled Enforcement (Fail Closed)', () => {
    const disabledFlagCases = [
      { name: 'undefined (default)', envVal: undefined },
      { name: 'false', envVal: 'false' },
      { name: 'case sensitivity TRUE', envVal: 'TRUE' },
      { name: 'numeric 1', envVal: '1' },
    ];

    for (const testCase of disabledFlagCases) {
      it(`fails closed with 404 when ENABLE_SPIKES is ${testCase.name} before auth or DB`, async () => {
        const unconfiguredEnv: WorkerEnv = {
          ...BASE_TEST_ENV,
          ENABLE_SPIKES: testCase.envVal,
          SESSION_SECRET: undefined,
          GOOGLE_CLIENT_ID: undefined,
          GOOGLE_CLIENT_SECRET: undefined,
        };

        // Document navigation
        const docRes = await app.request(
          'http://localhost:5173/spike/calendar-sharing',
          {},
          unconfiguredEnv,
        );
        expect(docRes.status).toBe(404);
        expect(docRes.headers.get('Cache-Control')).toBe('no-store');
        expect(docRes.headers.get('Pragma')).toBe('no-cache');
        expect(docRes.headers.get('Referrer-Policy')).toBe('no-referrer');

        // Metadata API
        const metaRes = await app.request(
          'http://localhost:5173/api/spike/calendar-sharing',
          {},
          unconfiguredEnv,
        );
        expect(metaRes.status).toBe(404);
        expect(metaRes.headers.get('Cache-Control')).toBe('no-store');
        const metaBody = await metaRes.json();
        expect(apiErrorResponseSchema.parse(metaBody)).toEqual({ error: 'Not Found' });

        // Operation API
        const postRes = await app.request(
          'http://localhost:5173/api/spike/calendar-sharing',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              Origin: TEST_APP_ORIGIN,
            },
            body: JSON.stringify({ action: 'insertCalendar' }),
          },
          unconfiguredEnv,
        );
        expect(postRes.status).toBe(404);
        expect(postRes.headers.get('Cache-Control')).toBe('no-store');

        // Zero network calls
        expect(recordedRequests.length).toBe(0);
      });
    }
  });

  describe('2. Document Navigation under /spike (Flag Enabled)', () => {
    it('redirects unauthenticated document request to / with 302 and no-store', async () => {
      const res = await app.request(
        'http://localhost:5173/spike/calendar-sharing',
        {},
        BASE_TEST_ENV,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    });

    it('returns 200 with SPA shell from mocked ASSETS canonical / for authenticated document navigation', async () => {
      const cookie = await createSessionCookie(userA.id);

      const mockAssetsFetcher: Fetcher = {
        fetch: async (req: Request | string) => {
          const urlStr = typeof req === 'string' ? req : req.url;
          const parsed = new URL(urlStr);
          expect(parsed.pathname).toBe('/');
          return new Response('<!DOCTYPE html><html><body>Danran SPA</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        },
      } as unknown as Fetcher;

      const envWithAssets: WorkerEnv = {
        ...BASE_TEST_ENV,
        ASSETS: mockAssetsFetcher,
      };

      const res = await app.request(
        'http://localhost:5173/spike/calendar-sharing',
        { headers: { Cookie: cookie } },
        envWithAssets,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      const text = await res.text();
      expect(text).toContain('Danran SPA');
    });

    it('regression: requests canonical / from ASSETS binding to avoid Cloudflare 307 redirect when serving SPA shell', async () => {
      const cookie = await createSessionCookie(userA.id);

      const mockAssetsFetcher: Fetcher = {
        fetch: async (req: Request | string) => {
          const urlStr = typeof req === 'string' ? req : req.url;
          const parsed = new URL(urlStr);
          if (parsed.pathname === '/index.html') {
            return new Response(null, {
              status: 307,
              headers: { Location: '/' },
            });
          }
          if (parsed.pathname === '/') {
            return new Response('<!DOCTYPE html><html><body>Danran SPA Shell</body></html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            });
          }
          return new Response('Not Found', { status: 404 });
        },
      } as unknown as Fetcher;

      const envWithAssets: WorkerEnv = {
        ...BASE_TEST_ENV,
        ASSETS: mockAssetsFetcher,
      };

      const res = await app.request(
        'http://localhost:5173/spike/calendar-sharing',
        { headers: { Cookie: cookie } },
        envWithAssets,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Location')).toBeNull();
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const text = await res.text();
      expect(text).toContain('Danran SPA Shell');
    });

    it('enforces request URL origin === APP_ORIGIN with 403 on document route', async () => {
      const cookie = await createSessionCookie(userA.id);
      const res = await app.request(
        'https://attacker-origin.example.com/spike/calendar-sharing',
        { headers: { Cookie: cookie } },
        BASE_TEST_ENV,
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('Forbidden');
    });

    it('returns 503 if auth service is unconfigured on document route', async () => {
      const cookie = await createSessionCookie(userA.id);
      const brokenEnv: WorkerEnv = {
        ...BASE_TEST_ENV,
        SESSION_SECRET: undefined,
      };
      const res = await app.request(
        'http://localhost:5173/spike/calendar-sharing',
        { headers: { Cookie: cookie } },
        brokenEnv,
      );
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('Auth service unconfigured');
    });

    it('returns 404 for unknown spike subpaths', async () => {
      const cookie = await createSessionCookie(userA.id);
      const res = await app.request(
        'http://localhost:5173/spike/nonexistent-subpath',
        { headers: { Cookie: cookie } },
        BASE_TEST_ENV,
      );

      expect(res.status).toBe(404);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
  });

  describe('3. API Authentication & CSRF Defenses', () => {
    it('rejects unauthenticated GET and POST with 401', async () => {
      const getRes = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {},
        BASE_TEST_ENV,
      );
      expect(getRes.status).toBe(401);
      expect(apiErrorResponseSchema.parse(await getRes.json())).toEqual({ error: 'Unauthorized' });

      const postRes = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({ action: 'insertCalendar' }),
        },
        BASE_TEST_ENV,
      );
      expect(postRes.status).toBe(401);
      expect(apiErrorResponseSchema.parse(await postRes.json())).toEqual({ error: 'Unauthorized' });
    });

    it('enforces request URL origin === APP_ORIGIN with 403', async () => {
      const cookie = await createSessionCookie(userA.id);

      const res = await app.request(
        'https://attacker-origin.example.com/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({ action: 'insertCalendar' }),
        },
        BASE_TEST_ENV,
      );
      expect(res.status).toBe(403);
      expect(apiErrorResponseSchema.parse(await res.json())).toEqual({ error: 'Forbidden' });
    });

    it('rejects POST missing X-Requested-With header with 403', async () => {
      const cookie = await createSessionCookie(userA.id);

      const res = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({ action: 'insertCalendar' }),
        },
        BASE_TEST_ENV,
      );
      expect(res.status).toBe(403);
      expect(apiErrorResponseSchema.parse(await res.json())).toEqual({ error: 'Forbidden' });
    });

    it('rejects POST with mismatched Origin header with 403', async () => {
      const cookie = await createSessionCookie(userA.id);

      const res = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'http://malicious-origin.test',
          },
          body: JSON.stringify({ action: 'insertCalendar' }),
        },
        BASE_TEST_ENV,
      );
      expect(res.status).toBe(403);
      expect(apiErrorResponseSchema.parse(await res.json())).toEqual({ error: 'Forbidden' });
    });

    it('rejects POST with non-JSON content-type with 400', async () => {
      const cookie = await createSessionCookie(userA.id);

      const res = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'Content-Type': 'text/plain',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: 'action=insertCalendar',
        },
        BASE_TEST_ENV,
      );
      expect(res.status).toBe(400);
    });

    it('rejects POST with body > 16KB with 400', async () => {
      const cookie = await createSessionCookie(userA.id);
      const hugeString = 'A'.repeat(20000);

      const res = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({ action: 'insertCalendar', extra: hugeString }),
        },
        BASE_TEST_ENV,
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 JSON for unknown API subpaths', async () => {
      const cookie = await createSessionCookie(userA.id);
      const res = await app.request(
        'http://localhost:5173/api/spike/unknown-subpath',
        { headers: { Cookie: cookie } },
        BASE_TEST_ENV,
      );
      expect(res.status).toBe(404);
      expect(apiErrorResponseSchema.parse(await res.json())).toEqual({ error: 'Not Found' });
    });
  });

  describe('4. Metadata Endpoint', () => {
    it('returns current user id and displayName without leaking email, googleSub, or tokens', async () => {
      const cookie = await createSessionCookie(userA.id);

      const res = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        { headers: { Cookie: cookie } },
        BASE_TEST_ENV,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const body = await res.json();
      const parsed = spikeMetadataResponseSchema.parse(body);

      expect(parsed.user.id).toBe(userA.id);
      expect(parsed.user.displayName).toBe(userA.displayName);
      expect(body).not.toHaveProperty('user.email');
      expect(body).not.toHaveProperty('user.googleSub');
    });
  });

  describe('5. Operations & Token Isolation (User B own token, not A proxy)', () => {
    it('User A creates calendar -> issues receipt -> A grants ACL writer to B with notification false', async () => {
      const cookieA = await createSessionCookie(userA.id);

      // 1. User A inserts calendar
      const calRes = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieA,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({ action: 'insertCalendar' }),
        },
        BASE_TEST_ENV,
      );

      expect(calRes.status).toBe(200);
      const calBody = spikeOperationResponseSchema.parse(await calRes.json());
      expect(calBody.ok).toBe(true);
      if (!calBody.ok || calBody.action !== 'insertCalendar') return;

      expect(calBody.calendarId).toBe('mock_calendar_id_12345@group.calendar.google.com');
      expect(calBody.receipt).toBeDefined();

      const lastCalReq = required(
        recordedRequests.find((r) => r.url.endsWith('/calendars') && r.method === 'POST'),
      );
      expect(lastCalReq.headers.authorization).toBe(`Bearer ${userA.accessToken}`);
      expect(lastCalReq.bodyJson).toEqual({ summary: 'Danran spike', timeZone: 'Asia/Tokyo' });

      // 2. User A grants ACL writer to User B
      const aclRes = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieA,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'insertAcl',
            calendarId: calBody.calendarId,
            email: userB.email,
            receipt: calBody.receipt,
          }),
        },
        BASE_TEST_ENV,
      );

      expect(aclRes.status).toBe(200);
      const aclBody = spikeOperationResponseSchema.parse(await aclRes.json());
      expect(aclBody.ok).toBe(true);

      const aclReq = required(
        recordedRequests.find((r) => r.url.includes('/acl') && r.method === 'POST'),
      );
      expect(aclReq.url).toContain('sendNotifications=false');
      expect(aclReq.headers.authorization).toBe(`Bearer ${userA.accessToken}`);
      expect(aclReq.bodyJson).toEqual({
        role: 'writer',
        scope: { type: 'user', value: userB.email },
      });
    });

    it('User B operations prove User B token is sent (never User A token as proxy)', async () => {
      const cookieB = await createSessionCookie(userB.id);
      const testCalendarId = 'mock_calendar_id_12345@group.calendar.google.com';

      // 1. User B inserts calendar into calendarList
      const listInsertRes = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieB,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'insertCalendarList',
            calendarId: testCalendarId,
          }),
        },
        BASE_TEST_ENV,
      );

      expect(listInsertRes.status).toBe(200);
      const listInsertBody = spikeOperationResponseSchema.parse(await listInsertRes.json());
      expect(listInsertBody.ok).toBe(true);

      const listReq = required(
        recordedRequests.find(
          (r) => r.url.includes('/users/me/calendarList') && r.method === 'POST',
        ),
      );
      expect(listReq.headers.authorization).toBe(`Bearer ${userB.accessToken}`);
      expect(listReq.headers.authorization).not.toBe(`Bearer ${userA.accessToken}`);
      expect(listReq.bodyJson).toEqual({ id: testCalendarId });

      // 2. User B lists events -> verifies event payload is stripped and never returned
      const listEventsRes = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieB,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'listEvents',
            calendarId: testCalendarId,
          }),
        },
        BASE_TEST_ENV,
      );

      expect(listEventsRes.status).toBe(200);
      const listEventsBody = spikeOperationResponseSchema.parse(await listEventsRes.json());
      expect(listEventsBody.ok).toBe(true);
      if (!listEventsBody.ok || listEventsBody.action !== 'listEvents') return;

      expect(listEventsBody.eventCount).toBe(1);
      expect(listEventsBody.hasMore).toBe(false);

      // Verify privacy invariant: zero event summary/description in response
      const rawText = JSON.stringify(listEventsBody);
      expect(rawText).not.toContain('Sensitive Event Title That Must Never Leak');
      expect(rawText).not.toContain('Private confidential description');
      expect(listEventsBody).not.toHaveProperty('items');

      // 3. User B inserts synthetic test event
      const insertEventRes = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieB,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'insertEvent',
            calendarId: testCalendarId,
          }),
        },
        BASE_TEST_ENV,
      );

      expect(insertEventRes.status).toBe(200);
      const insertEventBody = spikeOperationResponseSchema.parse(await insertEventRes.json());
      expect(insertEventBody.ok).toBe(true);
      if (!insertEventBody.ok || insertEventBody.action !== 'insertEvent') return;

      expect(insertEventBody.eventId).toBe('mock_event_id_67890');
      expect(insertEventBody.receipt).toBeDefined();

      const eventPostReq = required(
        recordedRequests.find((r) => r.url.includes('/events') && r.method === 'POST'),
      );
      expect(eventPostReq.headers.authorization).toBe(`Bearer ${userB.accessToken}`);
      expect(eventPostReq.url).toContain('sendUpdates=none');
      expect(eventPostReq.bodyJson).toMatchObject({
        summary: 'Danran spike test',
        start: { dateTime: '2030-01-01T12:00:00+09:00', timeZone: 'Asia/Tokyo' },
        end: { dateTime: '2030-01-01T12:15:00+09:00', timeZone: 'Asia/Tokyo' },
      });

      // 4. User B deletes own test event using receipt
      const deleteEventRes = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieB,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'deleteEvent',
            calendarId: testCalendarId,
            eventId: insertEventBody.eventId,
            receipt: insertEventBody.receipt,
          }),
        },
        BASE_TEST_ENV,
      );

      expect(deleteEventRes.status).toBe(200);
      const deleteEventBody = spikeOperationResponseSchema.parse(await deleteEventRes.json());
      expect(deleteEventBody.ok).toBe(true);

      const eventDelReq = required(
        recordedRequests.find((r) => r.url.includes('/events/') && r.method === 'DELETE'),
      );
      expect(eventDelReq.headers.authorization).toBe(`Bearer ${userB.accessToken}`);
      expect(eventDelReq.url).toContain('sendUpdates=none');
    });

    it('rejects targeting primary calendar for listEvents, insertEvent, and insertCalendarList', async () => {
      const cookieB = await createSessionCookie(userB.id);

      const actions: SpikeOperationRequest[] = [
        { action: 'listEvents', calendarId: 'primary' },
        { action: 'insertEvent', calendarId: 'Primary' },
        { action: 'insertCalendarList', calendarId: 'PRIMARY' },
      ];

      for (const req of actions) {
        const res = await app.request(
          'http://localhost:5173/api/spike/calendar-sharing',
          {
            method: 'POST',
            headers: {
              Cookie: cookieB,
              'Content-Type': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              Origin: TEST_APP_ORIGIN,
            },
            body: JSON.stringify(req),
          },
          BASE_TEST_ENV,
        );
        expect(res.status).toBe(400);
        expect(apiErrorResponseSchema.parse(await res.json())).toEqual({
          error: 'Invalid operation parameters',
        });
      }
    });
  });

  describe('6. Cryptographic Receipt Boundaries & Tamper Resistance', () => {
    it('rejects tampered receipt signature with 400 and zero Google fetch', async () => {
      const cookieA = await createSessionCookie(userA.id);
      const testCalId = 'test_cal_123';
      const validReceipt = await issueSpikeReceipt({
        sessionSecret: TEST_SESSION_SECRET,
        userId: userA.id,
        kind: 'calendar',
        calendarId: testCalId,
      });

      const tamperedReceipt = `${validReceipt.slice(0, -6)}tamper`;

      const initialCount = recordedRequests.length;
      const res = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieA,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'deleteCalendar',
            calendarId: testCalId,
            receipt: tamperedReceipt,
          }),
        },
        BASE_TEST_ENV,
      );

      expect(res.status).toBe(400);
      expect(apiErrorResponseSchema.parse(await res.json())).toEqual({
        error: 'Invalid or expired receipt',
      });
      expect(recordedRequests.length).toBe(initialCount);
    });

    it('rejects receipt issued to different user (sub mismatch) with 400 and zero Google fetch', async () => {
      const cookieB = await createSessionCookie(userB.id);
      const testCalId = 'cal_owned_by_a';

      // Receipt issued to User A
      const receiptA = await issueSpikeReceipt({
        sessionSecret: TEST_SESSION_SECRET,
        userId: userA.id,
        kind: 'calendar',
        calendarId: testCalId,
      });

      // User B attempts to delete User A's calendar using User A's receipt
      const initialCount = recordedRequests.length;
      const res = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieB,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'deleteCalendar',
            calendarId: testCalId,
            receipt: receiptA,
          }),
        },
        BASE_TEST_ENV,
      );

      expect(res.status).toBe(400);
      expect(recordedRequests.length).toBe(initialCount);
    });

    it('rejects receipt with wrong calendarId with 400 and zero Google fetch', async () => {
      const cookieA = await createSessionCookie(userA.id);
      const receiptCal1 = await issueSpikeReceipt({
        sessionSecret: TEST_SESSION_SECRET,
        userId: userA.id,
        kind: 'calendar',
        calendarId: 'calendar_01',
      });

      // Attempt to delete calendar_02 with receipt for calendar_01
      const initialCount = recordedRequests.length;
      const res = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieA,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'deleteCalendar',
            calendarId: 'calendar_02',
            receipt: receiptCal1,
          }),
        },
        BASE_TEST_ENV,
      );

      expect(res.status).toBe(400);
      expect(recordedRequests.length).toBe(initialCount);
    });

    it('rejects receipt with wrong kind (e.g. event receipt used to delete calendar) with 400', async () => {
      const cookieA = await createSessionCookie(userA.id);
      const eventReceipt = await issueSpikeReceipt({
        sessionSecret: TEST_SESSION_SECRET,
        userId: userA.id,
        kind: 'event',
        calendarId: 'cal_123',
        eventId: 'evt_123',
      });

      const initialCount = recordedRequests.length;
      const res = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieA,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'deleteCalendar',
            calendarId: 'cal_123',
            receipt: eventReceipt,
          }),
        },
        BASE_TEST_ENV,
      );

      expect(res.status).toBe(400);
      expect(recordedRequests.length).toBe(initialCount);
    });

    it('rejects expired receipt with 400', async () => {
      const cookieA = await createSessionCookie(userA.id);
      const key = new TextEncoder().encode(TEST_SESSION_SECRET);
      const expiredReceipt = await new SignJWT({
        kind: 'calendar',
        calendarId: 'cal_expired',
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('danran-spike')
        .setAudience('danran-spike-ops')
        .setSubject(userA.id)
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(key);

      const initialCount = recordedRequests.length;
      const res = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieA,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'deleteCalendar',
            calendarId: 'cal_expired',
            receipt: expiredReceipt,
          }),
        },
        BASE_TEST_ENV,
      );

      expect(res.status).toBe(400);
      expect(recordedRequests.length).toBe(initialCount);
    });
  });

  describe('7. Google API Error Sanitization & Permission Isolation', () => {
    it('returns allowlisted reason "forbidden" and googleStatus 403 without leaking raw error message', async () => {
      const cookieA = await createSessionCookie(userA.id);
      const calReceipt = await issueSpikeReceipt({
        sessionSecret: TEST_SESSION_SECRET,
        userId: userA.id,
        kind: 'calendar',
        calendarId: 'cal_forbidden',
      });

      customFetchHandler = async (req) => {
        if (req.url.includes('/acl')) {
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                message: 'Sensitive raw upstream message containing secret-info@corp.internal',
                errors: [
                  {
                    domain: 'calendar',
                    reason: 'forbidden',
                    message: 'User does not have permission to insert ACL',
                  },
                ],
              },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return null;
      };

      const res = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieA,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'insertAcl',
            calendarId: 'cal_forbidden',
            email: userB.email,
            receipt: calReceipt,
          }),
        },
        BASE_TEST_ENV,
      );

      expect(res.status).toBe(200);
      const body = spikeOperationResponseSchema.parse(await res.json());
      expect(body.ok).toBe(false);
      if (body.ok) return;

      expect(body.googleStatus).toBe(403);
      expect(body.reason).toBe('forbidden');
      expect(body.error).toBe('Google Calendar API request failed');

      // Verify no upstream message or email leakage
      const rawText = JSON.stringify(body);
      expect(rawText).not.toContain('secret-info@corp.internal');
      expect(rawText).not.toContain('User does not have permission');
    });

    it('sanitizes unknown Google error reason to null and strips sensitive fields', async () => {
      const cookieB = await createSessionCookie(userB.id);

      customFetchHandler = async (req) => {
        if (req.url.includes('/users/me/calendarList')) {
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                message: 'Raw upstream private message with token Bearer xyz',
                errors: [
                  {
                    domain: 'calendar',
                    reason: 'unregisteredInternalReasonCode',
                    message: 'private detail',
                  },
                ],
              },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return null;
      };

      const res = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieB,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'insertCalendarList',
            calendarId: 'cal_test_probe',
          }),
        },
        BASE_TEST_ENV,
      );

      expect(res.status).toBe(200);
      const body = spikeOperationResponseSchema.parse(await res.json());
      expect(body.ok).toBe(false);
      if (body.ok) return;

      expect(body.googleStatus).toBe(403);
      expect(body.reason).toBeNull();
      const rawText = JSON.stringify(body);
      expect(rawText).not.toContain('unregisteredInternalReasonCode');
      expect(rawText).not.toContain('Bearer xyz');
    });

    it('calendarList 403 failure does NOT block subsequent independent events list probe', async () => {
      const cookieB = await createSessionCookie(userB.id);

      // 1. calendarList fails 403
      customFetchHandler = async (req) => {
        if (req.url.includes('/users/me/calendarList')) {
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                errors: [{ reason: 'forbidden' }],
              },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return null;
      };

      const failRes = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieB,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'insertCalendarList',
            calendarId: 'cal_independent_test',
          }),
        },
        BASE_TEST_ENV,
      );
      const failBody = spikeOperationResponseSchema.parse(await failRes.json());
      expect(failBody.ok).toBe(false);

      // 2. Subsequent listEvents succeeds independently
      const successRes = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieB,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({
            action: 'listEvents',
            calendarId: 'cal_independent_test',
          }),
        },
        BASE_TEST_ENV,
      );
      const successBody = spikeOperationResponseSchema.parse(await successRes.json());
      expect(successBody.ok).toBe(true);
    });

    it('returns googleStatus null and outcome uncertain on nonidempotent network mutation error', async () => {
      const cookieA = await createSessionCookie(userA.id);

      customFetchHandler = async (req) => {
        if (req.url.endsWith('/calendars') && req.method === 'POST') {
          throw new TypeError('Network connection reset');
        }
        return null;
      };

      const res = await app.request(
        'http://localhost:5173/api/spike/calendar-sharing',
        {
          method: 'POST',
          headers: {
            Cookie: cookieA,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_APP_ORIGIN,
          },
          body: JSON.stringify({ action: 'insertCalendar' }),
        },
        BASE_TEST_ENV,
      );

      expect(res.status).toBe(200);
      const body = spikeOperationResponseSchema.parse(await res.json());
      expect(body.ok).toBe(false);
      if (body.ok) return;

      expect(body.googleStatus).toBeNull();
      expect(body.outcome).toBe('uncertain');
      expect(body.code).toBe('UNCERTAIN_MUTATION');
    });
  });
});
