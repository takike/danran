import { validateGoogleAuthUrl } from '@client/api/family';
import { familyIdSchema } from '@shared/schemas/family';
import {
  type PersonalEventsErrorResponse,
  type PersonalWeekResponse,
  type UpdatePersonalCalendarsInput,
  type UpdatePersonalCalendarsResponse,
  personalCalendarListResponseSchema,
  personalEventsErrorResponseSchema,
  personalWeekResponseSchema,
  updatePersonalCalendarsInputSchema,
  updatePersonalCalendarsResponseSchema,
} from '@shared/schemas/personal';
import { weekQuerySchema } from '@shared/schemas/week';

type PersonalErrorCode = PersonalEventsErrorResponse['code'];

export class PersonalEventsApiError extends Error {
  constructor(
    message: string,
    public readonly code?: PersonalErrorCode,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'PersonalEventsApiError';
  }
}

const ERROR_MESSAGES: Record<PersonalErrorCode, string> = {
  UNAUTHORIZED: 'ログインし直してください。',
  FORBIDDEN: 'この家族の個人予定を表示する権限がありません。',
  NOT_FOUND: '家族または対象メンバーが見つかりませんでした。',
  INVALID_INPUT: '入力内容を確認してください。',
  REAUTH_REQUIRED: 'Google カレンダーへの再認証が必要です。',
  CALENDAR_ACCESS_DENIED: 'Google カレンダーへのアクセスを確認してください。',
  GOOGLE_TEMPORARY_ERROR: '個人予定を取得できませんでした。時間をおいて再度お試しください。',
  GOOGLE_ERROR: 'Google カレンダーとの通信に失敗しました。',
  INTERNAL_ERROR: '個人予定を取得できませんでした。時間をおいて再度お試しください。',
  CALENDAR_PAGE_LIMIT: '個人予定が多いため、週を分けて確認してください。',
};

async function parseError(response: Response): Promise<PersonalEventsApiError> {
  try {
    const parsed = personalEventsErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      return new PersonalEventsApiError(
        ERROR_MESSAGES[parsed.data.code],
        parsed.data.code,
        response.status,
      );
    }
  } catch {
    // Keep arbitrary response text out of the UI.
  }
  return new PersonalEventsApiError(
    '個人予定を取得できませんでした。時間をおいて再度お試しください。',
    undefined,
    response.status,
  );
}

function safeFamilyPath(familyId: string): string {
  const parsed = familyIdSchema.safeParse(familyId);
  if (!parsed.success)
    throw new PersonalEventsApiError('家族情報を確認してください。', 'INVALID_INPUT');
  return `/api/families/${encodeURIComponent(parsed.data)}`;
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => { success: boolean; data?: T },
  invalidResponseMessage: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...init.headers,
      },
    });
  } catch (error: unknown) {
    if (init.signal?.aborted) throw error;
    throw new PersonalEventsApiError(
      '個人予定を取得できませんでした。通信状態を確認してください。',
    );
  }

  if (!response.ok) throw await parseError(response);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new PersonalEventsApiError(invalidResponseMessage, undefined, response.status);
  }
  const parsed = parse(json);
  if (!parsed.success || parsed.data === undefined) {
    throw new PersonalEventsApiError(invalidResponseMessage, undefined, response.status);
  }
  return parsed.data;
}

export async function fetchPersonalCalendars(familyId: string, signal?: AbortSignal) {
  return requestJson(
    `${safeFamilyPath(familyId)}/personal-calendars`,
    { method: 'GET', signal },
    (value) => personalCalendarListResponseSchema.safeParse(value),
    'カレンダー一覧の応答形式が無効です。',
  );
}

export async function updatePersonalCalendars(
  familyId: string,
  input: UpdatePersonalCalendarsInput,
  signal?: AbortSignal,
): Promise<UpdatePersonalCalendarsResponse> {
  const body = updatePersonalCalendarsInputSchema.safeParse(input);
  if (!body.success) {
    throw new PersonalEventsApiError('入力内容を確認してください。', 'INVALID_INPUT');
  }
  const result = await requestJson(
    `${safeFamilyPath(familyId)}/personal-calendars`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(body.data),
      signal,
    },
    (value) => updatePersonalCalendarsResponseSchema.safeParse(value),
    'カレンダー選択の応答形式が無効です。',
  );
  if (result.authorizationRequired) {
    try {
      return { ...result, authorizationUrl: validateGoogleAuthUrl(result.authorizationUrl) };
    } catch {
      throw new PersonalEventsApiError('認可先を確認できませんでした。');
    }
  }
  return result;
}

export async function fetchPersonalWeek(
  familyId: string,
  start: string,
  signal?: AbortSignal,
): Promise<PersonalWeekResponse> {
  const parsedStart = weekQuerySchema.safeParse({ start });
  if (!parsedStart.success) {
    throw new PersonalEventsApiError('週の指定を確認してください。', 'INVALID_INPUT');
  }
  const canonicalStart = parsedStart.data.start;
  if (!canonicalStart) {
    throw new PersonalEventsApiError('週の指定を確認してください。', 'INVALID_INPUT');
  }
  const query = `?start=${encodeURIComponent(canonicalStart)}`;
  return requestJson(
    `${safeFamilyPath(familyId)}/week/personal${query}`,
    { method: 'GET', signal },
    (value) => personalWeekResponseSchema.safeParse(value),
    '個人予定の応答形式が無効です。',
  );
}
