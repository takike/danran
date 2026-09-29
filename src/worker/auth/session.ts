import type { Database } from '@worker/db';
import { type User, sessions, users } from '@worker/db/schema';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from './config';
import { generateRandomToken, sha256Hex } from './crypto';

export const SESSION_COOKIE_OPTIONS = {
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax' as const,
  maxAge: SESSION_TTL_SECONDS,
};

/**
 * Creates a persistent session in D1.
 * Returns the unhashed raw token (to be sent via signed cookie) and expiration.
 */
export async function createSession(
  db: Database,
  userId: string,
): Promise<{ rawToken: string; expiresAt: number }> {
  const rawToken = generateRandomToken(32);
  const sessionId = await sha256Hex(rawToken);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL_SECONDS;

  await db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt,
    createdAt: now,
  });

  return { rawToken, expiresAt };
}

/**
 * Stores the HMAC-signed raw session token in __Host-danran_session cookie.
 */
export async function setSessionCookie(
  c: Context,
  rawToken: string,
  sessionSecret: string,
): Promise<void> {
  await setSignedCookie(c, SESSION_COOKIE_NAME, rawToken, sessionSecret, SESSION_COOKIE_OPTIONS);
}

/**
 * Clears the session cookie from the client using identical attributes.
 */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  });
}

/**
 * Retrieves the authenticated user and session ID from the current request.
 * Returns null if no valid, unexpired session is present.
 */
export async function getSessionUser(
  c: Context,
  db: Database,
  sessionSecret: string,
): Promise<{ user: User; sessionId: string } | null> {
  const rawToken = await getSignedCookie(c, sessionSecret, SESSION_COOKIE_NAME);
  if (!rawToken || typeof rawToken !== 'string') {
    return null;
  }

  const sessionId = await sha256Hex(rawToken);
  const now = Math.floor(Date.now() / 1000);

  const sessionRows = await db.select().from(sessions).where(eq(sessions.id, sessionId));

  const session = sessionRows[0];
  if (!session) {
    return null;
  }

  if (session.expiresAt <= now) {
    // Opportunistically remove expired session
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }

  const userRows = await db.select().from(users).where(eq(users.id, session.userId));

  const user = userRows[0];
  if (!user) {
    return null;
  }

  return { user, sessionId };
}

/**
 * Removes a session row by its hashed ID from D1.
 */
export async function deleteSession(db: Database, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}
