import { FAMILY_ERROR_MESSAGES, FamilyApiError } from '@client/api/family';
import {
  familyDetailResponseSchema,
  familyErrorResponseSchema,
  familyIdSchema,
} from '@shared/schemas/family';
import {
  type CreateClosureRangeInput,
  type UpdateMemberInput,
  createClosureRangeInputSchema,
  createClosureRangeResponseSchema,
  deleteClosureResponseSchema,
  settingsClosuresResponseSchema,
  updateMemberInputSchema,
} from '@shared/schemas/settings';

const ERROR_FALLBACK = '設定を保存できませんでした。しばらく経ってから再度お試しください。';

async function throwApiError(response: Response): Promise<never> {
  try {
    const parsed = familyErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      throw new FamilyApiError(
        FAMILY_ERROR_MESSAGES[parsed.data.code],
        parsed.data.code,
        response.status,
      );
    }
  } catch (error: unknown) {
    if (error instanceof FamilyApiError) throw error;
  }
  throw new FamilyApiError(ERROR_FALLBACK, undefined, response.status);
}

function validatePathId(value: string): string {
  const parsed = familyIdSchema.safeParse(value);
  if (!parsed.success) throw new FamilyApiError(ERROR_FALLBACK, 'INVALID_INPUT');
  return encodeURIComponent(parsed.data);
}

async function fetchJson<T>(
  path: string,
  options: RequestInit,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  fallback: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...options.headers,
      },
    });
  } catch (error: unknown) {
    if (options.signal?.aborted) throw error;
    throw new FamilyApiError(ERROR_FALLBACK);
  }
  if (!response.ok) return throwApiError(response);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new FamilyApiError(fallback, undefined, response.status);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success || parsed.data === undefined) {
    throw new FamilyApiError(fallback, undefined, response.status);
  }
  return parsed.data;
}

const mutationOptions = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  },
  body: JSON.stringify(body),
  signal,
});

export async function updateFamilyMember(
  familyId: string,
  memberId: string,
  input: UpdateMemberInput,
  signal?: AbortSignal,
) {
  const parsed = updateMemberInputSchema.safeParse(input);
  if (!parsed.success) throw new FamilyApiError('入力内容を確認してください。', 'INVALID_INPUT');
  const family = validatePathId(familyId);
  const member = validatePathId(memberId);
  const response = await fetchJson(
    `/api/families/${family}/members/${member}`,
    mutationOptions(parsed.data, signal),
    familyDetailResponseSchema,
    '家族情報の応答形式が無効です。',
  );
  return response.family;
}

export async function fetchFamilyClosures(familyId: string, signal?: AbortSignal) {
  const family = validatePathId(familyId);
  return fetchJson(
    `/api/families/${family}/closures`,
    { method: 'GET', signal },
    settingsClosuresResponseSchema,
    '休園日の応答形式が無効です。',
  );
}

export async function createFamilyClosures(
  familyId: string,
  input: CreateClosureRangeInput,
  signal?: AbortSignal,
) {
  const parsed = createClosureRangeInputSchema.safeParse(input);
  if (!parsed.success) throw new FamilyApiError('入力内容を確認してください。', 'INVALID_INPUT');
  const family = validatePathId(familyId);
  return fetchJson(
    `/api/families/${family}/closures`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(parsed.data),
      signal,
    },
    createClosureRangeResponseSchema,
    '休園日の応答形式が無効です。',
  );
}

export async function deleteFamilyClosure(
  familyId: string,
  closureId: string,
  signal?: AbortSignal,
): Promise<{ ok: true }> {
  const family = validatePathId(familyId);
  const closure = validatePathId(closureId);
  const response = await fetchJson(
    `/api/families/${family}/closures/${closure}`,
    {
      method: 'DELETE',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      signal,
    },
    deleteClosureResponseSchema,
    '休園日の応答形式が無効です。',
  );
  if (response.ok !== true) {
    throw new FamilyApiError(ERROR_FALLBACK, undefined, undefined);
  }
  return response;
}
