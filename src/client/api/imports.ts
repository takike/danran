import {
  type ImportJob,
  importClientRequestIdSchema,
  importDeleteResponseSchema,
  importErrorResponseSchema,
  importJobSchema,
  importListResponseSchema,
} from '@shared/schemas/imports';

const ERROR_MESSAGES: Record<string, string> = {
  UNAUTHORIZED: 'ログインの有効期限が切れました。再度ログインしてください。',
  FORBIDDEN: 'この操作を行う権限がありません。',
  NOT_FOUND: '家族または写真が見つかりませんでした。',
  FAMILY_NOT_READY: '家族カレンダーの準備ができていません。',
  INVALID_INPUT: '写真を確認して、もう一度お試しください。',
  UNSUPPORTED_MEDIA_TYPE: 'JPEG形式の写真を選んでください。',
  IMAGE_TOO_LARGE: '写真のサイズが大きすぎます。別の写真を選んでください。',
  INVALID_JPEG: '写真を読み込めませんでした。別の写真を選んでください。',
  EXIF_NOT_ALLOWED: '写真を縮小できませんでした。もう一度写真を選んでください。',
  PENDING_LIMIT_REACHED: '保存できる写真の上限に達しました。不要な写真を削除してください。',
  UPLOAD_IN_PROGRESS: '写真を保存しています。しばらくしてから一覧を更新してください。',
  COMMITTED_IMPORT: '登録済みの写真は削除できません。',
  INTERNAL_ERROR: '写真を保存できませんでした。時間をおいてもう一度お試しください。',
};

export class ImportApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ImportApiError';
  }
}

function importsPath(familyId: string): string {
  return `/api/families/${encodeURIComponent(familyId)}/imports`;
}

async function apiError(response: Response): Promise<ImportApiError> {
  try {
    const parsed = importErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      return new ImportApiError(
        ERROR_MESSAGES[parsed.data.code] ?? '写真の操作に失敗しました。',
        parsed.data.code,
        response.status,
      );
    }
  } catch {
    // Ignore untrusted error bodies.
  }
  return new ImportApiError(
    '写真の操作に失敗しました。時間をおいてもう一度お試しください。',
    undefined,
    response.status,
  );
}

function networkError(signal?: AbortSignal): ImportApiError | Error {
  return signal?.aborted
    ? new DOMException('The request was aborted', 'AbortError')
    : new ImportApiError('通信に失敗しました。接続を確認して、もう一度お試しください。');
}

export async function fetchImports(familyId: string, signal?: AbortSignal): Promise<ImportJob[]> {
  let response: Response;
  try {
    response = await fetch(importsPath(familyId), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch {
    throw networkError(signal);
  }
  if (!response.ok) throw await apiError(response);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ImportApiError('写真の一覧を確認できませんでした。');
  }
  const parsed = importListResponseSchema.safeParse(json);
  if (!parsed.success) throw new ImportApiError('写真の一覧を確認できませんでした。');
  return parsed.data.imports;
}

export async function uploadImport(
  familyId: string,
  blob: Blob,
  clientRequestId: string,
  signal?: AbortSignal,
): Promise<ImportJob> {
  const parsedId = importClientRequestIdSchema.safeParse(clientRequestId);
  if (!parsedId.success) throw new ImportApiError('写真の送信情報を確認できませんでした。');
  let response: Response;
  try {
    response = await fetch(importsPath(familyId), {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'image/jpeg',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Client-Request-Id': parsedId.data,
      },
      body: blob,
      signal,
    });
  } catch {
    throw networkError(signal);
  }
  if (!response.ok) throw await apiError(response);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ImportApiError('写真の保存結果を確認できませんでした。');
  }
  const parsed = importJobSchema.safeParse(json);
  if (!parsed.success) throw new ImportApiError('写真の保存結果を確認できませんでした。');
  return parsed.data;
}

export async function deleteImport(
  familyId: string,
  importId: string,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${importsPath(familyId)}/${encodeURIComponent(importId)}`, {
      method: 'DELETE',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      signal,
    });
  } catch {
    throw networkError(signal);
  }
  if (!response.ok) throw await apiError(response);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ImportApiError('写真の削除結果を確認できませんでした。');
  }
  if (!importDeleteResponseSchema.safeParse(json).success) {
    throw new ImportApiError('写真の削除結果を確認できませんでした。');
  }
}

export async function fetchImportAttachment(
  familyId: string,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(
      `/api/families/${encodeURIComponent(familyId)}/attachments/${encodeURIComponent(attachmentId)}`,
      {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'image/jpeg' },
        signal,
      },
    );
  } catch {
    throw networkError(signal);
  }
  if (!response.ok) throw await apiError(response);
  const contentType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'image/jpeg') throw new ImportApiError('写真を表示できませんでした。');
  try {
    return await response.blob();
  } catch {
    throw new ImportApiError('写真を表示できませんでした。');
  }
}
