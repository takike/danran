import { familyIdSchema } from '@shared/schemas/family';
import {
  type WeekErrorResponse,
  type WeekResponse,
  weekErrorResponseSchema,
  weekQuerySchema,
  weekResponseSchema,
} from '@shared/schemas/week';

export class WeekApiError extends Error {
  constructor(
    message: string,
    public readonly code?: WeekErrorResponse['code'],
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'WeekApiError';
  }
}

const WEEK_ERROR_MESSAGES: Record<WeekErrorResponse['code'], string> = {
  UNAUTHORIZED: 'ログインが必要です。',
  FORBIDDEN: '週情報を取得する権限がありません。',
  NOT_FOUND: '家族情報が見つかりませんでした。',
  INVALID_INPUT: '週の指定を確認してください。',
  FAMILY_NOT_READY: '家族カレンダーの準備が完了していません。',
  REAUTH_REQUIRED: 'Google カレンダーの再認証が必要です。',
  CALENDAR_ACCESS_DENIED: '家族カレンダーにアクセスできません。',
  GOOGLE_TEMPORARY_ERROR:
    'Google カレンダーとの通信に失敗しました。時間をおいて再度お試しください。',
  GOOGLE_ERROR: 'Google カレンダーとの通信に失敗しました。',
  INTERNAL_ERROR: '週情報の取得に失敗しました。しばらく経ってから再度お試しください。',
  CALENDAR_PAGE_LIMIT: '予定が多いため週情報を取得できませんでした。',
};

const WEEK_FETCH_ERROR_MESSAGE = '週情報の通信に失敗しました。';
const WEEK_RESPONSE_ERROR_MESSAGE = '週情報の応答形式が無効です。';
const WEEK_RESPONSE_VALIDATION_ERROR_MESSAGE = '週情報の検証に失敗しました。';
const WEEK_REQUEST_ERROR_MESSAGE = '週の指定を確認してください。';

async function parseWeekApiError(response: Response): Promise<WeekApiError> {
  try {
    const rawJson: unknown = await response.json();
    const parsed = weekErrorResponseSchema.safeParse(rawJson);
    if (parsed.success) {
      return new WeekApiError(
        WEEK_ERROR_MESSAGES[parsed.data.code],
        parsed.data.code,
        response.status,
      );
    }
  } catch {
    // Do not expose arbitrary error bodies or transport details.
  }

  return new WeekApiError(WEEK_ERROR_MESSAGES.INTERNAL_ERROR, undefined, response.status);
}

/** Fetches and validates one family week without exposing backend error text. */
export async function fetchWeek(
  familyId: string,
  start?: string,
  signal?: AbortSignal,
): Promise<WeekResponse> {
  if (!familyIdSchema.safeParse(familyId).success) {
    throw new WeekApiError(WEEK_REQUEST_ERROR_MESSAGE);
  }

  const query = weekQuerySchema.safeParse(start === undefined ? {} : { start });
  if (!query.success) {
    throw new WeekApiError(WEEK_REQUEST_ERROR_MESSAGE, 'INVALID_INPUT');
  }

  const queryString = query.data.start ? `?start=${encodeURIComponent(query.data.start)}` : '';
  let response: Response;
  try {
    response = await fetch(`/api/families/${encodeURIComponent(familyId)}/week${queryString}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    throw new WeekApiError(WEEK_FETCH_ERROR_MESSAGE);
  }

  if (!response.ok) {
    throw await parseWeekApiError(response);
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    throw new WeekApiError(WEEK_RESPONSE_ERROR_MESSAGE, undefined, response.status);
  }

  const parsed = weekResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new WeekApiError(WEEK_RESPONSE_VALIDATION_ERROR_MESSAGE, undefined, response.status);
  }

  return parsed.data;
}
