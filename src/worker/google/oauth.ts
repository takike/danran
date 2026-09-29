import {
  type GoogleIdTokenClaims,
  type GoogleTokenResponse,
  googleErrorResponseSchema,
  googleIdTokenClaimsSchema,
  googleTokenResponseSchema,
} from '@shared/schemas/auth';
import {
  type AuthConfig,
  GOOGLE_JWKS_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  PHASE1_SCOPES,
  getAuthConfig,
} from '@worker/auth/config';
import { decryptAesGcm, encryptAesGcm } from '@worker/auth/crypto';
import type { Database } from '@worker/db';
import { createDb } from '@worker/db';
import { googleTokens } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { and, eq } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export class ReauthNeededError extends Error {
  constructor(message = 'Re-authentication with Google is required') {
    super(message);
    this.name = 'ReauthNeededError';
  }
}

export class GoogleAuthError extends Error {
  constructor(message = 'Google authentication error') {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

export class GoogleApiError extends Error {
  constructor(message = 'Upstream Google API request failed') {
    super(message);
    this.name = 'GoogleApiError';
  }
}

const defaultGoogleJWKS = createRemoteJWKSet(new URL(GOOGLE_JWKS_ENDPOINT));

/**
 * Normalizes Google OAuth scope aliases to canonical form.
 * e.g. https://www.googleapis.com/auth/userinfo.email -> email
 */
export function normalizeGoogleScope(scope: string): string {
  if (scope === 'https://www.googleapis.com/auth/userinfo.email') return 'email';
  if (scope === 'https://www.googleapis.com/auth/userinfo.profile') return 'profile';
  return scope;
}

/**
 * Validates that all Phase 1 required scopes have been granted.
 * Normalizes aliases and returns canonical space-separated scope string.
 */
export function validateAndNormalizeScopes(scopeStr?: string): {
  normalizedScopes: string[];
  canonicalScopeString: string;
} {
  if (!scopeStr) {
    throw new GoogleAuthError('Missing granted scopes in Google token response');
  }

  const granted = new Set(
    scopeStr
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(normalizeGoogleScope),
  );

  for (const required of PHASE1_SCOPES) {
    if (!granted.has(required)) {
      throw new GoogleAuthError(`Missing required Phase 1 scope: ${required}`);
    }
  }

  const sorted = Array.from(granted).sort();
  return {
    normalizedScopes: sorted,
    canonicalScopeString: sorted.join(' '),
  };
}

/**
 * Exchanges authorization code and PKCE code_verifier for Google tokens.
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  config: AuthConfig,
): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: `${config.appOrigin}/api/auth/callback`,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new GoogleApiError('Failed to communicate with Google token endpoint');
  }

  if (!response.ok) {
    throw new GoogleAuthError('Google token exchange failed');
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new GoogleAuthError('Google token response is not valid JSON');
  }

  const parseResult = googleTokenResponseSchema.safeParse(rawJson);
  if (!parseResult.success) {
    throw new GoogleAuthError('Google token response failed schema validation');
  }

  return parseResult.data;
}

/**
 * Cryptographically verifies Google ID Token JWT against official Google JWKS endpoint.
 * Validates RS256 signature, issuer, audience, required claims (sub, exp, iat, nonce), azp, and verified email.
 * Production code contains no test JWKS injection seams.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  expectedNonce: string,
): Promise<GoogleIdTokenClaims> {
  let verifyResult: Awaited<ReturnType<typeof jwtVerify>>;
  try {
    verifyResult = await jwtVerify(idToken, defaultGoogleJWKS, {
      algorithms: ['RS256'],
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId,
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
    });
  } catch {
    throw new GoogleAuthError('Google ID token verification failed');
  }

  const { payload } = verifyResult;

  if (payload.nonce !== expectedNonce) {
    throw new GoogleAuthError('Google ID token nonce mismatch');
  }

  if (payload.azp && payload.azp !== clientId) {
    throw new GoogleAuthError('Google ID token azp does not match client ID');
  }

  const parseResult = googleIdTokenClaimsSchema.safeParse(payload);
  if (!parseResult.success) {
    throw new GoogleAuthError('Google ID token claims failed schema validation');
  }

  const claims = parseResult.data;
  if (!claims.email_verified) {
    throw new GoogleAuthError('Google account email is not verified');
  }

  return claims;
}

/**
 * Server-only helper: retrieves a fresh Google access token on demand for the user
 * by decrypting their stored refresh token and calling Google's token endpoint.
 *
 * Does NOT persist short-lived access tokens to DB.
 * On invalid_grant on 4xx: conditionally invalidates stored grant and throws ReauthNeededError.
 * On network/429/5xx: retains stored grant and throws GoogleApiError (even if body has invalid_grant).
 * On rotated refresh token: encrypts and updates stored refresh token using conditional update without trimming.
 * Validates and updates scopes atomically when returned; preserves previous scopes when omitted.
 */
export async function getGoogleAccessToken(
  env: WorkerEnv,
  userId: string,
): Promise<{ accessToken: string; expiresIn: number; tokenType: string }> {
  const config = getAuthConfig(env);
  const db: Database = createDb(env.DB);

  const tokenRows = await db.select().from(googleTokens).where(eq(googleTokens.userId, userId));

  const tokenRow = tokenRows[0];
  if (!tokenRow) {
    throw new ReauthNeededError('No Google grant found for user');
  }

  const refreshToken = await decryptAesGcm(
    tokenRow.refreshTokenEnc,
    config.tokenEncKey,
    `google-refresh:${userId}`,
  );

  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new GoogleApiError('Failed to communicate with Google token endpoint');
  }

  if (!response.ok) {
    // Only non-429 4xx responses may indicate invalid_grant for grant invalidation
    const is4xxAuthError =
      response.status >= 400 && response.status < 500 && response.status !== 429;

    if (is4xxAuthError) {
      let isInvalidGrant = false;
      try {
        const errJson = await response.json();
        const parsedErr = googleErrorResponseSchema.safeParse(errJson);
        if (parsedErr.success && parsedErr.data.error === 'invalid_grant') {
          isInvalidGrant = true;
        }
      } catch {
        // ignore parse error on error response
      }

      if (isInvalidGrant) {
        // Conditional delete on old ciphertext so concurrent new grant is not erased
        await db
          .delete(googleTokens)
          .where(
            and(
              eq(googleTokens.userId, userId),
              eq(googleTokens.refreshTokenEnc, tokenRow.refreshTokenEnc),
            ),
          );
        throw new ReauthNeededError('Google grant was revoked or expired');
      }
    }

    // Upstream transient (429/5xx) or non-invalid_grant error: retain stored grant
    throw new GoogleApiError('Google token refresh failed');
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new GoogleApiError('Google token refresh response was not valid JSON');
  }

  const parseResult = googleTokenResponseSchema.safeParse(rawJson);
  if (!parseResult.success) {
    throw new GoogleApiError('Google token refresh response failed validation');
  }

  const data = parseResult.data;

  // Validate scopes if returned (reject empty/partial); preserve previous scopes only when omitted
  let scopesToPersist = tokenRow.scopes;
  if (data.scope !== undefined) {
    scopesToPersist = validateAndNormalizeScopes(data.scope).canonicalScopeString;
  }

  // Handle potential refresh token rotation (do NOT trim opaque tokens)
  if (data.refresh_token && data.refresh_token.length > 0) {
    const newEncrypted = await encryptAesGcm(
      data.refresh_token,
      config.tokenEncKey,
      `google-refresh:${userId}`,
    );

    // Conditional update matching the exact old ciphertext
    await db
      .update(googleTokens)
      .set({
        refreshTokenEnc: newEncrypted,
        scopes: scopesToPersist,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(
        and(
          eq(googleTokens.userId, userId),
          eq(googleTokens.refreshTokenEnc, tokenRow.refreshTokenEnc),
        ),
      );
  } else if (scopesToPersist !== tokenRow.scopes) {
    await db
      .update(googleTokens)
      .set({
        scopes: scopesToPersist,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(
        and(
          eq(googleTokens.userId, userId),
          eq(googleTokens.refreshTokenEnc, tokenRow.refreshTokenEnc),
        ),
      );
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
  };
}
