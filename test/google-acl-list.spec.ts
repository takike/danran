import { env } from 'cloudflare:test';
import type { AclListOptions, GoogleAclListPage } from '@shared/schemas/google-calendar';
import { encryptAesGcm } from '@worker/auth/crypto';
import { createDb } from '@worker/db';
import { googleTokens, users } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import {
  GOOGLE_CALENDAR_API_BASE,
  GoogleCalendarError,
  createGoogleCalendarClient,
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

const db = createDb(env.DB);
const testUserId = 'usr_google_acl_list_test';
const pageOne: GoogleAclListPage = {
  items: [
    {
      id: 'user:owner@example.test',
      role: 'owner',
      scope: { type: 'user', value: 'owner@example.test' },
      etag: '"acl-one"',
    },
  ],
  nextPageToken: 'next/page+token',
};

describe('Google Calendar ACL list client method', () => {
  let apiRequests: Request[] = [];
  let tokenRequests = 0;

  async function seedTestUser() {
    await db.insert(users).values({
      id: testUserId,
      googleSub: `sub_${testUserId}`,
      email: 'owner@example.test',
      displayName: 'Test Owner',
    });

    const encrypted = await encryptAesGcm(
      'mock-refresh-token',
      TEST_ENV.TOKEN_ENC_KEY ?? '',
      `google-refresh:${testUserId}`,
    );
    await db.insert(googleTokens).values({
      userId: testUserId,
      refreshTokenEnc: encrypted,
      scopes:
        'openid email profile https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.acls',
      updatedAt: Math.floor(Date.now() / 1000),
    });
  }

  function mockFetch(apiHandler: (request: Request) => Response | Promise<Response>) {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url === 'https://oauth2.googleapis.com/token') {
        tokenRequests += 1;
        return Response.json({
          access_token: `mock-access-token-${tokenRequests}`,
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      if (request.url.startsWith(GOOGLE_CALENDAR_API_BASE)) {
        apiRequests.push(request);
        return await apiHandler(request);
      }
      throw new Error('Unexpected outgoing request');
    });
  }

  function requireApiRequest(index: number): Request {
    const request = apiRequests[index];
    if (!request) {
      throw new Error(`Expected Google Calendar API request at index ${index}`);
    }
    return request;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    apiRequests = [];
    tokenRequests = 0;
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

  it('encodes the calendar path and sends supported pagination parameters with the owner token', async () => {
    mockFetch(() => Response.json(pageOne));

    const result = await createGoogleCalendarClient(TEST_ENV, testUserId).acl.list(
      'family/team#one@group.calendar.google.com',
      { maxResults: 125, pageToken: 'next/page+token' },
    );

    expect(result).toEqual(pageOne);
    expect(apiRequests).toHaveLength(1);
    const request = requireApiRequest(0);
    expect(request.method).toBe('GET');
    expect(new URL(request.url).pathname).toBe(
      '/calendar/v3/calendars/family%2Fteam%23one%40group.calendar.google.com/acl',
    );
    expect(new URL(request.url).searchParams.get('maxResults')).toBe('125');
    expect(new URL(request.url).searchParams.get('pageToken')).toBe('next/page+token');
    expect(request.headers.get('authorization')).toBe('Bearer mock-access-token-1');
    expect(request.redirect).toBe('manual');
    expect(tokenRequests).toBe(1);
  });

  it('accepts a valid terminal page with an empty ACL list', async () => {
    mockFetch(() => Response.json({ items: [], etag: '"empty"' }));

    await expect(
      createGoogleCalendarClient(TEST_ENV, testUserId).acl.list('family-calendar'),
    ).resolves.toEqual({ items: [], etag: '"empty"' });
  });

  it('refreshes the owner token once after a 401 and retries the same page request', async () => {
    mockFetch((request) => {
      if (request.headers.get('authorization') === 'Bearer mock-access-token-1') {
        return new Response(null, { status: 401 });
      }
      return Response.json(pageOne);
    });

    await expect(
      createGoogleCalendarClient(TEST_ENV, testUserId).acl.list('family-calendar', {
        maxResults: 10,
      }),
    ).resolves.toEqual(pageOne);

    expect(apiRequests).toHaveLength(2);
    expect(apiRequests.map((request) => request.headers.get('authorization'))).toEqual([
      'Bearer mock-access-token-1',
      'Bearer mock-access-token-2',
    ]);
    expect(requireApiRequest(1).url).toBe(requireApiRequest(0).url);
    expect(tokenRequests).toBe(2);
  });

  it('validates pagination arguments before making any network request', async () => {
    mockFetch(() => Response.json(pageOne));
    const client = createGoogleCalendarClient(TEST_ENV, testUserId);

    await expect(client.acl.list('family-calendar', { maxResults: 251 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      client.acl.list('family-calendar', { pageToken: 'token', extra: true } as AclListOptions),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.acl.list('..')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    expect(apiRequests).toHaveLength(0);
    expect(tokenRequests).toBe(0);
  });

  it('rejects malformed Google ACL data without exposing upstream response details', async () => {
    const privateValue = 'private-calendar-error-details@example.test';
    mockFetch(() =>
      Response.json({
        error: { message: privateValue },
        items: [{ id: privateValue, role: 'secret-role', scope: { type: 'user' } }],
      }),
    );

    const client = createGoogleCalendarClient(TEST_ENV, testUserId);
    let caught: unknown;
    try {
      await client.acl.list('family-calendar');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GoogleCalendarError);
    expect(caught).toMatchObject({ code: 'INVALID_RESPONSE', status: 200 });
    expect((caught as Error).message).not.toContain(privateValue);
    expect(JSON.stringify(caught)).not.toContain(privateValue);
    expect(apiRequests).toHaveLength(1);
  });

  it('returns sanitized API errors without copying Google error text', async () => {
    const privateValue = 'calendar-id-and-email-secret';
    mockFetch(() =>
      Response.json(
        { error: { message: privateValue, errors: [{ reason: 'forbidden' }] } },
        { status: 403 },
      ),
    );

    const client = createGoogleCalendarClient(TEST_ENV, testUserId);
    let caught: unknown;
    try {
      await client.acl.list('family-calendar');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GoogleCalendarError);
    expect(caught).toMatchObject({ code: 'API_ERROR', reason: 'forbidden' });
    expect((caught as Error).message).not.toContain(privateValue);
    expect(apiRequests).toHaveLength(1);
  });
});
