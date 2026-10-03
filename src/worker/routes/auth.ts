import {
  type AuthCallbackQuery,
  type OAuthPayload,
  authCallbackQuerySchema,
  authLoginRequestBodySchema,
  authLoginResponseSchema,
  authLogoutResponseSchema,
  authMeResponseSchema,
} from '@shared/schemas/auth';
import { apiErrorResponseSchema } from '@shared/schemas/errors';
import {
  type AuthConfig,
  FAMILY_ACL_SCOPE,
  SESSION_TTL_SECONDS,
  getAuthConfig,
} from '@worker/auth/config';
import { encryptAesGcm, generateRandomToken, sha256Hex } from '@worker/auth/crypto';
import { clearOAuthCookie, consumeOAuthFlow, initiateOAuthFlow } from '@worker/auth/oauth';
import {
  clearSessionCookie,
  deleteSession,
  getSessionUser,
  setSessionCookie,
} from '@worker/auth/session';
import { createDb } from '@worker/db';
import { families, googleTokens, members, sessions, users } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import {
  GoogleAuthError,
  exchangeCodeForTokens,
  validateAndNormalizeScopes,
  verifyGoogleIdToken,
} from '@worker/google/oauth';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

export const authRoute = new Hono<{ Bindings: WorkerEnv }>();

type CallbackFailureDestination =
  | '/?error=auth_expired'
  | '/?error=auth_failed'
  | '/?error=access_denied'
  | '/onboarding?error=acl_failed'
  | '/onboarding?error=acl_account_mismatch'
  | '/onboarding?error=acl_denied'
  | { kind: 'invite'; error: 'auth_failed' | 'access_denied'; inviteToken: string };

function callbackDestination(
  payload: OAuthPayload,
  outcome: 'cancelled' | 'failed',
): CallbackFailureDestination {
  if (payload.purpose === 'family-acl') {
    return outcome === 'cancelled'
      ? '/onboarding?error=acl_denied'
      : '/onboarding?error=acl_failed';
  }

  if (payload.inviteToken) {
    return outcome === 'cancelled'
      ? { kind: 'invite', error: 'access_denied', inviteToken: payload.inviteToken }
      : { kind: 'invite', error: 'auth_failed', inviteToken: payload.inviteToken };
  }

  return outcome === 'cancelled' ? '/?error=access_denied' : '/?error=auth_failed';
}

const callbackFallbacks = new WeakMap<object, CallbackFailureDestination>();

function callbackFailure(
  c: Parameters<typeof clearOAuthCookie>[0],
  destination: CallbackFailureDestination,
) {
  clearOAuthCookie(c);
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');
  const location =
    typeof destination === 'string'
      ? destination
      : `/invite?error=${destination.error}#${destination.inviteToken}`;
  return c.redirect(location, 302);
}

function isCallbackRequest(c: { req: { method: string; path: string } }): boolean {
  return (
    c.req.method === 'GET' &&
    (c.req.path === '/api/auth/callback' || c.req.path === '/auth/callback')
  );
}

// Enforce mandatory security headers, auth configuration, and strict origin matching across all /auth/* routes
authRoute.use('/auth/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');

  // Validate configuration lazily: fail-closed 503 if unconfigured
  let config: AuthConfig;
  try {
    config = getAuthConfig(c.env);
  } catch {
    if (isCallbackRequest(c)) {
      return callbackFailure(c, '/?error=auth_expired');
    }
    const errorBody = apiErrorResponseSchema.parse({
      error: 'Auth service unconfigured',
    });
    return c.json(errorBody, 503);
  }

  // Enforce request URL origin matches configured APP_ORIGIN exactly before any side effects
  let requestOrigin: string;
  try {
    requestOrigin = new URL(c.req.url).origin;
  } catch {
    if (isCallbackRequest(c)) {
      return callbackFailure(c, '/?error=auth_expired');
    }
    const errorBody = apiErrorResponseSchema.parse({ error: 'Forbidden' });
    return c.json(errorBody, 403);
  }

  if (requestOrigin !== config.appOrigin) {
    if (isCallbackRequest(c)) {
      return callbackFailure(c, '/?error=auth_expired');
    }
    const errorBody = apiErrorResponseSchema.parse({ error: 'Forbidden' });
    return c.json(errorBody, 403);
  }

  await next();

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');
});

// Custom error handler to guarantee no sensitive data or tokens leak in responses or logs
authRoute.onError((err, c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');

  if (isCallbackRequest(c)) {
    return callbackFailure(c, callbackFallbacks.get(c) ?? '/?error=auth_expired');
  }

  if (err instanceof GoogleAuthError) {
    const errorBody = apiErrorResponseSchema.parse({ error: 'Authentication failed' });
    return c.json(errorBody, 400);
  }

  const errorBody = apiErrorResponseSchema.parse({ error: 'Authentication error' });
  return c.json(errorBody, 500);
});

