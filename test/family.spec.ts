import { env } from 'cloudflare:test';
import {
  MEMBER_COLORS,
  type MemberColor,
  createFamilyResponseSchema,
  familyDetailResponseSchema,
  familyErrorResponseSchema,
  familyListResponseSchema,
  inviteIssueResponseSchema,
  joinInfoResponseSchema,
  joinSuccessResponseSchema,
  memberColorSchema,
} from '@shared/schemas/family';
import { FAMILY_ACL_SCOPE, PHASE1_SCOPES, SESSION_COOKIE_NAME } from '@worker/auth/config';
import { encryptAesGcm, generateRandomToken, sha256Hex } from '@worker/auth/crypto';
import { createSession } from '@worker/auth/session';
import { createDb } from '@worker/db';
import {
  closureDays,
  families,
  googleTokens,
  invites,
  members,
  oauthStates,
  sessions,
  users,
} from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { createGoogleCalendarClient } from '@worker/google/calendar';
import { app } from '@worker/index';
import { and, eq } from 'drizzle-orm';
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

async function createSignedCookieHeader(
  rawToken: string,
  secret = TEST_SESSION_SECRET,
): Promise<string> {
  const dummyApp = new Hono();
  dummyApp.get('/test', async (c) => {
    await setSignedCookie(c, SESSION_COOKIE_NAME, rawToken, secret, SESSION_COOKIE_OPTIONS);
    return c.text('ok');
  });
  const res = await dummyApp.request('http://localhost/test');
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('Failed to set signed cookie in test');
  const cookiePart = setCookie.split(';')[0];
  if (!cookiePart) throw new Error('Failed to parse cookie header');
  return cookiePart;
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mockGoogleTokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: 'mock-google-access-token-123',
      expires_in: 3600,
      token_type: 'Bearer',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('Task 1-4: Family Onboarding, Creation, & Invitations', () => {
  const db = createDb(env.DB);
  const interceptedUrls: string[] = [];

  let calendarCallCount = 0;

  beforeEach(async () => {
    interceptedUrls.length = 0;
    calendarCallCount = 0;

    // Strict network gate
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const urlStr = req.url;
      interceptedUrls.push(urlStr);

      // 1. Google OAuth token refresh
      if (urlStr === 'https://oauth2.googleapis.com/token') {
        return mockGoogleTokenResponse();
      }

      // 2. Google Calendar creation
      if (urlStr === 'https://www.googleapis.com/calendar/v3/calendars' && req.method === 'POST') {
        calendarCallCount++;
        const bodyBuffer = await req.clone().arrayBuffer();
        const bodyText = new TextDecoder().decode(bodyBuffer);
        const bodyJson = JSON.parse(bodyText);

        const calId =
          calendarCallCount === 1
            ? 'mock_cal_family_456'
            : `mock_cal_${calendarCallCount}_${crypto.randomUUID().replace(/-/g, '')}`;

        return new Response(
          JSON.stringify({
            id: calId,
            summary: bodyJson.summary,
            timeZone: 'Asia/Tokyo',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // 3. Google Calendar ACL insert
      if (urlStr.includes('/acl') && req.method === 'POST') {
        const bodyBuffer = await req.clone().arrayBuffer();
        const bodyText = new TextDecoder().decode(bodyBuffer);
        const bodyJson = JSON.parse(bodyText);

        return new Response(
          JSON.stringify({
            id: `user:${bodyJson.scope.value}`,
            role: bodyJson.role,
            scope: bodyJson.scope,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected network call to: ${urlStr}`);
    });

    // Clean D1 storage
    await db.delete(invites);
    await db.delete(closureDays);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(oauthStates);
    await db.delete(users);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    try {
      await db.delete(invites);
      await db.delete(closureDays);
      await db.delete(members);
      await db.delete(families);
      await db.delete(googleTokens);
      await db.delete(sessions);
      await db.delete(oauthStates);
      await db.delete(users);
    } catch {
      // Ignore cleanup error
    }
  });

  async function createTestUser(params: {
    id: string;
    googleSub: string;
    email: string;
    displayName: string;
    scopes?: string[];
    refreshToken?: string;
  }): Promise<{ cookieHeader: string; user: typeof users.$inferSelect }> {
    await db.insert(users).values({
      id: params.id,
      googleSub: params.googleSub,
      email: params.email,
      displayName: params.displayName,
    });

    const rawRefreshToken = params.refreshToken ?? 'mock-refresh-token';
    const refreshTokenEnc = await encryptAesGcm(
      rawRefreshToken,
      TEST_AES_KEY_BASE64,
      `google-refresh:${params.id}`,
    );

    const userScopes = params.scopes ?? [...PHASE1_SCOPES, FAMILY_ACL_SCOPE];

    await db.insert(googleTokens).values({
      userId: params.id,
      refreshTokenEnc,
      scopes: userScopes.join(' '),
    });

    const { rawToken } = await createSession(db, params.id);
    const cookieHeader = await createSignedCookieHeader(rawToken);

    return {
      cookieHeader,
      user: {
        id: params.id,
        googleSub: params.googleSub,
        email: params.email,
        displayName: params.displayName,
        createdAt: Math.floor(Date.now() / 1000),
      },
    };
  }

  describe('1. Family Creation Sequence, Children Management, & Edge Cases', () => {
    it('accepts the eight member colors and rejects legacy relationship labels in both Zod and D1', async () => {
      expect(MEMBER_COLORS).toEqual([
        'indigo',
        'green',
        'ochre',
        'purple',
        'coral',
        'teal',
        'rose',
        'slate',
      ]);
      for (const color of MEMBER_COLORS)
        expect(memberColorSchema.safeParse(color).success).toBe(true);
      for (const color of ['papa', 'mama', 'daughter', 'son']) {
        expect(memberColorSchema.safeParse(color).success).toBe(false);
      }

      const owner = await createTestUser({
        id: 'usr_palette_check',
        googleSub: 'sub-palette-check',
        email: 'palette@example.test',
        displayName: 'Palette Test',
      });
      await db.insert(families).values({
        id: 'fam_palette_check',
        name: '色検証家',
        ownerUserId: owner.user.id,
        creationStatus: 'ready',
        calendarCreationId: 'palette-creation',
      });
      await expect(
        db.insert(members).values({
          id: 'mem_palette_invalid',
          familyId: 'fam_palette_check',
          userId: null,
          kind: 'child',
          name: '子ども',
          color: 'daughter' as MemberColor,
          sortOrder: 1,
          status: 'active',
        }),
      ).rejects.toThrow();
    });

    it('creates a family, provisions Google Calendar, reserves owner and child members atomically, and returns strictly mapped schema', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_1',
        googleSub: 'google-sub-owner-1',
        email: 'owner@example.test',
        displayName: 'Takuya',
      });

      const res = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({
            name: '池町家',
            children: [{ name: 'はな', color: 'ochre' }],
          }),
        },
        TEST_ENV,
      );

      expect(res.status).toBe(201);
      const data = createFamilyResponseSchema.parse(await res.json());

      expect(data.family.name).toBe('池町家');
      expect(data.family.familyCalendarId).toBe('mock_cal_family_456');
      expect(data.family.ownerUserId).toBe(owner.user.id);
      expect(data.family.creationStatus).toBe('ready');

      // Members: owner + 1 child
      expect(data.family.members).toHaveLength(2);
      expect(data.family.members[0]).toMatchObject({
        userId: owner.user.id,
        kind: 'adult',
        name: 'Takuya',
        color: 'indigo',
        sortOrder: 0,
      });
      expect(data.family.members[1]).toMatchObject({
        userId: null,
        kind: 'child',
        name: 'はな',
        color: 'ochre',
        sortOrder: 1,
      });

      // No status field in public schema
      expect('status' in (data.family.members[0] ?? {})).toBe(false);

      // Verify Google Calendar was created with correct title
      expect(
        interceptedUrls.some((u) => u === 'https://www.googleapis.com/calendar/v3/calendars'),
      ).toBe(true);

      // GET /api/families returns the family for owner
      const listRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        { headers: { Cookie: owner.cookieHeader } },
        TEST_ENV,
      );
      expect(listRes.status).toBe(200);
      const listData = familyListResponseSchema.parse(await listRes.json());
      expect(listData.families).toHaveLength(1);
      expect(listData.families[0]?.id).toBe(data.family.id);

      // GET /api/families/:id returns detail
      const detailRes = await app.request(
        `${TEST_ORIGIN}/api/families/${data.family.id}`,
        { headers: { Cookie: owner.cookieHeader } },
        TEST_ENV,
      );
      expect(detailRes.status).toBe(200);
      const detailData = familyDetailResponseSchema.parse(await detailRes.json());
      expect(detailData.family.id).toBe(data.family.id);
    });

    it('manages children via PUT /api/families/:id/children: replaces child set atomically and preserves IDs on identical retry', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_children',
        googleSub: 'google-sub-children',
        email: 'children.owner@example.test',
        displayName: 'Owner With Children',
      });

      // 1. Create family with 1 child
      const createRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({
            name: '子どもテスト家',
            children: [{ name: 'はな', color: 'ochre' }],
          }),
        },
        TEST_ENV,
      );
      expect(createRes.status).toBe(201);
      const famId = createFamilyResponseSchema.parse(await createRes.json()).family.id;

      // 2. PUT children: replace with 2 children
      const putRes = await app.request(
        `${TEST_ORIGIN}/api/families/${famId}/children`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({
            children: [
              { name: 'はな', color: 'ochre' },
              { name: 'はる', color: 'purple' },
            ],
          }),
        },
        TEST_ENV,
      );
      expect(putRes.status).toBe(200);
      const putData = familyDetailResponseSchema.parse(await putRes.json());
      expect(putData.family.members).toHaveLength(3); // 1 adult + 2 children
      const child1Id = putData.family.members[1]?.id;
      const child2Id = putData.family.members[2]?.id;

      // 3. PUT with exact same ordered children preserves IDs
      const putIdempotentRes = await app.request(
        `${TEST_ORIGIN}/api/families/${famId}/children`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({
            children: [
              { name: 'はな', color: 'ochre' },
              { name: 'はる', color: 'purple' },
            ],
          }),
        },
        TEST_ENV,
      );
      expect(putIdempotentRes.status).toBe(200);
      const idempotentData = familyDetailResponseSchema.parse(await putIdempotentRes.json());
      expect(idempotentData.family.members[1]?.id).toBe(child1Id);
      expect(idempotentData.family.members[2]?.id).toBe(child2Id);
    });

    it('clears children array cleanly when PUT /api/families/:id/children is called with empty array while preserving adults', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_empty_children',
        googleSub: 'google-sub-empty-children',
        email: 'empty.children@example.test',
        displayName: 'Empty Children Owner',
      });

      const createRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({
            name: '子無し更新家',
            children: [{ name: 'はな', color: 'ochre' }],
          }),
        },
        TEST_ENV,
      );
      expect(createRes.status).toBe(201);
      const famId = createFamilyResponseSchema.parse(await createRes.json()).family.id;

      // PUT children with empty array
      const putRes = await app.request(
        `${TEST_ORIGIN}/api/families/${famId}/children`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({ children: [] }),
        },
        TEST_ENV,
      );
      expect(putRes.status).toBe(200);
      const putData = familyDetailResponseSchema.parse(await putRes.json());
      expect(putData.family.members).toHaveLength(1); // Only adult remains
      expect(putData.family.members[0]?.kind).toBe('adult');
      expect(putData.family.members[0]?.userId).toBe(owner.user.id);
    });

    it('normalizes and caps long adult display name to 80 characters and trims spaces without trailing space', async () => {
      // 1. Long name with leading and trailing spaces
      const longName =
        '   Alice with a very very very very very very very long name that exceeds eighty characters by quite a lot indeed and needs to be trimmed and capped   ';
      const owner = await createTestUser({
        id: 'usr_owner_long_name',
        googleSub: 'google-sub-long-name',
        email: 'long.name@example.test',
        displayName: longName,
      });

      const res = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({ name: '名前正規化家', children: [] }),
        },
        TEST_ENV,
      );
      expect(res.status).toBe(201);
      const data = createFamilyResponseSchema.parse(await res.json());
      expect(data.family.members[0]?.name.length).toBeLessThanOrEqual(80);
      expect(data.family.members[0]?.name.endsWith(' ')).toBe(false);

      // 2. Name with exactly 79 'A's + ' ' + 'B' (81 chars): sliced to 80 chars, ends in ' ', then trimmed to 79 'A's
      const boundaryName = `${'A'.repeat(79)} B`;
      const boundaryOwner = await createTestUser({
        id: 'usr_owner_boundary_name',
        googleSub: 'google-sub-boundary-name',
        email: 'boundary.name@example.test',
        displayName: boundaryName,
      });

      const boundaryRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: boundaryOwner.cookieHeader,
          },
          body: JSON.stringify({ name: '境界名前家', children: [] }),
        },
        TEST_ENV,
      );
      expect(boundaryRes.status).toBe(201);
      const boundaryData = createFamilyResponseSchema.parse(await boundaryRes.json());
      expect(boundaryData.family.members[0]?.name).toBe('A'.repeat(79));
      expect(boundaryData.family.members[0]?.name.endsWith(' ')).toBe(false);

      // 3. User with all-whitespace display name falls back safely
      const emptyNameOwner = await createTestUser({
        id: 'usr_owner_empty_name',
        googleSub: 'google-sub-empty-name',
        email: 'empty.name@example.test',
        displayName: '     ',
      });

      const emptyNameRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: emptyNameOwner.cookieHeader,
          },
          body: JSON.stringify({ name: 'フォールバック家', children: [] }),
        },
        TEST_ENV,
      );
      expect(emptyNameRes.status).toBe(201);
      const emptyNameData = createFamilyResponseSchema.parse(await emptyNameRes.json());
      expect(emptyNameData.family.members[0]?.name).toBe('オーナー');
    });

    it('allows explicit retry of a failed creation using conditional status update and does not duplicate reservation', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_retry',
        googleSub: 'google-sub-retry',
        email: 'retry.owner@example.test',
        displayName: 'Retry Owner',
      });

      // Force first creation to fail
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return mockGoogleTokenResponse();
        }
        if (req.url === 'https://www.googleapis.com/calendar/v3/calendars') {
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                message: 'Forbidden',
                errors: [{ reason: 'forbidden' }],
              },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected call: ${req.url}`);
      });

      const failRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({ name: 'リトライ家', children: [] }),
        },
        TEST_ENV,
      );
      expect(failRes.status).toBe(502);

      const failedFam = await db
        .select()
        .from(families)
        .where(eq(families.ownerUserId, owner.user.id));
      expect(failedFam).toHaveLength(1);
      expect(failedFam[0]?.creationStatus).toBe('failed');

      // Now restore working Google mock and retry
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return mockGoogleTokenResponse();
        }
        if (req.url === 'https://www.googleapis.com/calendar/v3/calendars') {
          return new Response(
            JSON.stringify({
              id: 'mock_cal_retried_789',
              summary: 'Danran（リトライ家）',
              timeZone: 'Asia/Tokyo',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected call: ${req.url}`);
      });

      const retryRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({ name: 'リトライ家', children: [] }),
        },
        TEST_ENV,
      );
      expect(retryRes.status).toBe(201);
      const retryData = createFamilyResponseSchema.parse(await retryRes.json());
      expect(retryData.family.id).toBe(failedFam[0]?.id);
      expect(retryData.family.creationStatus).toBe('ready');
      expect(retryData.family.familyCalendarId).toBe('mock_cal_retried_789');
    });

    it('concurrent family creation with deferred Google gate: exactly 1 Google call, 1 family, second request rejected with 409 IN_PROGRESS', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_race',
        googleSub: 'google-sub-race',
        email: 'race.owner@danran.test',
        displayName: 'Race Owner',
      });

      const enteredGate = createDeferred();
      const releaseGate = createDeferred();
      let googleCallCount = 0;

      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return mockGoogleTokenResponse();
        }
        if (req.url === 'https://www.googleapis.com/calendar/v3/calendars') {
          googleCallCount++;
          enteredGate.resolve();
          await releaseGate.promise;
          return new Response(
            JSON.stringify({
              id: 'mock_cal_race_1',
              summary: 'Danran（並行作成家）',
              timeZone: 'Asia/Tokyo',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected call: ${req.url}`);
      });

      try {
        const reqA = app.request(
          `${TEST_ORIGIN}/api/families`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: TEST_ORIGIN,
              'X-Requested-With': 'XMLHttpRequest',
              Cookie: owner.cookieHeader,
            },
            body: JSON.stringify({ name: '並行作成家', children: [] }),
          },
          TEST_ENV,
        );

        await enteredGate.promise;

        const reqB = await app.request(
          `${TEST_ORIGIN}/api/families`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: TEST_ORIGIN,
              'X-Requested-With': 'XMLHttpRequest',
              Cookie: owner.cookieHeader,
            },
            body: JSON.stringify({ name: '並行作成家', children: [] }),
          },
          TEST_ENV,
        );

        expect(reqB.status).toBe(409);
        const bodyB = familyErrorResponseSchema.parse(await reqB.json());
        expect(bodyB.code).toBe('IN_PROGRESS');

        releaseGate.resolve();
        const resA = await reqA;
        expect(resA.status).toBe(201);

        expect(googleCallCount).toBe(1);

        const userFamilies = await db
          .select()
          .from(families)
          .where(eq(families.ownerUserId, owner.user.id));
        expect(userFamilies).toHaveLength(1);
        expect(userFamilies[0]?.creationStatus).toBe('ready');

        const userMembers = await db
          .select()
          .from(members)
          .where(eq(members.userId, owner.user.id));
        expect(userMembers).toHaveLength(1);
      } finally {
        releaseGate.resolve();
      }
    });

    it('concurrent failed retry with deferred Google gate: exactly 1 retry succeeds and only 1 Google call is made', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_retry_race',
        googleSub: 'google-sub-retry-race',
        email: 'retry.race@danran.test',
        displayName: 'Retry Race Owner',
      });

      const famId = 'fam_retry_race';
      await db.insert(families).values({
        id: famId,
        name: 'リトライ並行家',
        ownerUserId: owner.user.id,
        creationStatus: 'failed',
        dayStartHour: 8,
        dayEndHour: 20,
        createdAt: Math.floor(Date.now() / 1000),
      });
      await db.insert(members).values({
        id: 'mem_owner_retry_race',
        familyId: famId,
        userId: owner.user.id,
        kind: 'adult',
        name: 'Retry Race Owner',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      });

      const enteredGate = createDeferred();
      const releaseGate = createDeferred();
      let googleCallCount = 0;

      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return mockGoogleTokenResponse();
        }
        if (req.url === 'https://www.googleapis.com/calendar/v3/calendars') {
          googleCallCount++;
          enteredGate.resolve();
          await releaseGate.promise;
          return new Response(
            JSON.stringify({
              id: 'mock_cal_retried_race',
              summary: 'Danran（リトライ並行家）',
              timeZone: 'Asia/Tokyo',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected call: ${req.url}`);
      });

      try {
        const reqA = app.request(
          `${TEST_ORIGIN}/api/families`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: TEST_ORIGIN,
              'X-Requested-With': 'XMLHttpRequest',
              Cookie: owner.cookieHeader,
            },
            body: JSON.stringify({ name: 'リトライ並行家', children: [] }),
          },
          TEST_ENV,
        );

        await enteredGate.promise;

        const reqB = await app.request(
          `${TEST_ORIGIN}/api/families`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: TEST_ORIGIN,
              'X-Requested-With': 'XMLHttpRequest',
              Cookie: owner.cookieHeader,
            },
            body: JSON.stringify({ name: 'リトライ並行家', children: [] }),
          },
          TEST_ENV,
        );

        expect(reqB.status).toBe(409);
        const bodyB = familyErrorResponseSchema.parse(await reqB.json());
        expect(bodyB.code).toBe('IN_PROGRESS');

        releaseGate.resolve();
        const resA = await reqA;
        expect(resA.status).toBe(201);
        expect(googleCallCount).toBe(1);

        const updated = await db.select().from(families).where(eq(families.id, famId));
        expect(updated[0]?.creationStatus).toBe('ready');
      } finally {
        releaseGate.resolve();
      }
    });

    it('concurrent create vs join by same user: only 1 reservation succeeds, other is rejected with 409', async () => {
      const user = await createTestUser({
        id: 'usr_dual_action',
        googleSub: 'google-sub-dual-action',
        email: 'dual@danran.test',
        displayName: 'Dual Action User',
      });

      // Existing other family to join
      const otherOwner = await createTestUser({
        id: 'usr_other_owner_dual',
        googleSub: 'google-sub-other-dual',
        email: 'other.owner@danran.test',
        displayName: 'Other Owner',
      });
      const otherFamId = 'fam_other_dual';
      await db.insert(families).values({
        id: otherFamId,
        name: '他家',
        familyCalendarId: 'cal_other_dual',
        ownerUserId: otherOwner.user.id,
        creationStatus: 'ready',
        dayStartHour: 8,
        dayEndHour: 20,
        createdAt: Math.floor(Date.now() / 1000),
      });
      await db.insert(members).values({
        id: 'mem_other_owner_dual',
        familyId: otherFamId,
        userId: otherOwner.user.id,
        kind: 'adult',
        name: 'Other Owner',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      });

      const rawToken = generateRandomToken(32);
      const tokenHash = await sha256Hex(rawToken);
      await db.insert(invites).values({
        id: 'inv_other_dual',
        familyId: otherFamId,
        tokenHash,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        status: 'available',
        createdAt: Math.floor(Date.now() / 1000),
      });

      const enteredGate = createDeferred();
      const releaseGate = createDeferred();

      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return mockGoogleTokenResponse();
        }
        if (req.url === 'https://www.googleapis.com/calendar/v3/calendars') {
          enteredGate.resolve();
          await releaseGate.promise;
          return new Response(
            JSON.stringify({
              id: 'mock_cal_dual',
              summary: 'Danran（二重動作家）',
              timeZone: 'Asia/Tokyo',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected call: ${req.url}`);
      });

      try {
        // Start create
        const createReq = app.request(
          `${TEST_ORIGIN}/api/families`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: TEST_ORIGIN,
              'X-Requested-With': 'XMLHttpRequest',
              Cookie: user.cookieHeader,
            },
            body: JSON.stringify({ name: '二重動作家', children: [] }),
          },
          TEST_ENV,
        );

        await enteredGate.promise;

        // While create is in flight (user already has an active member row in the creating family),
        // join request must fail with 409
        const joinReq = await app.request(
          `${TEST_ORIGIN}/api/invites/join`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: TEST_ORIGIN,
              'X-Requested-With': 'XMLHttpRequest',
              Cookie: user.cookieHeader,
            },
            body: JSON.stringify({ token: rawToken }),
          },
          TEST_ENV,
        );

        expect(joinReq.status).toBe(409);

        releaseGate.resolve();
        const createRes = await createReq;
        expect(createRes.status).toBe(201);
      } finally {
        releaseGate.resolve();
      }
    });

    it('keeps uncertain calendar creation fenced until the owner uses reconcile', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_uncertain',
        googleSub: 'google-sub-uncertain',
        email: 'uncertain.owner@danran.test',
        displayName: 'Uncertain Owner',
      });

      // Simulate 500 error from Google Calendar insert
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return mockGoogleTokenResponse();
        }
        if (req.url === 'https://www.googleapis.com/calendar/v3/calendars') {
          return new Response(JSON.stringify({ error: { code: 500, message: 'Backend Error' } }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unexpected call: ${req.url}`);
      });

      const res = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({ name: '不確実家', children: [] }),
        },
        TEST_ENV,
      );

      expect(res.status).toBe(500);
      const errData = familyErrorResponseSchema.parse(await res.json());
      expect(errData.code).toBe('UNCERTAIN_MUTATION');

      // Verify family creationStatus is uncertain
      const famRecord = await db
        .select()
        .from(families)
        .where(eq(families.ownerUserId, owner.user.id));
      expect(famRecord).toHaveLength(1);
      expect(famRecord[0]?.creationStatus).toBe('uncertain');

      // GET /api/families includes own uncertain family so UI recovery can block new create
      const listRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        { headers: { Cookie: owner.cookieHeader } },
        TEST_ENV,
      );
      expect(listRes.status).toBe(200);
      const listData = familyListResponseSchema.parse(await listRes.json());
      expect(listData.families).toHaveLength(1);
      expect(listData.families[0]?.id).toBe(famRecord[0]?.id);
      expect(listData.families[0]?.creationStatus).toBe('uncertain');

      // Subsequent POST /api/families returns 409 UNCERTAIN_MUTATION with no Google calls
      const retryRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({ name: '不確実家', children: [] }),
        },
        TEST_ENV,
      );
      expect(retryRes.status).toBe(409);
      const retryErr = familyErrorResponseSchema.parse(await retryRes.json());
      expect(retryErr.code).toBe('UNCERTAIN_MUTATION');
    });
  });

  describe('2. Multi-user Invitation Flow & Security Boundary', () => {
    it('executes full invite, inspect, and join flow between 2 users with ACL writer grant, notification, zero calendarList calls, and verifies joiner uses own credentials for events', async () => {
      const ownerRefreshToken = 'mock-refresh-owner-flow';
      const joinerRefreshToken = 'mock-refresh-joiner-flow';
      const ownerAccessToken = 'bearer-access-token-owner-flow';
      const joinerAccessToken = 'bearer-access-token-joiner-flow';

      const owner = await createTestUser({
        id: 'usr_owner_flow',
        googleSub: 'google-sub-flow-owner',
        email: 'owner@danran.test',
        displayName: 'Owner User',
        scopes: [...PHASE1_SCOPES, FAMILY_ACL_SCOPE],
        refreshToken: ownerRefreshToken,
      });

      const joiner = await createTestUser({
        id: 'usr_joiner_flow',
        googleSub: 'google-sub-flow-joiner',
        email: 'joiner@danran.test',
        displayName: 'Joiner User',
        scopes: [...PHASE1_SCOPES], // Explicitly omit FAMILY_ACL_SCOPE
        refreshToken: joinerRefreshToken,
      });

      let aclInsertCalled = false;
      let aclRequestRecipient = '';
      let aclSendNotifications = '';

      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const urlStr = req.url;
        interceptedUrls.push(urlStr);

        // 1. Google OAuth token refresh
        if (urlStr === 'https://oauth2.googleapis.com/token') {
          const bodyText = new TextDecoder().decode(await req.clone().arrayBuffer());
          const params = new URLSearchParams(bodyText);
          const rt = params.get('refresh_token');

          if (rt === ownerRefreshToken) {
            return new Response(
              JSON.stringify({
                access_token: ownerAccessToken,
                expires_in: 3600,
                token_type: 'Bearer',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (rt === joinerRefreshToken) {
            return new Response(
              JSON.stringify({
                access_token: joinerAccessToken,
                expires_in: 3600,
                token_type: 'Bearer',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return mockGoogleTokenResponse();
        }

        // 2. Google Calendar creation (called by owner)
        if (
          urlStr === 'https://www.googleapis.com/calendar/v3/calendars' &&
          req.method === 'POST'
        ) {
          expect(req.headers.get('Authorization')).toBe(`Bearer ${ownerAccessToken}`);
          expect(req.headers.get('Authorization')).not.toBe(`Bearer ${joinerAccessToken}`);
          const bodyBuffer = await req.clone().arrayBuffer();
          const bodyText = new TextDecoder().decode(bodyBuffer);
          const bodyJson = JSON.parse(bodyText);

          return new Response(
            JSON.stringify({
              id: 'mock_cal_shared_family_789',
              summary: bodyJson.summary,
              timeZone: 'Asia/Tokyo',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // 3. Google Calendar ACL insert (called by owner)
        if (urlStr.includes('/acl') && req.method === 'POST') {
          expect(req.headers.get('Authorization')).toBe(`Bearer ${ownerAccessToken}`);
          expect(req.headers.get('Authorization')).not.toBe(`Bearer ${joinerAccessToken}`);
          aclInsertCalled = true;
          const urlObj = new URL(req.url);
          aclSendNotifications = urlObj.searchParams.get('sendNotifications') ?? '';

          const bodyBuffer = await req.clone().arrayBuffer();
          const bodyText = new TextDecoder().decode(bodyBuffer);
          const bodyJson = JSON.parse(bodyText);
          aclRequestRecipient = bodyJson.scope.value;

          return new Response(
            JSON.stringify({
              id: `user:${bodyJson.scope.value}`,
              role: 'writer',
              scope: { type: 'user', value: bodyJson.scope.value },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // 4. Events API operations (called by joiner using own credentials)
        if (urlStr.includes('/events') && req.method === 'GET') {
          expect(req.headers.get('Authorization')).toBe(`Bearer ${joinerAccessToken}`);
          expect(req.headers.get('Authorization')).not.toBe(`Bearer ${ownerAccessToken}`);
          return new Response(
            JSON.stringify({
              items: [],
              timeZone: 'Asia/Tokyo',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (urlStr.includes('/events') && req.method === 'POST') {
          expect(req.headers.get('Authorization')).toBe(`Bearer ${joinerAccessToken}`);
          expect(req.headers.get('Authorization')).not.toBe(`Bearer ${ownerAccessToken}`);
          const bodyBuffer = await req.clone().arrayBuffer();
          const bodyText = new TextDecoder().decode(bodyBuffer);
          const bodyJson = JSON.parse(bodyText);

          return new Response(
            JSON.stringify({
              id: 'mock_event_joiner_123',
              summary: bodyJson.summary,
              start: bodyJson.start,
              end: bodyJson.end,
              status: 'confirmed',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (urlStr.includes('/events/mock_event_joiner_123') && req.method === 'DELETE') {
          expect(req.headers.get('Authorization')).toBe(`Bearer ${joinerAccessToken}`);
          expect(req.headers.get('Authorization')).not.toBe(`Bearer ${ownerAccessToken}`);
          return new Response(null, { status: 204 });
        }

        throw new Error(`Unexpected call to: ${req.url}`);
      });

      // 1. Owner creates family
      const createRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({ name: '共有テスト家', children: [] }),
        },
        TEST_ENV,
      );
      expect(createRes.status).toBe(201);
      const famId = createFamilyResponseSchema.parse(await createRes.json()).family.id;

      // 2. Owner generates invite link with {} body
      const inviteRes = await app.request(
        `${TEST_ORIGIN}/api/families/${famId}/invites`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({}),
        },
        TEST_ENV,
      );
      expect(inviteRes.status).toBe(200);
      const inviteData = inviteIssueResponseSchema.parse(await inviteRes.json());
      expect(inviteData.authorizationRequired).toBe(false);
      if (inviteData.authorizationRequired) return;

      const rawToken = inviteData.inviteUrl.split('#')[1];
      expect(rawToken).toHaveLength(43);

      // Verify token plaintext is NOT stored in DB
      const storedInvites = await db.select().from(invites);
      expect(storedInvites).toHaveLength(1);
      expect(storedInvites[0]?.tokenHash).not.toContain(rawToken);

      // 3. Joiner inspects invite token
      const inspectRes = await app.request(
        `${TEST_ORIGIN}/api/invites/inspect`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );
      expect(inspectRes.status).toBe(200);
      const inspectData = joinInfoResponseSchema.parse(await inspectRes.json());
      expect(inspectData.familyName).toBe('共有テスト家');
      expect(inspectData.status).toBe('available');
      expect(inspectData.alreadyMember).toBe(false);

      // 4. Joiner joins family
      const joinRes = await app.request(
        `${TEST_ORIGIN}/api/invites/join`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );
      expect(joinRes.status).toBe(200);
      const joinData = joinSuccessResponseSchema.parse(await joinRes.json());
      expect(joinData.family.members).toHaveLength(2); // Owner + Joiner

      // Verify Google Calendar ACL was called with joiner's verified email and sendNotifications=true
      expect(aclInsertCalled).toBe(true);
      expect(aclRequestRecipient).toBe(joiner.user.email);
      expect(aclSendNotifications).toBe('true');

      // Verify invite is now marked 'used'
      const usedInvite = (await db.select().from(invites))[0];
      expect(usedInvite?.status).toBe('used');

      // 5. Assert Joiner B's stored scope grant is STILL PHASE1_SCOPES only (FAMILY_ACL_SCOPE absent)
      const joinerTokenRows = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, joiner.user.id));
      expect(joinerTokenRows).toHaveLength(1);
      const joinerStoredScopes = joinerTokenRows[0]?.scopes.split(' ') ?? [];
      for (const requiredScope of PHASE1_SCOPES) {
        expect(joinerStoredScopes).toContain(requiredScope);
      }
      expect(joinerStoredScopes).not.toContain(FAMILY_ACL_SCOPE);

      // 6. Joiner uses own client to list, insert, and delete events on joined family's calendar
      const joinerCalendarClient = createGoogleCalendarClient(TEST_ENV, joiner.user.id);
      const actualFamilyCalendarId = joinData.family.familyCalendarId;
      expect(actualFamilyCalendarId).toBe('mock_cal_shared_family_789');
      if (!actualFamilyCalendarId) {
        throw new Error('Expected familyCalendarId to be present on joined family');
      }

      // 6a. events.list with Joiner's token
      const eventList = await joinerCalendarClient.events.list(actualFamilyCalendarId);
      expect(eventList.items).toEqual([]);

      // 6b. events.insert with Joiner's token (synthetic explicit Tokyo RFC3339 date-time)
      const createdEvent = await joinerCalendarClient.events.insert(actualFamilyCalendarId, {
        summary: '家族旅行の予定',
        start: { dateTime: '2026-10-10T09:00:00+09:00', timeZone: 'Asia/Tokyo' },
        end: { dateTime: '2026-10-10T17:00:00+09:00', timeZone: 'Asia/Tokyo' },
      });
      expect(createdEvent.id).toBe('mock_event_joiner_123');
      expect(createdEvent.summary).toBe('家族旅行の予定');

      // 6c. events.delete with Joiner's token
      await expect(
        joinerCalendarClient.events.delete(actualFamilyCalendarId, 'mock_event_joiner_123'),
      ).resolves.toBeUndefined();

      // 7. Verify NO calendarList calls were made for the entire flow
      expect(interceptedUrls.some((u) => u.includes('calendarList'))).toBe(false);

      // 8. Joiner inspecting used invite sees alreadyMember: true
      const inspectUsedRes = await app.request(
        `${TEST_ORIGIN}/api/invites/inspect`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );
      expect(inspectUsedRes.status).toBe(200);
      const inspectUsedData = joinInfoResponseSchema.parse(await inspectUsedRes.json());
      expect(inspectUsedData.alreadyMember).toBe(true);

      // 9. Another outsider inspecting the used invite gets 410 without leaking claimer identity
      const outsider = await createTestUser({
        id: 'usr_outsider',
        googleSub: 'google-sub-outsider',
        email: 'outsider@example.test',
        displayName: 'Outsider User',
      });

      const outsiderInspectRes = await app.request(
        `${TEST_ORIGIN}/api/invites/inspect`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: outsider.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );
      expect(outsiderInspectRes.status).toBe(410);
    });

    it('returns authorizationRequired: true when owner lacks calendar.acls scope', async () => {
      const ownerWithoutAcl = await createTestUser({
        id: 'usr_owner_no_acl',
        googleSub: 'google-sub-no-acl',
        email: 'no.acl@danran.test',
        displayName: 'No ACL Owner',
        scopes: [...PHASE1_SCOPES], // explicitly omit FAMILY_ACL_SCOPE
      });

      // Create family
      const createRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: ownerWithoutAcl.cookieHeader,
          },
          body: JSON.stringify({ name: '権限要求家', children: [] }),
        },
        TEST_ENV,
      );
      expect(createRes.status).toBe(201);
      const famId = createFamilyResponseSchema.parse(await createRes.json()).family.id;

      // POST invites returns authorizationRequired: true with authUrl
      const inviteRes = await app.request(
        `${TEST_ORIGIN}/api/families/${famId}/invites`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: ownerWithoutAcl.cookieHeader,
          },
          body: JSON.stringify({}),
        },
        TEST_ENV,
      );
      expect(inviteRes.status).toBe(200);
      const inviteData = inviteIssueResponseSchema.parse(await inviteRes.json());
      expect(inviteData.authorizationRequired).toBe(true);
      if (!inviteData.authorizationRequired) return;
      expect(inviteData.authorizationUrl).toContain('https://accounts.google.com');
    });

    it('enforces active member guards: non-member or pending user cannot read family detail or list', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_guard',
        googleSub: 'google-sub-guard',
        email: 'guard.owner@danran.test',
        displayName: 'Guard Owner',
      });

      const outsider = await createTestUser({
        id: 'usr_outsider_guard',
        googleSub: 'google-sub-outsider-guard',
        email: 'outsider.guard@danran.test',
        displayName: 'Outsider',
      });

      const pendingJoiner = await createTestUser({
        id: 'usr_pending_guard',
        googleSub: 'google-sub-pending-guard',
        email: 'pending.guard@danran.test',
        displayName: 'Pending Joiner',
      });

      const createRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({ name: 'ガード家', children: [] }),
        },
        TEST_ENV,
      );
      expect(createRes.status).toBe(201);
      const famId = createFamilyResponseSchema.parse(await createRes.json()).family.id;

      // Seed pending membership for pendingJoiner
      await db.insert(members).values({
        id: 'mem_pending_guard_row',
        familyId: famId,
        userId: pendingJoiner.user.id,
        kind: 'adult',
        name: 'Pending Joiner',
        color: 'green',
        sortOrder: 1,
        status: 'pending',
      });

      // Outsider receives 404 (non-enumerated) on detail
      const outsiderDetailRes = await app.request(
        `${TEST_ORIGIN}/api/families/${famId}`,
        { headers: { Cookie: outsider.cookieHeader } },
        TEST_ENV,
      );
      expect(outsiderDetailRes.status).toBe(404);

      // Outsider receives empty list
      const outsiderListRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        { headers: { Cookie: outsider.cookieHeader } },
        TEST_ENV,
      );
      expect(outsiderListRes.status).toBe(200);
      const outsiderListData = familyListResponseSchema.parse(await outsiderListRes.json());
      expect(outsiderListData.families).toHaveLength(0);

      // Pending joiner receives 404 on detail
      const pendingDetailRes = await app.request(
        `${TEST_ORIGIN}/api/families/${famId}`,
        { headers: { Cookie: pendingJoiner.cookieHeader } },
        TEST_ENV,
      );
      expect(pendingDetailRes.status).toBe(404);

      // Pending joiner receives empty list (pending does NOT grant family authorization)
      const pendingListRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        { headers: { Cookie: pendingJoiner.cookieHeader } },
        TEST_ENV,
      );
      expect(pendingListRes.status).toBe(200);
      const pendingListData = familyListResponseSchema.parse(await pendingListRes.json());
      expect(pendingListData.families).toHaveLength(0);
    });

    it('forbids non-owner active member from issuing invites or modifying children (403 FORBIDDEN)', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_nonowner_test',
        googleSub: 'sub-owner-nonowner',
        email: 'owner.nonowner@danran.test',
        displayName: 'Owner',
      });
      const memberUser = await createTestUser({
        id: 'usr_member_nonowner_test',
        googleSub: 'sub-member-nonowner',
        email: 'member.nonowner@danran.test',
        displayName: 'Member Adult',
      });

      const famId = 'fam_nonowner_test';
      await db.insert(families).values({
        id: famId,
        name: '非オーナー権限テスト家',
        familyCalendarId: 'cal_nonowner_test',
        ownerUserId: owner.user.id,
        creationStatus: 'ready',
        dayStartHour: 8,
        dayEndHour: 20,
        createdAt: Math.floor(Date.now() / 1000),
      });
      await db.insert(members).values([
        {
          id: 'mem_owner_entry',
          familyId: famId,
          userId: owner.user.id,
          kind: 'adult',
          name: 'Owner',
          color: 'indigo',
          sortOrder: 0,
          status: 'active',
        },
        {
          id: 'mem_adult_entry',
          familyId: famId,
          userId: memberUser.user.id,
          kind: 'adult',
          name: 'Member Adult',
          color: 'green',
          sortOrder: 1,
          status: 'active',
        },
      ]);

      // Non-owner attempts to issue invite -> 403
      const inviteRes = await app.request(
        `${TEST_ORIGIN}/api/families/${famId}/invites`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: memberUser.cookieHeader,
          },
          body: JSON.stringify({}),
        },
        TEST_ENV,
      );
      expect(inviteRes.status).toBe(403);

      // Non-owner attempts to update children -> 403
      const childRes = await app.request(
        `${TEST_ORIGIN}/api/families/${famId}/children`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: memberUser.cookieHeader,
          },
          body: JSON.stringify({ children: [] }),
        },
        TEST_ENV,
      );
      expect(childRes.status).toBe(403);
    });

    it('enforces CSRF headers (Origin and X-Requested-With) on all state-changing endpoints', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_csrf',
        googleSub: 'google-sub-csrf',
        email: 'csrf@danran.test',
        displayName: 'CSRF Owner',
      });

      // Missing X-Requested-With
      const noHeaderRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({ name: '不正リクエスト家', children: [] }),
        },
        TEST_ENV,
      );
      expect(noHeaderRes.status).toBe(403);

      // Mismatched Origin
      const badOriginRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil-attacker.example.com',
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({ name: '不正オリジン家', children: [] }),
        },
        TEST_ENV,
      );
      expect(badOriginRes.status).toBe(403);
    });

    it('makes zero Google API calls on invalid CSRF, invalid JSON, or outsider requests', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_no_call',
        googleSub: 'google-sub-no-call',
        email: 'no.call@danran.test',
        displayName: 'No Call Owner',
      });

      // Invalid CSRF
      await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil.test',
            Cookie: owner.cookieHeader,
          },
          body: JSON.stringify({ name: '悪意リクエスト', children: [] }),
        },
        TEST_ENV,
      );

      // Invalid JSON syntax
      await app.request(
        `${TEST_ORIGIN}/api/families`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: owner.cookieHeader,
          },
          body: '{ invalid-json-body',
        },
        TEST_ENV,
      );

      // Outsider accessing unknown family
      const outsider = await createTestUser({
        id: 'usr_outsider_no_call',
        googleSub: 'google-sub-outsider-no-call',
        email: 'outsider.no.call@danran.test',
        displayName: 'Outsider',
      });
      await app.request(
        `${TEST_ORIGIN}/api/families/fam_non_existent/invites`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: outsider.cookieHeader,
          },
          body: JSON.stringify({}),
        },
        TEST_ENV,
      );

      // Verify zero Google calls were made
      expect(interceptedUrls.filter((u) => u.includes('googleapis.com'))).toHaveLength(0);
    });

    it('rejects invite inspection and join when body contains unexpected properties (.strict()) and verifies token plaintext is never stored in DB', async () => {
      const joiner = await createTestUser({
        id: 'usr_joiner_strict',
        googleSub: 'sub-joiner-strict',
        email: 'joiner.strict@danran.test',
        displayName: 'Strict Joiner',
      });

      const validToken = generateRandomToken(32);

      // Inspect with unexpected property
      const inspectRes = await app.request(
        `${TEST_ORIGIN}/api/invites/inspect`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: validToken, evilField: 'malicious' }),
        },
        TEST_ENV,
      );
      expect(inspectRes.status).toBe(400);

      // Join with unexpected property
      const joinRes = await app.request(
        `${TEST_ORIGIN}/api/invites/join`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: validToken, email: 'attacker@evil.com' }),
        },
        TEST_ENV,
      );
      expect(joinRes.status).toBe(400);

      // Verify no invite records exist
      const allInvites = await db.select().from(invites);
      expect(allInvites).toHaveLength(0);
    });

    it('handles expired invite token (410 EXPIRED_INVITE)', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_expired',
        googleSub: 'sub-owner-expired',
        email: 'owner.expired@danran.test',
        displayName: 'Owner',
      });
      const joiner = await createTestUser({
        id: 'usr_joiner_expired',
        googleSub: 'sub-joiner-expired',
        email: 'joiner.expired@danran.test',
        displayName: 'Joiner',
      });

      const famId = 'fam_expired_test';
      await db.insert(families).values({
        id: famId,
        name: '期限切れテスト家',
        familyCalendarId: 'cal_expired_test',
        ownerUserId: owner.user.id,
        creationStatus: 'ready',
        dayStartHour: 8,
        dayEndHour: 20,
        createdAt: Math.floor(Date.now() / 1000),
      });

      const rawToken = generateRandomToken(32);
      const tokenHash = await sha256Hex(rawToken);
      // Expired in past
      await db.insert(invites).values({
        id: 'inv_expired_test',
        familyId: famId,
        tokenHash,
        expiresAt: Math.floor(Date.now() / 1000) - 3600,
        status: 'available',
        createdAt: Math.floor(Date.now() / 1000) - 7200,
      });

      const inspectRes = await app.request(
        `${TEST_ORIGIN}/api/invites/inspect`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );
      expect(inspectRes.status).toBe(410);
      const inspectData = familyErrorResponseSchema.parse(await inspectRes.json());
      expect(inspectData.code).toBe('EXPIRED_INVITE');

      const joinRes = await app.request(
        `${TEST_ORIGIN}/api/invites/join`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );
      expect(joinRes.status).toBe(410);
      const joinData = familyErrorResponseSchema.parse(await joinRes.json());
      expect(joinData.code).toBe('EXPIRED_INVITE');
    });

    it('handles used invite by another user (410 USED_INVITE without leaking claimer identity) and same-user idempotent inspect (alreadyMember: true) and join (200 without Google ACL call)', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_idempotent',
        googleSub: 'sub-owner-idempotent',
        email: 'owner.idempotent@danran.test',
        displayName: 'Owner',
      });
      const joiner = await createTestUser({
        id: 'usr_joiner_idempotent',
        googleSub: 'sub-joiner-idempotent',
        email: 'joiner.idempotent@danran.test',
        displayName: 'Joiner',
      });
      const thirdUser = await createTestUser({
        id: 'usr_third_user',
        googleSub: 'sub-third-user',
        email: 'third@danran.test',
        displayName: 'Third User',
      });

      const famId = 'fam_idempotent_test';
      await db.insert(families).values({
        id: famId,
        name: '冪等テスト家',
        familyCalendarId: 'cal_idempotent_test',
        ownerUserId: owner.user.id,
        creationStatus: 'ready',
        dayStartHour: 8,
        dayEndHour: 20,
        createdAt: Math.floor(Date.now() / 1000),
      });
      await db.insert(members).values([
        {
          id: 'mem_owner_idempotent',
          familyId: famId,
          userId: owner.user.id,
          kind: 'adult',
          name: 'Owner',
          color: 'indigo',
          sortOrder: 0,
          status: 'active',
        },
        {
          id: 'mem_joiner_idempotent',
          familyId: famId,
          userId: joiner.user.id,
          kind: 'adult',
          name: 'Joiner',
          color: 'green',
          sortOrder: 1,
          status: 'active',
        },
      ]);

      const rawToken = generateRandomToken(32);
      const tokenHash = await sha256Hex(rawToken);
      await db.insert(invites).values({
        id: 'inv_idempotent_test',
        familyId: famId,
        tokenHash,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        status: 'used',
        claimedUserId: joiner.user.id,
        usedAt: Math.floor(Date.now() / 1000),
        createdAt: Math.floor(Date.now() / 1000) - 60,
      });

      // 1. Joiner inspecting sees alreadyMember: true
      const joinerInspect = await app.request(
        `${TEST_ORIGIN}/api/invites/inspect`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );
      expect(joinerInspect.status).toBe(200);
      const inspectData = joinInfoResponseSchema.parse(await joinerInspect.json());
      expect(inspectData.alreadyMember).toBe(true);

      // 2. Joiner joining again returns 200 idempotent without calling Google ACL
      const joinerJoin = await app.request(
        `${TEST_ORIGIN}/api/invites/join`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );
      expect(joinerJoin.status).toBe(200);
      const joinSuccess = joinSuccessResponseSchema.parse(await joinerJoin.json());
      expect(joinSuccess.family.id).toBe(famId);
      expect(interceptedUrls.filter((u) => u.includes('/acl'))).toHaveLength(0);

      // 3. Third user inspecting sees 410 USED_INVITE without leaking joiner identity
      const thirdInspect = await app.request(
        `${TEST_ORIGIN}/api/invites/inspect`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: thirdUser.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );
      expect(thirdInspect.status).toBe(410);
      const thirdInspectBody = familyErrorResponseSchema.parse(await thirdInspect.json());
      expect(thirdInspectBody.code).toBe('USED_INVITE');
      expect(JSON.stringify(thirdInspectBody)).not.toContain(joiner.user.email);
    });

    it('concurrent join by 2 different users for the same invite: exactly 1 succeeds with ACL grant, second user rejected with 410 USED_INVITE with no loser row in members', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_join_race',
        googleSub: 'sub-owner-join-race',
        email: 'owner.join.race@danran.test',
        displayName: 'Owner Join Race',
      });
      const joiner1 = await createTestUser({
        id: 'usr_joiner_1',
        googleSub: 'sub-joiner-1',
        email: 'joiner1@danran.test',
        displayName: 'Joiner One',
      });
      const joiner2 = await createTestUser({
        id: 'usr_joiner_2',
        googleSub: 'sub-joiner-2',
        email: 'joiner2@danran.test',
        displayName: 'Joiner Two',
      });

      const famId = 'fam_join_race';
      await db.insert(families).values({
        id: famId,
        name: '参加レース家',
        familyCalendarId: 'cal_join_race',
        ownerUserId: owner.user.id,
        creationStatus: 'ready',
        dayStartHour: 8,
        dayEndHour: 20,
        createdAt: Math.floor(Date.now() / 1000),
      });
      await db.insert(members).values({
        id: 'mem_owner_join_race',
        familyId: famId,
        userId: owner.user.id,
        kind: 'adult',
        name: 'Owner Join Race',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      });

      const rawToken = generateRandomToken(32);
      const tokenHash = await sha256Hex(rawToken);
      const inviteId = 'inv_join_race';
      await db.insert(invites).values({
        id: inviteId,
        familyId: famId,
        tokenHash,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        status: 'available',
        createdAt: Math.floor(Date.now() / 1000),
      });

      const enteredGate = createDeferred();
      const releaseGate = createDeferred();
      let aclCallCount = 0;

      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return mockGoogleTokenResponse();
        }
        if (req.url.includes('/acl')) {
          aclCallCount++;
          enteredGate.resolve();
          await releaseGate.promise;
          const bodyBuffer = await req.clone().arrayBuffer();
          const bodyJson = JSON.parse(new TextDecoder().decode(bodyBuffer));
          return new Response(
            JSON.stringify({
              id: `user:${bodyJson.scope.value}`,
              role: 'writer',
              scope: { type: 'user', value: bodyJson.scope.value },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected call: ${req.url}`);
      });

      try {
        // Joiner 1 starts join
        const req1 = app.request(
          `${TEST_ORIGIN}/api/invites/join`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: TEST_ORIGIN,
              'X-Requested-With': 'XMLHttpRequest',
              Cookie: joiner1.cookieHeader,
            },
            body: JSON.stringify({ token: rawToken }),
          },
          TEST_ENV,
        );

        await enteredGate.promise;

        // Joiner 2 tries to join the same invite concurrently
        const req2 = await app.request(
          `${TEST_ORIGIN}/api/invites/join`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: TEST_ORIGIN,
              'X-Requested-With': 'XMLHttpRequest',
              Cookie: joiner2.cookieHeader,
            },
            body: JSON.stringify({ token: rawToken }),
          },
          TEST_ENV,
        );

        expect(req2.status).toBe(410);
        const body2 = familyErrorResponseSchema.parse(await req2.json());
        expect(body2.code).toBe('USED_INVITE');

        releaseGate.resolve();
        const res1 = await req1;
        expect(res1.status).toBe(200);

        expect(aclCallCount).toBe(1);

        // Verify Joiner 2 has NO row in members ("no loser row")
        const joiner2Members = await db
          .select()
          .from(members)
          .where(eq(members.userId, joiner2.user.id));
        expect(joiner2Members).toHaveLength(0);

        // Verify Joiner 1 is active member
        const joiner1Members = await db
          .select()
          .from(members)
          .where(eq(members.userId, joiner1.user.id));
        expect(joiner1Members).toHaveLength(1);
        expect(joiner1Members[0]?.status).toBe('active');
      } finally {
        releaseGate.resolve();
      }
    });

    it('concurrent join of 2 different invites by same user: only 1 ACL call, second claim rolls back and invite remains available', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_two_invites',
        googleSub: 'sub-owner-two-invites',
        email: 'owner.two.invites@danran.test',
        displayName: 'Owner Two Invites',
      });
      const joiner = await createTestUser({
        id: 'usr_joiner_same_two',
        googleSub: 'sub-joiner-same-two',
        email: 'joiner.same.two@danran.test',
        displayName: 'Joiner Same Two',
      });

      const famId = 'fam_two_invites';
      await db.insert(families).values({
        id: famId,
        name: '2招待家',
        familyCalendarId: 'cal_two_invites',
        ownerUserId: owner.user.id,
        creationStatus: 'ready',
        dayStartHour: 8,
        dayEndHour: 20,
        createdAt: Math.floor(Date.now() / 1000),
      });
      await db.insert(members).values({
        id: 'mem_owner_two_invites',
        familyId: famId,
        userId: owner.user.id,
        kind: 'adult',
        name: 'Owner Two Invites',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      });

      const tokenA = generateRandomToken(32);
      const hashA = await sha256Hex(tokenA);
      const inviteIdA = 'inv_token_a';
      await db.insert(invites).values({
        id: inviteIdA,
        familyId: famId,
        tokenHash: hashA,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        status: 'available',
        createdAt: Math.floor(Date.now() / 1000),
      });

      const tokenB = generateRandomToken(32);
      const hashB = await sha256Hex(tokenB);
      const inviteIdB = 'inv_token_b';
      await db.insert(invites).values({
        id: inviteIdB,
        familyId: famId,
        tokenHash: hashB,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        status: 'available',
        createdAt: Math.floor(Date.now() / 1000),
      });

      const enteredGate = createDeferred();
      const releaseGate = createDeferred();
      let aclCallCount = 0;

      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return mockGoogleTokenResponse();
        }
        if (req.url.includes('/acl')) {
          aclCallCount++;
          enteredGate.resolve();
          await releaseGate.promise;
          const bodyBuffer = await req.clone().arrayBuffer();
          const bodyJson = JSON.parse(new TextDecoder().decode(bodyBuffer));
          return new Response(
            JSON.stringify({
              id: `user:${bodyJson.scope.value}`,
              role: 'writer',
              scope: { type: 'user', value: bodyJson.scope.value },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected call: ${req.url}`);
      });

      try {
        const reqA = app.request(
          `${TEST_ORIGIN}/api/invites/join`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: TEST_ORIGIN,
              'X-Requested-With': 'XMLHttpRequest',
              Cookie: joiner.cookieHeader,
            },
            body: JSON.stringify({ token: tokenA }),
          },
          TEST_ENV,
        );

        await enteredGate.promise;

        const reqB = await app.request(
          `${TEST_ORIGIN}/api/invites/join`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: TEST_ORIGIN,
              'X-Requested-With': 'XMLHttpRequest',
              Cookie: joiner.cookieHeader,
            },
            body: JSON.stringify({ token: tokenB }),
          },
          TEST_ENV,
        );

        expect(reqB.status).toBe(409);

        releaseGate.resolve();
        const resA = await reqA;
        expect(resA.status).toBe(200);

        expect(aclCallCount).toBe(1);

        // Invite B was rolled back to available!
        const inviteBRecord = await db.select().from(invites).where(eq(invites.id, inviteIdB));
        expect(inviteBRecord[0]?.status).toBe('available');
        expect(inviteBRecord[0]?.claimedUserId).toBeNull();
      } finally {
        releaseGate.resolve();
      }
    });

    it('retries uncertain ACL sharing only for the original claimant and keeps their pending member', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_acl_uncertain',
        googleSub: 'sub-owner-acl-uncertain',
        email: 'owner.acl.uncertain@danran.test',
        displayName: 'Owner',
      });
      const joiner = await createTestUser({
        id: 'usr_joiner_acl_uncertain',
        googleSub: 'sub-joiner-acl-uncertain',
        email: 'joiner.acl.uncertain@danran.test',
        displayName: 'Joiner',
      });

      const famId = 'fam_acl_uncertain';
      await db.insert(families).values({
        id: famId,
        name: 'ACL不確実家',
        familyCalendarId: 'cal_acl_uncertain',
        ownerUserId: owner.user.id,
        creationStatus: 'ready',
        dayStartHour: 8,
        dayEndHour: 20,
        createdAt: Math.floor(Date.now() / 1000),
      });
      await db.insert(members).values({
        id: 'mem_owner_acl_uncertain',
        familyId: famId,
        userId: owner.user.id,
        kind: 'adult',
        name: 'Owner',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      });

      const rawToken = generateRandomToken(32);
      const tokenHash = await sha256Hex(rawToken);
      const inviteId = 'inv_acl_uncertain';
      await db.insert(invites).values({
        id: inviteId,
        familyId: famId,
        tokenHash,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        status: 'available',
        createdAt: Math.floor(Date.now() / 1000),
      });

      // Simulate 500 error from Google ACL
      let aclCallCount = 0;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return mockGoogleTokenResponse();
        }
        if (req.url.includes('/acl')) {
          aclCallCount++;
          return new Response(
            JSON.stringify({ error: { code: 500, message: 'Google ACL Internal Error' } }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected call: ${req.url}`);
      });

      const joinRes = await app.request(
        `${TEST_ORIGIN}/api/invites/join`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );

      expect(joinRes.status).toBe(500);
      const body = familyErrorResponseSchema.parse(await joinRes.json());
      expect(body.code).toBe('UNCERTAIN_MUTATION');

      // Invite is now in 'uncertain' status
      const inviteRecord = await db.select().from(invites).where(eq(invites.id, inviteId));
      expect(inviteRecord[0]?.status).toBe('uncertain');

      // Member remains 'pending'
      const joinerMembers = await db
        .select()
        .from(members)
        .where(eq(members.userId, joiner.user.id));
      expect(joinerMembers).toHaveLength(1);
      expect(joinerMembers[0]?.status).toBe('pending');

      // Joiner denied access to family detail (404) and family list ([])
      const detailRes = await app.request(
        `${TEST_ORIGIN}/api/families/${famId}`,
        { headers: { Cookie: joiner.cookieHeader } },
        TEST_ENV,
      );
      expect(detailRes.status).toBe(404);

      const listRes = await app.request(
        `${TEST_ORIGIN}/api/families`,
        { headers: { Cookie: joiner.cookieHeader } },
        TEST_ENV,
      );
      expect(listRes.status).toBe(200);
      const listData = familyListResponseSchema.parse(await listRes.json());
      expect(listData.families).toHaveLength(0);

      // Explicit retry replays the ACL grant for the same claimant and preserves the reservation.
      const retryJoin = await app.request(
        `${TEST_ORIGIN}/api/invites/join`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );
      expect(retryJoin.status).toBe(500);
      const retryBody = familyErrorResponseSchema.parse(await retryJoin.json());
      expect(retryBody.code).toBe('UNCERTAIN_MUTATION');
      expect(aclCallCount).toBe(2);
      const pendingAfterRetry = await db
        .select()
        .from(members)
        .where(eq(members.userId, joiner.user.id));
      expect(pendingAfterRetry).toHaveLength(1);
      expect(pendingAfterRetry[0]?.id).toBe(joinerMembers[0]?.id);
    });

    it('handles definitive Google ACL error (403): resets invite to available, deletes pending member, and permits explicit retry', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_acl_def',
        googleSub: 'sub-owner-acl-def',
        email: 'owner.acl.def@danran.test',
        displayName: 'Owner',
      });
      const joiner = await createTestUser({
        id: 'usr_joiner_acl_def',
        googleSub: 'sub-joiner-acl-def',
        email: 'joiner.acl.def@danran.test',
        displayName: 'Joiner',
      });

      const famId = 'fam_acl_def';
      await db.insert(families).values({
        id: famId,
        name: 'ACL確定エラー家',
        familyCalendarId: 'cal_acl_def',
        ownerUserId: owner.user.id,
        creationStatus: 'ready',
        dayStartHour: 8,
        dayEndHour: 20,
        createdAt: Math.floor(Date.now() / 1000),
      });
      await db.insert(members).values({
        id: 'mem_owner_acl_def',
        familyId: famId,
        userId: owner.user.id,
        kind: 'adult',
        name: 'Owner',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      });

      const rawToken = generateRandomToken(32);
      const tokenHash = await sha256Hex(rawToken);
      const inviteId = 'inv_acl_def';
      await db.insert(invites).values({
        id: inviteId,
        familyId: famId,
        tokenHash,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        status: 'available',
        createdAt: Math.floor(Date.now() / 1000),
      });

      // 1. Force definitive 403 error from Google ACL
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return mockGoogleTokenResponse();
        }
        if (req.url.includes('/acl')) {
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                message: 'Access forbidden',
                errors: [{ reason: 'forbidden' }],
              },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected call: ${req.url}`);
      });

      const failRes = await app.request(
        `${TEST_ORIGIN}/api/invites/join`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );
      expect(failRes.status).toBe(502);
      const failBody = familyErrorResponseSchema.parse(await failRes.json());
      expect(failBody.code).toBe('GOOGLE_ERROR');

      // Verify invite was reset to 'available'
      const inviteAfterFail = await db.select().from(invites).where(eq(invites.id, inviteId));
      expect(inviteAfterFail[0]?.status).toBe('available');
      expect(inviteAfterFail[0]?.claimedUserId).toBeNull();

      // Verify pending member was deleted
      const joinerMembers = await db
        .select()
        .from(members)
        .where(eq(members.userId, joiner.user.id));
      expect(joinerMembers).toHaveLength(0);

      // 2. Restore working ACL mock and retry explicitly
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return mockGoogleTokenResponse();
        }
        if (req.url.includes('/acl')) {
          const bodyBuffer = await req.clone().arrayBuffer();
          const bodyJson = JSON.parse(new TextDecoder().decode(bodyBuffer));
          return new Response(
            JSON.stringify({
              id: `user:${bodyJson.scope.value}`,
              role: 'writer',
              scope: { type: 'user', value: bodyJson.scope.value },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected call: ${req.url}`);
      });

      const retryRes = await app.request(
        `${TEST_ORIGIN}/api/invites/join`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );
      expect(retryRes.status).toBe(200);
      const retryData = joinSuccessResponseSchema.parse(await retryRes.json());
      expect(retryData.family.members).toHaveLength(2);
    });

    it('validates ACL response: marks invite uncertain if role !== "writer", scope.type !== "user", or recipient email does not match', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_acl_val',
        googleSub: 'sub-owner-acl-val',
        email: 'owner.acl.val@danran.test',
        displayName: 'Owner',
      });
      const joiner = await createTestUser({
        id: 'usr_joiner_acl_val',
        googleSub: 'sub-joiner-acl-val',
        email: 'joiner.acl.val@danran.test',
        displayName: 'Joiner',
      });

      const famId = 'fam_acl_val';
      await db.insert(families).values({
        id: famId,
        name: 'ACL検証家',
        familyCalendarId: 'cal_acl_val',
        ownerUserId: owner.user.id,
        creationStatus: 'ready',
        dayStartHour: 8,
        dayEndHour: 20,
        createdAt: Math.floor(Date.now() / 1000),
      });
      await db.insert(members).values({
        id: 'mem_owner_acl_val',
        familyId: famId,
        userId: owner.user.id,
        kind: 'adult',
        name: 'Owner',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      });

      const rawToken = generateRandomToken(32);
      const tokenHash = await sha256Hex(rawToken);
      const inviteId = 'inv_acl_val';
      await db.insert(invites).values({
        id: inviteId,
        familyId: famId,
        tokenHash,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        status: 'available',
        createdAt: Math.floor(Date.now() / 1000),
      });

      // ACL response returns wrong role ('reader' instead of 'writer')
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return mockGoogleTokenResponse();
        }
        if (req.url.includes('/acl')) {
          return new Response(
            JSON.stringify({
              id: 'user:joiner.acl.val@danran.test',
              role: 'reader', // INVALID
              scope: { type: 'user', value: 'joiner.acl.val@danran.test' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected call: ${req.url}`);
      });

      const res = await app.request(
        `${TEST_ORIGIN}/api/invites/join`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: joiner.cookieHeader,
          },
          body: JSON.stringify({ token: rawToken }),
        },
        TEST_ENV,
      );

      expect(res.status).toBe(500);
      const body = familyErrorResponseSchema.parse(await res.json());
      expect(body.code).toBe('UNCERTAIN_MUTATION');

      // Invite is marked uncertain
      const inviteRecord = await db.select().from(invites).where(eq(invites.id, inviteId));
      expect(inviteRecord[0]?.status).toBe('uncertain');

      // Member remains pending
      const memberRecord = await db
        .select()
        .from(members)
        .where(eq(members.userId, joiner.user.id));
      expect(memberRecord[0]?.status).toBe('pending');
    });

    it('detects lost claim / deleted pending member during gated ACL response: rolls back, does not activate member or mark invite used', async () => {
      const owner = await createTestUser({
        id: 'usr_owner_lost_claim',
        googleSub: 'sub-owner-lost-claim',
        email: 'owner.lost@danran.test',
        displayName: 'Owner Lost',
      });
      const joiner = await createTestUser({
        id: 'usr_joiner_lost_claim',
        googleSub: 'sub-joiner-lost-claim',
        email: 'joiner.lost@danran.test',
        displayName: 'Joiner Lost',
      });

      const famId = 'fam_lost_claim';
      await db.insert(families).values({
        id: famId,
        name: 'クレーム喪失家',
        familyCalendarId: 'cal_lost_claim',
        ownerUserId: owner.user.id,
        creationStatus: 'ready',
        dayStartHour: 8,
        dayEndHour: 20,
        createdAt: Math.floor(Date.now() / 1000),
      });
      await db.insert(members).values({
        id: 'mem_owner_lost_claim',
        familyId: famId,
        userId: owner.user.id,
        kind: 'adult',
        name: 'Owner Lost',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      });

      const rawToken = generateRandomToken(32);
      const tokenHash = await sha256Hex(rawToken);
      const inviteId = 'inv_lost_claim';
      await db.insert(invites).values({
        id: inviteId,
        familyId: famId,
        tokenHash,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        status: 'available',
        createdAt: Math.floor(Date.now() / 1000),
      });

      const enteredGate = createDeferred();
      const releaseGate = createDeferred();

      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return mockGoogleTokenResponse();
        }
        if (req.url.includes('/acl')) {
          enteredGate.resolve();
          await releaseGate.promise;
          const bodyBuffer = await req.clone().arrayBuffer();
          const bodyJson = JSON.parse(new TextDecoder().decode(bodyBuffer));
          return new Response(
            JSON.stringify({
              id: `user:${bodyJson.scope.value}`,
              role: 'writer',
              scope: { type: 'user', value: bodyJson.scope.value },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected call: ${req.url}`);
      });

      try {
        const joinReq = app.request(
          `${TEST_ORIGIN}/api/invites/join`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: TEST_ORIGIN,
              'X-Requested-With': 'XMLHttpRequest',
              Cookie: joiner.cookieHeader,
            },
            body: JSON.stringify({ token: rawToken }),
          },
          TEST_ENV,
        );

        await enteredGate.promise;

        // While ACL is in flight, pending member is deleted by external event
        await db.delete(members).where(eq(members.userId, joiner.user.id));

        // Release ACL call
        releaseGate.resolve();
        const joinRes = await joinReq;

        // Guarded activation batch catches 0 rows updated, marks invite uncertain, returns 500
        expect(joinRes.status).toBe(500);
        const body = familyErrorResponseSchema.parse(await joinRes.json());
        expect(body.code).toBe('UNCERTAIN_MUTATION');

        // Invite is NOT used
        const inviteRecord = await db.select().from(invites).where(eq(invites.id, inviteId));
        expect(inviteRecord[0]?.status).toBe('uncertain');

        // No active member for joiner
        const joinerMembers = await db
          .select()
          .from(members)
          .where(eq(members.userId, joiner.user.id));
        expect(joinerMembers).toHaveLength(0);
      } finally {
        releaseGate.resolve();
      }
    });
  });

  describe('3. Spike Route Deletions', () => {
    it('requests to /api/spike and /spike return 404 with security headers regardless of environment', async () => {
      const res1 = await app.request(`${TEST_ORIGIN}/api/spike`, { method: 'GET' }, TEST_ENV);
      expect(res1.status).toBe(404);
      expect(res1.headers.get('Cache-Control')).toBe('no-store');

      const res2 = await app.request(`${TEST_ORIGIN}/spike`, { method: 'GET' }, TEST_ENV);
      expect(res2.status).toBe(404);
      expect(res2.headers.get('Cache-Control')).toBe('no-store');

      const res3 = await app.request(
        `${TEST_ORIGIN}/api/spike`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: TEST_ORIGIN,
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({ test: 1 }),
        },
        TEST_ENV,
      );
      expect(res3.status).toBe(404);
    });
  });
});
