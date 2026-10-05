import { familyIdSchema } from '@shared/schemas/family';
import { weekQuerySchema } from '@shared/schemas/week';
import {
  type BusyWeekErrorResponse,
  type BusyWeekResponse,
  busyWeekErrorResponseSchema,
  busyWeekResponseSchema,
} from '@shared/schemas/week-busy';

type BusyWeekErrorCode = BusyWeekErrorResponse['code'];

const ERROR_MESSAGES: Record<BusyWeekErrorCode, string> = {
  UNAUTHORIZED: 'ログインし直してください。',
  FORBIDDEN: '空き状況を表示する権限がありません。',
  NOT_FOUND: '家族情報が見つかりませんでした。',
  INVALID_INPUT: '週の指定を確認してください。',
  INTERNAL_ERROR: '空き状況を取得できませんでした。',
};

export class BusyWeekApiError extends Error {
  constructor(
    message: string,
    public readonly code?: BusyWeekErrorCode,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'BusyWeekApiError';
  }
}

const FETCH_ERROR_MESSAGE = '空き状況を読み込めませんでした。';
const RESPONSE_ERROR_MESSAGE = '空き状況の応答形式が無効です。';

async function parseError(response: Response): Promise<BusyWeekApiError> {
  try {
    const parsed = busyWeekErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      return new BusyWeekApiError(
        ERROR_MESSAGES[parsed.data.code],
        parsed.data.code,
        response.status,
      );
    }
  } catch {
    // Never expose arbitrary error response content.
  }
  return new BusyWeekApiError(ERROR_MESSAGES.INTERNAL_ERROR, undefined, response.status);
}

/** Fetches a single family busy week without persisting or exposing raw server errors. */
export async function fetchBusyWeek(
  familyId: string,
  start: string,
  signal?: AbortSignal,
): Promise<BusyWeekResponse> {
  if (!familyIdSchema.safeParse(familyId).success) {
    throw new BusyWeekApiError('家族情報を確認してください。', 'INVALID_INPUT');
  }
  const parsedStart = weekQuerySchema.safeParse({ start });
  if (!parsedStart.success || !parsedStart.data.start) {
    throw new BusyWeekApiError('週の指定を確認してください。', 'INVALID_INPUT');
  }

  const query = `?start=${encodeURIComponent(parsedStart.data.start)}`;
  let response: Response;
  try {
    response = await fetch(`/api/families/${encodeURIComponent(familyId)}/week/busy${query}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    throw new BusyWeekApiError(FETCH_ERROR_MESSAGE);
  }

  if (!response.ok) throw await parseError(response);

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new BusyWeekApiError(RESPONSE_ERROR_MESSAGE, undefined, response.status);
  }
  const parsed = busyWeekResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BusyWeekApiError(RESPONSE_ERROR_MESSAGE, undefined, response.status);
  }
  return parsed.data;
}