/**
 * GET /api/auth/login
 * Initiates Google OAuth 2.0 flow with PKCE, state, and browser binding.
 * Plain baseline login only. Rejects arbitrary returnURL query parameter.
 */
authRoute.get('/auth/login', async (c) => {
  if (c.req.query('returnUrl') || c.req.query('return_url')) {
    const errorBody = apiErrorResponseSchema.parse({ error: 'Invalid query parameters' });
    return c.json(errorBody, 400);
  }

  const config = getAuthConfig(c.env);
  const db = createDb(c.env.DB);

  const { authUrl } = await initiateOAuthFlow(c, db, config);
  return c.redirect(authUrl, 302);
});

/**
 * POST /api/auth/login
 * Initiates baseline OAuth login with invite token continuation.
 * Strict body validation max 2KiB, exact Origin and XMLHttpRequest even anonymous.
 * Rejects arbitrary returnURL. Returns { authorizationUrl }.
 */
authRoute.post(
  '/auth/login',
  bodyLimit({
    maxSize: 2048,
    onError: (c) => {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Payload Too Large' });
      return c.json(errorBody, 413);
    },
  }),
  async (c) => {
    const xRequestedWith = c.req.header('x-requested-with');
    if (xRequestedWith !== 'XMLHttpRequest') {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Forbidden' });
      return c.json(errorBody, 403);
    }

    const originHeader = c.req.header('origin');
    const config = getAuthConfig(c.env);
    if (originHeader !== config.appOrigin) {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Forbidden' });
      return c.json(errorBody, 403);
    }

    if (c.req.query('returnUrl') || c.req.query('return_url')) {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Invalid query parameters' });
      return c.json(errorBody, 400);
    }

    let parsedJson: unknown;
    try {
      parsedJson = await c.req.json();
    } catch {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Invalid JSON' });
      return c.json(errorBody, 400);
    }

    const bodyResult = authLoginRequestBodySchema.safeParse(parsedJson);
    if (!bodyResult.success) {
      const errorBody = apiErrorResponseSchema.parse({ error: 'Invalid request body' });
      return c.json(errorBody, 400);
    }

    const db = createDb(c.env.DB);
    const { authUrl } = await initiateOAuthFlow(c, db, config, {
      purpose: 'login',
      inviteToken: bodyResult.data.inviteToken,
    });

    const responseBody = authLoginResponseSchema.parse({
      authorizationUrl: authUrl,
    });
    return c.json(responseBody, 200);
  },
);

/**
 * GET /api/auth/callback
 * Consumes single-use state atomically, exchanges authorization code for tokens,
 * cryptographically verifies Google ID Token, saves encrypted refresh token,
 * batches session rotation, and redirects to root.
 */
