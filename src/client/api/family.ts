import {
  type AddChildrenInput,
  type ChildInput,
  type CreateFamilyInput,
  type FamilyErrorCode,
  type FamilyPublic,
  type InviteIssueResponse,
  type InviteStatus,
  type JoinInfoResponse,
  type MemberColor,
  childResponseSchema,
  createFamilyInputSchema,
  createFamilyResponseSchema,
  familyErrorResponseSchema,
  familyListResponseSchema,
  inviteIssueResponseSchema,
  joinInfoResponseSchema,
  joinSuccessResponseSchema,
  reconcileFamilyResponseSchema,
} from '@shared/schemas/family';
import { z } from 'zod';

export class FamilyApiError extends Error {
  constructor(
    message: string,
    public readonly code?: FamilyErrorCode,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'FamilyApiError';
  }
}

/**
 * Fixed Japanese error message mapping for FamilyErrorCode enum.
 * Invariant: Never reflect arbitrary backend or third-party error strings in the UI.
 */
export const FAMILY_ERROR_MESSAGES: Record<FamilyErrorCode, string> = {
  INVALID_INPUT: '入力内容を確認してください。',
  UNAUTHORIZED: 'ログインが必要です。',
  FORBIDDEN: 'この操作を行う権限がありません。',
  NOT_FOUND: '対象のデータが見つかりませんでした。',
  ALREADY_IN_FAMILY: 'すでに家族に所属しています。別の家族には参加できません。',
  IN_PROGRESS: '現在処理中です。しばらくお待ちください。',
  UNCERTAIN_MUTATION:
    '処理結果を確認できませんでした。状態を確認するか、しばらく経ってから再度お試しください。',
  GOOGLE_ERROR: 'Google カレンダーとの通信に失敗しました。時間をおいて再度お試しください。',
  REAUTH_REQUIRED:
    'Google カレンダーの認可が不足しています。家族のオーナーに招待リンクの再発行を依頼してください。',
  INTERNAL_ERROR: 'サーバーで問題が発生しました。しばらく経ってから再度お試しください。',
  EXPIRED_INVITE: '招待リンクの有効期限が切れています。',
  USED_INVITE: 'この招待リンクは既に使用されています。',
};

async function parseApiError(response: Response, defaultMessage: string): Promise<FamilyApiError> {
  try {
    const rawJson = await response.json();
    const parsed = familyErrorResponseSchema.safeParse(rawJson);
    if (parsed.success) {
      const msg = FAMILY_ERROR_MESSAGES[parsed.data.code] ?? defaultMessage;
      return new FamilyApiError(msg, parsed.data.code, response.status);
    }
  } catch {
    // Non-JSON response
  }
  return new FamilyApiError(defaultMessage, undefined, response.status);
}

/**
 * Validates that an OAuth authorization URL strictly targets accounts.google.com without credentials, port, or hash.
 */
export function validateGoogleAuthUrl(urlStr: string): string {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new FamilyApiError('無効な認可 URL です。');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.host !== 'accounts.google.com' ||
    parsed.origin !== 'https://accounts.google.com' ||
    parsed.pathname !== '/o/oauth2/v2/auth' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== ''
  ) {
    throw new FamilyApiError('許可されていない認可先 URL です。');
  }
  return parsed.toString();
}

/**
 * Validates that an invite URL matches the current app origin, /invite path, strict 43-character fragment, and no userinfo or query.
 */
export function validateInviteUrl(urlStr: string): { url: string; token: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new FamilyApiError('無効な招待 URL です。');
  }
  if (
    parsed.origin !== window.location.origin ||
    parsed.host !== window.location.host ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/invite' ||
    parsed.search !== ''
  ) {
    throw new FamilyApiError('招待 URL の形式が無効です。');
  }
  const fragment = parsed.hash.replace(/^#/, '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(fragment)) {
    throw new FamilyApiError('招待トークンの形式が無効です。');
  }
  return { url: parsed.toString(), token: fragment };
}

