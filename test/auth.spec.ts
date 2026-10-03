import { env } from 'cloudflare:test';
import { authLogoutResponseSchema, authMeResponseSchema } from '@shared/schemas/auth';
import { apiErrorResponseSchema } from '@shared/schemas/errors';
import {
  OAUTH_COOKIE_NAME,
  PHASE1_SCOPES,
  SESSION_COOKIE_NAME,
  getTrustedAppOrigin,
} from '@worker/auth/config';
import {
  decryptAesGcm,
  encryptAesGcm,
  parseAes256Key,
  sha256Hex,
  uint8ArrayToBase64Url,
} from '@worker/auth/crypto';
import { createDb } from '@worker/db';
import { googleTokens, oauthStates, sessions, users } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import {
  GoogleApiError,
  GoogleAuthError,
  ReauthNeededError,
  getGoogleAccessToken,
  validateAndNormalizeScopes,
} from '@worker/google/oauth';
import { app, createApp } from '@worker/index';
import { and, eq } from 'drizzle-orm';
import { type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 32 ASCII '0' bytes in standard base64 (canonical, no nonzero pad bits)
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
let evilKeyPair: Awaited<ReturnType<typeof generateKeyPair>>;
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
  customKid?: string;
  omitExp?: boolean;
  omitIat?: boolean;
  omitSub?: boolean;
  omitNonce?: boolean;
}

async function signTestIdToken(
  claims: SignTestTokenOptions,
  keyPair = testKeyPair,
): Promise<string> {
  const iat = claims.iat ?? Math.floor(Date.now() / 1000);
  const exp = claims.exp ?? iat + 3600;

  const payload: Record<string, unknown> = {
    email: claims.email ?? 'synthetic.user@example.test',
    email_verified: claims.email_verified ?? true,
    name: claims.name ?? 'Synthetic Test User',
    azp: claims.azp ?? TEST_AUTH_ENV.GOOGLE_CLIENT_ID,
  };

  if (!claims.omitSub) {
    payload.sub = claims.sub ?? 'google-sub-synthetic-12345';
  }
  if (!claims.omitNonce && claims.nonce !== undefined) {
    payload.nonce = claims.nonce;
  }

  const signer = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: claims.customKid ?? 'test-jwk-key-1' })
    .setIssuer(claims.iss ?? 'https://accounts.google.com')
    .setAudience(claims.aud ?? TEST_AUTH_ENV.GOOGLE_CLIENT_ID);

  if (!claims.omitIat) {
    signer.setIssuedAt(iat);
  }
  if (!claims.omitExp) {
    signer.setExpirationTime(exp);
  }

  return await signer.sign(keyPair.privateKey);
}

interface SetupFetchMockOptions {
  idToken?: string;
  accessToken?: string;
  refreshToken?: string | null;
  tokenStatus?: number;
  tokenBody?: unknown;
  rawResponseBody?: string;
  contentType?: string;
  onTokenRequest?: (req: Request, params: URLSearchParams) => void | Promise<void>;
  tokenRouter?: (req: Request, params: URLSearchParams) => Response | Promise<Response>;
}

function setupGoogleFetchMock(options: SetupFetchMockOptions = {}) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    // Tests workerd runtime compatibility: Request constructor with redirect: 'manual'
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
      const contentType = req.headers.get('content-type') ?? '';
      expect(contentType).toContain('application/x-www-form-urlencoded');

      const bodyBuffer = await req.clone().arrayBuffer();
      const bodyText = new TextDecoder().decode(bodyBuffer);
      const bodyParams = new URLSearchParams(bodyText);

      if (options.onTokenRequest) {
        await options.onTokenRequest(req, bodyParams);
      }

      if (options.tokenRouter) {
        return await options.tokenRouter(req, bodyParams);
      }

      if (options.rawResponseBody !== undefined) {
        return new Response(options.rawResponseBody, {
          status: options.tokenStatus ?? 200,
          headers: { 'Content-Type': options.contentType ?? 'application/json' },
        });
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
        scope: PHASE1_SCOPES.join(' '),
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

async function initiateLogin(appInstance = app, envOverride: WorkerEnv = TEST_AUTH_ENV) {
  const loginRes = await appInstance.request(
    'http://localhost:5173/api/auth/login',
    {},
    envOverride,
  );
  expect(loginRes.status).toBe(302);
  const jar = extractCookies(loginRes);
  const locationHeader = loginRes.headers.get('Location');
  const location = new URL(required(locationHeader, 'Location header missing on login redirect'));
  const state = required(location.searchParams.get('state'), 'State missing on login redirect');
  const nonce = required(location.searchParams.get('nonce'), 'Nonce missing on login redirect');
  const challenge = required(
    location.searchParams.get('code_challenge'),
    'Challenge missing on login redirect',
  );

  return {
    res: loginRes,
    jar,
    location,
    state,
    nonce,
    challenge,
  };
}

async function initiateInviteLogin(inviteToken: string) {
  const response = await app.request(
    'http://localhost:5173/api/auth/login',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: TEST_AUTH_ENV.APP_ORIGIN,
      },
      body: JSON.stringify({ inviteToken }),
    },
    TEST_AUTH_ENV,
  );
  expect(response.status).toBe(200);
  const jar = extractCookies(response);
  const body = (await response.json()) as { authorizationUrl: string };
  const authorizationUrl = new URL(body.authorizationUrl);
  return {
    jar,
    state: required(authorizationUrl.searchParams.get('state')),
    nonce: required(authorizationUrl.searchParams.get('nonce')),
  };
}

