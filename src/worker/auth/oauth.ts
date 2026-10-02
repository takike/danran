import {
  type OAuthFamilyAclPayload,
  type OAuthLoginPayload,
  type OAuthPayload,
  oauthPayloadSchema,
} from '@shared/schemas/auth';
import type { Database } from '@worker/db';
import { oauthStates } from '@worker/db/schema';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import {
  type AuthConfig,
  FAMILY_ACL_SCOPE,
  GOOGLE_AUTH_ENDPOINT,
  OAUTH_COOKIE_NAME,
  OAUTH_STATE_TTL_SECONDS,
  PHASE1_SCOPES,
} from './config';
import {
  decryptAesGcm,
  encryptAesGcm,
  generateCodeChallenge,
  generateRandomToken,
  sha256Hex,
} from './crypto';

export const OAUTH_COOKIE_OPTIONS = {
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax' as const,
  maxAge: OAUTH_STATE_TTL_SECONDS,
};

export type InitiateOAuthContext =
  | {
      purpose?: 'login';
      inviteToken?: string;
    }
  | {
      purpose: 'family-acl';
      userId: string;
      sessionId: string;
      familyId: string;
      loginHint?: string;
    };

/**
 * Opportunistically cleans up expired transient OAuth states from D1.
 * Called during login flow initiation (no Cron trigger required).
 */
export async function cleanupExpiredOAuthStates(db: Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now));
  } catch {
    // Opportunistic cleanup failure should not prevent login
  }
}

/**
 * Initializes a new OAuth authorization flow:
 * 1. Cleans up expired states.
 * 2. Generates state, nonce, PKCE verifier/challenge, and browser binding.
 * 3. Encrypts verifier and nonce, saving to oauth_states table.
 * 4. Sets signed browser binding cookie (__Host-danran_oauth).
 * 5. Returns Google authorization URL.
 */
export async function initiateOAuthFlow(
  c: Context,
  db: Database,
  config: AuthConfig,
  context?: InitiateOAuthContext,
): Promise<{ authUrl: string }> {
  await cleanupExpiredOAuthStates(db);

  const state = generateRandomToken(32);
  const nonce = generateRandomToken(32);
  const codeVerifier = generateRandomToken(32);
  const browserBinding = generateRandomToken(32);

  const stateHash = await sha256Hex(state);
  const bindingHash = await sha256Hex(browserBinding);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  let payload: string;
  if (context?.purpose === 'family-acl') {
    const aclPayload: OAuthFamilyAclPayload = {
      purpose: 'family-acl',
      codeVerifier,
      nonce,
      userId: context.userId,
      sessionId: context.sessionId,
      familyId: context.familyId,
    };
    payload = JSON.stringify(aclPayload);
  } else if (context?.inviteToken) {
    const loginPayload: OAuthLoginPayload = {
      purpose: 'login',
      codeVerifier,
      nonce,
      inviteToken: context.inviteToken,
    };
    payload = JSON.stringify(loginPayload);
  } else {
    // Preserve legacy format { codeVerifier, nonce } for standard login without invite token
    payload = JSON.stringify({ codeVerifier, nonce });
  }

  const payloadEnc = await encryptAesGcm(payload, config.tokenEncKey, `oauth-state:${stateHash}`);

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + OAUTH_STATE_TTL_SECONDS;

  await db.insert(oauthStates).values({
    stateHash,
    browserBindingHash: bindingHash,
    payloadEnc,
    expiresAt,
    createdAt: now,
  });

  await setSignedCookie(
    c,
    OAUTH_COOKIE_NAME,
    browserBinding,
    config.sessionSecret,
    OAUTH_COOKIE_OPTIONS,
  );

  const redirectUri = `${config.appOrigin}/api/auth/callback`;
  const isFamilyAcl = context?.purpose === 'family-acl';

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: isFamilyAcl ? [...PHASE1_SCOPES, FAMILY_ACL_SCOPE].join(' ') : PHASE1_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  if (isFamilyAcl) {
    params.set('include_granted_scopes', 'true');
    if (context.loginHint) {
      params.set('login_hint', context.loginHint);
    }
  }

  const authUrl = `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
  return { authUrl };
}

/**
 * Atomically consumes an OAuth flow state on callback before any external token exchange.
 * Single-use atomic consumption prevents replay attacks and race conditions.
 * Always clears the browser binding cookie.
 */
export async function consumeOAuthFlow(
  c: Context,
  db: Database,
  config: AuthConfig,
  state: string,
): Promise<OAuthPayload> {
  const browserBinding = await getSignedCookie(c, config.sessionSecret, OAUTH_COOKIE_NAME);

  // Clear oauth cookie immediately regardless of outcome
  clearOAuthCookie(c);

  if (!browserBinding || typeof browserBinding !== 'string') {
    throw new Error('Missing or invalid OAuth browser binding cookie');
  }

  const stateHash = await sha256Hex(state);
  const bindingHash = await sha256Hex(browserBinding);
  const now = Math.floor(Date.now() / 1000);

  // Atomic single-use deletion with RETURNING
  const deletedRows = await db
    .delete(oauthStates)
    .where(
      and(
        eq(oauthStates.stateHash, stateHash),
        eq(oauthStates.browserBindingHash, bindingHash),
        gt(oauthStates.expiresAt, now),
      ),
    )
    .returning({ payloadEnc: oauthStates.payloadEnc });

  const deleted = deletedRows[0];
  if (!deleted) {
    throw new Error('OAuth flow state invalid, expired, or already consumed');
  }

  const payloadJson = await decryptAesGcm(
    deleted.payloadEnc,
    config.tokenEncKey,
    `oauth-state:${stateHash}`,
  );

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payloadJson);
  } catch {
    throw new Error('Invalid OAuth flow payload format');
  }

  const payloadResult = oauthPayloadSchema.safeParse(parsedJson);
  if (!payloadResult.success) {
    throw new Error('Incomplete OAuth flow payload fields');
  }

  return payloadResult.data;
}

/**
 * Clears the __Host-danran_oauth cookie.
 */
export function clearOAuthCookie(c: Context): void {
  deleteCookie(c, OAUTH_COOKIE_NAME, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  });
}