/**
 * Extracts and strictly validates raw 43-character invite token from hash.
 */
export function extractInviteToken(hash: string): string | null {
  const token = hash.replace(/^#/, '');
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return token;
  }
  return null;
}

/**
 * GET /api/families
 * Fetches active family memberships for the current user.
 */
export async function fetchFamilies(signal?: AbortSignal): Promise<FamilyPublic[]> {
  let response: Response;
  try {
    response = await fetch('/api/families', {
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
    throw new FamilyApiError('家族情報の通信に失敗しました。');
  }

  if (!response.ok) {
    throw await parseApiError(response, '家族情報の取得に失敗しました。');
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new FamilyApiError('家族情報の応答形式が無効です。', undefined, response.status);
  }

  const parsed = familyListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new FamilyApiError('家族情報の検証に失敗しました。', undefined, response.status);
  }

  return parsed.data.families;
}

/**
 * POST /api/families
 * Creates a new family calendar and family membership.
 */
export async function createFamily(
  input: CreateFamilyInput,
  signal?: AbortSignal,
): Promise<FamilyPublic> {
  let response: Response;
  try {
    response = await fetch('/api/families', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
      body: JSON.stringify(input),
      signal,
    });
  } catch (err: unknown) {
    if (signal?.aborted) {
      throw err;
    }
    throw new FamilyApiError('家族カレンダー作成の通信に失敗しました。');
  }

  if (!response.ok) {
    throw await parseApiError(response, '家族カレンダーの作成に失敗しました。');
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new FamilyApiError('作成レスポンスの形式が無効です。', undefined, response.status);
  }

  const parsed = createFamilyResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new FamilyApiError('作成レスポンスの検証に失敗しました。', undefined, response.status);
  }

  return parsed.data.family;
}

/**
 * POST /api/families/:id/reconcile
 * Reconciles uncertain family creation state with Google Calendar.
 */
export async function reconcileFamily(
  familyId: string,
  signal?: AbortSignal,
): Promise<FamilyPublic> {
  let response: Response;
  try {
    response = await fetch(`/api/families/${encodeURIComponent(familyId)}/reconcile`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
      body: JSON.stringify({}),
      signal,
    });
  } catch (err: unknown) {
    if (signal?.aborted) {
      throw err;
    }
    throw new FamilyApiError('家族状態の確認通信に失敗しました。');
  }

  if (!response.ok) {
    throw await parseApiError(response, '家族状態の確認に失敗しました。');
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new FamilyApiError('状態確認レスポンスの形式が無効です。', undefined, response.status);
  }

  const parsed = reconcileFamilyResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new FamilyApiError(
      '状態確認レスポンスの検証に失敗しました。',
      undefined,
      response.status,
    );
  }

  return parsed.data.family;
}

/**
 * PUT /api/families/:id/children
 * Updates or replaces the child member set (0..10 children).
 */
export async function updateChildren(
  familyId: string,
  children: ChildInput[],
  signal?: AbortSignal,
): Promise<FamilyPublic> {
  let response: Response;
  try {
    response = await fetch(`/api/families/${encodeURIComponent(familyId)}/children`, {
      method: 'PUT',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
      body: JSON.stringify({ children }),
      signal,
    });
  } catch (err: unknown) {
    if (signal?.aborted) {
      throw err;
    }
    throw new FamilyApiError('子ども情報の更新通信に失敗しました。');
  }

  if (!response.ok) {
    throw await parseApiError(response, '子ども情報の更新に失敗しました。');
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new FamilyApiError('更新レスポンスの形式が無効です。', undefined, response.status);
  }

  const parsed = childResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new FamilyApiError('更新レスポンスの検証に失敗しました。', undefined, response.status);
  }

  return parsed.data.family;
}

/**
 * POST /api/families/:id/invites
 * Issues an invite link or returns incremental authorization URL for calendar.acls scope.
 */