authRoute.get('/auth/callback', async (c) => {
  callbackFallbacks.set(c, '/?error=auth_expired');
  const rawQuery = c.req.query();
  const queryResult = authCallbackQuerySchema.safeParse(rawQuery);
  if (!queryResult.success) {
    return callbackFailure(c, '/?error=auth_expired');
  }

  const query: AuthCallbackQuery = queryResult.data;
  let config: AuthConfig;
  let db: ReturnType<typeof createDb>;
  try {
    config = getAuthConfig(c.env);
    db = createDb(c.env.DB);
  } catch {
    return callbackFailure(c, '/?error=auth_expired');
  }

  // Handle user cancellation / error from Google:
  // Must atomically consume matching valid state and browser binding before redirecting
  if (query.error) {
    if (!query.state) {
      return callbackFailure(c, '/?error=auth_expired');
    }

    let consumed: OAuthPayload;
    try {
      consumed = await consumeOAuthFlow(c, db, config, query.state);
    } catch {
      return callbackFailure(c, '/?error=auth_expired');
    }

    const cancellationDestination = callbackDestination(consumed, 'cancelled');
    callbackFallbacks.set(c, callbackDestination(consumed, 'failed'));
    return callbackFailure(c, cancellationDestination);
  }

  if (!query.code || !query.state) {
    return callbackFailure(c, '/?error=auth_expired');
  }

  // 1. Single-use atomic consumption of OAuth state and browser binding
  let consumed: OAuthPayload;
  try {
    consumed = await consumeOAuthFlow(c, db, config, query.state);
  } catch {
    return callbackFailure(c, '/?error=auth_expired');
  }

  const loginFailureDestination = callbackDestination(consumed, 'failed');
  callbackFallbacks.set(c, loginFailureDestination);

  const { codeVerifier, nonce } = consumed;

  // -------------------------------------------------------------
  // BRANCH 1: Incremental Family ACL authorization flow
  // -------------------------------------------------------------
  if (consumed.purpose === 'family-acl') {
    // 1. BEFORE token exchange: validate signed current session cookie matches payload sessionId/userId,
    // and current family is ready, owned by user, with active owner membership
    const currentSession = await getSessionUser(c, db, config.sessionSecret);
    if (
      !currentSession ||
      currentSession.sessionId !== consumed.sessionId ||
      currentSession.user.id !== consumed.userId
    ) {
      return callbackFailure(c, '/onboarding?error=acl_failed');
    }

    const boundFamilies = await db
      .select()
      .from(families)
      .where(
        and(
          eq(families.id, consumed.familyId),
          eq(families.ownerUserId, consumed.userId),
          eq(families.creationStatus, 'ready'),
        ),
      );

    const boundFamily = boundFamilies[0];
    if (!boundFamily) {
      return callbackFailure(c, '/onboarding?error=acl_failed');
    }

    const activeMembers = await db
      .select()
      .from(members)
      .where(
        and(
          eq(members.familyId, consumed.familyId),
          eq(members.userId, consumed.userId),
          eq(members.status, 'active'),
        ),
      );

    if (!activeMembers[0]) {
      return callbackFailure(c, '/onboarding?error=acl_failed');
    }

    // 2. Token exchange with Google
    let tokenResponse: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
    try {
      tokenResponse = await exchangeCodeForTokens(query.code, codeVerifier, config);
    } catch {
      return c.redirect('/onboarding?error=acl_failed', 302);
    }

    if (!tokenResponse.id_token) {
      return c.redirect('/onboarding?error=acl_failed', 302);
    }

    // 3. Cryptographic JWT Verification (sub, exp, iat, nonce required)
    let claims: Awaited<ReturnType<typeof verifyGoogleIdToken>>;
    try {
      claims = await verifyGoogleIdToken(tokenResponse.id_token, config.clientId, nonce);
    } catch {
      return c.redirect('/onboarding?error=acl_failed', 302);
    }

    // 4. Require claims.sub === initiating current user.googleSub
    if (claims.sub !== currentSession.user.googleSub) {
      return callbackFailure(c, '/onboarding?error=acl_account_mismatch');
    }

    // 5. Require returned scope baseline + FAMILY_ACL_SCOPE (no union with stored scopes)
    let canonicalScopes: string;
    try {
      const scopeData = validateAndNormalizeScopes(tokenResponse.scope);
      if (!scopeData.normalizedScopes.includes(FAMILY_ACL_SCOPE)) {
        return c.redirect('/onboarding?error=acl_failed', 302);
      }
      canonicalScopes = scopeData.canonicalScopeString;
    } catch {
      return c.redirect('/onboarding?error=acl_failed', 302);
    }

    // 6. Recheck bound session + owner after asynchronous Google verify, immediately before write
    const recheckedSession = await getSessionUser(c, db, config.sessionSecret);
    if (
      !recheckedSession ||
      recheckedSession.sessionId !== consumed.sessionId ||
      recheckedSession.user.id !== consumed.userId
    ) {
      return callbackFailure(c, '/onboarding?error=acl_failed');
    }

    const recheckedFamilies = await db
      .select()
      .from(families)
      .where(
        and(
          eq(families.id, consumed.familyId),
          eq(families.ownerUserId, consumed.userId),
          eq(families.creationStatus, 'ready'),
        ),
      );

    if (!recheckedFamilies[0]) {
      return callbackFailure(c, '/onboarding?error=acl_failed');
    }

    const recheckedMembers = await db
      .select()
      .from(members)
      .where(
        and(
          eq(members.familyId, consumed.familyId),
          eq(members.userId, consumed.userId),
          eq(members.status, 'active'),
        ),
      );

    if (!recheckedMembers[0]) {
      return callbackFailure(c, '/onboarding?error=acl_failed');
    }

    // 7. Token grant write with atomic WHERE EXISTS guarding session, family, active member, and matching old ciphertext
    const existingTokens = await db
      .select()
      .from(googleTokens)
      .where(eq(googleTokens.userId, consumed.userId));
    const existingToken = existingTokens[0];

    let encryptedRefresh: string | undefined;
    if (tokenResponse.refresh_token && tokenResponse.refresh_token.length > 0) {
      encryptedRefresh = await encryptAesGcm(
        tokenResponse.refresh_token,
        config.tokenEncKey,
        `google-refresh:${consumed.userId}`,
      );
    }

    if (!encryptedRefresh && !existingToken) {
      return c.redirect('/onboarding?error=acl_failed', 302);
    }

    const writeTime = Math.floor(Date.now() / 1000);

    if (existingToken) {
      const newRefreshTokenEnc = encryptedRefresh ?? existingToken.refreshTokenEnc;
      const updateResult = await db.all<{ user_id: string }>(
        sql`UPDATE google_tokens
            SET refresh_token_enc = ${newRefreshTokenEnc},
                scopes = ${canonicalScopes},
                updated_at = ${writeTime}
            WHERE user_id = ${consumed.userId}
              AND refresh_token_enc = ${existingToken.refreshTokenEnc}
              AND EXISTS (
                SELECT 1 FROM sessions
                WHERE id = ${consumed.sessionId}
                  AND user_id = ${consumed.userId}
                  AND expires_at > unixepoch()
              )
              AND EXISTS (
                SELECT 1 FROM families
                WHERE id = ${consumed.familyId}
                  AND owner_user_id = ${consumed.userId}
                  AND creation_status = 'ready'
              )
              AND EXISTS (
                SELECT 1 FROM members
                WHERE family_id = ${consumed.familyId}
                  AND user_id = ${consumed.userId}
                  AND status = 'active'
              )
            RETURNING user_id`,
      );

      if (!updateResult || updateResult.length !== 1) {
        return c.redirect('/onboarding?error=acl_failed', 302);
      }
    } else if (encryptedRefresh) {
      const insertResult = await db.all<{ user_id: string }>(
        sql`INSERT INTO google_tokens (user_id, refresh_token_enc, scopes, updated_at)
            SELECT ${consumed.userId}, ${encryptedRefresh}, ${canonicalScopes}, ${writeTime}
            WHERE EXISTS (
              SELECT 1 FROM sessions
              WHERE id = ${consumed.sessionId}
                AND user_id = ${consumed.userId}
                AND expires_at > unixepoch()
            )
            AND EXISTS (
              SELECT 1 FROM families
              WHERE id = ${consumed.familyId}
                AND owner_user_id = ${consumed.userId}
                AND creation_status = 'ready'
            )
            AND EXISTS (
              SELECT 1 FROM members
              WHERE family_id = ${consumed.familyId}
                AND user_id = ${consumed.userId}
                AND status = 'active'
            )
            AND NOT EXISTS (
              SELECT 1 FROM google_tokens
              WHERE user_id = ${consumed.userId}
            )
            RETURNING user_id`,
      );

      if (!insertResult || insertResult.length !== 1) {
        return c.redirect('/onboarding?error=acl_failed', 302);
      }
    }

    // 8. No normal login upsert, no session rotation, no invite issued in callback
    return c.redirect('/onboarding?acl=granted', 302);
  }

  // -------------------------------------------------------------
  // BRANCH 2: Ordinary baseline login flow (with optional invite continuation)
  // -------------------------------------------------------------
  // 2. Token exchange with Google
  let tokenResponse: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  try {
    tokenResponse = await exchangeCodeForTokens(query.code, codeVerifier, config);
  } catch {
    return callbackFailure(c, loginFailureDestination);
  }

  if (!tokenResponse.id_token) {
    return callbackFailure(c, loginFailureDestination);
  }

  // 3. Scope validation
  let canonicalScopes: string;
  try {
    const scopeData = validateAndNormalizeScopes(tokenResponse.scope);
    canonicalScopes = scopeData.canonicalScopeString;
  } catch {
    return callbackFailure(c, loginFailureDestination);
  }

  // 4. Cryptographic JWT Verification (sub, exp, iat, nonce required)
  let claims: Awaited<ReturnType<typeof verifyGoogleIdToken>>;
  try {
    claims = await verifyGoogleIdToken(tokenResponse.id_token, config.clientId, nonce);
  } catch {
    return callbackFailure(c, loginFailureDestination);
  }

  // 5. Pre-mutation grant validation: check missing refresh BEFORE any user profile mutation
  const existingUserRows = await db.select().from(users).where(eq(users.googleSub, claims.sub));
  const existingUser = existingUserRows[0];

  if (!tokenResponse.refresh_token) {
    if (!existingUser) {
      return callbackFailure(c, loginFailureDestination);
    }

    const existingTokenRows = await db
      .select()
      .from(googleTokens)
      .where(eq(googleTokens.userId, existingUser.id));

    if (!existingTokenRows[0]) {
      return callbackFailure(c, loginFailureDestination);
    }
  }

  // 6. User upsert resolving canonical id atomically via ON CONFLICT (google_sub)
  const candidateId = `usr_${crypto.randomUUID()}`;
  const upsertedUsers = await db
    .insert(users)
    .values({
      id: candidateId,
      googleSub: claims.sub,
      email: claims.email,
      displayName: claims.name || claims.email,
    })
    .onConflictDoUpdate({
      target: users.googleSub,
      set: {
        email: claims.email,
        displayName: claims.name || claims.email,
      },
    })
    .returning({ id: users.id });

  const upsertedUser = upsertedUsers[0];
  if (!upsertedUser) {
    return callbackFailure(c, loginFailureDestination);
  }
  const userId = upsertedUser.id;

  // 7. Encrypt refresh token prior to database transaction (do NOT trim opaque tokens)
  let encryptedRefresh: string | undefined;
  if (tokenResponse.refresh_token && tokenResponse.refresh_token.length > 0) {
    encryptedRefresh = await encryptAesGcm(
      tokenResponse.refresh_token,
      config.tokenEncKey,
      `google-refresh:${userId}`,
    );
  }

  // 8. Prepare session creation
  const newRawToken = generateRandomToken(32);
  const newSessionId = await sha256Hex(newRawToken);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL_SECONDS;

  const newSessionStmt = db.insert(sessions).values({
    id: newSessionId,
    userId,
    expiresAt,
    createdAt: now,
  });

  // Prepare grant upsert statement
  const grantStmt = encryptedRefresh
    ? db
        .insert(googleTokens)
        .values({
          userId,
          refreshTokenEnc: encryptedRefresh,
          scopes: canonicalScopes,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: googleTokens.userId,
          set: {
            refreshTokenEnc: encryptedRefresh,
            scopes: canonicalScopes,
            updatedAt: now,
          },
        })
    : db
        .update(googleTokens)
        .set({
          scopes: canonicalScopes,
          updatedAt: now,
        })
        .where(eq(googleTokens.userId, userId));

  // Check current browser session for rotation (preserves other devices)
  const currentBrowserSession = await getSessionUser(c, db, config.sessionSecret);

  // Batch grant write, new session creation, and old current session deletion atomically
  if (currentBrowserSession) {
    const deleteOldSessionStmt = db
      .delete(sessions)
      .where(eq(sessions.id, currentBrowserSession.sessionId));
    await db.batch([grantStmt, newSessionStmt, deleteOldSessionStmt] as const);
  } else {
    await db.batch([grantStmt, newSessionStmt] as const);
  }

  // Issue session cookie only after atomic batch transaction succeeds
  await setSessionCookie(c, newRawToken, config.sessionSecret);

  if (consumed.inviteToken) {
    return c.redirect(`/invite#${consumed.inviteToken}`, 302);
  }

  return c.redirect('/', 302);
});

