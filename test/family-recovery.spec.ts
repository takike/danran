import { env } from 'cloudflare:test';
import { buildFamilyCalendarDescription, matchFamilyCalendar } from '@shared/domain/familyCalendar';
import {
  createFamilyResponseSchema,
  familyErrorResponseSchema,
  joinInfoResponseSchema,
  joinSuccessResponseSchema,
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
  sessions,
  users,
} from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { app } from '@worker/index';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { setSignedCookie } from 'hono/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'http://localhost:5173';
const AES_KEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';
const SESSION_SECRET = 'test-session-secret-at-least-32-chars-long-secure-entropy';
const TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret-12345',
  SESSION_SECRET,
  TOKEN_ENC_KEY: AES_KEY,
};
const db = createDb(env.DB);

async function cookieFor(token: string): Promise<string> {
  const helper = new Hono();
  helper.get('/', async (c) => {
    await setSignedCookie(c, SESSION_COOKIE_NAME, token, SESSION_SECRET, {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 3600,
    });
    return c.text('ok');
  });
  const response = await helper.request('http://localhost/');
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Session cookie was not created');
  return cookie;
}

async function addUser(id: string, email: string, scopes = [...PHASE1_SCOPES, FAMILY_ACL_SCOPE]) {
  await db.insert(users).values({ id, googleSub: `sub-${id}`, email, displayName: id });
  const refreshTokenEnc = await encryptAesGcm(`refresh-${id}`, AES_KEY, `google-refresh:${id}`);
  await db.insert(googleTokens).values({ userId: id, refreshTokenEnc, scopes: scopes.join(' ') });
  const { rawToken } = await createSession(db, id);
  return { id, email, cookie: await cookieFor(rawToken) };
}

function postHeaders(cookie: string) {
  return {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    'X-Requested-With': 'XMLHttpRequest',
    Cookie: cookie,
  };
}

function calendarListUrl(req: Request): URL {
  return new URL(req.url);
}

async function seedUncertainInvite(input: {
  suffix: string;
  owner: { id: string };
  joiner: { id: string };
  expiresAt?: number;
}) {
  const familyId = `fam_uncertain_${input.suffix}`;
  const inviteId = `invite_uncertain_${input.suffix}`;
  const pendingId = `mem_pending_${input.suffix}`;
  const now = Math.floor(Date.now() / 1000);
  const rawToken = generateRandomToken(32);
  await db.insert(families).values({
    id: familyId,
    name: '招待復旧家',
    familyCalendarId: `calendar-${input.suffix}`,
    ownerUserId: input.owner.id,
    creationStatus: 'ready',
    calendarCreationId: `creation-${input.suffix}`,
  });
  await db.insert(members).values([
    {
      id: `mem_owner_${input.suffix}`,
      familyId,
      userId: input.owner.id,
      kind: 'adult',
      name: 'オーナー',
      color: 'indigo',
      sortOrder: 0,
      status: 'active',
    },
    {
      id: pendingId,
      familyId,
      userId: input.joiner.id,
      kind: 'adult',
      name: '招待された大人',
      color: 'coral',
      sortOrder: 3,
      status: 'pending',
    },
  ]);
  await db.insert(invites).values({
    id: inviteId,
    familyId,
    tokenHash: await sha256Hex(rawToken),
    expiresAt: input.expiresAt ?? now + 3600,
    claimedUserId: input.joiner.id,
    status: 'uncertain',
    createdAt: now - 100,
  });
  return { familyId, inviteId, pendingId, rawToken };
}

