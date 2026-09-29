import {
  type AuthCallbackQuery,
  authCallbackQuerySchema,
  authLogoutResponseSchema,
  authMeResponseSchema,
} from '@shared/schemas/auth';
import { apiErrorResponseSchema } from '@shared/schemas/errors';
import { type AuthConfig, SESSION_TTL_SECONDS, getAuthConfig } from '@worker/auth/config';
import { encryptAesGcm, generateRandomToken, sha256Hex } from '@worker/auth/crypto';
import { clearOAuthCookie, consumeOAuthFlow, initiateOAuthFlow } from '@worker/auth/oauth';
import {
  clearSessionCookie,
  deleteSession,
  getSessionUser,
  setSessionCookie,
} from '@worker/auth/session';
import { createDb } from '@worker/db';
import { googleTokens, sessions, users } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import {
  GoogleAuthError,
  exchangeCodeForTokens,
  validateAndNormalizeScopes,
  verifyGoogleIdToken,
} from '@worker/google/oauth';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

export const authRoute = new Hono<{ Bindings: WorkerEnv }>();

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
    const errorBody = apiErrorResponseSchema.parse({ error: 'Forbidden' });
    return c.json(errorBody, 403);
  }

  if (requestOrigin !== config.appOrigin) {
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
 */
authRoute.get('/auth/login', async (c) => {
  const config = getAuthConfig(c.env);
  const db = createDb(c.env.DB);

  const { authUrl } = await initiateOAuthFlow(c, db, config);
  return c.redirect(authUrl, 302);
});

/**
 * GET /api/auth/callback
 * Consumes single-use state atomically, exchanges authorization code for tokens,
 * cryptographically verifies Google ID Token, saves encrypted refresh token,
 * batches session rotation, and redirects to root.
 */
authRoute.get('/auth/callback', async (c) => {
  const rawQuery = c.req.query();
  const queryResult = authCallbackQuerySchema.safeParse(rawQuery);
  if (!queryResult.success) {
    clearOAuthCookie(c);
    const errorBody = apiErrorResponseSchema.parse({
      error: 'Invalid callback parameters',
    });
    return c.json(errorBody, 400);
  }

  const query: AuthCallbackQuery = queryResult.data;
  const config = getAuthConfig(c.env);
  const db = createDb(c.env.DB);

  // Handle user cancellation / error from Google:
  // Must atomically consume matching valid state and browser binding before redirecting to fixed root
  if (query.error) {
    if (!query.state) {
      clearOAuthCookie(c);
      const errorBody = apiErrorResponseSchema.parse({
        error: 'Missing state parameter on denial',
      });
      return c.json(errorBody, 400);
    }

    try {
      await consumeOAuthFlow(c, db, config, query.state);
    } catch {
      clearOAuthCookie(c);
      const errorBody = apiErrorResponseSchema.parse({
        error: 'Invalid or expired OAuth state',
      });
      return c.json(errorBody, 400);
    }

    return c.redirect('/?error=access_denied', 302);
  }

  if (!query.code || !query.state) {
    clearOAuthCookie(c);
    const errorBody = apiErrorResponseSchema.parse({
      error: 'Missing code or state parameter',
    });
    return c.json(errorBody, 400);
  }

  // 1. Single-use atomic consumption of OAuth state and browser binding
  let codeVerifier: string;
  let nonce: string;
  try {
    const consumed = await consumeOAuthFlow(c, db, config, query.state);
    codeVerifier = consumed.codeVerifier;
    nonce = consumed.nonce;
  } catch {
    const errorBody = apiErrorResponseSchema.parse({
      error: 'Invalid or expired OAuth state',
    });
    return c.json(errorBody, 400);
  }

  // 2. Token exchange with Google
  let tokenResponse: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  try {
    tokenResponse = await exchangeCodeForTokens(query.code, codeVerifier, config);
  } catch {
    const errorBody = apiErrorResponseSchema.parse({
      error: 'Failed to exchange authorization code',
    });
    return c.json(errorBody, 400);
  }

  if (!tokenResponse.id_token) {
    const errorBody = apiErrorResponseSchema.parse({
      error: 'Missing ID token in Google response',
    });
    return c.json(errorBody, 400);
  }

  // 3. Scope validation
  let canonicalScopes: string;
  try {
    const scopeData = validateAndNormalizeScopes(tokenResponse.scope);
    canonicalScopes = scopeData.canonicalScopeString;
  } catch {
    const errorBody = apiErrorResponseSchema.parse({
      error: 'Required permissions not granted',
    });
    return c.json(errorBody, 400);
  }

  // 4. Cryptographic JWT Verification (sub, exp, iat, nonce required)
  let claims: Awaited<ReturnType<typeof verifyGoogleIdToken>>;
  try {
    claims = await verifyGoogleIdToken(tokenResponse.id_token, config.clientId, nonce);
  } catch {
    const errorBody = apiErrorResponseSchema.parse({
      error: 'Failed to verify Google identity',
    });
    return c.json(errorBody, 400);
  }

  // 5. Pre-mutation grant validation: check missing refresh BEFORE any user profile mutation
  const existingUserRows = await db.select().from(users).where(eq(users.googleSub, claims.sub));
  const existingUser = existingUserRows[0];

  if (!tokenResponse.refresh_token) {
    if (!existingUser) {
      const errorBody = apiErrorResponseSchema.parse({
        error: 'First-time sign-in requires offline consent',
      });
      return c.json(errorBody, 400);
    }

    const existingTokenRows = await db
      .select()
      .from(googleTokens)
      .where(eq(googleTokens.userId, existingUser.id));

    if (!existingTokenRows[0]) {
      const errorBody = apiErrorResponseSchema.parse({
        error: 'Missing Google credentials for user',
      });
      return c.json(errorBody, 400);
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
    const errorBody = apiErrorResponseSchema.parse({
      error: 'Failed to persist user profile',
    });
    return c.json(errorBody, 500);
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