export async function issueInvite(
  familyId: string,
  signal?: AbortSignal,
): Promise<InviteIssueResponse> {
  let response: Response;
  try {
    response = await fetch(`/api/families/${encodeURIComponent(familyId)}/invites`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
      body: JSON.stringify({}),
      signal,
    });
  } catch (err: unknown) {
    if (signal?.aborted) {
      throw err;
    }
    throw new FamilyApiError('招待リンク発行の通信に失敗しました。');
  }

  if (!response.ok) {
    throw await parseApiError(response, '招待リンクの発行に失敗しました。');
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new FamilyApiError('招待発行レスポンスの形式が無効です。', undefined, response.status);
  }

  const parsed = inviteIssueResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new FamilyApiError(
      '招待発行レスポンスの検証に失敗しました。',
      undefined,
      response.status,
    );
  }

  if (parsed.data.authorizationRequired) {
    validateGoogleAuthUrl(parsed.data.authorizationUrl);
  } else {
    validateInviteUrl(parsed.data.inviteUrl);
  }

  return parsed.data;
}

/**
 * POST /api/invites/inspect
 * Inspects invite status for an authenticated user.
 */
export async function inspectInvite(
  token: string,
  signal?: AbortSignal,
): Promise<JoinInfoResponse> {
  let response: Response;
  try {
    response = await fetch('/api/invites/inspect', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
      body: JSON.stringify({ token }),
      signal,
    });
  } catch (err: unknown) {
    if (signal?.aborted) {
      throw err;
    }
    throw new FamilyApiError('招待情報の確認通信に失敗しました。');
  }

  if (!response.ok) {
    throw await parseApiError(response, '招待情報の確認に失敗しました。');
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new FamilyApiError('招待情報レスポンスの形式が無効です。', undefined, response.status);
  }

  const parsed = joinInfoResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new FamilyApiError(
      '招待情報レスポンスの検証に失敗しました。',
      undefined,
      response.status,
    );
  }

  return parsed.data;
}

/**
 * POST /api/invites/join
 * Joins a family using an invite token after explicit user confirmation.
 */
export async function joinFamily(token: string, signal?: AbortSignal): Promise<FamilyPublic> {
  let response: Response;
  try {
    response = await fetch('/api/invites/join', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
      body: JSON.stringify({ token }),
      signal,
    });
  } catch (err: unknown) {
    if (signal?.aborted) {
      throw err;
    }
    throw new FamilyApiError('家族参加の通信に失敗しました。');
  }

  if (!response.ok) {
    throw await parseApiError(response, '家族への参加に失敗しました。');
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new FamilyApiError('参加レスポンスの形式が無効です。', undefined, response.status);
  }

  const parsed = joinSuccessResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new FamilyApiError('参加レスポンスの検証に失敗しました。', undefined, response.status);
  }

  return parsed.data.family;
}

const loginInviteResponseSchema = z.object({
  authorizationUrl: z.string().min(1),
});

/**
 * POST /api/auth/login with inviteToken
 * Initiates anonymous login bound to an invite token with encrypted state returning to /invite#token.
 */
export async function loginWithInviteToken(
  inviteToken: string,
  signal?: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/auth/login', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
      body: JSON.stringify({ inviteToken }),
      signal,
    });
  } catch (err: unknown) {
    if (signal?.aborted) {
      throw err;
    }
    throw new FamilyApiError('ログイン処理の通信に失敗しました。');
  }

  if (!response.ok) {
    throw await parseApiError(response, 'ログイン処理の開始に失敗しました。');
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new FamilyApiError('ログインレスポンスの形式が無効です。', undefined, response.status);
  }

  const parsed = loginInviteResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new FamilyApiError(
      'ログインレスポンスの検証に失敗しました。',
      undefined,
      response.status,
    );
  }

  return validateGoogleAuthUrl(parsed.data.authorizationUrl);
}
