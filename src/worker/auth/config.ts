import type { WorkerEnv } from '@worker/env';
import { parseAes256Key } from './crypto';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';

export const SESSION_COOKIE_NAME = '__Host-danran_session';
export const OAUTH_COOKIE_NAME = '__Host-danran_oauth';

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const OAUTH_STATE_TTL_SECONDS = 10 * 60; // 10 minutes

export const PHASE1_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const;

export const FAMILY_ACL_SCOPE = 'https://www.googleapis.com/auth/calendar.acls' as const;
export const PERSONAL_EVENTS_SCOPE =
  'https://www.googleapis.com/auth/calendar.events.readonly' as const;

/**
 * Validates and extracts pure application origin from configured APP_ORIGIN.
 * Enforces HTTPS except for localhost and loopback IPv4/IPv6 development origins.
 * Strictly throws without fallback when APP_ORIGIN is missing or invalid.
 */
export function getTrustedAppOrigin(env: WorkerEnv): string {
  if (!env.APP_ORIGIN || typeof env.APP_ORIGIN !== 'string' || env.APP_ORIGIN.trim().length === 0) {
    throw new Error('APP_ORIGIN is not configured');
  }

  let url: URL;
  try {
    url = new URL(env.APP_ORIGIN.trim());
  } catch {
    throw new Error('Invalid APP_ORIGIN configuration');
  }

  const isLocalhost =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';

  if (url.protocol !== 'https:' && (!isLocalhost || url.protocol !== 'http:')) {
    throw new Error('APP_ORIGIN must use HTTPS (HTTP is allowed only for localhost)');
  }

  if (url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
    throw new Error('APP_ORIGIN must be a pure origin without path, query, or hash');
  }

  if (url.username || url.password) {
    throw new Error('APP_ORIGIN must not include credentials');
  }

  return `${url.protocol}//${url.host}`;
}

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  tokenEncKey: string;
  appOrigin: string;
}

/**
 * Returns true if all required auth secrets, APP_ORIGIN, and keys are valid and complete.
 */
export function isAuthConfigured(env: WorkerEnv): boolean {
  try {
    getAuthConfig(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates and retrieves required auth configuration.
 * Validates canonical base64 AES key and pure origin before any side effects.
 * Throws if unconfigured or if secrets/origin fail validation.
 */
export function getAuthConfig(env: WorkerEnv): AuthConfig {
  const appOrigin = getTrustedAppOrigin(env);

  if (typeof env.GOOGLE_CLIENT_ID !== 'string' || env.GOOGLE_CLIENT_ID.trim().length === 0) {
    throw new Error('GOOGLE_CLIENT_ID is not configured');
  }

  if (
    typeof env.GOOGLE_CLIENT_SECRET !== 'string' ||
    env.GOOGLE_CLIENT_SECRET.trim().length === 0
  ) {
    throw new Error('GOOGLE_CLIENT_SECRET is not configured');
  }

  if (typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.trim().length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }

  if (typeof env.TOKEN_ENC_KEY !== 'string' || env.TOKEN_ENC_KEY.trim().length === 0) {
    throw new Error('TOKEN_ENC_KEY is not configured');
  }

  // Validate strict canonical standard base64 32-byte key
  parseAes256Key(env.TOKEN_ENC_KEY);

  return {
    clientId: env.GOOGLE_CLIENT_ID.trim(),
    clientSecret: env.GOOGLE_CLIENT_SECRET.trim(),
    sessionSecret: env.SESSION_SECRET.trim(),
    tokenEncKey: env.TOKEN_ENC_KEY.trim(),
    appOrigin,
  };
}
