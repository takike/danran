import { validateGoogleAuthUrl } from '@client/api/family';
import {
  type BusyCalendarsErrorResponse,
  type UpdateBusyCalendarsInput,
  type UpdateBusyCalendarsResponse,
  busyCalendarListResponseSchema,
  busyCalendarsErrorResponseSchema,
  updateBusyCalendarsInputSchema,
  updateBusyCalendarsResponseSchema,
} from '@shared/schemas/busy';
import { familyIdSchema } from '@shared/schemas/family';

type BusyCalendarsErrorCode = BusyCalendarsErrorResponse['code'];

export class BusyCalendarsApiError extends Error {
  constructor(
    message: string,
    public readonly code?: BusyCalendarsErrorCode,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'BusyCalendarsApiError';
  }
}

const ERROR_MESSAGES: Record<BusyCalendarsErrorCode, string> = {
  UNAUTHORIZED: 'ログインし直してください。',
  FORBIDDEN: 'この家族の空き状況を設定する権限がありません。',
  NOT_FOUND: '家族または対象メンバーが見つかりませんでした。',
  INVALID_INPUT: 'カレンダーの選択内容を確認してください。',
  REAUTH_REQUIRED: 'Google カレンダーへの再認証が必要です。',
  CALENDAR_ACCESS_DENIED: 'Google カレンダーへのアクセスを確認してください。',
  GOOGLE_TEMPORARY_ERROR: 'カレンダー一覧を取得できませんでした。時間をおいて再度お試しください。',
  GOOGLE_ERROR: 'Google カレンダーとの通信に失敗しました。',
  INTERNAL_ERROR: '空き状況の設定を読み込めませんでした。時間をおいて再度お試しください。',
  CALENDAR_PAGE_LIMIT: 'カレンダーが多いため、一覧を取得できませんでした。',
};

function safeFamilyPath(familyId: string): string {
  const parsed = familyIdSchema.safeParse(familyId);
  if (!parsed.success) {
    throw new BusyCalendarsApiError('家族情報を確認してください。', 'INVALID_INPUT');
  }
  return `/api/families/${encodeURIComponent(parsed.data)}`;
}

async function readApiError(response: Response): Promise<BusyCalendarsApiError> {
  try {
    const parsed = busyCalendarsErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      return new BusyCalendarsApiError(
        ERROR_MESSAGES[parsed.data.code],
        parsed.data.code,
        response.status,
      );
    }
  } catch {
    // Never reflect arbitrary response content in the UI.
  }
  return new BusyCalendarsApiError(
    '空き状況の設定を読み込めませんでした。時間をおいて再度お試しください。',
    undefined,
    response.status,
  );
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
      headers: { Accept: 'application/json', ...init.headers },
    });
  } catch (error: unknown) {
    if (init.signal?.aborted) throw error;
    throw new BusyCalendarsApiError(
      '空き状況の設定を取得できませんでした。通信状態を確認してください。',
    );
  }

  if (!response.ok) throw await readApiError(response);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new BusyCalendarsApiError(invalidResponseMessage, undefined, response.status);
  }
  const parsed = parse(json);
  if (!parsed.success || parsed.data === undefined) {
    throw new BusyCalendarsApiError(invalidResponseMessage, undefined, response.status);
  }
  return parsed.data;
}

export async function fetchBusyCalendars(familyId: string, signal?: AbortSignal) {
  return requestJson(
    `${safeFamilyPath(familyId)}/busy-calendars`,
    { method: 'GET', signal },
    (value) => busyCalendarListResponseSchema.safeParse(value),
    '空き状況のカレンダー一覧を読み込めませんでした。',
  );
}

export async function updateBusyCalendars(
  familyId: string,
  input: UpdateBusyCalendarsInput,
  signal?: AbortSignal,
): Promise<UpdateBusyCalendarsResponse> {
  const body = updateBusyCalendarsInputSchema.safeParse(input);
  if (!body.success) {
    throw new BusyCalendarsApiError('カレンダーの選択内容を確認してください。', 'INVALID_INPUT');
  }
  const result = await requestJson(
    `${safeFamilyPath(familyId)}/busy-calendars`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(body.data),
      signal,
    },
    (value) => updateBusyCalendarsResponseSchema.safeParse(value),
    '空き状況のカレンダー選択を保存できませんでした。',
  );
  if (result.authorizationRequired) {
    try {
      return { ...result, authorizationUrl: validateGoogleAuthUrl(result.authorizationUrl) };
    } catch {
      throw new BusyCalendarsApiError('認可先を確認できませんでした。');
    }
  }
  return result;
}
