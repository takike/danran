import {
  type AuthUser,
  authLogoutResponseSchema,
  authMeResponseSchema,
} from '@shared/schemas/auth';

export class AuthApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AuthApiError';
  }
}

/**
 * Fetches the current session profile from GET /api/auth/me.
 *
 * Invariants:
 * - 401 status indicates an unauthenticated session (returns null).
 * - 200 responses are strictly validated against authMeResponseSchema.
 * - Non-200 responses or invalid schemas throw AuthApiError.
 * - Always uses cache: 'no-store' and passes AbortSignal for query cancellation.
 */
export async function fetchSession(signal?: AbortSignal): Promise<AuthUser | null> {
  let response: Response;
  try {
    response = await fetch('/api/auth/me', {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
      },
      signal,
    });
  } catch (err: unknown) {
    if (signal?.aborted) {
      throw err;
    }
    throw new AuthApiError('認証サーバーとの通信に失敗しました。');
  }

  // 401 means unauthenticated / logged out (normal state, not an exception)
  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new AuthApiError('認証情報の取得に失敗しました。', response.status);
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new AuthApiError('認証レスポンスの形式が無効です。', response.status);
  }

  const parseResult = authMeResponseSchema.safeParse(rawJson);
  if (!parseResult.success) {
    throw new AuthApiError('認証データの検証に失敗しました。', response.status);
  }

  return parseResult.data.user;
}

/**
 * Logs out the current user via POST /api/auth/logout.
 *
 * Invariants:
 * - Sends X-Requested-With: XMLHttpRequest and credentials: same-origin for CSRF prevention.
 * - Validates successful 200 response with authLogoutResponseSchema.
 * - Throws AuthApiError on non-200 response so caller can support retry and preserve account state.
 */
export async function logout(): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/auth/logout', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
    });
  } catch {
    throw new AuthApiError('ログアウト処理の通信に失敗しました。');
  }

  if (!response.ok) {
    throw new AuthApiError('ログアウト処理に失敗しました。', response.status);
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new AuthApiError('ログアウトレスポンスの形式が無効です。', response.status);
  }

  const parseResult = authLogoutResponseSchema.safeParse(rawJson);
  if (!parseResult.success) {
    throw new AuthApiError('ログアウトデータの検証に失敗しました。', response.status);
  }
}