/**
 * POST /api/auth/logout
 * Requires XMLHttpRequest and exact Origin header to prevent CSRF.
 * Idempotent: invalidates D1 session row and clears session cookie.
 */
authRoute.post('/auth/logout', async (c) => {
  const xRequestedWith = c.req.header('x-requested-with');
  if (xRequestedWith !== 'XMLHttpRequest') {
    const errorBody = apiErrorResponseSchema.parse({ error: 'Forbidden' });
    return c.json(errorBody, 403);
  }

  const originHeader = c.req.header('origin');
  const config = getAuthConfig(c.env);
  if (originHeader !== config.appOrigin) {
    const errorBody = apiErrorResponseSchema.parse({ error: 'Forbidden' });
    return c.json(errorBody, 403);
  }

  const db = createDb(c.env.DB);
  const sessionData = await getSessionUser(c, db, config.sessionSecret);
  if (sessionData) {
    await deleteSession(db, sessionData.sessionId);
  }

  clearSessionCookie(c);
  const responseData = authLogoutResponseSchema.parse({ ok: true });
  return c.json(responseData, 200);
});

/**
 * GET /api/auth/me
 * Returns public user identification for valid active session, or 401.
 * Never leaks googleSub, tokens, or hashes.
 */
authRoute.get('/auth/me', async (c) => {
  const config = getAuthConfig(c.env);
  const db = createDb(c.env.DB);
  const sessionData = await getSessionUser(c, db, config.sessionSecret);

  if (!sessionData) {
    const errorBody = apiErrorResponseSchema.parse({ error: 'Unauthorized' });
    return c.json(errorBody, 401);
  }

  const responseData = authMeResponseSchema.parse({
    user: {
      id: sessionData.user.id,
      email: sessionData.user.email,
      displayName: sessionData.user.displayName,
    },
  });

  return c.json(responseData, 200);
});
