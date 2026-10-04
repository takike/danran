import { env } from 'cloudflare:test';
import {
  authLoginRequestBodySchema,
  authLoginResponseSchema,
  oauthPayloadSchema,
} from '@shared/schemas/auth';
import { apiErrorResponseSchema } from '@shared/schemas/errors';
import {
  type AuthConfig,
  FAMILY_ACL_SCOPE,
  OAUTH_COOKIE_NAME,
  PERSONAL_EVENTS_SCOPE,
  PHASE1_SCOPES,
  SESSION_COOKIE_NAME,
} from '@worker/auth/config';
import {
  decryptAesGcm,
  encryptAesGcm,
  generateRandomToken,
  sha256Hex,
  uint8ArrayToBase64Url,
} from '@worker/auth/crypto';
import { initiateOAuthFlow } from '@worker/auth/oauth';
import { createDb } from '@worker/db';
import { families, googleTokens, members, oauthStates, sessions, users } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { app } from '@worker/index';
import { and, eq } from 'drizzle-orm';
import { type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_AES_KEY_BASE64 = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';

const TEST_AUTH_ENV = {
  ...env,
  APP_ORIGIN: 'http://localhost:5173',
  GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret-12345',
  SESSION_SECRET: 'test-session-secret-at-least-32-chars-long-secure-entropy',
  TOKEN_ENC_KEY: TEST_AES_KEY_BASE64,
} satisfies WorkerEnv;

let testKeyPair: Awaited<ReturnType<typeof generateKeyPair>>;
let testPublicJwk: JWK & { kid: string; alg: string; use: string };

function required<T>(value: T | null | undefined, message = 'Required value missing'): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

function extractCookies(response: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  const setCookieHeaders =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter((h): h is string => Boolean(h));

  for (const header of setCookieHeaders) {
    const parts = header.split(';');
    const nameVal = parts[0];
    if (nameVal) {
      const eqIdx = nameVal.indexOf('=');
      if (eqIdx !== -1) {
        const key = nameVal.substring(0, eqIdx).trim();
        const val = nameVal.substring(eqIdx + 1).trim();
        jar[key] = val;
      }
    }
  }
  return jar;
}

function cookieHeaderFromJar(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function expectCallbackFailure(response: Response, destination: string): Promise<void> {
  expect(response.status).toBe(302);
  expect(response.headers.get('Location')).toBe(destination);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Pragma')).toBe('no-cache');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  const clearedCookie = response.headers.get('set-cookie') ?? '';
  expect(clearedCookie).toContain(`${OAUTH_COOKIE_NAME}=`);
  expect(clearedCookie).toContain('Max-Age=0');
  expect(clearedCookie).toContain('Path=/');
  expect(clearedCookie).toContain('HttpOnly');
  expect(clearedCookie).toContain('Secure');
  expect(await response.clone().text()).toBe('');
}

async function computeS256Challenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return uint8ArrayToBase64Url(new Uint8Array(hash));
}

interface SignTestTokenOptions {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  nonce?: string;
  aud?: string;
  iss?: string;
  exp?: number;
  iat?: number;
  azp?: string;
}

async function signTestIdToken(claims: SignTestTokenOptions): Promise<string> {
  const iat = claims.iat ?? Math.floor(Date.now() / 1000);
  const exp = claims.exp ?? iat + 3600;

  const payload: Record<string, unknown> = {
    sub: claims.sub ?? 'google-sub-synthetic-12345',
    email: claims.email ?? 'synthetic.user@example.test',
    email_verified: claims.email_verified ?? true,
    name: claims.name ?? 'Synthetic Test User',
    azp: claims.azp ?? TEST_AUTH_ENV.GOOGLE_CLIENT_ID,
  };

  if (claims.nonce !== undefined) {
    payload.nonce = claims.nonce;
  }

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-jwk-key-1' })
    .setIssuer(claims.iss ?? 'https://accounts.google.com')
    .setAudience(claims.aud ?? TEST_AUTH_ENV.GOOGLE_CLIENT_ID)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(testKeyPair.privateKey);
}

interface SetupFetchMockOptions {
  idToken?: string;
  accessToken?: string;
  refreshToken?: string | null;
  tokenStatus?: number;
  tokenBody?: unknown;
  scope?: string;
  onTokenRequest?: (req: Request, params: URLSearchParams) => void | Promise<void>;
}

function setupGoogleFetchMock(options: SetupFetchMockOptions = {}) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const urlStr = req.url;

    if (urlStr === 'https://www.googleapis.com/oauth2/v3/certs') {
      return new Response(JSON.stringify({ keys: [testPublicJwk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (urlStr === 'https://oauth2.googleapis.com/token') {
      expect(req.method).toBe('POST');
      const bodyBuffer = await req.clone().arrayBuffer();
      const bodyText = new TextDecoder().decode(bodyBuffer);
      const bodyParams = new URLSearchParams(bodyText);

      if (options.onTokenRequest) {
        await options.onTokenRequest(req, bodyParams);
      }

      if (options.tokenStatus && options.tokenStatus !== 200) {
        return new Response(JSON.stringify(options.tokenBody ?? { error: 'invalid_grant' }), {
          status: options.tokenStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const defaultBody: Record<string, unknown> = {
        access_token: options.accessToken ?? 'mock-access-token-xyz',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: options.scope ?? [...PHASE1_SCOPES, FAMILY_ACL_SCOPE].join(' '),
        id_token: options.idToken,
      };

      if (options.refreshToken !== undefined) {
        if (options.refreshToken !== null) {
          defaultBody.refresh_token = options.refreshToken;
        }
      } else {
        defaultBody.refresh_token = 'mock-refresh-token-xyz';
      }

      return new Response(JSON.stringify(options.tokenBody ?? defaultBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected outgoing network call to: ${urlStr}`);
  });
}

function gateEncryptForUser(targetUserId: string, onEncryptEntered: () => Promise<void> | void) {
  const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  let entered = false;
  const spy = vi
    .spyOn(crypto.subtle, 'encrypt')
    .mockImplementation(async (algorithm, key, data) => {
      const params = algorithm as AesGcmParams;
      if (params?.additionalData) {
        const aad = new TextDecoder().decode(params.additionalData);
        if (aad === `google-refresh:${targetUserId}`) {
          entered = true;
          try {
            await onEncryptEntered();
          } finally {
            // gate released
          }
        }
      }
      return await originalEncrypt(algorithm, key, data);
    });
  return {
    wasEntered: () => entered,
    restore: () => spy.mockRestore(),
  };
}

describe('Task 1-4: Incremental Family ACL Authorization & Invite Continuation', () => {
  const db = createDb(env.DB);

  beforeAll(async () => {
    testKeyPair = await generateKeyPair('RS256');
    const exported = await exportJWK(testKeyPair.publicKey);
    testPublicJwk = {
      ...exported,
      kid: 'test-jwk-key-1',
      alg: 'RS256',
      use: 'sig',
    };
  });

  beforeEach(async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      throw new Error(`Unexpected network call intercepted: ${urlStr}`);
    });

    await db.delete(oauthStates);
    await db.delete(sessions);
    await db.delete(googleTokens);
    await db.delete(members);
    await db.delete(families);
    await db.delete(users);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    try {
      await db.delete(oauthStates);
      await db.delete(sessions);
      await db.delete(googleTokens);
      await db.delete(members);
      await db.delete(families);
      await db.delete(users);
    } catch {
      // Ignore
    }
  });

  /**
   * Helper to perform a full baseline login with explicit PHASE1 scopes only.
   * This ensures the owner begins with NO FAMILY_ACL_SCOPE stored in D1.
   */
  async function performLogin(sub = 'google-sub-owner-123', email = 'owner@example.test') {
    const loginRes = await app.request('http://localhost:5173/api/auth/login', {}, TEST_AUTH_ENV);
    expect(loginRes.status).toBe(302);
    const loginJar = extractCookies(loginRes);
    const location = new URL(required(loginRes.headers.get('Location'), 'Location header missing'));
    const state = required(location.searchParams.get('state'), 'State missing');
    const nonce = required(location.searchParams.get('nonce'), 'Nonce missing');

    const signedIdToken = await signTestIdToken({ sub, email, nonce });
    setupGoogleFetchMock({
      idToken: signedIdToken,
      refreshToken: 'initial-owner-refresh',
      scope: PHASE1_SCOPES.join(' '),
    });

    const cbRes = await app.request(
      `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: cookieHeaderFromJar(loginJar) } },
      TEST_AUTH_ENV,
    );
    expect(cbRes.status).toBe(302);
    const sessionJar = extractCookies(cbRes);
    expect(sessionJar[SESSION_COOKIE_NAME]).toBeDefined();

    const userRows = await db.select().from(users).where(eq(users.googleSub, sub));
    const user = required(userRows[0], 'User not found in D1');
    const sessionRows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    const session = required(sessionRows[sessionRows.length - 1], 'Session not found in D1');

    return { user, session, sessionJar };
  }

  /**
   * Helper to set up an active ready family owned by the user
   */
  async function setupOwnedFamily(userId: string, userName = 'Owner User') {
    const familyId = `fam_${crypto.randomUUID()}`;
    await db.insert(families).values({
      id: familyId,
      name: 'Happy Family',
      ownerUserId: userId,
      familyCalendarId: `cal_${crypto.randomUUID()}`,
      creationStatus: 'ready',
    });

    const memberId = `mem_${crypto.randomUUID()}`;
    await db.insert(members).values({
      id: memberId,
      familyId,
      userId,
      kind: 'adult',
      name: userName,
      color: 'indigo',
      sortOrder: 0,
      status: 'active',
    });

    return { familyId, memberId };
  }

  /**
   * Helper to call POST /api/families/:id/invites and assert status 200 + authorizationRequired === true
   * BEFORE parsing the authorization URL, preventing vague URL parser failures.
   */
  async function requestFamilyAclUrl(familyId: string, sessionJar: Record<string, string>) {
    const inviteRes = await app.request(
      `http://localhost:5173/api/families/${familyId}/invites`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: 'http://localhost:5173',
          Cookie: cookieHeaderFromJar(sessionJar),
        },
        body: JSON.stringify({}),
      },
      TEST_AUTH_ENV,
    );
    expect(inviteRes.status).toBe(200);
    const inviteData = (await inviteRes.json()) as {
      authorizationRequired?: boolean;
      authorizationUrl?: string;
    };
    expect(inviteData.authorizationRequired).toBe(true);
    const authUrl = new URL(
      required(inviteData.authorizationUrl, 'authorizationUrl missing from invite response'),
    );
    const oauthJar = extractCookies(inviteRes);
    return { inviteRes, inviteData, authUrl, oauthJar };
  }

  describe('1. Baseline Scopes & ACL Scope Absence', () => {
    it('baselineGET and POST scopesACLabsent: GET /api/auth/login does not include FAMILY_ACL_SCOPE', async () => {
      const res = await app.request('http://localhost:5173/api/auth/login', {}, TEST_AUTH_ENV);
      expect(res.status).toBe(302);
      const location = new URL(required(res.headers.get('Location'), 'Location header missing'));
      const scopeParam = required(location.searchParams.get('scope'), 'Scope param missing');
      const scopes = scopeParam.split(' ');

      for (const requiredScope of PHASE1_SCOPES) {
        expect(scopes).toContain(requiredScope);
      }
      expect(scopes).not.toContain(FAMILY_ACL_SCOPE);
      expect(location.searchParams.get('include_granted_scopes')).toBe('true');
    });

    it('baselineGET and POST scopesACLabsent: POST /api/auth/login does not include FAMILY_ACL_SCOPE', async () => {
      const res = await app.request(
        'http://localhost:5173/api/auth/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'http://localhost:5173',
          },
          body: JSON.stringify({ inviteToken: 'A'.repeat(43) }),
        },
        TEST_AUTH_ENV,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      const parsed = authLoginResponseSchema.parse(body);
      const url = new URL(parsed.authorizationUrl);
      const scopes = required(url.searchParams.get('scope'), 'Scope param missing').split(' ');

      for (const requiredScope of PHASE1_SCOPES) {
        expect(scopes).toContain(requiredScope);
      }
      expect(scopes).not.toContain(FAMILY_ACL_SCOPE);
      expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    });
  });

  describe('2. Incremental Family ACL Initiation', () => {
    it('ACLinitfromPOSTfamilyowner inclgranted/PKCEstate and OAuthgetactualencryptedstatefornonce', async () => {
      const { user, session, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id, user.displayName);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);

      const scopes = required(authUrl.searchParams.get('scope'), 'Scope param missing').split(' ');
      expect(scopes).toContain(FAMILY_ACL_SCOPE);
      for (const requiredScope of PHASE1_SCOPES) {
        expect(scopes).toContain(requiredScope);
      }
      expect(authUrl.searchParams.get('include_granted_scopes')).toBe('true');
      expect(authUrl.searchParams.get('login_hint')).toBe(user.googleSub);

      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');
      const challenge = required(authUrl.searchParams.get('code_challenge'), 'Challenge missing');
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');

      expect(oauthJar[OAUTH_COOKIE_NAME]).toBeDefined();

      const stateHash = await sha256Hex(state);
      const stateRows = await db
        .select()
        .from(oauthStates)
        .where(eq(oauthStates.stateHash, stateHash));
      expect(stateRows.length).toBe(1);
      const stateRow = required(stateRows[0], 'State row missing');

      const decryptedPayload = await decryptAesGcm(
        stateRow.payloadEnc,
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `oauth-state:${stateHash}`,
      );
      const parsedPayload = oauthPayloadSchema.parse(JSON.parse(decryptedPayload));
      expect(parsedPayload.purpose).toBe('family-acl');
      if (parsedPayload.purpose === 'family-acl') {
        expect(parsedPayload.userId).toBe(user.id);
        expect(parsedPayload.sessionId).toBe(session.id);
        expect(parsedPayload.familyId).toBe(familyId);
        expect(parsedPayload.nonce).toBe(nonce);
        expect(await computeS256Challenge(parsedPayload.codeVerifier)).toBe(challenge);
      }
    });
  });

  describe('Task 2-1 personal calendar authorization', () => {
    async function requestPersonalAuthorization(
      familyId: string,
      sessionJar: Record<string, string>,
    ) {
      const response = await app.request(
        `http://localhost:5173/api/families/${familyId}/personal-calendars`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'http://localhost:5173',
            Cookie: cookieHeaderFromJar(sessionJar),
          },
          body: JSON.stringify({ calendarIds: [] }),
        },
        TEST_AUTH_ENV,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        authorizationRequired: boolean;
        authorizationUrl: string;
      };
      expect(body.authorizationRequired).toBe(true);
      return { authUrl: new URL(body.authorizationUrl), oauthJar: extractCookies(response) };
    }

    it('binds incremental consent to the caller and stores the returned scope set without losing earlier grants', async () => {
      const { user, sessionJar } = await performLogin(
        'personal-owner-sub',
        'personal@example.test',
      );
      const { familyId } = await setupOwnedFamily(user.id);
      const { authUrl, oauthJar } = await requestPersonalAuthorization(familyId, sessionJar);
      expect(authUrl.searchParams.get('include_granted_scopes')).toBe('true');
      expect(authUrl.searchParams.get('login_hint')).toBe(user.googleSub);
      expect(authUrl.searchParams.get('scope')?.split(' ')).toEqual(
        expect.arrayContaining([...PHASE1_SCOPES, PERSONAL_EVENTS_SCOPE]),
      );
      const state = required(authUrl.searchParams.get('state'));
      const nonce = required(authUrl.searchParams.get('nonce'));
      const idToken = await signTestIdToken({ sub: user.googleSub, nonce });
      setupGoogleFetchMock({
        idToken,
        refreshToken: 'personal-refresh',
        scope: [...PHASE1_SCOPES, FAMILY_ACL_SCOPE, PERSONAL_EVENTS_SCOPE].join(' '),
      });
      const callback = await app.request(
        `http://localhost:5173/api/auth/callback?code=personal-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar({ ...sessionJar, ...oauthJar }) } },
        TEST_AUTH_ENV,
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get('Location')).toBe('/family?personal=granted');
      const saved = required(
        (await db.select().from(googleTokens).where(eq(googleTokens.userId, user.id)))[0],
      );
      expect(saved.scopes.split(' ')).toEqual(
        expect.arrayContaining([...PHASE1_SCOPES, FAMILY_ACL_SCOPE, PERSONAL_EVENTS_SCOPE]),
      );
    });

    it('uses fixed cancellation, token failure, account mismatch, and stale-session redirects', async () => {
      const { user, session, sessionJar } = await performLogin(
        'personal-branch-sub',
        'branch@example.test',
      );
      const { familyId } = await setupOwnedFamily(user.id);

      const cancelledFlow = await requestPersonalAuthorization(familyId, sessionJar);
      const cancelledState = required(cancelledFlow.authUrl.searchParams.get('state'));
      const cancelled = await app.request(
        `http://localhost:5173/api/auth/callback?error=access_denied&error_description=private&state=${encodeURIComponent(cancelledState)}`,
        { headers: { Cookie: cookieHeaderFromJar({ ...sessionJar, ...cancelledFlow.oauthJar }) } },
        TEST_AUTH_ENV,
      );
      await expectCallbackFailure(cancelled, '/family?error=personal_denied');
      expect(await cancelled.text()).not.toContain('private');
      const replayedCancellation = await app.request(
        `http://localhost:5173/api/auth/callback?error=access_denied&state=${encodeURIComponent(cancelledState)}`,
        { headers: { Cookie: cookieHeaderFromJar({ ...sessionJar, ...cancelledFlow.oauthJar }) } },
        TEST_AUTH_ENV,
      );
      expect(replayedCancellation.headers.get('Location')).toBe('/?error=auth_expired');

      const failedFlow = await requestPersonalAuthorization(familyId, sessionJar);
      const failedState = required(failedFlow.authUrl.searchParams.get('state'));
      setupGoogleFetchMock({ tokenStatus: 500 });
      const failed = await app.request(
        `http://localhost:5173/api/auth/callback?code=bad&state=${encodeURIComponent(failedState)}`,
        { headers: { Cookie: cookieHeaderFromJar({ ...sessionJar, ...failedFlow.oauthJar }) } },
        TEST_AUTH_ENV,
      );
      await expectCallbackFailure(failed, '/family?error=personal_failed');

      const mismatchFlow = await requestPersonalAuthorization(familyId, sessionJar);
      const mismatchState = required(mismatchFlow.authUrl.searchParams.get('state'));
      const mismatchNonce = required(mismatchFlow.authUrl.searchParams.get('nonce'));
      setupGoogleFetchMock({
        idToken: await signTestIdToken({ sub: 'other-google-account', nonce: mismatchNonce }),
        scope: [...PHASE1_SCOPES, PERSONAL_EVENTS_SCOPE].join(' '),
      });
      const mismatch = await app.request(
        `http://localhost:5173/api/auth/callback?code=mismatch&state=${encodeURIComponent(mismatchState)}`,
        { headers: { Cookie: cookieHeaderFromJar({ ...sessionJar, ...mismatchFlow.oauthJar }) } },
        TEST_AUTH_ENV,
      );
      await expectCallbackFailure(mismatch, '/family?error=personal_account_mismatch');

      const staleFlow = await requestPersonalAuthorization(familyId, sessionJar);
      const staleState = required(staleFlow.authUrl.searchParams.get('state'));
      await db.delete(sessions).where(eq(sessions.id, session.id));
      const stale = await app.request(
        `http://localhost:5173/api/auth/callback?code=stale&state=${encodeURIComponent(staleState)}`,
        { headers: { Cookie: cookieHeaderFromJar({ ...sessionJar, ...staleFlow.oauthJar }) } },
        TEST_AUTH_ENV,
      );
      await expectCallbackFailure(stale, '/family?error=personal_failed');
    });

    it('rejects missing personal scope or ID token and preserves the existing grant without refresh token', async () => {
      const { user, sessionJar } = await performLogin(
        'personal-invalid-grant-sub',
        'invalid@example.test',
      );
      const { familyId } = await setupOwnedFamily(user.id);
      const oldToken = required(
        (await db.select().from(googleTokens).where(eq(googleTokens.userId, user.id)))[0],
      );

      const scopeFlow = await requestPersonalAuthorization(familyId, sessionJar);
      const scopeState = required(scopeFlow.authUrl.searchParams.get('state'));
      const scopeNonce = required(scopeFlow.authUrl.searchParams.get('nonce'));
      setupGoogleFetchMock({
        idToken: await signTestIdToken({ sub: user.googleSub, nonce: scopeNonce }),
        scope: PHASE1_SCOPES.join(' '),
      });
      const missingScope = await app.request(
        `http://localhost:5173/api/auth/callback?code=missing-scope&state=${encodeURIComponent(scopeState)}`,
        { headers: { Cookie: cookieHeaderFromJar({ ...sessionJar, ...scopeFlow.oauthJar }) } },
        TEST_AUTH_ENV,
      );
      await expectCallbackFailure(missingScope, '/family?error=personal_failed');
      const afterMissingScope = required(
        (await db.select().from(googleTokens).where(eq(googleTokens.userId, user.id)))[0],
      );
      expect(afterMissingScope.refreshTokenEnc).toBe(oldToken.refreshTokenEnc);
      expect(afterMissingScope.scopes).toBe(oldToken.scopes);

      const noIdFlow = await requestPersonalAuthorization(familyId, sessionJar);
      const noIdState = required(noIdFlow.authUrl.searchParams.get('state'));
      setupGoogleFetchMock({
        scope: [...PHASE1_SCOPES, PERSONAL_EVENTS_SCOPE].join(' '),
        refreshToken: null,
      });
      const noIdToken = await app.request(
        `http://localhost:5173/api/auth/callback?code=missing-id-token&state=${encodeURIComponent(noIdState)}`,
        { headers: { Cookie: cookieHeaderFromJar({ ...sessionJar, ...noIdFlow.oauthJar }) } },
        TEST_AUTH_ENV,
      );
      await expectCallbackFailure(noIdToken, '/family?error=personal_failed');
      const afterNoIdToken = required(
        (await db.select().from(googleTokens).where(eq(googleTokens.userId, user.id)))[0],
      );
      expect(afterNoIdToken.refreshTokenEnc).toBe(oldToken.refreshTokenEnc);
      expect(afterNoIdToken.scopes).toBe(oldToken.scopes);

      const noRefreshFlow = await requestPersonalAuthorization(familyId, sessionJar);
      const noRefreshState = required(noRefreshFlow.authUrl.searchParams.get('state'));
      const noRefreshNonce = required(noRefreshFlow.authUrl.searchParams.get('nonce'));
      setupGoogleFetchMock({
        idToken: await signTestIdToken({ sub: user.googleSub, nonce: noRefreshNonce }),
        scope: [...PHASE1_SCOPES, PERSONAL_EVENTS_SCOPE].join(' '),
        refreshToken: null,
      });
      const noRefresh = await app.request(
        `http://localhost:5173/api/auth/callback?code=no-refresh&state=${encodeURIComponent(noRefreshState)}`,
        { headers: { Cookie: cookieHeaderFromJar({ ...sessionJar, ...noRefreshFlow.oauthJar }) } },
        TEST_AUTH_ENV,
      );
      expect(noRefresh.headers.get('Location')).toBe('/family?personal=granted');
      const afterNoRefresh = required(
        (await db.select().from(googleTokens).where(eq(googleTokens.userId, user.id)))[0],
      );
      expect(afterNoRefresh.refreshTokenEnc).toBe(oldToken.refreshTokenEnc);
      expect(afterNoRefresh.scopes.split(' ')).toEqual(
        expect.arrayContaining([...PHASE1_SCOPES, PERSONAL_EVENTS_SCOPE]),
      );
    });
  });

  it('preserves the exact Google-returned scope set on ordinary and invite logins', async () => {
    const { user, sessionJar } = await performLogin('scope-refresh-sub', 'scope@example.test');
    await db
      .update(googleTokens)
      .set({
        scopes: [...PHASE1_SCOPES, 'https://www.googleapis.com/auth/calendar.readonly'].join(' '),
      })
      .where(eq(googleTokens.userId, user.id));
    const returnedScopes = [...PHASE1_SCOPES, FAMILY_ACL_SCOPE, PERSONAL_EVENTS_SCOPE];

    const ordinary = await app.request(
      'http://localhost:5173/api/auth/login',
      { headers: { Cookie: cookieHeaderFromJar(sessionJar) } },
      TEST_AUTH_ENV,
    );
    const ordinaryUrl = new URL(required(ordinary.headers.get('Location')));
    const ordinaryNonce = required(ordinaryUrl.searchParams.get('nonce'));
    const ordinaryState = required(ordinaryUrl.searchParams.get('state'));
    setupGoogleFetchMock({
      idToken: await signTestIdToken({ sub: user.googleSub, nonce: ordinaryNonce }),
      scope: returnedScopes.join(' '),
    });
    const ordinaryCallback = await app.request(
      `http://localhost:5173/api/auth/callback?code=ordinary&state=${encodeURIComponent(ordinaryState)}`,
      { headers: { Cookie: cookieHeaderFromJar({ ...sessionJar, ...extractCookies(ordinary) }) } },
      TEST_AUTH_ENV,
    );
    expect(ordinaryCallback.headers.get('Location')).toBe('/');
    const ordinaryToken = required(
      (await db.select().from(googleTokens).where(eq(googleTokens.userId, user.id)))[0],
    );
    expect(ordinaryToken.scopes.split(' ').sort()).toEqual([...returnedScopes].sort());

    const inviteToken = 'F'.repeat(43);
    const inviteStart = await app.request(
      'http://localhost:5173/api/auth/login',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ inviteToken }),
      },
      TEST_AUTH_ENV,
    );
    const inviteUrl = new URL(
      authLoginResponseSchema.parse(await inviteStart.json()).authorizationUrl,
    );
    const inviteNonce = required(inviteUrl.searchParams.get('nonce'));
    const inviteState = required(inviteUrl.searchParams.get('state'));
    setupGoogleFetchMock({
      idToken: await signTestIdToken({ sub: user.googleSub, nonce: inviteNonce }),
      scope: returnedScopes.join(' '),
    });
    const inviteCallback = await app.request(
      `http://localhost:5173/api/auth/callback?code=invite&state=${encodeURIComponent(inviteState)}`,
      { headers: { Cookie: cookieHeaderFromJar(extractCookies(inviteStart)) } },
      TEST_AUTH_ENV,
    );
    expect(inviteCallback.headers.get('Location')).toBe(`/invite#${inviteToken}`);
    const inviteTokenRow = required(
      (await db.select().from(googleTokens).where(eq(googleTokens.userId, user.id)))[0],
    );
    expect(inviteTokenRow.scopes.split(' ').sort()).toEqual([...returnedScopes].sort());
  });

  describe('3. Bound Session & Pre-Exchange Verification Gate', () => {
    it('mismatchedcurrentcookie missing/differentuser/differentsession redirects when session cookie is missing before Google fetch', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');

      // Call callback with oauth cookie ONLY, NO session cookie
      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(oauthJar) } },
        TEST_AUTH_ENV,
      );

      // Redirects before any external fetch
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_failed');
    });

    it('mismatchedcurrentcookie: redirects when session belongs to a different user without Google fetch', async () => {
      const { user: userA, sessionJar: jarA } = await performLogin('sub-a', 'userA@test.com');
      const { sessionJar: jarB } = await performLogin('sub-b', 'userB@test.com');
      const { familyId } = await setupOwnedFamily(userA.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, jarA);
      const state = required(authUrl.searchParams.get('state'), 'State missing');

      // Combined jar has User B's session and User A's oauth cookie
      const crossJar = {
        ...oauthJar,
        [SESSION_COOKIE_NAME]: required(jarB[SESSION_COOKIE_NAME], 'Session cookie missing'),
      };

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(crossJar) } },
        TEST_AUTH_ENV,
      );

      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_failed');
    });

    it('mismatchedcurrentcookie: redirects before Google call when session cookie belongs to same user but different session', async () => {
      const {
        user,
        session: session1,
        sessionJar: jar1,
      } = await performLogin('sub-multi-sess', 'multi@example.test');
      const { familyId } = await setupOwnedFamily(user.id);

      // Initiate family-acl with session 1
      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, jar1);
      const state = required(authUrl.searchParams.get('state'), 'State missing');

      // Perform a second login for the same user to obtain a separate valid session
      const { session: session2, sessionJar: jar2 } = await performLogin(
        'sub-multi-sess',
        'multi@example.test',
      );
      expect(session2.id).not.toBe(session1.id);
      expect(session2.userId).toBe(user.id);

      // Present session 2's cookie with session 1's oauth state
      const crossJar = {
        ...oauthJar,
        [SESSION_COOKIE_NAME]: required(jar2[SESSION_COOKIE_NAME], 'Session cookie missing'),
      };

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(crossJar) } },
        TEST_AUTH_ENV,
      );

      // Pre-exchange check detects currentSession.sessionId !== consumed.sessionId
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_failed');
    });

    it('invalidatedoldsession: redirects before Google call when session was deleted or expired', async () => {
      const { user, session, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');

      // Delete session from DB before callback
      await db.delete(sessions).where(eq(sessions.id, session.id));

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_failed');
    });
  });

  describe('4. Token Exchange & Identity Verification', () => {
    it('wrongGoogleIDsub nevertoken/profile/sessionchange: redirects when Google sub mismatches active user', async () => {
      const { user, sessionJar } = await performLogin('owner-google-sub');
      const { familyId } = await setupOwnedFamily(user.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');

      // Sign token with WRONG Google sub
      const wrongSubToken = await signTestIdToken({
        sub: 'attacker-sub-999',
        nonce,
      });
      setupGoogleFetchMock({ idToken: wrongSubToken });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_account_mismatch');

      // Assert no grant has been written with ACL scope
      const tokens = await db.select().from(googleTokens).where(eq(googleTokens.userId, user.id));
      const grant = tokens[0];
      if (grant) {
        expect(grant.scopes).not.toContain(FAMILY_ACL_SCOPE);
      }
    });

    it('noncefailure: redirects /onboarding?error=acl_failed when ID token nonce fails verification', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');

      // Wrong nonce
      const wrongNonceToken = await signTestIdToken({
        sub: user.googleSub,
        nonce: 'invalid-nonce-value',
      });
      setupGoogleFetchMock({ idToken: wrongNonceToken });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_failed');
    });

    it('partialACLscope withheld no write: redirects /onboarding?error=acl_failed when user denies calendar.acls', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');

      const validToken = await signTestIdToken({ sub: user.googleSub, nonce });
      // Returned scope has ONLY Phase 1 scopes, omitting calendar.acls
      setupGoogleFetchMock({
        idToken: validToken,
        scope: PHASE1_SCOPES.join(' '),
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_failed');
    });
  });

  describe('5. Cancellation, Replay & State Invalidation', () => {
    it('cancelsinglestate noinvite: user denies consent, state consumed, redirects /onboarding?error=acl_denied', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const stateHash = await sha256Hex(state);

      const cancelRes = await app.request(
        `http://localhost:5173/api/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      expect(cancelRes.status).toBe(302);
      await expectCallbackFailure(cancelRes, '/onboarding?error=acl_denied');

      // State is consumed
      const stateRows = await db
        .select()
        .from(oauthStates)
        .where(eq(oauthStates.stateHash, stateHash));
      expect(stateRows.length).toBe(0);

      // Replaying consumed state redirects to the fixed expired-state destination.
      const replayRes = await app.request(
        `http://localhost:5173/api/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );
      expect(replayRes.status).toBe(302);
      expect(replayRes.headers.get('Location')).toBe('/?error=auth_expired');
    });
  });

  describe('6. Successful Incremental Grant Storage & Token Preservation', () => {
    it('successwithrefreshAES/AADstoredno plain: stores new encrypted refresh token with AAD and redirects /onboarding?acl=granted', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');

      const newRefreshToken = 'fresh-google-refresh-token-xyz-999';
      const validToken = await signTestIdToken({ sub: user.googleSub, nonce });
      setupGoogleFetchMock({
        idToken: validToken,
        refreshToken: newRefreshToken,
        scope: [...PHASE1_SCOPES, FAMILY_ACL_SCOPE].join(' '),
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?acl=granted');

      // Verify token in DB
      const tokenRows = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, user.id));
      expect(tokenRows.length).toBe(1);
      const row = required(tokenRows[0], 'Token row missing');
      expect(row.refreshTokenEnc).not.toContain(newRefreshToken);
      expect(row.refreshTokenEnc.startsWith('v1.')).toBe(true);

      const decrypted = await decryptAesGcm(
        row.refreshTokenEnc,
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `google-refresh:${user.id}`,
      );
      expect(decrypted).toBe(newRefreshToken);
      expect(row.scopes).toContain(FAMILY_ACL_SCOPE);
    });

    it('norefreshpreservesold: preserves existing encrypted refresh token when Google returns none', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      // Fetch existing token row
      const preTokens = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, user.id));
      const oldCiphertext = required(
        preTokens[0],
        'Pre-existing token row missing',
      ).refreshTokenEnc;

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');

      const validToken = await signTestIdToken({ sub: user.googleSub, nonce });
      // Google returns NO refresh token
      setupGoogleFetchMock({
        idToken: validToken,
        refreshToken: null,
        scope: [...PHASE1_SCOPES, FAMILY_ACL_SCOPE].join(' '),
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?acl=granted');

      const postTokens = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, user.id));
      const postRow = required(postTokens[0], 'Post-token row missing');
      // Old ciphertext preserved exactly
      expect(postRow.refreshTokenEnc).toBe(oldCiphertext);
      expect(postRow.scopes).toContain(FAMILY_ACL_SCOPE);
    });

    it('legitimate prior token rotation before grant read: succeeds and updates latest grant with ACL scope', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');

      const validToken = await signTestIdToken({ sub: user.googleSub, nonce });
      const priorRotatedRefresh = 'prior-rotated-refresh-before-read';
      const priorRotatedEnc = await encryptAesGcm(
        priorRotatedRefresh,
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `google-refresh:${user.id}`,
      );

      setupGoogleFetchMock({
        idToken: validToken,
        onTokenRequest: async () => {
          // Legitimate rotation occurred BEFORE callback reads existing grant from D1
          await db
            .update(googleTokens)
            .set({ refreshTokenEnc: priorRotatedEnc })
            .where(eq(googleTokens.userId, user.id));
        },
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      // Reads latest grant and saves legitimate consent
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?acl=granted');

      const postTokens = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, user.id));
      const postRow = required(postTokens[0], 'Post token row missing');
      expect(postRow.scopes).toContain(FAMILY_ACL_SCOPE);
    });
  });

  describe('7. Concurrency & Mid-Exchange Mutations Gate', () => {
    it('redirects acl_failed on a post-consumption session database exception without Google exchange', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);
      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const originalPrepare = TEST_AUTH_ENV.DB.prepare.bind(TEST_AUTH_ENV.DB);
      const prepareSpy = vi.spyOn(TEST_AUTH_ENV.DB, 'prepare').mockImplementation((query) => {
        if (query.toLowerCase().includes('sessions')) {
          throw new Error('synthetic session database fault');
        }
        return originalPrepare(query);
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(sessionJar[SESSION_COOKIE_NAME]),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      await expectCallbackFailure(cbRes, '/onboarding?error=acl_failed');
      expect(prepareSpy).toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      prepareSpy.mockRestore();
    });

    it('redirects acl_failed on grant write exception and preserves the existing grant', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);
      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');
      const validToken = await signTestIdToken({ sub: user.googleSub, nonce });
      setupGoogleFetchMock({ idToken: validToken, refreshToken: 'replacement-refresh-token' });

      const beforeRows = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, user.id));
      const beforeGrant = required(beforeRows[0], 'Existing grant missing');
      const originalPrepare = TEST_AUTH_ENV.DB.prepare.bind(TEST_AUTH_ENV.DB);
      const prepareSpy = vi.spyOn(TEST_AUTH_ENV.DB, 'prepare').mockImplementation((query) => {
        if (query.includes('UPDATE google_tokens')) {
          throw new Error('synthetic grant write fault');
        }
        return originalPrepare(query);
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(sessionJar[SESSION_COOKIE_NAME]),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      await expectCallbackFailure(cbRes, '/onboarding?error=acl_failed');
      expect(prepareSpy).toHaveBeenCalled();
      prepareSpy.mockRestore();

      const afterRows = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, user.id));
      expect(afterRows).toHaveLength(1);
      expect(required(afterRows[0]).refreshTokenEnc).toBe(beforeGrant.refreshTokenEnc);
      expect(required(afterRows[0]).scopes).toBe(beforeGrant.scopes);
      const sessionsAfter = await db.select().from(sessions).where(eq(sessions.userId, user.id));
      expect(sessionsAfter).toHaveLength(1);
    });

    it('ownerchange/logout DURINGexchangegate finalmutationfailure: rejects when session is deleted during exchange', async () => {
      const { user, session, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');

      const validToken = await signTestIdToken({ sub: user.googleSub, nonce });
      setupGoogleFetchMock({
        idToken: validToken,
        onTokenRequest: async () => {
          // Concurrent logout/deletion DURING token exchange
          await db.delete(sessions).where(eq(sessions.id, session.id));
        },
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      // Recheck catches the deleted session and returns the fixed ACL failure redirect.
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_failed');
    });

    it('ownershipchange whileexchange inprogress: redirects when ownerUserId changes before recheck', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');

      // Seed existing synthetic new user before ownership transfer to satisfy FK constraint
      const newOwnerId = `usr_${crypto.randomUUID()}`;
      await db.insert(users).values({
        id: newOwnerId,
        googleSub: `sub-new-owner-${crypto.randomUUID()}`,
        email: 'newowner@example.test',
        displayName: 'New Owner User',
      });

      const validToken = await signTestIdToken({ sub: user.googleSub, nonce });
      setupGoogleFetchMock({
        idToken: validToken,
        onTokenRequest: async () => {
          // Family ownership transferred while token exchange is in progress with Google
          await db
            .update(families)
            .set({ ownerUserId: newOwnerId })
            .where(eq(families.id, familyId));
        },
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      // Recheck step 6 catches ownership loss.
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_failed');

      const postTokens = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, user.id));
      const postRow = required(postTokens[0], 'Token row missing');
      expect(postRow.scopes).not.toContain(FAMILY_ACL_SCOPE);

      // Assert no other profile or session mutations occurred
      const userCheck = await db.select().from(users).where(eq(users.id, user.id));
      expect(userCheck.length).toBe(1);
      const sessionCheck = await db.select().from(sessions).where(eq(sessions.userId, user.id));
      expect(sessionCheck.length).toBe(1);
    });

    it('concurrentgoogleTokensciphertextrotation zeroaffected rejects: rejects when ciphertext is rotated concurrently during encrypt gate', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');

      const validToken = await signTestIdToken({ sub: user.googleSub, nonce });
      setupGoogleFetchMock({ idToken: validToken });

      // Precompute valid new AES ciphertext value before gate
      const validNewAesValue = await encryptAesGcm(
        'concurrent-rotated-refresh-token',
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `google-refresh:${user.id}`,
      );

      // Gate: after callback reads existing grant before final write
      const gate = gateEncryptForUser(user.id, async () => {
        await db
          .update(googleTokens)
          .set({ refreshTokenEnc: validNewAesValue })
          .where(eq(googleTokens.userId, user.id));
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      expect(gate.wasEntered()).toBe(true);

      // CAS 0-row mismatch causes redirect to /onboarding?error=acl_failed
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_failed');

      // The new ciphertext remains in DB and scopes are NOT updated to contain FAMILY_ACL_SCOPE
      const postTokens = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, user.id));
      const postRow = required(postTokens[0], 'Post token row missing');
      expect(postRow.refreshTokenEnc).toBe(validNewAesValue);
      expect(postRow.scopes).not.toContain(FAMILY_ACL_SCOPE);
    });

    it('owner/sessionchange AFTERrechecks duringencrypt gate finalSQL rejects: rejects when session deleted during encrypt gate', async () => {
      const { user, session, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');

      const validToken = await signTestIdToken({ sub: user.googleSub, nonce });
      setupGoogleFetchMock({ idToken: validToken });

      // Gate: after rechecks pass, during encryption before final SQL write
      const gate = gateEncryptForUser(user.id, async () => {
        // Delete session from DB
        await db.delete(sessions).where(eq(sessions.id, session.id));
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      expect(gate.wasEntered()).toBe(true);
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_failed');

      // Scopes in DB not updated
      const postTokens = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, user.id));
      const postRow = required(postTokens[0], 'Token row missing');
      expect(postRow.scopes).not.toContain(FAMILY_ACL_SCOPE);
    });

    it('owner/sessionchange AFTERrechecks duringencrypt gate finalSQL rejects: rejects when family ownership transferred during encrypt gate', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');

      const validToken = await signTestIdToken({ sub: user.googleSub, nonce });
      setupGoogleFetchMock({ idToken: validToken });

      // Seed existing synthetic new user before ownership transfer to satisfy FK constraint
      const newOwnerId = `usr_${crypto.randomUUID()}`;
      await db.insert(users).values({
        id: newOwnerId,
        googleSub: `sub-new-owner-${crypto.randomUUID()}`,
        email: 'newowner2@example.test',
        displayName: 'New Owner User 2',
      });

      // Gate: after rechecks pass, during encryption before final SQL write
      const gate = gateEncryptForUser(user.id, async () => {
        await db.update(families).set({ ownerUserId: newOwnerId }).where(eq(families.id, familyId));
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      expect(gate.wasEntered()).toBe(true);
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_failed');

      const postTokens = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, user.id));
      const postRow = required(postTokens[0], 'Token row missing');
      expect(postRow.scopes).not.toContain(FAMILY_ACL_SCOPE);

      // Assert no other profile or session mutations occurred
      const userCheck = await db.select().from(users).where(eq(users.id, user.id));
      expect(userCheck.length).toBe(1);
      const sessionCheck = await db.select().from(sessions).where(eq(sessions.userId, user.id));
      expect(sessionCheck.length).toBe(1);
    });

    it('absentrowguard: redirects /onboarding?error=acl_failed when user has no existing grant and Google returns no refresh token', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      // Delete existing grant row so user has no stored grant
      await db.delete(googleTokens).where(eq(googleTokens.userId, user.id));

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');

      const validToken = await signTestIdToken({ sub: user.googleSub, nonce });
      // Google returns NO refresh token
      setupGoogleFetchMock({
        idToken: validToken,
        refreshToken: null,
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      // Absent row guard triggers: !encryptedRefresh && !existingToken -> /onboarding?error=acl_failed
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_failed');

      // Still no tokens row in DB
      const postTokens = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, user.id));
      expect(postTokens.length).toBe(0);
    });

    it('conflicting grant 0-row guard: redirects /onboarding?error=acl_failed when grant row is inserted concurrently before INSERT', async () => {
      const { user, sessionJar } = await performLogin();
      const { familyId } = await setupOwnedFamily(user.id);

      // Delete existing grant row so user has no stored grant initially
      await db.delete(googleTokens).where(eq(googleTokens.userId, user.id));

      const { authUrl, oauthJar } = await requestFamilyAclUrl(familyId, sessionJar);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');

      const validToken = await signTestIdToken({ sub: user.googleSub, nonce });
      setupGoogleFetchMock({
        idToken: validToken,
        refreshToken: 'new-google-refresh-token',
      });

      // Gate: after checking that existingTokens was absent, during encryption before INSERT
      const concurrentCiphertext = await encryptAesGcm(
        'concurrent-first-grant-refresh',
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `google-refresh:${user.id}`,
      );

      const gate = gateEncryptForUser(user.id, async () => {
        // Concurrently insert a conflicting grant for this user
        await db.insert(googleTokens).values({
          userId: user.id,
          refreshTokenEnc: concurrentCiphertext,
          scopes: PHASE1_SCOPES.join(' '),
          updatedAt: Math.floor(Date.now() / 1000),
        });
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: cookieHeaderFromJar({
              ...oauthJar,
              [SESSION_COOKIE_NAME]: required(
                sessionJar[SESSION_COOKIE_NAME],
                'Session cookie missing',
              ),
            }),
          },
        },
        TEST_AUTH_ENV,
      );

      expect(gate.wasEntered()).toBe(true);

      // Atomic INSERT ... WHERE NOT EXISTS (SELECT 1 FROM google_tokens ...) produces 0 rows
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/onboarding?error=acl_failed');

      // Pre-existing conflicting row is preserved and NOT overwritten
      const postTokens = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, user.id));
      expect(postTokens.length).toBe(1);
      const postRow = required(postTokens[0], 'Conflicting token row missing');
      expect(postRow.refreshTokenEnc).toBe(concurrentCiphertext);
      expect(postRow.scopes).not.toContain(FAMILY_ACL_SCOPE);
    });
  });

  describe('8. Invite Continuation & Security Boundaries', () => {
    it('invite login denial returns to the validated invite fragment with a fixed cancellation code', async () => {
      const inviteToken = 'B'.repeat(43);
      const loginRes = await app.request(
        'http://localhost:5173/api/auth/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'http://localhost:5173',
          },
          body: JSON.stringify({ inviteToken }),
        },
        TEST_AUTH_ENV,
      );
      const authUrl = new URL(
        authLoginResponseSchema.parse(await loginRes.json()).authorizationUrl,
      );
      const state = required(authUrl.searchParams.get('state'), 'State missing');

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?error=access_denied&error_description=private-value&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(extractCookies(loginRes)) } },
        TEST_AUTH_ENV,
      );

      await expectCallbackFailure(cbRes, `/invite?error=access_denied#${inviteToken}`);
      expect(await cbRes.text()).not.toContain('private-value');
    });

    it('invite logincontinuationexplicitfragment: redirects /invite#TOKEN after successful login', async () => {
      const inviteToken = 'B'.repeat(43);

      const loginRes = await app.request(
        'http://localhost:5173/api/auth/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'http://localhost:5173',
          },
          body: JSON.stringify({ inviteToken }),
        },
        TEST_AUTH_ENV,
      );
      expect(loginRes.status).toBe(200);
      const loginJar = extractCookies(loginRes);
      const body = await loginRes.json();
      const authUrl = new URL(authLoginResponseSchema.parse(body).authorizationUrl);
      const state = required(authUrl.searchParams.get('state'), 'State missing');
      const nonce = required(authUrl.searchParams.get('nonce'), 'Nonce missing');

      const signedToken = await signTestIdToken({ nonce });
      setupGoogleFetchMock({
        idToken: signedToken,
        refreshToken: 'invite-user-refresh',
        scope: PHASE1_SCOPES.join(' '),
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(loginJar) } },
        TEST_AUTH_ENV,
      );

      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe(`/invite#${inviteToken}`);
    });

    it('maliciousreturnURL rejection: GET /api/auth/login rejects returnUrl query param', async () => {
      const res = await app.request(
        'http://localhost:5173/api/auth/login?returnUrl=https://evil.test/steal',
        {},
        TEST_AUTH_ENV,
      );
      expect(res.status).toBe(400);
      expect(apiErrorResponseSchema.parse(await res.json())).toEqual({
        error: 'Invalid query parameters',
      });
    });

    it('maliciousreturnURL rejection: POST /api/auth/login rejects returnUrl in query or body', async () => {
      // Query param injection
      const res1 = await app.request(
        'http://localhost:5173/api/auth/login?returnUrl=https://evil.test',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'http://localhost:5173',
          },
          body: JSON.stringify({ inviteToken: 'C'.repeat(43) }),
        },
        TEST_AUTH_ENV,
      );
      expect(res1.status).toBe(400);

      // Body extra param injection (strict schema)
      const res2 = await app.request(
        'http://localhost:5173/api/auth/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'http://localhost:5173',
          },
          body: JSON.stringify({
            inviteToken: 'C'.repeat(43),
            returnUrl: 'https://evil.test',
          }),
        },
        TEST_AUTH_ENV,
      );
      expect(res2.status).toBe(400);
    });

    it('POST /api/auth/login enforces CSRF guards (XMLHttpRequest and Origin)', async () => {
      // Missing XMLHttpRequest
      const res1 = await app.request(
        'http://localhost:5173/api/auth/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://localhost:5173',
          },
          body: JSON.stringify({ inviteToken: 'D'.repeat(43) }),
        },
        TEST_AUTH_ENV,
      );
      expect(res1.status).toBe(403);

      // Mismatched Origin
      const res2 = await app.request(
        'http://localhost:5173/api/auth/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'https://attacker.example.test',
          },
          body: JSON.stringify({ inviteToken: 'D'.repeat(43) }),
        },
        TEST_AUTH_ENV,
      );
      expect(res2.status).toBe(403);
    });

    it('POST /api/auth/login body limit: rejects bodies exceeding 2048 bytes with 413', async () => {
      const largePayload = {
        inviteToken: 'E'.repeat(43),
        padding: 'X'.repeat(3000),
      };

      const res = await app.request(
        'http://localhost:5173/api/auth/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'http://localhost:5173',
          },
          body: JSON.stringify(largePayload),
        },
        TEST_AUTH_ENV,
      );
      expect(res.status).toBe(413);
      expect(apiErrorResponseSchema.parse(await res.json())).toEqual({
        error: 'Payload Too Large',
      });
    });
  });
});
