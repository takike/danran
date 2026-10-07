import {
  type ManualTaskCreate,
  type Task,
  type TaskPatch,
  manualTaskCreateSchema,
  taskDeleteResponseSchema,
  taskErrorResponseSchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
  taskPatchSchema,
} from '@shared/schemas/tasks';

export class TaskApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'TaskApiError';
  }
}

const TASK_ERROR_MESSAGES: Record<string, string> = {
  INVALID_INPUT: '入力内容を確認してください。',
  UNAUTHORIZED: 'ログインの有効期限が切れました。再度ログインしてください。',
  FORBIDDEN: 'この操作を行う権限がありません。',
  NOT_FOUND: '家族またはやることが見つかりませんでした。',
  FAMILY_NOT_READY: '家族カレンダーの準備ができていません。',
  AUTO_TASK_IMMUTABLE:
    '持ち物から自動で作られたやることは、タイトル・期限の変更や削除はできません。',
  RECURRING_EVENT_UNSUPPORTED: '繰り返し予定の本体には紐づけられません。',
  REAUTH_REQUIRED: 'Google カレンダーの再認証が必要です。',
  CALENDAR_ACCESS_DENIED: '家族カレンダーにアクセスできません。',
  GOOGLE_TEMPORARY_ERROR:
    'Google カレンダーとの通信に一時的な問題があります。時間をおいて再度お試しください。',
  GOOGLE_ERROR: 'Google カレンダーとの通信に失敗しました。',
  INTERNAL_ERROR: 'やることを保存できませんでした。しばらくしてから再度お試しください。',
};

async function readError(response: Response): Promise<TaskApiError> {
  try {
    const parsed = taskErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      return new TaskApiError(
        TASK_ERROR_MESSAGES[parsed.data.code] ?? 'やることを保存できませんでした。',
        parsed.data.code,
        response.status,
      );
    }
  } catch {
    // Do not expose untrusted response bodies or transport details.
  }
  return new TaskApiError(
    'やることを保存できませんでした。時間をおいてもう一度お試しください。',
    undefined,
    response.status,
  );
}

async function requestTask<T>(
  familyId: string,
  taskId: string | undefined,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
  responseSchema: {
    safeParse: (value: unknown) => { success: true; data: T } | { success: false };
  },
  signal?: AbortSignal,
): Promise<T> {
  const taskPath = taskId ? `/${encodeURIComponent(taskId)}` : '';
  const path = `/api/families/${encodeURIComponent(familyId)}/tasks${taskPath}`;
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
      ...(method !== 'GET' && method !== 'DELETE' ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    throw new TaskApiError('通信に失敗しました。接続を確認して、もう一度お試しください。');
  }

  if (!response.ok) throw await readError(response);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new TaskApiError('やることの応答を確認できませんでした。');
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new TaskApiError('やることの応答を確認できませんでした。');
  return parsed.data;
}

export async function fetchTasks(familyId: string, signal?: AbortSignal): Promise<Task[]> {
  const result = await requestTask(
    familyId,
    undefined,
    'GET',
    undefined,
    taskListResponseSchema,
    signal,
  );
  return result.tasks;
}

export async function createTask(
  familyId: string,
  input: ManualTaskCreate,
  signal?: AbortSignal,
): Promise<Task> {
  const parsed = manualTaskCreateSchema.safeParse(input);
  if (!parsed.success) throw new TaskApiError('入力内容を確認してください。', 'INVALID_INPUT');
  const response = await requestTask(
    familyId,
    undefined,
    'POST',
    parsed.data,
    taskMutationResponseSchema,
    signal,
  );
  return response.task;
}

export function updateTask(
  familyId: string,
  taskId: string,
  input: TaskPatch,
  signal?: AbortSignal,
) {
  const parsed = taskPatchSchema.safeParse(input);
  if (!parsed.success) throw new TaskApiError('入力内容を確認してください。', 'INVALID_INPUT');
  return requestTask(
    familyId,
    taskId,
    'PATCH',
    parsed.data,
    taskMutationResponseSchema,
    signal,
  ).then((result) => result.task);
}

export async function deleteTask(familyId: string, taskId: string, signal?: AbortSignal) {
  const parsed = await requestTask(
    familyId,
    taskId,
    'DELETE',
    undefined,
    taskDeleteResponseSchema,
    signal,
  );
  return parsed;
}
