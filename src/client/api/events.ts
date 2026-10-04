import {
  type CreateEventInput,
  type EventInput,
  createEventInputSchema,
  eventDeleteResponseSchema,
  eventErrorResponseSchema,
  eventInputSchema,
  eventMutationResponseSchema,
} from '@shared/schemas/events';

export class EventApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'EventApiError';
  }
}

const EVENT_ERROR_MESSAGES: Record<string, string> = {
  INVALID_INPUT: '入力内容を確認してください。',
  UNAUTHORIZED: 'ログインの有効期限が切れました。再度ログインしてください。',
  FORBIDDEN: 'この操作を行う権限がありません。',
  NOT_FOUND: '予定が見つかりませんでした。週の表示を更新してください。',
  FAMILY_NOT_READY: '家族カレンダーの準備ができていません。',
  REAUTH_REQUIRED: 'Google カレンダーの再認証が必要です。',
  CALENDAR_ACCESS_DENIED: '家族カレンダーにアクセスできません。',
  GOOGLE_TEMPORARY_ERROR:
    'Google カレンダーとの通信に一時的な問題があります。時間をおいて再度お試しください。',
  GOOGLE_ERROR: 'Google カレンダーとの通信に失敗しました。',
  RECURRING_EVENT_UNSUPPORTED: '繰り返し予定の変更は準備中です。',
  INTERNAL_ERROR: '予定を保存できませんでした。しばらく経ってから再度お試しください。',
};

async function getError(response: Response): Promise<EventApiError> {
  try {
    const parsed = eventErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      return new EventApiError(
        EVENT_ERROR_MESSAGES[parsed.data.code] ??
          '予定を保存できませんでした。時間をおいて再度お試しください。',
        parsed.data.code,
        response.status,
      );
    }
  } catch {
    // Do not expose arbitrary response bodies or transport details.
  }
  return new EventApiError(
    '予定を保存できませんでした。時間をおいて再度お試しください。',
    undefined,
    response.status,
  );
}

async function sendEventRequest<T>(
  familyId: string,
  eventId: string | undefined,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
  responseSchema: {
    safeParse: (value: unknown) => { success: true; data: T } | { success: false };
  },
  signal?: AbortSignal,
): Promise<T> {
  const path = `/api/families/${encodeURIComponent(familyId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}`;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: method === 'DELETE' ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    throw new EventApiError('通信に失敗しました。接続を確認して、もう一度お試しください。');
  }

  if (!response.ok) throw await getError(response);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new EventApiError('予定の応答を確認できませんでした。週の表示を更新してください。');
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success)
    throw new EventApiError('予定の応答を確認できませんでした。週の表示を更新してください。');
  return parsed.data;
}

export function createEvent(familyId: string, input: CreateEventInput, signal?: AbortSignal) {
  const parsed = createEventInputSchema.safeParse(input);
  if (!parsed.success) throw new EventApiError('入力内容を確認してください。', 'INVALID_INPUT');
  return sendEventRequest(
    familyId,
    undefined,
    'POST',
    parsed.data,
    eventMutationResponseSchema,
    signal,
  );
}

export function updateEvent(
  familyId: string,
  eventId: string,
  input: EventInput,
  signal?: AbortSignal,
) {
  const parsed = eventInputSchema.safeParse(input);
  if (!parsed.success) throw new EventApiError('入力内容を確認してください。', 'INVALID_INPUT');
  return sendEventRequest(
    familyId,
    eventId,
    'PATCH',
    parsed.data,
    eventMutationResponseSchema,
    signal,
  );
}

export function deleteEvent(familyId: string, eventId: string, signal?: AbortSignal) {
  return sendEventRequest(
    familyId,
    eventId,
    'DELETE',
    undefined,
    eventDeleteResponseSchema,
    signal,
  );
}