describe('family creation and invite recovery', () => {
  beforeEach(async () => {
    await db.delete(invites);
    await db.delete(closureDays);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      throw new Error(`Unexpected synthetic network request: ${req.url}`);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await db.delete(invites);
    await db.delete(closureDays);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);
  });

  it('reconciles only a unique exact calendar found on a later hidden page', async () => {
    const owner = await addUser('reconcile_owner', 'owner@example.test');
    const familyId = 'fam_reconcile_later';
    const creationId = 'creation-marker-123';
    await db.insert(families).values({
      id: familyId,
      name: '池町家',
      ownerUserId: owner.id,
      familyCalendarId: null,
      creationStatus: 'uncertain',
      calendarCreationId: creationId,
    });
    await db.insert(members).values({
      id: 'mem_reconcile_owner',
      familyId,
      userId: owner.id,
      kind: 'adult',
      name: owner.id,
      color: 'indigo',
      sortOrder: 0,
      status: 'active',
    });

    const calls: URL[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      const url = calendarListUrl(req);
      calls.push(url);
      if (!url.pathname.endsWith('/users/me/calendarList'))
        throw new Error(`Unexpected request: ${req.url}`);
      if (url.searchParams.get('pageToken') === 'second') {
        return Response.json({
          items: [
            {
              id: 'calendar-match',
              summary: 'Danran（池町家）',
              description: `danran-family:${familyId};creation:${creationId}`,
              accessRole: 'owner',
              primary: false,
              deleted: false,
              hidden: true,
              dataOwner: 'OWNER@example.test',
            },
          ],
        });
      }
      return Response.json({
        items: [{ id: 'unrelated', summary: 'Private', accessRole: 'owner' }],
        nextPageToken: 'second',
      });
    });

    const response = await app.request(
      `${ORIGIN}/api/families/${familyId}/reconcile`,
      {
        method: 'POST',
        headers: postHeaders(owner.cookie),
        body: '{}',
      },
      TEST_ENV,
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      family: { familyCalendarId: string; creationStatus: string };
    };
    expect(data.family).toMatchObject({
      familyCalendarId: 'calendar-match',
      creationStatus: 'ready',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.searchParams.get('maxResults')).toBe('250');
    expect(calls[0]?.searchParams.get('showHidden')).toBe('true');
    expect(calls[0]?.searchParams.get('showDeleted')).toBe('false');
    expect(calls[0]?.searchParams.has('minAccessRole')).toBe(false);
  });

  it('rejects reconcile requests without authorization, CSRF headers, or a strict empty body before calling Google', async () => {
    const owner = await addUser('reconcile_guard_owner', 'guard-owner@example.test');
    const member = await addUser('reconcile_guard_member', 'guard-member@example.test');
    const familyId = 'fam_reconcile_guards';
    await db.insert(families).values({
      id: familyId,
      name: '認可家',
      ownerUserId: owner.id,
      creationStatus: 'uncertain',
      calendarCreationId: 'guard-marker',
    });
    await db.insert(members).values([
      {
        id: 'mem_guard_owner',
        familyId,
        userId: owner.id,
        kind: 'adult',
        name: owner.id,
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      },
      {
        id: 'mem_guard_member',
        familyId,
        userId: member.id,
        kind: 'adult',
        name: member.id,
        color: 'green',
        sortOrder: 1,
        status: 'active',
      },
    ]);
    let googleCalls = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      googleCalls++;
      throw new Error(`Unexpected Google request: ${req.url}`);
    });

    const path = `${ORIGIN}/api/families/${familyId}/reconcile`;
    const unauthenticated = await app.request(
      path,
      {
        method: 'POST',
        headers: { Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' },
        body: '{}',
      },
      TEST_ENV,
    );
    const noOrigin = await app.request(
      path,
      {
        method: 'POST',
        headers: { Cookie: owner.cookie, 'X-Requested-With': 'XMLHttpRequest' },
        body: '{}',
      },
      TEST_ENV,
    );
    const noRequestedWith = await app.request(
      path,
      {
        method: 'POST',
        headers: { Cookie: owner.cookie, Origin: ORIGIN },
        body: '{}',
      },
      TEST_ENV,
    );
    const memberResponse = await app.request(
      path,
      {
        method: 'POST',
        headers: postHeaders(member.cookie),
        body: '{}',
      },
      TEST_ENV,
    );
    const invalidBody = await app.request(
      path,
      {
        method: 'POST',
        headers: postHeaders(owner.cookie),
        body: '{"unexpected":true}',
      },
      TEST_ENV,
    );

    expect(unauthenticated.status).toBe(401);
    expect(noOrigin.status).toBe(403);
    expect(noRequestedWith.status).toBe(403);
    expect(memberResponse.status).toBe(403);
    expect(invalidBody.status).toBe(400);
    expect(googleCalls).toBe(0);
    expect(
      (await db.select().from(families).where(eq(families.id, familyId)))[0]?.creationStatus,
    ).toBe('uncertain');
  });

  it.each([
    {
      label: 'two distinct exact matches',
      secondId: 'calendar-match-two',
      second: undefined,
      expectedStatus: 500,
    },
    {
      label: 'contradictory metadata for a repeated calendar ID',
      secondId: 'calendar-match-one',
      second: { primary: true },
      expectedStatus: 500,
    },
    {
      label: 'an identical repeated calendar ID',
      secondId: 'calendar-match-one',
      second: {},
      expectedStatus: 200,
    },
  ])('handles $label without guessing', async ({ secondId, second, expectedStatus }) => {
    const owner = await addUser(
      `duplicate_owner_${expectedStatus}_${secondId}`,
      `duplicate-${expectedStatus}-${secondId}@example.test`,
    );
    const familyId = `fam_duplicate_${expectedStatus}_${secondId}`;
    const creationId = 'duplicate-marker';
    await db.insert(families).values({
      id: familyId,
      name: '重複家',
      ownerUserId: owner.id,
      creationStatus: 'uncertain',
      calendarCreationId: creationId,
    });
    await db.insert(members).values({
      id: `mem_duplicate_${expectedStatus}_${secondId}`,
      familyId,
      userId: owner.id,
      kind: 'adult',
      name: owner.id,
      color: 'indigo',
      sortOrder: 0,
      status: 'active',
    });
    const exactEntry = {
      id: 'calendar-match-one',
      summary: 'Danran（重複家）',
      description: `danran-family:${familyId};creation:${creationId}`,
      accessRole: 'owner',
    };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      if (req.url.includes('/calendarList')) {
        if (new URL(req.url).searchParams.get('pageToken') === 'second') {
          return Response.json({ items: [{ ...exactEntry, id: secondId, ...second }] });
        }
        return Response.json({ items: [exactEntry], nextPageToken: 'second' });
      }
      throw new Error(`Unexpected request: ${req.url}`);
    });

    const response = await app.request(
      `${ORIGIN}/api/families/${familyId}/reconcile`,
      {
        method: 'POST',
        headers: postHeaders(owner.cookie),
        body: '{}',
      },
      TEST_ENV,
    );
    expect(response.status).toBe(expectedStatus);
    const family = (await db.select().from(families).where(eq(families.id, familyId)))[0];
    if (expectedStatus === 200) {
      expect(family).toMatchObject({
        creationStatus: 'ready',
        familyCalendarId: 'calendar-match-one',
      });
    } else {
      expect(family?.creationStatus).toBe('uncertain');
      expect(family?.familyCalendarId).toBeNull();
    }
  });

  it('keeps uncertainty after an incomplete calendar listing', async () => {
    const owner = await addUser('reconcile_partial_owner', 'partial@example.test');
    const familyId = 'fam_reconcile_partial';
    await db.insert(families).values({
      id: familyId,
      name: '未完了家',
      ownerUserId: owner.id,
      creationStatus: 'uncertain',
      calendarCreationId: 'creation-partial-1',
    });
    await db.insert(members).values({
      id: 'mem_reconcile_partial',
      familyId,
      userId: owner.id,
      kind: 'adult',
      name: owner.id,
      color: 'indigo',
      sortOrder: 0,
      status: 'active',
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      if (req.url.includes('/calendarList')) {
        if (new URL(req.url).searchParams.get('pageToken') === 'second') {
          return Response.json(
            { error: { code: 400, message: 'Synthetic page failure' } },
            { status: 400 },
          );
        }
        return Response.json({
          items: [
            {
              id: 'partial-exact-match',
              summary: 'Danran（未完了家）',
              description: `danran-family:${familyId};creation:creation-partial-1`,
              accessRole: 'owner',
            },
          ],
          nextPageToken: 'second',
        });
      }
      throw new Error(`Unexpected request: ${req.url}`);
    });
    const response = await app.request(
      `${ORIGIN}/api/families/${familyId}/reconcile`,
      {
        method: 'POST',
        headers: postHeaders(owner.cookie),
        body: '{}',
      },
      TEST_ENV,
    );
    expect(response.status).toBe(500);
    expect(familyErrorResponseSchema.parse(await response.json()).code).toBe('UNCERTAIN_MUTATION');
    expect(
      (await db.select().from(families).where(eq(families.id, familyId)))[0]?.creationStatus,
    ).toBe('uncertain');
  });

  it.each([
    { label: 'a repeated page token', nextPageToken: 'loop' },
    { label: 'an empty page token', nextPageToken: '' },
  ])('keeps uncertainty and bounds requests after $label', async ({ nextPageToken }) => {
    const owner = await addUser(`reconcile_loop_${nextPageToken || 'empty'}`, 'loop@example.test');
    const familyId = `fam_reconcile_loop_${nextPageToken || 'empty'}`;
    await db.insert(families).values({
      id: familyId,
      name: '循環家',
      ownerUserId: owner.id,
      creationStatus: 'uncertain',
      calendarCreationId: 'creation-loop',
    });
    await db.insert(members).values({
      id: `mem_${familyId}`,
      familyId,
      userId: owner.id,
      kind: 'adult',
      name: owner.id,
      color: 'indigo',
      sortOrder: 0,
      status: 'active',
    });
    let listCalls = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      if (req.url.includes('/calendarList')) {
        listCalls++;
        const token = new URL(req.url).searchParams.get('pageToken') ?? undefined;
        if (nextPageToken === 'loop' && token === 'loop') {
          return Response.json({ items: [], nextPageToken: 'loop' });
        }
        return Response.json({ items: [], nextPageToken });
      }
      throw new Error(`Unexpected request: ${req.url}`);
    });
    const response = await app.request(
      `${ORIGIN}/api/families/${familyId}/reconcile`,
      {
        method: 'POST',
        headers: postHeaders(owner.cookie),
        body: '{}',
      },
      TEST_ENV,
    );
    expect(response.status).toBe(500);
    expect(familyErrorResponseSchema.parse(await response.json()).code).toBe('UNCERTAIN_MUTATION');
    expect(listCalls).toBeLessThanOrEqual(3);
    expect(
      (await db.select().from(families).where(eq(families.id, familyId)))[0]?.creationStatus,
    ).toBe('uncertain');
  });

  it.each([
    {
      label: 'a unique match',
      items: [
        {
          id: 'old-match',
          summary: 'Danran（競合家）',
          description: '',
          accessRole: 'owner',
        },
      ],
    },
    { label: 'a complete zero-match scan', items: [] },
  ])(
    'does not reveal or overwrite a family made ready by a new owner during $label reconciliation',
    async ({ items }) => {
      const owner = await addUser(
        `race_owner_${items.length}`,
        `race-${items.length}@example.test`,
      );
      const nextOwner = await addUser(
        `race_next_${items.length}`,
        `next-${items.length}@example.test`,
      );
      const familyId = `fam_owner_race_${items.length}`;
      const creationId = 'owner-race-marker';
      const raceItems = items.map((item) => ({
        ...item,
        description: buildFamilyCalendarDescription(familyId, creationId),
      }));
      const uniqueMatch = raceItems[0];
      if (uniqueMatch) {
        expect(
          matchFamilyCalendar(uniqueMatch, {
            familyId,
            calendarCreationId: creationId,
            familyName: '競合家',
            ownerEmail: owner.email,
          }),
        ).toBe(true);
      }
      await db.insert(families).values({
        id: familyId,
        name: '競合家',
        ownerUserId: owner.id,
        creationStatus: 'uncertain',
        calendarCreationId: creationId,
      });
      await db.insert(members).values([
        {
          id: `mem_race_old_${items.length}`,
          familyId,
          userId: owner.id,
          kind: 'adult',
          name: '旧所有者専用名',
          color: 'indigo',
          sortOrder: 0,
          status: 'active',
        },
      ]);

      let releaseListing!: () => void;
      let announceListing!: () => void;
      const listingStarted = new Promise<void>((resolve) => {
        announceListing = resolve;
      });
      const listingGate = new Promise<void>((resolve) => {
        releaseListing = resolve;
      });
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token') {
          return Response.json({
            access_token: 'synthetic-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
          });
        }
        if (req.url.includes('/calendarList')) {
          announceListing();
          await listingGate;
          return Response.json({ items: raceItems });
        }
        throw new Error(`Unexpected request: ${req.url}`);
      });

      const responsePromise = app.request(
        `${ORIGIN}/api/families/${familyId}/reconcile`,
        {
          method: 'POST',
          headers: postHeaders(owner.cookie),
          body: '{}',
        },
        TEST_ENV,
      );
      await listingStarted;
      await db
        .update(families)
        .set({
          ownerUserId: nextOwner.id,
          creationStatus: 'ready',
          familyCalendarId: 'new-owner-calendar-secret',
          calendarCreationId: 'new-owner-attempt',
        })
        .where(eq(families.id, familyId));
      await db.insert(members).values({
        id: `mem_race_next_${items.length}`,
        familyId,
        userId: nextOwner.id,
        kind: 'adult',
        name: '新所有者専用名',
        color: 'green',
        sortOrder: 0,
        status: 'active',
      });
      releaseListing();

      const response = await responsePromise;
      const body = await response.text();
      expect(response.status).toBe(409);
      expect(body).not.toContain('new-owner-calendar-secret');
      expect(body).not.toContain('新所有者専用名');
      expect(body).not.toContain('旧所有者専用名');
      expect((await db.select().from(families).where(eq(families.id, familyId)))[0]).toMatchObject({
        ownerUserId: nextOwner.id,
        creationStatus: 'ready',
        familyCalendarId: 'new-owner-calendar-secret',
        calendarCreationId: 'new-owner-attempt',
      });
    },
  );

  it('returns unauthorized and preserves uncertainty if the session is deleted during Google listing', async () => {
    const owner = await addUser('session_race_owner', 'session-race@example.test');
    const familyId = 'fam_session_race';
    await db.insert(families).values({
      id: familyId,
      name: 'セッション家',
      ownerUserId: owner.id,
      creationStatus: 'uncertain',
      calendarCreationId: 'session-race-marker',
    });
    await db.insert(members).values({
      id: 'mem_session_race',
      familyId,
      userId: owner.id,
      kind: 'adult',
      name: owner.id,
      color: 'indigo',
      sortOrder: 0,
      status: 'active',
    });
    let releaseListing!: () => void;
    let announceListing!: () => void;
    const listingStarted = new Promise<void>((resolve) => {
      announceListing = resolve;
    });
    const listingGate = new Promise<void>((resolve) => {
      releaseListing = resolve;
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      if (req.url.includes('/calendarList')) {
        announceListing();
        await listingGate;
        return Response.json({ items: [] });
      }
      throw new Error(`Unexpected request: ${req.url}`);
    });

    const responsePromise = app.request(
      `${ORIGIN}/api/families/${familyId}/reconcile`,
      {
        method: 'POST',
        headers: postHeaders(owner.cookie),
        body: '{}',
      },
      TEST_ENV,
    );
    await listingStarted;
    await db.delete(sessions);
    releaseListing();
    const response = await responsePromise;
    expect(response.status).toBe(401);
    expect(
      (await db.select().from(families).where(eq(families.id, familyId)))[0]?.creationStatus,
    ).toBe('uncertain');
  });

  it('does not let an old reconciliation overwrite a later creation attempt after an uncertain-failed-uncertain ABA transition', async () => {
    const owner = await addUser('aba_reconcile_owner', 'aba-reconcile@example.test');
    const familyId = 'fam_aba_reconcile';
    const oldCreationId = 'aba-old-marker';
    await db.insert(families).values({
      id: familyId,
      name: 'ABA家',
      ownerUserId: owner.id,
      creationStatus: 'uncertain',
      calendarCreationId: oldCreationId,
    });
    await db.insert(members).values({
      id: 'mem_aba_reconcile',
      familyId,
      userId: owner.id,
      kind: 'adult',
      name: owner.id,
      color: 'indigo',
      sortOrder: 0,
      status: 'active',
    });
    let releaseListing!: () => void;
    let announceListing!: () => void;
    const listingStarted = new Promise<void>((resolve) => {
      announceListing = resolve;
    });
    const listingGate = new Promise<void>((resolve) => {
      releaseListing = resolve;
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      if (req.url.includes('/calendarList')) {
        announceListing();
        await listingGate;
        return Response.json({
          items: [
            {
              id: 'calendar-from-old-attempt',
              summary: 'Danran（ABA家）',
              description: `danran-family:${familyId};creation:${oldCreationId}`,
              accessRole: 'owner',
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${req.url}`);
    });

    const responsePromise = app.request(
      `${ORIGIN}/api/families/${familyId}/reconcile`,
      {
        method: 'POST',
        headers: postHeaders(owner.cookie),
        body: '{}',
      },
      TEST_ENV,
    );
    await listingStarted;
    await db
      .update(families)
      .set({ creationStatus: 'failed', familyCalendarId: null })
      .where(eq(families.id, familyId));
    await db
      .update(families)
      .set({ creationStatus: 'uncertain', calendarCreationId: 'aba-new-marker' })
      .where(eq(families.id, familyId));
    releaseListing();

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('calendar-from-old-attempt');
    expect((await db.select().from(families).where(eq(families.id, familyId)))[0]).toMatchObject({
      creationStatus: 'uncertain',
      familyCalendarId: null,
      calendarCreationId: 'aba-new-marker',
    });
  });

  it('moves a fully scanned zero match to failed, then starts a fresh marked creation attempt', async () => {
    const owner = await addUser('reconcile_zero_owner', 'zero@example.test');
    const familyId = 'fam_reconcile_zero';
    const oldCreationId = 'old-creation-attempt';
    await db.insert(families).values({
      id: familyId,
      name: '再試行家',
      ownerUserId: owner.id,
      creationStatus: 'uncertain',
      calendarCreationId: oldCreationId,
    });
    await db.insert(members).values({
      id: 'mem_reconcile_zero',
      familyId,
      userId: owner.id,
      kind: 'adult',
      name: owner.id,
      color: 'indigo',
      sortOrder: 0,
      status: 'active',
    });
    let retryDescription = '';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      if (req.url.includes('/calendarList')) return Response.json({ items: [] });
      if (req.url === 'https://www.googleapis.com/calendar/v3/calendars' && req.method === 'POST') {
        const body = (await req.json()) as { description: string; summary: string };
        retryDescription = body.description;
        return Response.json({
          id: 'calendar-after-retry',
          summary: body.summary,
          timeZone: 'Asia/Tokyo',
        });
      }
      throw new Error(`Unexpected request: ${req.url}`);
    });

    const reconcileResponse = await app.request(
      `${ORIGIN}/api/families/${familyId}/reconcile`,
      {
        method: 'POST',
        headers: postHeaders(owner.cookie),
        body: '{}',
      },
      TEST_ENV,
    );
    expect(reconcileResponse.status).toBe(200);
    const failedRecord = (await db.select().from(families).where(eq(families.id, familyId)))[0];
    expect(failedRecord?.creationStatus).toBe('failed');
    expect(failedRecord?.familyCalendarId).toBeNull();

    const retryResponse = await app.request(
      `${ORIGIN}/api/families`,
      {
        method: 'POST',
        headers: postHeaders(owner.cookie),
        body: JSON.stringify({ name: '再試行家' }),
      },
      TEST_ENV,
    );
    expect(retryResponse.status).toBe(201);
    const retryFamily = createFamilyResponseSchema.parse(await retryResponse.json()).family;
    expect(retryFamily.familyCalendarId).toBe('calendar-after-retry');
    expect(retryDescription).toContain(`danran-family:${familyId};creation:`);
    expect(retryDescription).not.toBe(`danran-family:${familyId};creation:${oldCreationId}`);
  });

  it('retries an uncertain invite for its original claimant, preserves the pending ID, and verifies a 409 writer across ACL pages', async () => {
    const owner = await addUser('acl_recovery_owner', 'acl-owner@example.test');
    const joiner = await addUser('acl_recovery_joiner', 'joiner@example.test');
    const familyId = 'fam_acl_recovery';
    const inviteId = 'invite_acl_recovery';
    const pendingId = 'mem_pending_original';
    const now = Math.floor(Date.now() / 1000);
    await db.insert(families).values({
      id: familyId,
      name: '復旧家',
      familyCalendarId: 'calendar-acl-recovery',
      ownerUserId: owner.id,
      creationStatus: 'ready',
      calendarCreationId: 'creation-acl-recovery',
    });
    await db.insert(members).values([
      {
        id: 'mem_acl_owner',
        familyId,
        userId: owner.id,
        kind: 'adult',
        name: owner.id,
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      },
      {
        id: pendingId,
        familyId,
        userId: joiner.id,
        kind: 'adult',
        name: joiner.id,
        color: 'green',
        sortOrder: 1,
        status: 'pending',
      },
    ]);
    const rawToken = generateRandomToken(32);
    await db.insert(invites).values({
      id: inviteId,
      familyId,
      tokenHash: await sha256Hex(rawToken),
      expiresAt: now - 1,
      claimedUserId: joiner.id,
      status: 'uncertain',
      createdAt: now - 100,
    });

    let aclInsertCount = 0;
    const aclListCalls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      if (req.url.includes('/acl') && req.method === 'POST') {
        aclInsertCount++;
        const requestBody = (await req.json()) as { role: string; scope: { value: string } };
        expect(requestBody).toMatchObject({ role: 'writer', scope: { value: joiner.email } });
        expect(new URL(req.url).searchParams.get('sendNotifications')).toBe('true');
        return new Response(
          JSON.stringify({
            error: { code: 409, message: 'Conflict', errors: [{ reason: 'conflict' }] },
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (req.url.includes('/acl') && req.method === 'GET') {
        const url = new URL(req.url);
        const pageToken = url.searchParams.get('pageToken') ?? '';
        aclListCalls.push(pageToken);
        if (pageToken === 'second')
          return Response.json({
            items: [
              {
                id: `user:${joiner.email}`,
                role: 'writer',
                scope: { type: 'user', value: joiner.email },
              },
            ],
          });
        return Response.json({
          items: [
            {
              id: 'user:other@example.test',
              role: 'reader',
              scope: { type: 'user', value: 'other@example.test' },
            },
          ],
          nextPageToken: 'second',
        });
      }
      throw new Error(`Unexpected request: ${req.url}`);
    });

    const response = await app.request(
      `${ORIGIN}/api/invites/join`,
      {
        method: 'POST',
        headers: postHeaders(joiner.cookie),
        body: JSON.stringify({ token: rawToken }),
      },
      TEST_ENV,
    );
    expect(response.status).toBe(200);
    const result = joinSuccessResponseSchema.parse(await response.json());
    expect(result.family.members.find((member) => member.userId === joiner.id)?.id).toBe(pendingId);
    expect(aclInsertCount).toBe(1);
    expect(aclListCalls).toEqual(['', 'second']);
    const updatedInvite = (await db.select().from(invites).where(eq(invites.id, inviteId)))[0];
    expect(updatedInvite?.status).toBe('used');
    const updatedMember = (await db.select().from(members).where(eq(members.id, pendingId)))[0];
    expect(updatedMember?.status).toBe('active');
  });

  it('serializes concurrent retries by the original claimant and activates the reserved member once', async () => {
    const owner = await addUser('concurrent_retry_owner', 'concurrent-owner@example.test');
    const joiner = await addUser('concurrent_retry_joiner', 'concurrent-joiner@example.test');
    const fixture = await seedUncertainInvite({ suffix: 'concurrent', owner, joiner });
    let releaseAcl!: () => void;
    let announceAcl!: () => void;
    const aclStarted = new Promise<void>((resolve) => {
      announceAcl = resolve;
    });
    const aclGate = new Promise<void>((resolve) => {
      releaseAcl = resolve;
    });
    let aclCalls = 0;
    let ownerTokenRefreshes = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        ownerTokenRefreshes++;
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      if (req.url.includes('/acl') && req.method === 'POST') {
        aclCalls++;
        announceAcl();
        await aclGate;
        return Response.json({
          id: `user:${joiner.email}`,
          role: 'writer',
          scope: { type: 'user', value: joiner.email },
        });
      }
      throw new Error(`Unexpected request: ${req.url}`);
    });
    const request = () =>
      app.request(
        `${ORIGIN}/api/invites/join`,
        {
          method: 'POST',
          headers: postHeaders(joiner.cookie),
          body: JSON.stringify({ token: fixture.rawToken }),
        },
        TEST_ENV,
      );
    const firstPromise = request();
    await aclStarted;
    const inFlightInvite = (
      await db.select().from(invites).where(eq(invites.id, fixture.inviteId))
    )[0];
    const inFlightMember = (
      await db.select().from(members).where(eq(members.id, fixture.pendingId))
    )[0];
    expect(inFlightInvite).toMatchObject({ status: 'claiming', claimedUserId: joiner.id });
    expect(inFlightMember).toMatchObject({
      id: fixture.pendingId,
      status: 'pending',
      name: '招待された大人',
      color: 'coral',
      sortOrder: 3,
    });
    const second = await request();
    expect(second.status).toBe(409);
    expect(aclCalls).toBe(1);
    expect(ownerTokenRefreshes).toBe(1);
    releaseAcl();
    const first = await firstPromise;
    expect(first.status).toBe(200);
    const result = joinSuccessResponseSchema.parse(await first.json());
    expect(result.family.members.find((member) => member.userId === joiner.id)?.id).toBe(
      fixture.pendingId,
    );
    expect(
      (await db.select().from(invites).where(eq(invites.id, fixture.inviteId)))[0]?.status,
    ).toBe('used');
    expect(
      (await db.select().from(members).where(eq(members.id, fixture.pendingId)))[0],
    ).toMatchObject({ id: fixture.pendingId, status: 'active' });
  });

  it('shows uncertain only to the original claimant after expiry and rejects a fresh expired invite', async () => {
    const owner = await addUser('expiry_retry_owner', 'expiry-owner@example.test');
    const joiner = await addUser('expiry_retry_joiner', 'expiry-joiner@example.test');
    const other = await addUser('expiry_retry_other', 'expiry-other@example.test');
    const fixture = await seedUncertainInvite({
      suffix: 'expiry',
      owner,
      joiner,
      expiresAt: Math.floor(Date.now() / 1000) - 20,
    });
    const inspect = (cookie: string) =>
      app.request(
        `${ORIGIN}/api/invites/inspect`,
        {
          method: 'POST',
          headers: postHeaders(cookie),
          body: JSON.stringify({ token: fixture.rawToken }),
        },
        TEST_ENV,
      );
    const ownInfo = await inspect(joiner.cookie);
    expect(ownInfo.status).toBe(200);
    expect(joinInfoResponseSchema.parse(await ownInfo.json())).toMatchObject({
      status: 'uncertain',
      alreadyMember: false,
    });
    const otherInfo = await inspect(other.cookie);
    expect(otherInfo.status).toBe(410);
    let googleCalls = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token')
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      googleCalls++;
      throw new Error(`Unexpected Google request: ${req.url}`);
    });
    const freshToken = generateRandomToken(32);
    await db.insert(invites).values({
      id: 'invite_expired_available',
      familyId: fixture.familyId,
      tokenHash: await sha256Hex(freshToken),
      expiresAt: Math.floor(Date.now() / 1000) - 1,
      claimedUserId: null,
      status: 'available',
      createdAt: Math.floor(Date.now() / 1000) - 100,
    });
    const fresh = await app.request(
      `${ORIGIN}/api/invites/join`,
      {
        method: 'POST',
        headers: postHeaders(other.cookie),
        body: JSON.stringify({ token: freshToken }),
      },
      TEST_ENV,
    );
    expect(fresh.status).toBe(410);
    expect(googleCalls).toBe(0);
    expect(
      (await db.select().from(invites).where(eq(invites.id, fixture.inviteId)))[0]?.status,
    ).toBe('uncertain');
    expect(
      (await db.select().from(members).where(eq(members.id, fixture.pendingId)))[0]?.status,
    ).toBe('pending');
  });

  it('rejects a different user retry before expiry without Google calls and preserves the pending reservation', async () => {
    const owner = await addUser('other_retry_owner', 'other-owner@example.test');
    const joiner = await addUser('other_retry_joiner', 'other-joiner@example.test');
    const other = await addUser('other_retry_user', 'other-user@example.test');
    const fixture = await seedUncertainInvite({ suffix: 'other-user', owner, joiner });
    let googleCalls = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token')
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      googleCalls++;
      throw new Error(`Unexpected Google request: ${req.url}`);
    });
    const response = await app.request(
      `${ORIGIN}/api/invites/join`,
      {
        method: 'POST',
        headers: postHeaders(other.cookie),
        body: JSON.stringify({ token: fixture.rawToken }),
      },
      TEST_ENV,
    );
    expect(response.status).toBe(410);
    expect(googleCalls).toBe(0);
    expect(
      (await db.select().from(invites).where(eq(invites.id, fixture.inviteId)))[0],
    ).toMatchObject({ status: 'uncertain', claimedUserId: joiner.id });
    expect(
      (await db.select().from(members).where(eq(members.id, fixture.pendingId)))[0],
    ).toMatchObject({ id: fixture.pendingId, status: 'pending', userId: joiner.id });
  });

  it.each([
    {
      label: 'Google rejects with 403',
      google403: true,
      ownerScopes: [...PHASE1_SCOPES, FAMILY_ACL_SCOPE],
      removeOwnerToken: false,
    },
    {
      label: 'owner grant is missing',
      google403: false,
      ownerScopes: [...PHASE1_SCOPES],
      removeOwnerToken: false,
    },
    {
      label: 'owner token is missing',
      google403: false,
      ownerScopes: [...PHASE1_SCOPES, FAMILY_ACL_SCOPE],
      removeOwnerToken: true,
    },
  ])(
    'keeps an uncertain reservation after retry failure: $label',
    async ({ google403, ownerScopes, removeOwnerToken }) => {
      const key = String(Number(google403)) + String(Number(removeOwnerToken));
      const owner = await addUser(
        `retry_fail_owner_${key}`,
        `retry-fail-${key}@example.test`,
        ownerScopes,
      );
      const joiner = await addUser(
        `retry_fail_joiner_${key}`,
        `retry-fail-joiner-${key}@example.test`,
      );
      const fixture = await seedUncertainInvite({ suffix: `failure-${key}`, owner, joiner });
      if (removeOwnerToken) await db.delete(googleTokens).where(eq(googleTokens.userId, owner.id));
      let aclCalls = 0;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token')
          return Response.json({
            access_token: 'synthetic-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
          });
        if (req.url.includes('/acl') && req.method === 'POST') {
          aclCalls++;
          return Response.json(
            { error: { code: 403, message: 'Synthetic forbidden' } },
            { status: 403 },
          );
        }
        throw new Error(`Unexpected request: ${req.url}`);
      });
      const response = await app.request(
        `${ORIGIN}/api/invites/join`,
        {
          method: 'POST',
          headers: postHeaders(joiner.cookie),
          body: JSON.stringify({ token: fixture.rawToken }),
        },
        TEST_ENV,
      );
      expect(response.status).toBe(google403 ? 500 : 403);
      expect(familyErrorResponseSchema.parse(await response.json()).code).toBe(
        'UNCERTAIN_MUTATION',
      );
      expect(aclCalls).toBe(google403 ? 1 : 0);
      expect(
        (await db.select().from(invites).where(eq(invites.id, fixture.inviteId)))[0],
      ).toMatchObject({ status: 'uncertain', claimedUserId: joiner.id });
      expect(
        (await db.select().from(members).where(eq(members.id, fixture.pendingId)))[0],
      ).toMatchObject({
        id: fixture.pendingId,
        status: 'pending',
        userId: joiner.id,
        name: '招待された大人',
        color: 'coral',
        sortOrder: 3,
      });
    },
  );

  it.each([
    {
      label: 'writer exists before a later page fails',
      firstItems: [
        {
          id: 'user:joiner@example.test',
          role: 'writer',
          scope: { type: 'user', value: 'joiner@example.test' },
        },
      ],
      nextPageToken: 'second',
      second: 'forbidden',
    },
    {
      label: 'only a reader exists',
      firstItems: [
        {
          id: 'user:joiner@example.test',
          role: 'reader',
          scope: { type: 'user', value: 'joiner@example.test' },
        },
      ],
      nextPageToken: undefined,
    },
    {
      label: 'writer and reader both exist for the recipient',
      firstItems: [
        {
          id: 'user:joiner@example.test',
          role: 'writer',
          scope: { type: 'user', value: 'joiner@example.test' },
        },
        {
          id: 'user:joiner@example.test#reader',
          role: 'reader',
          scope: { type: 'user', value: 'joiner@example.test' },
        },
      ],
      nextPageToken: undefined,
    },
    {
      label: 'pagination repeats a token',
      firstItems: [
        {
          id: 'user:other@example.test',
          role: 'reader',
          scope: { type: 'user', value: 'other@example.test' },
        },
      ],
      nextPageToken: 'loop',
      second: 'loop',
    },
  ])(
    'preserves an uncertain reservation after ACL conflict scan: $label',
    async ({ label, firstItems, nextPageToken, second }) => {
      const suffix = `acl_uncertain_${label.replaceAll(/[^a-z0-9]/gi, '_').toLowerCase()}`;
      const owner = await addUser(`${suffix}_owner`, `${suffix}-owner@example.test`);
      const joiner = await addUser(`${suffix}_joiner`, 'joiner@example.test');
      const fixture = await seedUncertainInvite({ suffix, owner, joiner });
      let aclGets = 0;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === 'https://oauth2.googleapis.com/token')
          return Response.json({
            access_token: 'synthetic-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
          });
        if (req.url.includes('/acl') && req.method === 'POST') {
          return Response.json(
            { error: { code: 409, message: 'Conflict', errors: [{ reason: 'conflict' }] } },
            { status: 409 },
          );
        }
        if (req.url.includes('/acl') && req.method === 'GET') {
          aclGets++;
          const token = new URL(req.url).searchParams.get('pageToken');
          if (second === 'forbidden' && token === 'second')
            return Response.json({ error: { code: 403, message: 'Forbidden' } }, { status: 403 });
          return Response.json({
            items: token === 'loop' ? [] : firstItems,
            ...(token === null && nextPageToken !== undefined ? { nextPageToken } : {}),
            ...(second === 'loop' ? { nextPageToken: 'loop' } : {}),
          });
        }
        throw new Error(`Unexpected request: ${req.url}`);
      });
      const response = await app.request(
        `${ORIGIN}/api/invites/join`,
        {
          method: 'POST',
          headers: postHeaders(joiner.cookie),
          body: JSON.stringify({ token: fixture.rawToken }),
        },
        TEST_ENV,
      );
      expect(response.status).toBe(500);
      expect(familyErrorResponseSchema.parse(await response.json()).code).toBe(
        'UNCERTAIN_MUTATION',
      );
      expect(aclGets).toBeLessThanOrEqual(3);
      expect(
        (await db.select().from(invites).where(eq(invites.id, fixture.inviteId)))[0],
      ).toMatchObject({ status: 'uncertain', claimedUserId: joiner.id });
      expect(
        (await db.select().from(members).where(eq(members.id, fixture.pendingId)))[0],
      ).toMatchObject({
        id: fixture.pendingId,
        status: 'pending',
        userId: joiner.id,
        name: '招待された大人',
        color: 'coral',
        sortOrder: 3,
      });
    },
  );

  it('records the creation marker in the Google insert request', async () => {
    const owner = await addUser('marker_owner', 'marker@example.test');
    let creationRequest: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === 'https://oauth2.googleapis.com/token') {
        return Response.json({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      if (req.url === 'https://www.googleapis.com/calendar/v3/calendars' && req.method === 'POST') {
        creationRequest = (await req.json()) as Record<string, unknown>;
        return Response.json({
          id: 'marker-calendar',
          summary: creationRequest.summary,
          timeZone: 'Asia/Tokyo',
        });
      }
      throw new Error(`Unexpected request: ${req.url}`);
    });
    const response = await app.request(
      `${ORIGIN}/api/families`,
      {
        method: 'POST',
        headers: postHeaders(owner.cookie),
        body: JSON.stringify({ name: '印付き家' }),
      },
      TEST_ENV,
    );
    expect(response.status).toBe(201);
    const result = createFamilyResponseSchema.parse(await response.json());
    expect(creationRequest?.description).toBe(
      `danran-family:${result.family.id};creation:${(await db.select().from(families).where(eq(families.id, result.family.id)))[0]?.calendarCreationId}`,
    );
    expect(creationRequest?.description).toMatch(
      /^danran-family:fam_[0-9a-f]+;creation:[0-9a-f]+$/,
    );
  });
});
