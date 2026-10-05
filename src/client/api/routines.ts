import {
  type RoutineInput,
  createRoutineInputSchema,
  routineDeleteResponseSchema,
  routineErrorResponseSchema,
  routineListResponseSchema,
  routineMutationResponseSchema,
} from '@shared/schemas/routines';

export class RoutineApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'RoutineApiError';
  }
}

const ROUTINE_ERROR_MESSAGES: Record<string, string> = {
  INVALID_INPUT: '入力内容を確認してください。',
  UNAUTHORIZED: 'ログインの有効期限が切れました。再度ログインしてください。',
  NOT_FOUND: '家族または繰り返し予定が見つかりませんでした。',
  FAMILY_NOT_READY: '家族カレンダーの準備ができていません。',
  REAUTH_REQUIRED: 'Google カレンダーの再認証が必要です。',
  CALENDAR_ACCESS_DENIED: '家族カレンダーにアクセスできません。',
  GOOGLE_TEMPORARY_ERROR:
    'Google カレンダーとの通信に一時的な問題があります。時間をおいて再度お試しください。',
  GOOGLE_ERROR: 'Google カレンダーとの通信に失敗しました。',
  INTERNAL_ERROR: '繰り返し予定を保存できませんでした。しばらく経ってから再度お試しください。',
};

async function readError(response: Response): Promise<RoutineApiError> {
  try {
    const parsed = routineErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      return new RoutineApiError(
        ROUTINE_ERROR_MESSAGES[parsed.data.code] ?? '繰り返し予定を保存できませんでした。',
        parsed.data.code,
        response.status,
      );
    }
  } catch {
    // Never expose arbitrary response bodies or transport details.
  }
  return new RoutineApiError(
    '繰り返し予定を保存できませんでした。時間をおいて再度お試しください。',
    undefined,
    response.status,
  );
}

async function requestRoutine<T>(
  familyId: string,
  routineId: string | undefined,
  method: 'GET' | 'POST' | 'DELETE',
  body: unknown,
  responseSchema: {
    safeParse: (value: unknown) => { success: true; data: T } | { success: false };
  },
  signal?: AbortSignal,
): Promise<T> {
  const path = `/api/families/${encodeURIComponent(familyId)}/routines${routineId ? `/${encodeURIComponent(routineId)}` : ''}`;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
      },
      ...(method !== 'GET' ? { body: method === 'DELETE' ? undefined : JSON.stringify(body) } : {}),
      signal,
    });
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    throw new RoutineApiError('通信に失敗しました。接続を確認して、もう一度お試しください。');
  }

  if (!response.ok) throw await readError(response);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new RoutineApiError('繰り返し予定の応答を確認できませんでした。');
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new RoutineApiError('繰り返し予定の応答を確認できませんでした。');
  return parsed.data;
}

export function fetchRoutines(familyId: string, signal?: AbortSignal) {
  return requestRoutine(familyId, undefined, 'GET', undefined, routineListResponseSchema, signal);
}

export function createRoutine(familyId: string, input: RoutineInput, signal?: AbortSignal) {
  const parsed = createRoutineInputSchema.safeParse(input);
  if (!parsed.success) throw new RoutineApiError('入力内容を確認してください。', 'INVALID_INPUT');
  return requestRoutine(
    familyId,
    undefined,
    'POST',
    parsed.data,
    routineMutationResponseSchema,
    signal,
  );
}

export function deleteRoutine(familyId: string, routineId: string, signal?: AbortSignal) {
  return requestRoutine(
    familyId,
    routineId,
    'DELETE',
    undefined,
    routineDeleteResponseSchema,
    signal,
  );
}