describe('Task 1-1: Google OAuth & Authentication', () => {
  const db = createDb(env.DB);

  beforeAll(async () => {
    testKeyPair = await generateKeyPair('RS256');
    evilKeyPair = await generateKeyPair('RS256');
    const exported = await exportJWK(testKeyPair.publicKey);
    testPublicJwk = {
      ...exported,
      kid: 'test-jwk-key-1',
      alg: 'RS256',
      use: 'sig',
    };
  });

  beforeEach(async () => {
    // Strict unexpected network denial in beforeEach for all tests
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      throw new Error(`Unexpected network call intercepted: ${urlStr}`);
    });

    // Storage isolation
    await db.delete(oauthStates);
    await db.delete(sessions);
    await db.delete(googleTokens);
    await db.delete(users);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    try {
      await db.delete(oauthStates);
      await db.delete(sessions);
      await db.delete(googleTokens);
      await db.delete(users);
    } catch {
      // Ignore cleanup error if tables not yet created
    }
  });

  describe('1. Unconfigured State, Origin Guards & Health Independence', () => {
    it('returns 503 fail-closed when auth secrets are unconfigured, while /api/health succeeds', async () => {
      const unconfiguredEnv: WorkerEnv = {
        ...env,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        SESSION_SECRET: undefined,
        TOKEN_ENC_KEY: undefined,
      };

      // 1. /api/auth/login returns safe 503
      const loginRes = await app.request(
        'http://localhost:5173/api/auth/login',
        {},
        unconfiguredEnv,
      );
      expect(loginRes.status).toBe(503);
      const loginBody = await loginRes.json();
      expect(apiErrorResponseSchema.parse(loginBody)).toEqual({
        error: 'Auth service unconfigured',
      });
      expect(loginRes.headers.get('Cache-Control')).toBe('no-store');

      // Callback failures always redirect to a fixed safe destination.
      const cbRes = await app.request(
        'http://localhost:5173/api/auth/callback',
        {},
        unconfiguredEnv,
      );
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_expired');
      expect(cbRes.headers.get('set-cookie')).toContain('Max-Age=0');

      const postCallbackRes = await app.request(
        'http://localhost:5173/api/auth/callback',
        { method: 'POST' },
        unconfiguredEnv,
      );
      expect(postCallbackRes.status).toBe(503);
      expect(apiErrorResponseSchema.parse(await postCallbackRes.json())).toEqual({
        error: 'Auth service unconfigured',
      });

      // 3. /api/auth/me returns safe 503 when unconfigured (fail-closed middleware)
      const meRes = await app.request('http://localhost:5173/api/auth/me', {}, unconfiguredEnv);
      expect(meRes.status).toBe(503);

      // 4. /api/auth/logout returns safe 503
      const logoutRes = await app.request(
        'http://localhost:5173/api/auth/logout',
        {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'http://localhost:5173',
          },
        },
        unconfiguredEnv,
      );
      expect(logoutRes.status).toBe(503);

      // 5. /api/health remains untouched and healthy (status 200) without secrets
      const healthRes = await app.request('http://localhost:5173/api/health', {}, unconfiguredEnv);
      expect(healthRes.status).toBe(200);
      const healthBody = await healthRes.json();
      expect(healthBody).toEqual({ ok: true });
    });

    it('returns 404 JSON on /api/unknown without auth secrets, and 404 JSON with no-store on /api/auth/unknown with auth secrets', async () => {
      const unconfiguredEnv: WorkerEnv = {
        ...env,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        SESSION_SECRET: undefined,
        TOKEN_ENC_KEY: undefined,
      };

      // 1. /api/unknown without secrets returns 404 JSON, NOT 503
      const unknownApiRes = await app.request(
        'http://localhost:5173/api/unknown-nonexistent-route',
        {},
        unconfiguredEnv,
      );
      expect(unknownApiRes.status).toBe(404);
      const unknownApiBody = await unknownApiRes.json();
      expect(apiErrorResponseSchema.parse(unknownApiBody)).toEqual({ error: 'Not Found' });

      // 2. /api/auth/unknown with configured secrets returns 404 JSON with Cache-Control: no-store
      const unknownAuthRes = await app.request(
        'http://localhost:5173/api/auth/unknown-endpoint',
        {},
        TEST_AUTH_ENV,
      );
      expect(unknownAuthRes.status).toBe(404);
      expect(unknownAuthRes.headers.get('Cache-Control')).toBe('no-store');
      const unknownAuthBody = await unknownAuthRes.json();
      expect(apiErrorResponseSchema.parse(unknownAuthBody)).toEqual({ error: 'Not Found' });
    });

    it('returns safe 503 when APP_ORIGIN is missing or invalid', async () => {
      const invalidOriginEnv: WorkerEnv = {
        ...TEST_AUTH_ENV,
        APP_ORIGIN: undefined as unknown as string,
      };

      const res = await app.request('http://localhost:5173/api/auth/login', {}, invalidOriginEnv);
      expect(res.status).toBe(503);
      expect(apiErrorResponseSchema.parse(await res.json())).toEqual({
        error: 'Auth service unconfigured',
      });
    });

    it('enforces HTTPS for remote APP_ORIGIN (rejecting non-localhost HTTP) and fails closed with 503', async () => {
      const nonHttpsEnv: WorkerEnv = {
        ...TEST_AUTH_ENV,
        APP_ORIGIN: 'http://danran.example.com',
      };

      const res = await app.request('http://danran.example.com/api/auth/login', {}, nonHttpsEnv);
      expect(res.status).toBe(503);
      expect(apiErrorResponseSchema.parse(await res.json())).toEqual({
        error: 'Auth service unconfigured',
      });

      expect(() => getTrustedAppOrigin(nonHttpsEnv)).toThrow(
        'APP_ORIGIN must use HTTPS (HTTP is allowed only for localhost)',
      );
    });

    it('returns safe 503 when TOKEN_ENC_KEY is not canonical base64 or wrong length', async () => {
      const nonCanonicalEnv: WorkerEnv = {
        ...TEST_AUTH_ENV,
        TOKEN_ENC_KEY: `${TEST_AES_KEY_BASE64.slice(0, -2)}B=`,
      };

      const res = await app.request('http://localhost:5173/api/auth/login', {}, nonCanonicalEnv);
      expect(res.status).toBe(503);
    });

    it('enforces request origin === configured APP_ORIGIN on all auth endpoints with 403 and zero DB/fetch side effects', async () => {
      const wrongOrigin = 'http://attacker.example.test:8080';

      // 1. Login with wrong origin
      const loginRes = await app.request(`${wrongOrigin}/api/auth/login`, {}, TEST_AUTH_ENV);
      expect(loginRes.status).toBe(403);
      expect(apiErrorResponseSchema.parse(await loginRes.json())).toEqual({
        error: 'Forbidden',
      });

      // 2. Callback with wrong origin
      const cbRes = await app.request(
        `${wrongOrigin}/api/auth/callback?code=mock&state=mock`,
        {},
        TEST_AUTH_ENV,
      );
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_expired');
      expect(cbRes.headers.get('set-cookie')).toContain('Max-Age=0');

      // 3. Me with wrong origin
      const meRes = await app.request(`${wrongOrigin}/api/auth/me`, {}, TEST_AUTH_ENV);
      expect(meRes.status).toBe(403);
      expect(apiErrorResponseSchema.parse(await meRes.json())).toEqual({
        error: 'Forbidden',
      });

      // 4. Logout with wrong origin
      const logoutRes = await app.request(
        `${wrongOrigin}/api/auth/logout`,
        {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_AUTH_ENV.APP_ORIGIN,
          },
        },
        TEST_AUTH_ENV,
      );
      expect(logoutRes.status).toBe(403);
      expect(apiErrorResponseSchema.parse(await logoutRes.json())).toEqual({
        error: 'Forbidden',
      });

      // Assert zero database side effects
      expect((await db.select().from(oauthStates)).length).toBe(0);
      expect((await db.select().from(sessions)).length).toBe(0);
      expect((await db.select().from(users)).length).toBe(0);
    });
  });

  describe('2. Login Initiation, Exact Scopes & Security Headers', () => {
    it('redirects to Google with valid PKCE challenge, state, nonce, exact scopes, and HttpOnly cookie', async () => {
      const { res, jar, location, state, nonce, challenge } = await initiateLogin();

      expect(res.status).toBe(302);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');

      expect(location.origin).toBe('https://accounts.google.com');
      expect(location.pathname).toBe('/o/oauth2/v2/auth');
      expect(location.searchParams.get('client_id')).toBe(TEST_AUTH_ENV.GOOGLE_CLIENT_ID);
      expect(location.searchParams.get('redirect_uri')).toBe(
        'http://localhost:5173/api/auth/callback',
      );
      expect(location.searchParams.get('response_type')).toBe('code');
      expect(location.searchParams.get('access_type')).toBe('offline');
      expect(location.searchParams.get('prompt')).toBe('consent');
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');

      // Assert exact scope set, not just contains
      const rawScopeParam = required(location.searchParams.get('scope'));
      const rawScopes = rawScopeParam.split(' ').sort();
      expect(rawScopes).toEqual([...PHASE1_SCOPES].sort());

      expect(state.length).toBeGreaterThan(16);
      expect(nonce.length).toBeGreaterThan(16);
      expect(challenge.length).toBeGreaterThan(16);

      // Verify cookie flags: HttpOnly, Secure, SameSite=Lax, Max-Age=600, Path=/
      expect(jar[OAUTH_COOKIE_NAME]).toBeDefined();
      const rawSetCookie = res.headers.get('set-cookie') ?? '';
      expect(rawSetCookie).toContain('Max-Age=600');
      expect(rawSetCookie).toContain('HttpOnly');
      expect(rawSetCookie).toContain('Secure');
      expect(rawSetCookie).toContain('SameSite=Lax');
      expect(rawSetCookie).toContain('Path=/');

      // Verify transient DB record: payload is encrypted, not plaintext
      const stateHash = await sha256Hex(state);
      const stateRows = await db
        .select()
        .from(oauthStates)
        .where(eq(oauthStates.stateHash, stateHash));
      expect(stateRows.length).toBe(1);
      const stateRow = required(stateRows[0]);
      expect(stateRow.payloadEnc).not.toContain(nonce);
      expect(stateRow.payloadEnc.startsWith('v1.')).toBe(true);
    });

    it('derives redirect_uri from non-default valid HTTPS APP_ORIGIN for both login authorization and callback token exchange', async () => {
      const customOrigin = 'https://danran-staging.tak-ikemachi.workers.dev';
      const customEnv: WorkerEnv = {
        ...TEST_AUTH_ENV,
        APP_ORIGIN: customOrigin,
      };

      // 1. GET /api/auth/login with custom HTTPS APP_ORIGIN
      const loginRes = await app.request(`${customOrigin}/api/auth/login`, {}, customEnv);
      expect(loginRes.status).toBe(302);
      const jar = extractCookies(loginRes);
      const location = new URL(
        required(loginRes.headers.get('Location'), 'Missing Location on login redirect'),
      );
      expect(location.searchParams.get('redirect_uri')).toBe(`${customOrigin}/api/auth/callback`);
      const state = required(location.searchParams.get('state'), 'Missing state');
      const nonce = required(location.searchParams.get('nonce'), 'Missing nonce');

      // 2. GET /api/auth/callback token exchange verifies redirect_uri sent to Google matches configured APP_ORIGIN
      const signedIdToken = await signTestIdToken({ nonce });
      let tokenExchangeRedirectUri: string | null = null;
      setupGoogleFetchMock({
        idToken: signedIdToken,
        onTokenRequest: async (_req, params) => {
          tokenExchangeRedirectUri = params.get('redirect_uri');
        },
      });

      const cbRes = await app.request(
        `${customOrigin}/api/auth/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        customEnv,
      );

      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/');
      expect(tokenExchangeRedirectUri).toBe(`${customOrigin}/api/auth/callback`);
    });
  });

  describe('3. Callback Denial & State Consumption', () => {
    it('consumes matching valid state and browser binding on OAuth denial, restores access_denied, and clears cookie', async () => {
      const { jar, state } = await initiateLogin();
      const stateHash = await sha256Hex(state);
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      // Denial callback with valid state and valid cookie
      const cancelRes = await app.request(
        `http://localhost:5173/api/auth/callback?error=access_denied&error_description=User%20denied%20consent&state=${encodeURIComponent(state)}`,
        {
          headers: { Cookie: cookieHeaderFromJar(jar) },
        },
        TEST_AUTH_ENV,
      );

      expect(cancelRes.status).toBe(302);
      expect(cancelRes.headers.get('Location')).toBe('/?error=access_denied');
      expect(cancelRes.headers.get('Cache-Control')).toBe('no-store');
      expect(cancelRes.headers.get('Pragma')).toBe('no-cache');
      expect(cancelRes.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(cancelRes.headers.get('set-cookie')).toContain('Path=/');
      expect(cancelRes.headers.get('set-cookie')).toContain('Max-Age=0');
      expect(cancelRes.headers.get('set-cookie')).toContain('HttpOnly');
      expect(cancelRes.headers.get('set-cookie')).toContain('Secure');
      expect(await cancelRes.text()).not.toContain('User denied consent');
      expect(fetchSpy).not.toHaveBeenCalled();

      // Ensure cookie is cleared with HttpOnly
      const cancelSetCookie = cancelRes.headers.get('set-cookie') ?? '';
      expect(cancelSetCookie).toContain('Max-Age=0');
      expect(cancelSetCookie).toContain('HttpOnly');
      expect(cancelSetCookie).toContain('Secure');

      // State must be consumed from DB
      const stateRowsAfter = await db
        .select()
        .from(oauthStates)
        .where(eq(oauthStates.stateHash, stateHash));
      expect(stateRowsAfter.length).toBe(0);

      // Replaying the same denial cannot reuse the consumed flow.
      const replayRes = await app.request(
        `http://localhost:5173/api/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
        {
          headers: { Cookie: cookieHeaderFromJar(jar) },
        },
        TEST_AUTH_ENV,
      );
      expect(replayRes.status).toBe(302);
      expect(replayRes.headers.get('Location')).toBe('/?error=auth_expired');
      await expectCallbackFailure(replayRes, '/?error=auth_expired');
    });

    it('returns invite cancellation to the validated fragment and ignores forged callback destinations', async () => {
      const inviteToken = 'A'.repeat(43);
      const { jar, state } = await initiateInviteLogin(inviteToken);
      const stateHash = await sha256Hex(state);
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const callback = await app.request(
        `http://localhost:5173/api/auth/callback?error=access_denied&error_description=${encodeURIComponent('untrusted-google-detail')}&state=${encodeURIComponent(state)}&inviteToken=${'Z'.repeat(43)}&token=${'Y'.repeat(43)}&returnUrl=https%3A%2F%2Fevil.example`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );

      await expectCallbackFailure(callback, `/invite?error=access_denied#${inviteToken}`);
      expect(await callback.text()).not.toContain('untrusted-google-detail');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(
        (await db.select().from(oauthStates).where(eq(oauthStates.stateHash, stateHash))).length,
      ).toBe(0);
      expect(await db.select().from(users)).toHaveLength(0);
      expect(await db.select().from(googleTokens)).toHaveLength(0);
      expect(await db.select().from(sessions)).toHaveLength(0);

      const replay = await app.request(
        `http://localhost:5173/api/auth/callback?error=access_denied&state=${encodeURIComponent(state)}&inviteToken=${inviteToken}&token=${inviteToken}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      await expectCallbackFailure(replay, '/?error=auth_expired');
      expect(replay.headers.get('Location')).not.toContain('#');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await db.select().from(users)).toHaveLength(0);
      expect(await db.select().from(googleTokens)).toHaveLength(0);
      expect(await db.select().from(sessions)).toHaveLength(0);
    });

    it.each(['missing', 'mismatched'] as const)(
      'rejects invite callback with %s browser binding without consuming state or restoring token',
      async (bindingCase) => {
        const inviteToken = 'E'.repeat(43);
        const first = await initiateInviteLogin(inviteToken);
        const second = await initiateInviteLogin('F'.repeat(43));
        const firstHash = await sha256Hex(first.state);
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        const cookie = bindingCase === 'missing' ? undefined : cookieHeaderFromJar(second.jar);
        const callback = await app.request(
          `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(first.state)}&token=${inviteToken}&inviteToken=${inviteToken}`,
          { headers: cookie ? { Cookie: cookie } : {} },
          TEST_AUTH_ENV,
        );
        await expectCallbackFailure(callback, '/?error=auth_expired');
        expect(callback.headers.get('Location')).not.toContain(inviteToken);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(
          await db.select().from(oauthStates).where(eq(oauthStates.stateHash, firstHash)),
        ).toHaveLength(1);
        expect(await db.select().from(users)).toHaveLength(0);
        expect(await db.select().from(googleTokens)).toHaveLength(0);
        expect(await db.select().from(sessions)).toHaveLength(0);

        const legitimateDenial = await app.request(
          `http://localhost:5173/api/auth/callback?error=access_denied&state=${encodeURIComponent(first.state)}`,
          { headers: { Cookie: cookieHeaderFromJar(first.jar) } },
          TEST_AUTH_ENV,
        );
        await expectCallbackFailure(legitimateDenial, `/invite?error=access_denied#${inviteToken}`);
        expect(
          await db.select().from(oauthStates).where(eq(oauthStates.stateHash, firstHash)),
        ).toHaveLength(0);
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );

    it('does not restore an invite token when state validation fails before consumption', async () => {
      const inviteToken = 'D'.repeat(43);
      const { jar, state } = await initiateInviteLogin(inviteToken);
      const stateHash = await sha256Hex(state);
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const callback = await app.request(
        `http://localhost:5173/api/auth/callback?error=access_denied&state=forged-state&inviteToken=${inviteToken}&token=${inviteToken}&returnUrl=https%3A%2F%2Fevil.example`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );

      await expectCallbackFailure(callback, '/?error=auth_expired');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(
        await db.select().from(oauthStates).where(eq(oauthStates.stateHash, stateHash)),
      ).toHaveLength(1);
      expect(await db.select().from(users)).toHaveLength(0);
    });

    it.each([
      ['token exchange', () => ({ tokenStatus: 400, tokenBody: { error: 'invalid_grant' } })],
      [
        'missing ID token',
        () => ({
          tokenBody: {
            access_token: 'mock-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: PHASE1_SCOPES.join(' '),
            refresh_token: 'mock-refresh',
          },
        }),
      ],
      ['ID token validation', () => ({ idToken: 'not-a-valid-jwt' })],
      [
        'partial scopes',
        async (nonce: string) => ({
          tokenBody: {
            access_token: 'mock-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'openid email',
            id_token: await signTestIdToken({ nonce }),
            refresh_token: 'mock-refresh',
          },
        }),
      ],
      [
        'missing refresh token',
        async (nonce: string) => ({
          idToken: await signTestIdToken({ nonce }),
          refreshToken: null,
        }),
      ],
    ])('returns invite continuation after %s failure', async (_label, makeGoogleOptions) => {
      const inviteToken = 'B'.repeat(43);
      const { jar, state, nonce } = await initiateInviteLogin(inviteToken);
      setupGoogleFetchMock(await makeGoogleOptions(nonce));

      const callback = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}&inviteToken=${'Z'.repeat(43)}&returnUrl=https%3A%2F%2Fevil.example`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );

      await expectCallbackFailure(callback, `/invite?error=auth_failed#${inviteToken}`);
      expect(await db.select().from(users)).toHaveLength(0);
      expect(await db.select().from(googleTokens)).toHaveLength(0);
      expect(await db.select().from(sessions)).toHaveLength(0);
    });

    it('returns invite auth_failed when an unexpected post-consumption database failure escapes', async () => {
      const inviteToken = 'C'.repeat(43);
      const { jar, state, nonce } = await initiateInviteLogin(inviteToken);
      setupGoogleFetchMock({ idToken: await signTestIdToken({ nonce }) });

      const originalPrepare = TEST_AUTH_ENV.DB.prepare.bind(TEST_AUTH_ENV.DB);
      const prepareSpy = vi.spyOn(TEST_AUTH_ENV.DB, 'prepare').mockImplementation((query) => {
        if (/sessions/i.test(query)) throw new Error('synthetic session lookup fault');
        return originalPrepare(query);
      });

      const callback = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );

      await expectCallbackFailure(callback, `/invite?error=auth_failed#${inviteToken}`);
      expect(prepareSpy).toHaveBeenCalled();
      prepareSpy.mockRestore();
    });

    it('rejects OAuth denial callback when state is missing, without touching Google or DB', async () => {
      const cancelRes = await app.request(
        'http://localhost:5173/api/auth/callback?error=access_denied',
        {},
        TEST_AUTH_ENV,
      );
      expect(cancelRes.status).toBe(302);
      expect(cancelRes.headers.get('Location')).toBe('/?error=auth_expired');
    });
  });

  describe('4. Token Exchange, S256 Challenge & Workerd Runtime Compatibility', () => {
    it('verifies token exchange POST body, parameters, and that code_verifier matches S256 challenge from login', async () => {
      const { jar, state, nonce, challenge } = await initiateLogin();
      const signedIdToken = await signTestIdToken({ nonce });

      let tokenRequestVerified = false;
      setupGoogleFetchMock({
        idToken: signedIdToken,
        onTokenRequest: async (_req, params) => {
          tokenRequestVerified = true;
          expect(params.get('grant_type')).toBe('authorization_code');
          expect(params.get('client_id')).toBe(TEST_AUTH_ENV.GOOGLE_CLIENT_ID);
          expect(params.get('client_secret')).toBe(TEST_AUTH_ENV.GOOGLE_CLIENT_SECRET);
          expect(params.get('redirect_uri')).toBe('http://localhost:5173/api/auth/callback');
          expect(params.get('code')).toBe('synthetic-auth-code');

          const codeVerifier = required(params.get('code_verifier'));
          const computedChallenge = await computeS256Challenge(codeVerifier);
          expect(computedChallenge).toBe(challenge);
        },
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=synthetic-auth-code&state=${encodeURIComponent(state)}`,
        {
          headers: { Cookie: cookieHeaderFromJar(jar) },
        },
        TEST_AUTH_ENV,
      );

      expect(cbRes.status).toBe(302);
      expect(tokenRequestVerified).toBe(true);
    });

    it('constructs outgoing token request with redirect: manual and rejects 3xx redirect responses without following or leaking credentials', async () => {
      const { jar, state, nonce } = await initiateLogin();
      const _signedIdToken = await signTestIdToken({ nonce });

      let redirectOptionObserved: string | undefined;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        redirectOptionObserved = init?.redirect;
        // Verify workerd runtime Request constructor compatibility with redirect: 'manual'
        const req = new Request(input, init);
        expect(req.method).toBe('POST');
        // Return 302 redirect response: edge runtime must not follow and must reject
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://evil-redirect.example.test/leak' },
        });
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );

      expect(redirectOptionObserved).toBe('manual');
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_failed');
    });

    it('redirects safely when Google token endpoint returns a non-JSON body', async () => {
      const { jar, state } = await initiateLogin();
      setupGoogleFetchMock({
        rawResponseBody: '<html><body>Internal Gateway Error</body></html>',
        contentType: 'text/html',
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        {
          headers: { Cookie: cookieHeaderFromJar(jar) },
        },
        TEST_AUTH_ENV,
      );
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_failed');
    });

    it('redirects when Google returns partial scopes missing calendar permissions', async () => {
      const { jar, state, nonce } = await initiateLogin();
      const signedIdToken = await signTestIdToken({ nonce });

      setupGoogleFetchMock({
        idToken: signedIdToken,
        tokenBody: {
          access_token: 'mock-partial-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'openid email profile', // Missing required calendar permissions
          id_token: signedIdToken,
          refresh_token: 'mock-refresh',
        },
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        {
          headers: { Cookie: cookieHeaderFromJar(jar) },
        },
        TEST_AUTH_ENV,
      );
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_failed');
    });
  });

  describe('5. Real Cryptographic ID Token Verification Failures', () => {
    it('rejects ID token with bad signature (signed with untrusted private key)', async () => {
      const { jar, state, nonce } = await initiateLogin();
      const badSigToken = await signTestIdToken({ nonce }, evilKeyPair);

      setupGoogleFetchMock({ idToken: badSigToken });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_failed');
    });

    it('rejects expired ID token (exp in the past)', async () => {
      const { jar, state, nonce } = await initiateLogin();
      const now = Math.floor(Date.now() / 1000);
      const expiredToken = await signTestIdToken({
        nonce,
        iat: now - 7200,
        exp: now - 3600,
      });

      setupGoogleFetchMock({ idToken: expiredToken });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_failed');
    });

    it('rejects ID token with untrusted issuer', async () => {
      const { jar, state, nonce } = await initiateLogin();
      const badIssToken = await signTestIdToken({
        nonce,
        iss: 'https://evil.accounts.test',
      });

      setupGoogleFetchMock({ idToken: badIssToken });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_failed');
    });

    it('rejects ID token with wrong audience', async () => {
      const { jar, state, nonce } = await initiateLogin();
      const badAudToken = await signTestIdToken({
        nonce,
        aud: 'completely-wrong-client-id.apps.googleusercontent.com',
      });

      setupGoogleFetchMock({ idToken: badAudToken });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_failed');
    });

    it('rejects ID token missing required claims: sub, exp, iat, or nonce', async () => {
      const testCases = [
        { label: 'missing sub', claims: { omitSub: true } },
        { label: 'missing exp', claims: { omitExp: true } },
        { label: 'missing iat', claims: { omitIat: true } },
        { label: 'missing nonce', claims: { omitNonce: true } },
      ];

      for (const tc of testCases) {
        const { jar, state, nonce } = await initiateLogin();
        const invalidToken = await signTestIdToken({
          nonce,
          ...tc.claims,
        });

        setupGoogleFetchMock({ idToken: invalidToken });

        const cbRes = await app.request(
          `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
          { headers: { Cookie: cookieHeaderFromJar(jar) } },
          TEST_AUTH_ENV,
        );
        expect(cbRes.status, `Failed for ${tc.label}`).toBe(302);
        expect(cbRes.headers.get('Location')).toBe('/?error=auth_failed');
      }
    });

    it('rejects ID token when nonce does not match session', async () => {
      const { jar, state } = await initiateLogin();
      const mismatchedNonceToken = await signTestIdToken({
        nonce: 'different-mismatched-nonce',
      });

      setupGoogleFetchMock({ idToken: mismatchedNonceToken });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_failed');
    });

    it('rejects ID token with mismatched azp claim', async () => {
      const { jar, state, nonce } = await initiateLogin();
      const badAzpToken = await signTestIdToken({
        nonce,
        azp: 'another-unauthorized-app.apps.googleusercontent.com',
      });

      setupGoogleFetchMock({ idToken: badAzpToken });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_failed');
    });

    it('rejects ID token with unverified email', async () => {
      const { jar, state, nonce } = await initiateLogin();
      const unverifiedToken = await signTestIdToken({
        nonce,
        email_verified: false,
      });

      setupGoogleFetchMock({ idToken: unverifiedToken });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_failed');
    });
  });

  describe('6. Browser Binding, Replay Prevention & Simultaneous Same-State Callbacks', () => {
    it('enforces single-use atomic consumption: replayed state rejects without Google token exchange', async () => {
      const { jar, state, nonce } = await initiateLogin();
      let tokenExchangeCount = 0;
      const signedIdToken = await signTestIdToken({ nonce });

      setupGoogleFetchMock({
        idToken: signedIdToken,
        onTokenRequest: () => {
          tokenExchangeCount++;
        },
      });

      // First callback consumes the state
      const cb1 = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code-1&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      expect(cb1.status).toBe(302);
      expect(tokenExchangeCount).toBe(1);

      // Replayed callback with same state must fail immediately without second token exchange
      const cb2 = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code-2&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      expect(cb2.status).toBe(302);
      expect(cb2.headers.get('Location')).toBe('/?error=auth_expired');
      expect(tokenExchangeCount).toBe(1);
    });

    it('ensures simultaneous concurrent callbacks with the exact same state execute only one Google exchange', async () => {
      const flow = await initiateLogin();
      const signedToken = await signTestIdToken({ nonce: flow.nonce });

      let googleTokenExchangeCount = 0;
      setupGoogleFetchMock({
        idToken: signedToken,
        onTokenRequest: () => {
          googleTokenExchangeCount++;
        },
      });

      // Simultaneous Promise.all execution with identical code and state
      const [res1, res2] = await Promise.all([
        app.request(
          `http://localhost:5173/api/auth/callback?code=mock-same-code&state=${encodeURIComponent(flow.state)}`,
          { headers: { Cookie: cookieHeaderFromJar(flow.jar) } },
          TEST_AUTH_ENV,
        ),
        app.request(
          `http://localhost:5173/api/auth/callback?code=mock-same-code&state=${encodeURIComponent(flow.state)}`,
          { headers: { Cookie: cookieHeaderFromJar(flow.jar) } },
          TEST_AUTH_ENV,
        ),
      ]);

      // Exactly one Google exchange occurred
      expect(googleTokenExchangeCount).toBe(1);

      // One request succeeds and one gets the fixed pre-consumption failure redirect.
      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([302, 302]);
      const locations = [res1.headers.get('Location'), res2.headers.get('Location')].sort();
      expect(locations).toEqual(['/', '/?error=auth_expired']);
    });

    it('rejects callback with expired state in DB', async () => {
      const { jar, state } = await initiateLogin();
      const stateHash = await sha256Hex(state);

      // Force state expiry into past
      await db
        .update(oauthStates)
        .set({ expiresAt: Math.floor(Date.now() / 1000) - 30 })
        .where(eq(oauthStates.stateHash, stateHash));

      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      await expectCallbackFailure(cbRes, '/?error=auth_expired');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('redirects auth_expired when state hashing throws and does not call Google', async () => {
      const { jar, state } = await initiateLogin();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const digestSpy = vi
        .spyOn(crypto.subtle, 'digest')
        .mockRejectedValue(new Error('crypto fault'));

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );

      await expectCallbackFailure(cbRes, '/?error=auth_expired');
      expect(fetchSpy).not.toHaveBeenCalled();
      digestSpy.mockRestore();
    });

    it('redirects auth_expired when state consumption fails in D1 and leaves OAuth state untouched', async () => {
      const { jar, state } = await initiateLogin();
      const stateHash = await sha256Hex(state);
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const originalPrepare = TEST_AUTH_ENV.DB.prepare.bind(TEST_AUTH_ENV.DB);
      const prepareSpy = vi.spyOn(TEST_AUTH_ENV.DB, 'prepare').mockImplementation((query) => {
        if (/delete\s+from\s+"?oauth_states"?/i.test(query)) {
          throw new Error('synthetic OAuth state consumption database fault');
        }
        return originalPrepare(query);
      });

      try {
        const cbRes = await app.request(
          `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
          { headers: { Cookie: cookieHeaderFromJar(jar) } },
          TEST_AUTH_ENV,
        );

        await expectCallbackFailure(cbRes, '/?error=auth_expired');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(prepareSpy).toHaveBeenCalled();

        const remainingState = await db
          .select()
          .from(oauthStates)
          .where(eq(oauthStates.stateHash, stateHash));
        expect(remainingState).toHaveLength(1);
        expect(await db.select().from(users)).toHaveLength(0);
        expect(await db.select().from(googleTokens)).toHaveLength(0);
        expect(await db.select().from(sessions)).toHaveLength(0);
      } finally {
        prepareSpy.mockRestore();
      }
    });

    it('rejects callback when state parameter does not match any DB state', async () => {
      const { jar } = await initiateLogin();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const cbRes = await app.request(
        'http://localhost:5173/api/auth/callback?code=mock-code&state=nonexistent-state-parameter',
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      await expectCallbackFailure(cbRes, '/?error=auth_expired');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects callback when browser binding cookie belongs to another browser flow', async () => {
      const flowA = await initiateLogin();
      const flowB = await initiateLogin();

      const signedIdToken = await signTestIdToken({ nonce: flowA.nonce });
      const onTokenRequest = vi.fn();
      setupGoogleFetchMock({ idToken: signedIdToken, onTokenRequest });

      // Request callback with flowA's state, but flowB's browser cookie
      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(flowA.state)}`,
        { headers: { Cookie: cookieHeaderFromJar(flowB.jar) } },
        TEST_AUTH_ENV,
      );
      await expectCallbackFailure(cbRes, '/?error=auth_expired');
      expect(onTokenRequest).not.toHaveBeenCalled();
    });

    it('rejects callback with tampered or forged browser binding cookie', async () => {
      const { state } = await initiateLogin();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: `${OAUTH_COOKIE_NAME}=forged-token-value.invalid-signature`,
          },
        },
        TEST_AUTH_ENV,
      );
      await expectCallbackFailure(cbRes, '/?error=auth_expired');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects callback with a missing browser binding cookie before Google exchange', async () => {
      const { state } = await initiateLogin();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        {},
        TEST_AUTH_ENV,
      );

      await expectCallbackFailure(cbRes, '/?error=auth_expired');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('7. Callback Persistence, Concurrency & RAW Shape Assertions', () => {
    it('processes valid callback, encrypts refresh token, rotates session, and asserts exact RAW /me JSON nested shape', async () => {
      const { jar, state, nonce } = await initiateLogin();
      const expectedSub = 'google-sub-verified-42';
      const expectedEmail = 'family.user@example.test';
      const expectedDisplayName = 'Family Organizer';
      const mockRefreshToken = 'mock-google-refresh-token-xyz';

      const signedIdToken = await signTestIdToken({
        sub: expectedSub,
        email: expectedEmail,
        name: expectedDisplayName,
        nonce,
      });

      setupGoogleFetchMock({
        idToken: signedIdToken,
        refreshToken: mockRefreshToken,
      });

      const callbackRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-auth-code&state=${encodeURIComponent(state)}`,
        {
          headers: { Cookie: cookieHeaderFromJar(jar) },
        },
        TEST_AUTH_ENV,
      );

      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get('Location')).toBe('/');
      expect(callbackRes.headers.get('Cache-Control')).toBe('no-store');

      const callbackJar = extractCookies(callbackRes);
      expect(callbackJar[SESSION_COOKIE_NAME]).toBeDefined();

      // Verify Set-Cookie has HttpOnly, Secure, SameSite=Lax, Max-Age=2592000 (30d)
      const rawSessionCookie = callbackRes.headers.get('set-cookie') ?? '';
      expect(rawSessionCookie).toContain('Max-Age=2592000');
      expect(rawSessionCookie).toContain('HttpOnly');
      expect(rawSessionCookie).toContain('Secure');
      expect(rawSessionCookie).toContain('SameSite=Lax');

      // Verify DB user creation and encrypted refresh token with AAD
      const userRows = await db.select().from(users).where(eq(users.googleSub, expectedSub));
      expect(userRows.length).toBe(1);
      const user = required(userRows[0]);
      expect(user.email).toBe(expectedEmail);
      expect(user.displayName).toBe(expectedDisplayName);

      const tokenRows = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, user.id));
      expect(tokenRows.length).toBe(1);
      const tokenRow = required(tokenRows[0]);
      expect(tokenRow.refreshTokenEnc).not.toContain(mockRefreshToken);
      expect(tokenRow.refreshTokenEnc.startsWith('v1.')).toBe(true);

      const decrypted = await decryptAesGcm(
        tokenRow.refreshTokenEnc,
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `google-refresh:${user.id}`,
      );
      expect(decrypted).toBe(mockRefreshToken);

      // Verify GET /api/auth/me and assert exact RAW JSON nested keys
      const meRes = await app.request(
        'http://localhost:5173/api/auth/me',
        {
          headers: { Cookie: cookieHeaderFromJar(callbackJar) },
        },
        TEST_AUTH_ENV,
      );

      expect(meRes.status).toBe(200);
      const meRawJson = (await meRes.json()) as Record<string, unknown>;

      // Strict raw shape check: ONLY ['user'] at top level
      expect(Object.keys(meRawJson).sort()).toEqual(['user']);

      // Strict user nested shape check: ONLY ['displayName', 'email', 'id']
      const meUser = meRawJson.user as Record<string, unknown>;
      expect(Object.keys(meUser).sort()).toEqual(['displayName', 'email', 'id']);
      expect(meUser.id).toBe(user.id);
      expect(meUser.email).toBe(expectedEmail);
      expect(meUser.displayName).toBe(expectedDisplayName);

      // Verify schema matches
      const validatedMe = authMeResponseSchema.parse(meRawJson);
      expect(validatedMe.user.id).toBe(user.id);

      // Restart persistence test on fresh createApp()
      const freshApp = createApp();
      const restartMeRes = await freshApp.request(
        'http://localhost:5173/api/auth/me',
        {
          headers: { Cookie: cookieHeaderFromJar(callbackJar) },
        },
        TEST_AUTH_ENV,
      );
      expect(restartMeRes.status).toBe(200);
      const restartBody = await restartMeRes.json();
      expect(authMeResponseSchema.parse(restartBody).user.id).toBe(user.id);
    });

    it('does not merge different Google sub accounts even if email addresses match', async () => {
      const sharedEmail = 'shared.family@example.test';
      const subAlpha = 'sub-alpha-user';
      const subBeta = 'sub-beta-user';

      // Insert User Alpha
      await db.insert(users).values({
        id: 'usr_alpha',
        googleSub: subAlpha,
        email: sharedEmail,
        displayName: 'User Alpha',
      });

      // Login User Beta with same email
      const flow = await initiateLogin();
      const signedToken = await signTestIdToken({
        sub: subBeta,
        email: sharedEmail,
        name: 'User Beta',
        nonce: flow.nonce,
      });

      setupGoogleFetchMock({ idToken: signedToken, refreshToken: 'refresh-beta' });

      const cb = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-beta&state=${encodeURIComponent(flow.state)}`,
        { headers: { Cookie: cookieHeaderFromJar(flow.jar) } },
        TEST_AUTH_ENV,
      );
      expect(cb.status).toBe(302);

      const allUsers = await db.select().from(users);
      expect(allUsers.length).toBe(2);
      expect(allUsers.some((u) => u.googleSub === subAlpha && u.id === 'usr_alpha')).toBe(true);
      expect(allUsers.some((u) => u.googleSub === subBeta && u.id !== 'usr_alpha')).toBe(true);
    });

    it('preserves other device sessions while rotating current browser session', async () => {
      const sub = 'google-sub-multidevice-user';
      const email = 'multidevice@example.test';
      const name = 'Multi Device User';

      // 1. Login on Device 1
      const flow1 = await initiateLogin();
      const signedIdToken1 = await signTestIdToken({ sub, email, name, nonce: flow1.nonce });
      setupGoogleFetchMock({ idToken: signedIdToken1, refreshToken: 'refresh-device-1' });

      const cb1 = await app.request(
        `http://localhost:5173/api/auth/callback?code=code-1&state=${encodeURIComponent(flow1.state)}`,
        { headers: { Cookie: cookieHeaderFromJar(flow1.jar) } },
        TEST_AUTH_ENV,
      );
      const jarDevice1 = extractCookies(cb1);

      // 2. Login on Device 2
      const flow2 = await initiateLogin();
      const signedIdToken2 = await signTestIdToken({ sub, email, name, nonce: flow2.nonce });
      setupGoogleFetchMock({ idToken: signedIdToken2 });

      const cb2 = await app.request(
        `http://localhost:5173/api/auth/callback?code=code-2&state=${encodeURIComponent(flow2.state)}`,
        { headers: { Cookie: cookieHeaderFromJar(flow2.jar) } },
        TEST_AUTH_ENV,
      );
      const jarDevice2 = extractCookies(cb2);

      // Both devices are active
      expect((await db.select().from(sessions)).length).toBe(2);
      const meDev1Before = await app.request(
        'http://localhost:5173/api/auth/me',
        { headers: { Cookie: cookieHeaderFromJar(jarDevice1) } },
        TEST_AUTH_ENV,
      );
      expect(meDev1Before.status).toBe(200);

      const meDev2Before = await app.request(
        'http://localhost:5173/api/auth/me',
        { headers: { Cookie: cookieHeaderFromJar(jarDevice2) } },
        TEST_AUTH_ENV,
      );
      expect(meDev2Before.status).toBe(200);

      // 3. Re-login on Device 1 (passes Device 1's existing session cookie during callback)
      const flow3 = await initiateLogin();
      const signedIdToken3 = await signTestIdToken({ sub, email, name, nonce: flow3.nonce });
      setupGoogleFetchMock({ idToken: signedIdToken3 });

      const cb3 = await app.request(
        `http://localhost:5173/api/auth/callback?code=code-3&state=${encodeURIComponent(flow3.state)}`,
        {
          headers: {
            Cookie: `${cookieHeaderFromJar(flow3.jar)}; ${cookieHeaderFromJar(jarDevice1)}`,
          },
        },
        TEST_AUTH_ENV,
      );
      const jarDevice1New = extractCookies(cb3);

      // Total sessions in DB is still 2 (old Device 1 session replaced, Device 2 session preserved)
      const sessionsInDb = await db.select().from(sessions);
      expect(sessionsInDb.length).toBe(2);

      // Old Device 1 session is now 401
      const meDev1Old = await app.request(
        'http://localhost:5173/api/auth/me',
        { headers: { Cookie: cookieHeaderFromJar(jarDevice1) } },
        TEST_AUTH_ENV,
      );
      expect(meDev1Old.status).toBe(401);

      // New Device 1 session is 200
      const meDev1New = await app.request(
        'http://localhost:5173/api/auth/me',
        { headers: { Cookie: cookieHeaderFromJar(jarDevice1New) } },
        TEST_AUTH_ENV,
      );
      expect(meDev1New.status).toBe(200);

      // Device 2 session remains valid (200)
      const meDev2After = await app.request(
        'http://localhost:5173/api/auth/me',
        { headers: { Cookie: cookieHeaderFromJar(jarDevice2) } },
        TEST_AUTH_ENV,
      );
      expect(meDev2After.status).toBe(200);
    });

    it('rejects first login when refresh token is missing, leaving zero user or session records', async () => {
      const { jar, state, nonce } = await initiateLogin();
      const signedIdToken = await signTestIdToken({
        sub: 'google-sub-first-login-no-refresh',
        nonce,
      });

      setupGoogleFetchMock({
        idToken: signedIdToken,
        refreshToken: null, // Google omitted refresh token on first login
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );

      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_failed');

      const createdUsers = await db
        .select()
        .from(users)
        .where(eq(users.googleSub, 'google-sub-first-login-no-refresh'));
      expect(createdUsers.length).toBe(0);
      expect((await db.select().from(sessions)).length).toBe(0);
    });

    it('preserves existing refresh token ciphertext in DB when Google omits refresh token during subsequent callback', async () => {
      const sub = 'sub-existing-subsequent';
      const userId = 'usr_subsequent_1';
      const initialRefresh = 'initial-token-value';

      await db.insert(users).values({
        id: userId,
        googleSub: sub,
        email: 'subsequent@example.test',
        displayName: 'Subsequent User',
      });

      const encInitial = await encryptAesGcm(
        initialRefresh,
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `google-refresh:${userId}`,
      );
      await db.insert(googleTokens).values({
        userId,
        refreshTokenEnc: encInitial,
        scopes: PHASE1_SCOPES.join(' '),
        updatedAt: Math.floor(Date.now() / 1000),
      });

      const flow = await initiateLogin();
      const signedToken = await signTestIdToken({
        sub,
        email: 'subsequent@example.test',
        nonce: flow.nonce,
      });

      setupGoogleFetchMock({
        idToken: signedToken,
        refreshToken: null, // Google omits refresh token on subsequent login
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-subsequent&state=${encodeURIComponent(flow.state)}`,
        { headers: { Cookie: cookieHeaderFromJar(flow.jar) } },
        TEST_AUTH_ENV,
      );
      expect(cbRes.status).toBe(302);

      const tokenRows = await db.select().from(googleTokens).where(eq(googleTokens.userId, userId));
      expect(tokenRows.length).toBe(1);
      expect(required(tokenRows[0]).refreshTokenEnc).toBe(encInitial);
    });

    it('rejects existing user login when user has no stored grant and Google omits refresh token, leaving profile untouched', async () => {
      const existingSub = 'sub-existing-no-grant';
      const existingUserId = 'usr_no_grant_1';

      await db.insert(users).values({
        id: existingUserId,
        googleSub: existingSub,
        email: 'original.email@example.test',
        displayName: 'Original Name',
      });

      const { jar, state, nonce } = await initiateLogin();
      const signedIdToken = await signTestIdToken({
        sub: existingSub,
        email: 'mutated.email@example.test',
        name: 'Mutated Name',
        nonce,
      });

      setupGoogleFetchMock({
        idToken: signedIdToken,
        refreshToken: null,
      });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );

      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get('Location')).toBe('/?error=auth_failed');

      // User profile must NOT be mutated before grant validation
      const userAfterRows = await db.select().from(users).where(eq(users.id, existingUserId));
      const userAfter = required(userAfterRows[0]);
      expect(userAfter.email).toBe('original.email@example.test');
      expect(userAfter.displayName).toBe('Original Name');
      expect((await db.select().from(sessions)).length).toBe(0);
    });

    it('handles concurrent parallel distinct-flow sign-ins for same Google sub with Promise.all without collisions', async () => {
      const sharedSub = 'sub-parallel-race-user';
      const [flowA, flowB] = await Promise.all([initiateLogin(), initiateLogin()]);

      const signedTokenA = await signTestIdToken({
        sub: sharedSub,
        email: 'race@example.test',
        nonce: flowA.nonce,
      });
      const signedTokenB = await signTestIdToken({
        sub: sharedSub,
        email: 'race@example.test',
        nonce: flowB.nonce,
      });

      setupGoogleFetchMock({
        tokenRouter: (_req, params) => {
          const code = params.get('code');
          if (code === 'code-a') {
            return new Response(
              JSON.stringify({
                access_token: 'access-a',
                expires_in: 3600,
                token_type: 'Bearer',
                scope: PHASE1_SCOPES.join(' '),
                id_token: signedTokenA,
                refresh_token: 'refresh-a',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              access_token: 'access-b',
              expires_in: 3600,
              token_type: 'Bearer',
              scope: PHASE1_SCOPES.join(' '),
              id_token: signedTokenB,
              refresh_token: 'refresh-b',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        },
      });

      // Execute both callbacks in true parallel with Promise.all
      const [cbA, cbB] = await Promise.all([
        app.request(
          `http://localhost:5173/api/auth/callback?code=code-a&state=${encodeURIComponent(flowA.state)}`,
          { headers: { Cookie: cookieHeaderFromJar(flowA.jar) } },
          TEST_AUTH_ENV,
        ),
        app.request(
          `http://localhost:5173/api/auth/callback?code=code-b&state=${encodeURIComponent(flowB.state)}`,
          { headers: { Cookie: cookieHeaderFromJar(flowB.jar) } },
          TEST_AUTH_ENV,
        ),
      ]);

      expect(cbA.status).toBe(302);
      expect(cbB.status).toBe(302);

      // Unique user row exists for the shared sub
      const userRows = await db.select().from(users).where(eq(users.googleSub, sharedSub));
      expect(userRows.length).toBe(1);
    });

    it('preserves existing browser session when database batch transaction fails during callback rotation', async () => {
      const sub = 'sub-batch-fault-user';
      const email = 'batch.fault@example.test';

      // 1. Establish valid session 1
      const flow1 = await initiateLogin();
      const signedToken1 = await signTestIdToken({ sub, email, nonce: flow1.nonce });
      setupGoogleFetchMock({ idToken: signedToken1, refreshToken: 'refresh-1' });

      const cb1 = await app.request(
        `http://localhost:5173/api/auth/callback?code=code-1&state=${encodeURIComponent(flow1.state)}`,
        { headers: { Cookie: cookieHeaderFromJar(flow1.jar) } },
        TEST_AUTH_ENV,
      );
      expect(cb1.status).toBe(302);
      const validSessionJar = extractCookies(cb1);

      // Verify session 1 works
      const meBefore = await app.request(
        'http://localhost:5173/api/auth/me',
        { headers: { Cookie: cookieHeaderFromJar(validSessionJar) } },
        TEST_AUTH_ENV,
      );
      expect(meBefore.status).toBe(200);

      // 2. Second login flow with D1 batch failure injection
      const flow2 = await initiateLogin();
      const signedToken2 = await signTestIdToken({ sub, email, nonce: flow2.nonce });
      setupGoogleFetchMock({ idToken: signedToken2 });

      // Get initial user and grant details to verify retention
      const userRows = await db.select().from(users).where(eq(users.googleSub, sub));
      const expectedUserId = required(userRows[0]).id;
      const initialTokenRows = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, expectedUserId));
      const initialGrantEnc = required(initialTokenRows[0]).refreshTokenEnc;

      const syntheticSentinel = 'SYNTHETIC_PRIVATE_DB_SENTINEL_FAULTPATH_12345';
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const batchFaultMock = vi.spyOn(TEST_AUTH_ENV.DB, 'batch').mockImplementation(async () => {
        throw new Error(`D1 simulated hardware fault with private sentinel: ${syntheticSentinel}`);
      });

      try {
        const cb2 = await app.request(
          `http://localhost:5173/api/auth/callback?code=code-2&state=${encodeURIComponent(flow2.state)}`,
          {
            headers: {
              Cookie: `${cookieHeaderFromJar(flow2.jar)}; ${cookieHeaderFromJar(validSessionJar)}`,
            },
          },
          TEST_AUTH_ENV,
        );
        expect(cb2.status).toBe(302);
        expect(cb2.headers.get('Location')).toBe('/?error=auth_failed');

        // Assert batch fault mock called exactly once
        expect(batchFaultMock).toHaveBeenCalledTimes(1);

        // NO new SESSION cookie issued on batch failure
        const cb2Jar = extractCookies(cb2);
        expect(cb2Jar[SESSION_COOKIE_NAME]).toBeUndefined();

        // Verify response and console logs do NOT leak synthetic sentinel
        const cb2Text = await cb2.text();
        expect(cb2Text).not.toContain(syntheticSentinel);

        const allLogs = [
          ...consoleErrorSpy.mock.calls,
          ...consoleWarnSpy.mock.calls,
          ...consoleLogSpy.mock.calls,
        ]
          .flat()
          .map(String)
          .join(' ');
        expect(allLogs).not.toContain(syntheticSentinel);

        // Prior session cookie MUST still be valid on normal env (me returns 200)
        const meAfter = await app.request(
          'http://localhost:5173/api/auth/me',
          { headers: { Cookie: cookieHeaderFromJar(validSessionJar) } },
          TEST_AUTH_ENV,
        );
        expect(meAfter.status).toBe(200);

        // Prior grant ciphertext retained in DB
        const tokenRowsAfter = await db
          .select()
          .from(googleTokens)
          .where(eq(googleTokens.userId, expectedUserId));
        expect(tokenRowsAfter.length).toBe(1);
        expect(required(tokenRowsAfter[0]).refreshTokenEnc).toBe(initialGrantEnc);
      } finally {
        batchFaultMock.mockRestore();
        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        consoleLogSpy.mockRestore();
      }
    });
  });

  describe('8. Session Invalidation, Tampering & CSRF-Protected Logout', () => {
    it('returns 401 on expired session in DB and cleans up expired session row', async () => {
      const userId = 'usr_expired_session_test';
      await db.insert(users).values({
        id: userId,
        googleSub: 'sub_expired_test',
        email: 'expired@example.test',
        displayName: 'Expired Session User',
      });

      const { res, jar } = await initiateLogin();
      const location = new URL(required(res.headers.get('Location')));
      const signedIdToken = await signTestIdToken({
        sub: 'sub_expired_test',
        nonce: required(location.searchParams.get('nonce')),
      });
      setupGoogleFetchMock({ idToken: signedIdToken });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock&state=${encodeURIComponent(
          required(location.searchParams.get('state')),
        )}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      const sessionJar = extractCookies(cbRes);

      // Force session row expiry into past
      await db
        .update(sessions)
        .set({ expiresAt: Math.floor(Date.now() / 1000) - 100 })
        .where(eq(sessions.userId, userId));

      const meRes = await app.request(
        'http://localhost:5173/api/auth/me',
        { headers: { Cookie: cookieHeaderFromJar(sessionJar) } },
        TEST_AUTH_ENV,
      );
      expect(meRes.status).toBe(401);

      // Expired session row is deleted
      const remainingSessions = await db.select().from(sessions).where(eq(sessions.userId, userId));
      expect(remainingSessions.length).toBe(0);
    });

    it('returns 401 when session cookie signature is tampered or invalid', async () => {
      const tamperedJar = {
        [SESSION_COOKIE_NAME]: 'fake-raw-token.tampered-hmac-signature',
      };

      const meRes = await app.request(
        'http://localhost:5173/api/auth/me',
        { headers: { Cookie: cookieHeaderFromJar(tamperedJar) } },
        TEST_AUTH_ENV,
      );
      expect(meRes.status).toBe(401);
    });

    it('rejects logout forgery when CSRF headers are missing or mismatched, preserving active session', async () => {
      const { res, jar } = await initiateLogin();
      const location = new URL(required(res.headers.get('Location')));
      const signedIdToken = await signTestIdToken({
        sub: 'sub_logout_forgery',
        nonce: required(location.searchParams.get('nonce')),
      });
      setupGoogleFetchMock({ idToken: signedIdToken });

      const cbRes = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock&state=${encodeURIComponent(
          required(location.searchParams.get('state')),
        )}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );
      const sessionJar = extractCookies(cbRes);

      // 1. Missing X-Requested-With header
      const forgeryMissingHeader = await app.request(
        'http://localhost:5173/api/auth/logout',
        {
          method: 'POST',
          headers: {
            Origin: TEST_AUTH_ENV.APP_ORIGIN,
            Cookie: cookieHeaderFromJar(sessionJar),
          },
        },
        TEST_AUTH_ENV,
      );
      expect(forgeryMissingHeader.status).toBe(403);

      // 2. Missing Origin header
      const forgeryMissingOrigin = await app.request(
        'http://localhost:5173/api/auth/logout',
        {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: cookieHeaderFromJar(sessionJar),
          },
        },
        TEST_AUTH_ENV,
      );
      expect(forgeryMissingOrigin.status).toBe(403);

      // 3. Mismatched cross-origin Origin
      const forgeryCrossOrigin = await app.request(
        'http://localhost:5173/api/auth/logout',
        {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'https://attacker.site.test',
            Cookie: cookieHeaderFromJar(sessionJar),
          },
        },
        TEST_AUTH_ENV,
      );
      expect(forgeryCrossOrigin.status).toBe(403);

      // Session MUST remain completely valid after forged logout attempts
      const meAfterForgery = await app.request(
        'http://localhost:5173/api/auth/me',
        { headers: { Cookie: cookieHeaderFromJar(sessionJar) } },
        TEST_AUTH_ENV,
      );
      expect(meAfterForgery.status).toBe(200);

      // 4. Legitimate logout invalidates session in D1 and clears cookie
      const legitimateLogout = await app.request(
        'http://localhost:5173/api/auth/logout',
        {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_AUTH_ENV.APP_ORIGIN,
            Cookie: cookieHeaderFromJar(sessionJar),
          },
        },
        TEST_AUTH_ENV,
      );
      expect(legitimateLogout.status).toBe(200);
      expect(authLogoutResponseSchema.parse(await legitimateLogout.json())).toEqual({ ok: true });

      const logoutSetCookie = legitimateLogout.headers.get('set-cookie') ?? '';
      expect(logoutSetCookie).toContain('Max-Age=0');
      expect(logoutSetCookie).toContain('HttpOnly');

      // Subsequent /me returns 401
      const meAfterLogout = await app.request(
        'http://localhost:5173/api/auth/me',
        { headers: { Cookie: cookieHeaderFromJar(sessionJar) } },
        TEST_AUTH_ENV,
      );
      expect(meAfterLogout.status).toBe(401);

      // Stored Google grant is PRESERVED on logout (does NOT revoke Google token)
      const tokenRows = await db.select().from(googleTokens);
      expect(tokenRows.length).toBe(1);
    });

    it('returns 200 OK on idempotent logout when already logged out or no session exists', async () => {
      const res = await app.request(
        'http://localhost:5173/api/auth/logout',
        {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            Origin: TEST_AUTH_ENV.APP_ORIGIN,
          },
        },
        TEST_AUTH_ENV,
      );
      expect(res.status).toBe(200);
      expect(authLogoutResponseSchema.parse(await res.json())).toEqual({ ok: true });
    });
  });

  describe('9. On-Demand Access Token Acquisition (getGoogleAccessToken)', () => {
    it('refreshes token via POST form-urlencoded, updates rotated token and scopes atomically without trimming', async () => {
      const userId = 'usr_token_demand_test';
      const initialRefresh = '  opaque_refresh_token_with_spaces_must_not_be_trimmed  ';

      await db.insert(users).values({
        id: userId,
        googleSub: 'sub_token_demand',
        email: 'demand@example.test',
        displayName: 'Demand User',
      });

      const encRefresh = await encryptAesGcm(
        initialRefresh,
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `google-refresh:${userId}`,
      );

      await db.insert(googleTokens).values({
        userId,
        refreshTokenEnc: encRefresh,
        scopes: PHASE1_SCOPES.join(' '),
        updatedAt: Math.floor(Date.now() / 1000),
      });

      let refreshFormVerified = false;
      const rotatedRefresh = 'new_rotated_refresh_token_val';
      setupGoogleFetchMock({
        onTokenRequest: async (_req, params) => {
          refreshFormVerified = true;
          expect(params.get('grant_type')).toBe('refresh_token');
          expect(params.get('client_id')).toBe(TEST_AUTH_ENV.GOOGLE_CLIENT_ID);
          expect(params.get('client_secret')).toBe(TEST_AUTH_ENV.GOOGLE_CLIENT_SECRET);
          expect(params.get('refresh_token')).toBe(initialRefresh);
        },
        tokenBody: {
          access_token: 'fresh-access-token-12345',
          expires_in: 3600,
          token_type: 'Bearer',
          refresh_token: rotatedRefresh,
          scope: PHASE1_SCOPES.join(' '),
        },
      });

      const tokenResult = await getGoogleAccessToken(TEST_AUTH_ENV, userId);
      expect(refreshFormVerified).toBe(true);
      expect(tokenResult.accessToken).toBe('fresh-access-token-12345');
      expect(tokenResult.expiresIn).toBe(3600);

      // Verify rotated token was updated in DB
      const updatedRows = await db
        .select()
        .from(googleTokens)
        .where(eq(googleTokens.userId, userId));
      const updatedRow = required(updatedRows[0]);
      expect(updatedRow.refreshTokenEnc).not.toBe(encRefresh);
      const decrypted = await decryptAesGcm(
        updatedRow.refreshTokenEnc,
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `google-refresh:${userId}`,
      );
      expect(decrypted).toBe(rotatedRefresh);
    });

    it('preserves existing refresh token ciphertext in DB when Google omits refresh token during getGoogleAccessToken', async () => {
      const userId = 'usr_token_omit_test';
      const initialRefresh = 'initial_refresh_must_be_preserved';

      await db.insert(users).values({
        id: userId,
        googleSub: 'sub_token_omit',
        email: 'omit@example.test',
        displayName: 'Omit User',
      });

      const encRefresh = await encryptAesGcm(
        initialRefresh,
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `google-refresh:${userId}`,
      );

      await db.insert(googleTokens).values({
        userId,
        refreshTokenEnc: encRefresh,
        scopes: PHASE1_SCOPES.join(' '),
        updatedAt: Math.floor(Date.now() / 1000),
      });

      setupGoogleFetchMock({
        tokenBody: {
          access_token: 'fresh-access-token-999',
          expires_in: 3600,
          token_type: 'Bearer',
          // refresh_token omitted by Google
        },
      });

      const result = await getGoogleAccessToken(TEST_AUTH_ENV, userId);
      expect(result.accessToken).toBe('fresh-access-token-999');

      const tokenRows = await db.select().from(googleTokens).where(eq(googleTokens.userId, userId));
      expect(tokenRows.length).toBe(1);
      expect(required(tokenRows[0]).refreshTokenEnc).toBe(encRefresh);
    });

    it('retains newer grant when stored ciphertext changes concurrently during token refresh rotation', async () => {
      const userId = 'usr_race_rotation_test';
      const initialRefresh = 'initial-token-val';

      await db.insert(users).values({
        id: userId,
        googleSub: 'sub_race_rotation',
        email: 'race.rot@example.test',
        displayName: 'Race Rot User',
      });

      const encInitial = await encryptAesGcm(
        initialRefresh,
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `google-refresh:${userId}`,
      );
      await db.insert(googleTokens).values({
        userId,
        refreshTokenEnc: encInitial,
        scopes: PHASE1_SCOPES.join(' '),
        updatedAt: Math.floor(Date.now() / 1000),
      });

      const concurrentNewCiphertext = 'v1.concurrently_updated_newer_ciphertext.tag';

      setupGoogleFetchMock({
        onTokenRequest: async () => {
          // Simulate concurrent login updating the stored token in DB before refresh response returns
          await db
            .update(googleTokens)
            .set({ refreshTokenEnc: concurrentNewCiphertext })
            .where(eq(googleTokens.userId, userId));
        },
        tokenBody: {
          access_token: 'fresh-access-token-concurrent',
          expires_in: 3600,
          token_type: 'Bearer',
          refresh_token: 'stale-rotated-token',
        },
      });

      const result = await getGoogleAccessToken(TEST_AUTH_ENV, userId);
      expect(result.accessToken).toBe('fresh-access-token-concurrent');

      // Stored token was NOT overwritten with stale rotated token because conditional update matched old ciphertext
      const tokenRows = await db.select().from(googleTokens).where(eq(googleTokens.userId, userId));
      const row = required(tokenRows[0]);
      expect(row.refreshTokenEnc).toBe(concurrentNewCiphertext);
    });

    it('retains newer grant when stored ciphertext changes concurrently before 400 invalid_grant', async () => {
      const userId = 'usr_race_invalid_grant';
      const initialRefresh = 'initial-revoked-token-val';

      await db.insert(users).values({
        id: userId,
        googleSub: 'sub_race_invalid',
        email: 'race.invalid@example.test',
        displayName: 'Race Invalid User',
      });

      const encInitial = await encryptAesGcm(
        initialRefresh,
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `google-refresh:${userId}`,
      );
      await db.insert(googleTokens).values({
        userId,
        refreshTokenEnc: encInitial,
        scopes: PHASE1_SCOPES.join(' '),
        updatedAt: Math.floor(Date.now() / 1000),
      });

      const concurrentLoginCiphertext = 'v1.new_login_concurrent_ciphertext.tag';

      setupGoogleFetchMock({
        tokenStatus: 400,
        tokenBody: { error: 'invalid_grant' },
        onTokenRequest: async () => {
          // Another device/login logged in, updating the token in DB before 400 response is processed
          await db
            .update(googleTokens)
            .set({ refreshTokenEnc: concurrentLoginCiphertext })
            .where(eq(googleTokens.userId, userId));
        },
      });

      await expect(getGoogleAccessToken(TEST_AUTH_ENV, userId)).rejects.toThrow(ReauthNeededError);

      // Newer grant was NOT deleted
      const tokenRows = await db.select().from(googleTokens).where(eq(googleTokens.userId, userId));
      expect(tokenRows.length).toBe(1);
      expect(required(tokenRows[0]).refreshTokenEnc).toBe(concurrentLoginCiphertext);
    });

    it('retains stored grant on transient 5xx or 429 errors even if body contains invalid_grant', async () => {
      const userId = 'usr_transient_test';
      const initialRefresh = 'transient-refresh-val';

      await db.insert(users).values({
        id: userId,
        googleSub: 'sub_transient',
        email: 'transient@example.test',
        displayName: 'Transient User',
      });

      const encRefresh = await encryptAesGcm(
        initialRefresh,
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `google-refresh:${userId}`,
      );

      await db.insert(googleTokens).values({
        userId,
        refreshTokenEnc: encRefresh,
        scopes: PHASE1_SCOPES.join(' '),
        updatedAt: Math.floor(Date.now() / 1000),
      });

      // 1. Transient 500 error
      setupGoogleFetchMock({
        tokenStatus: 500,
        tokenBody: { error: 'invalid_grant' },
      });
      await expect(getGoogleAccessToken(TEST_AUTH_ENV, userId)).rejects.toThrow(GoogleApiError);

      // Stored grant is NOT deleted
      expect(
        (await db.select().from(googleTokens).where(eq(googleTokens.userId, userId))).length,
      ).toBe(1);

      // 2. Transient 429 error (Rate limit)
      setupGoogleFetchMock({
        tokenStatus: 429,
        tokenBody: { error: 'invalid_grant' },
      });
      await expect(getGoogleAccessToken(TEST_AUTH_ENV, userId)).rejects.toThrow(GoogleApiError);

      // Stored grant is STILL NOT deleted
      expect(
        (await db.select().from(googleTokens).where(eq(googleTokens.userId, userId))).length,
      ).toBe(1);
    });

    it('invalidates stored grant conditionally on 400 invalid_grant when ciphertext matches', async () => {
      const userId = 'usr_invalid_grant_test';
      const initialRefresh = 'revoked-refresh-val';

      await db.insert(users).values({
        id: userId,
        googleSub: 'sub_invalid_grant',
        email: 'revoked@example.test',
        displayName: 'Revoked User',
      });

      const encRefresh = await encryptAesGcm(
        initialRefresh,
        TEST_AUTH_ENV.TOKEN_ENC_KEY,
        `google-refresh:${userId}`,
      );

      await db.insert(googleTokens).values({
        userId,
        refreshTokenEnc: encRefresh,
        scopes: PHASE1_SCOPES.join(' '),
        updatedAt: Math.floor(Date.now() / 1000),
      });

      // 400 invalid_grant
      setupGoogleFetchMock({
        tokenStatus: 400,
        tokenBody: { error: 'invalid_grant' },
      });

      await expect(getGoogleAccessToken(TEST_AUTH_ENV, userId)).rejects.toThrow(ReauthNeededError);

      // Token row is deleted
      const rowsAfter = await db.select().from(googleTokens).where(eq(googleTokens.userId, userId));
      expect(rowsAfter.length).toBe(0);
    });
  });

  describe('10. Scope Utilities, Envelope Robustness & Log Sentinel Spies', () => {
    it('normalizes Google scope aliases and rejects missing required permissions', () => {
      const withAliases =
        'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.calendarlist.readonly';
      const normalized = validateAndNormalizeScopes(withAliases);
      expect(normalized.normalizedScopes).toContain('email');
      expect(normalized.normalizedScopes).toContain('profile');

      expect(() => validateAndNormalizeScopes('openid email profile')).toThrow(GoogleAuthError);
    });

    it('encrypts with fresh nondeterministic IVs and rejects wrong key or wrong AAD', async () => {
      const plaintext = 'sensitive-google-refresh-token';
      const aad = 'google-refresh:usr_123';

      const enc1 = await encryptAesGcm(plaintext, TEST_AUTH_ENV.TOKEN_ENC_KEY, aad);
      const enc2 = await encryptAesGcm(plaintext, TEST_AUTH_ENV.TOKEN_ENC_KEY, aad);

      expect(enc1).not.toBe(enc2);
      expect(await decryptAesGcm(enc1, TEST_AUTH_ENV.TOKEN_ENC_KEY, aad)).toBe(plaintext);

      await expect(
        decryptAesGcm(enc1, TEST_AUTH_ENV.TOKEN_ENC_KEY, 'google-refresh:wrong_user'),
      ).rejects.toThrow();

      await expect(
        decryptAesGcm(enc1, TEST_AUTH_ENV.TOKEN_ENC_KEY, 'oauth-state:usr_123'),
      ).rejects.toThrow();

      // Tampered ciphertext with valid base64url character fails authentication tag check
      const parts = enc1.split('.');
      const cipherPart = required(parts[2]);
      const flippedChar = cipherPart[0] === 'A' ? 'B' : 'A';
      const tamperedCipher = `${parts[0]}.${parts[1]}.${flippedChar}${cipherPart.slice(1)}`;
      await expect(
        decryptAesGcm(tamperedCipher, TEST_AUTH_ENV.TOKEN_ENC_KEY, aad),
      ).rejects.toThrow();

      // Wrong key fails
      const anotherKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
      await expect(decryptAesGcm(enc1, anotherKey, aad)).rejects.toThrow();
    });

    it('rejects malformed TOKEN_ENC_KEY (wrong length, invalid chars, or non-zero pad bits)', () => {
      expect(() => parseAes256Key('c2hvcnQ=')).toThrow();
      expect(() => parseAes256Key('!invalid_base64!')).toThrow();
      const nonCanonicalKey = `${TEST_AES_KEY_BASE64.slice(0, -2)}B=`;
      expect(() => parseAes256Key(nonCanonicalKey)).toThrow();
    });

    it('guarantees sensitive tokens, secrets, subs, and stack traces never leak in error responses or console logs', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const sensitiveSecret = 'SUPER_SENSITIVE_SECRET_TOKEN_VALUE_XYZ';
      const { jar, state } = await initiateLogin();

      setupGoogleFetchMock({
        rawResponseBody: JSON.stringify({
          error: 'malformed_upstream_error',
          leak: sensitiveSecret,
        }),
      });

      const res = await app.request(
        `http://localhost:5173/api/auth/callback?code=mock&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookieHeaderFromJar(jar) } },
        TEST_AUTH_ENV,
      );

      const resText = await res.text();
      expect(resText).not.toContain(sensitiveSecret);
      expect(resText).not.toContain(TEST_AUTH_ENV.GOOGLE_CLIENT_SECRET);
      expect(resText).not.toContain(TEST_AUTH_ENV.TOKEN_ENC_KEY);

      const allLoggedMessages = [
        ...consoleErrorSpy.mock.calls,
        ...consoleWarnSpy.mock.calls,
        ...consoleLogSpy.mock.calls,
      ]
        .flat()
        .map(String)
        .join(' ');

      expect(allLoggedMessages).not.toContain(sensitiveSecret);
      expect(allLoggedMessages).not.toContain(TEST_AUTH_ENV.GOOGLE_CLIENT_SECRET);
      expect(allLoggedMessages).not.toContain(TEST_AUTH_ENV.TOKEN_ENC_KEY);
    });
  });
});
