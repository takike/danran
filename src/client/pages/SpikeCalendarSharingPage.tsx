import { apiErrorResponseSchema } from '@shared/schemas/errors';
import {
  type SpikeAction,
  type SpikeOperationRequest,
  spikeMetadataResponseSchema,
  spikeOperationResponseSchema,
} from '@shared/schemas/spike';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

interface HistoryItem {
  id: string;
  action: SpikeAction;
  actionLabel: string;
  ok: boolean;
  googleStatus: number | null;
  reason: string | null;
  code: string | null;
  details?: string;
  warning?: string;
}

const ACTION_LABELS: Record<SpikeAction, string> = {
  insertCalendar: 'カレンダー作成 (calendars.insert)',
  insertAcl: 'writer権限付与 (acl.insert)',
  deleteCalendar: 'カレンダー削除 (calendars.delete)',
  insertCalendarList: 'カレンダー一覧追加 (calendarList.insert)',
  listEvents: '予定一覧取得 (events.list)',
  insertEvent: 'テスト予定作成 (events.insert)',
  deleteEvent: 'テスト予定削除 (events.delete)',
};

const MUTATING_ACTIONS = new Set<SpikeAction>([
  'insertCalendar',
  'insertAcl',
  'deleteCalendar',
  'insertCalendarList',
  'insertEvent',
  'deleteEvent',
]);

export default function SpikeCalendarSharingPage(): React.ReactElement {
  const [initStatus, setInitStatus] = useState<
    'loading' | 'disabled' | 'unauthorized' | 'error' | 'ready'
  >('loading');
  const [userDisplayName, setUserDisplayName] = useState<string>('');

  // Previous user ID ref and request sequence tracking
  const previousUserIdRef = useRef<string | null>(null);
  const requestSequenceRef = useRef<number>(0);

  // In-memory receipts (never saved to localStorage / sessionStorage / URL)
  const [calendarReceipt, setCalendarReceipt] = useState<{
    calendarId: string;
    receipt: string;
  } | null>(null);

  const [eventReceipt, setEventReceipt] = useState<{
    calendarId: string;
    eventId: string;
    receipt: string;
  } | null>(null);

  // Inputs
  const [aclEmail, setAclEmail] = useState<string>('');
  const [targetCalendarId, setTargetCalendarId] = useState<string>('');

  // History and submission state
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isSubmitting, setIsSubmitting] = useState<SpikeAction | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const clearAllIdentityAndInputs = useCallback(() => {
    requestSequenceRef.current += 1;
    setCalendarReceipt(null);
    setEventReceipt(null);
    setHistory([]);
    setAclEmail('');
    setTargetCalendarId('');
    setUserDisplayName('');
    previousUserIdRef.current = null;
  }, []);

  // Session check with visibilitychange refetch and abort handling
  useEffect(() => {
    let isCancelled = false;
    let abortController = new AbortController();

    async function checkSession() {
      const reqSeq = ++requestSequenceRef.current;
      try {
        abortController.abort();
        abortController = new AbortController();
        const res = await fetch('/api/spike/calendar-sharing', {
          headers: { 'Cache-Control': 'no-store' },
          signal: abortController.signal,
        });

        if (isCancelled || reqSeq !== requestSequenceRef.current) return;

        if (res.status === 404) {
          clearAllIdentityAndInputs();
          setInitStatus('disabled');
          return;
        }

        if (res.status === 401) {
          clearAllIdentityAndInputs();
          setInitStatus('unauthorized');
          return;
        }

        if (!res.ok) {
          setInitStatus('error');
          return;
        }

        const data = await res.json();
        if (isCancelled || reqSeq !== requestSequenceRef.current) return;

        const parsed = spikeMetadataResponseSchema.safeParse(data);
        if (!parsed.success) {
          setInitStatus('error');
          return;
        }

        // Detect user change using ref
        const newUserId = parsed.data.user.id;
        if (previousUserIdRef.current !== null && previousUserIdRef.current !== newUserId) {
          clearAllIdentityAndInputs();
        }
        previousUserIdRef.current = newUserId;

        setUserDisplayName(parsed.data.user.displayName);
        setInitStatus('ready');
      } catch (err) {
        if (isCancelled || reqSeq !== requestSequenceRef.current) return;
        if ((err as Error)?.name === 'AbortError') return;
        setInitStatus('error');
      }
    }

    checkSession();

    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        checkSession();
      }
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      isCancelled = true;
      abortController.abort();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [clearAllIdentityAndInputs]);

  async function executeOperation(
    label: string,
    action: SpikeAction,
    request: SpikeOperationRequest,
    onSuccess?: (data: {
      calendarId?: string;
      eventId?: string;
      receipt?: string;
      eventCount?: number;
      hasMore?: boolean;
    }) => void,
  ) {
    setIsSubmitting(action);
    const itemId = `hist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const isMutating = MUTATING_ACTIONS.has(action);

    try {
      const res = await fetch('/api/spike/calendar-sharing', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify(request),
      });

      if (!res.ok) {
        if (res.status === 401) {
          clearAllIdentityAndInputs();
          setInitStatus('unauthorized');
          return;
        }
        if (res.status === 404) {
          clearAllIdentityAndInputs();
          setInitStatus('disabled');
          return;
        }

        let errMsg = `リクエストが拒否されました (HTTP ${res.status})`;
        if (res.status === 400) {
          errMsg = 'リクエストパラメータが無効です。';
        } else if (res.status === 403) {
          errMsg = 'アクセスが拒否されました。';
        } else if (res.status === 503) {
          errMsg = 'サービスが一時的に利用できません。';
        }

        const warning = isMutating
          ? '操作が反映されている可能性があるため、再試行する前に Google カレンダーを確認してください。'
          : undefined;

        setHistory((prev) => [
          {
            id: itemId,
            action,
            actionLabel: label,
            ok: false,
            googleStatus: null,
            reason: null,
            code: `HTTP_${res.status}`,
            details: errMsg,
            warning,
          },
          ...prev,
        ]);
        return;
      }

      const json = await res.json();
      const parsed = spikeOperationResponseSchema.safeParse(json);
      if (!parsed.success) {
        const warning = isMutating
          ? '操作が反映されている可能性があるため、再試行する前に Google カレンダーを確認してください。'
          : undefined;

        setHistory((prev) => [
          {
            id: itemId,
            action,
            actionLabel: label,
            ok: false,
            googleStatus: null,
            reason: null,
            code: 'INVALID_RESPONSE',
            details: 'サーバー応答の解析に失敗しました。',
            warning,
          },
          ...prev,
        ]);
        return;
      }

      const result = parsed.data;

      if (result.ok) {
        if (result.action !== action) {
          const warning = isMutating
            ? '操作が反映されている可能性があるため、再試行する前に Google カレンダーを確認してください。'
            : undefined;

          setHistory((prev) => [
            {
              id: itemId,
              action,
              actionLabel: label,
              ok: false,
              googleStatus: null,
              reason: null,
              code: 'INVALID_RESPONSE',
              details: 'サーバー応答のアクションが一致しません。',
              warning,
            },
            ...prev,
          ]);
          return;
        }

        let resourceMismatch = false;
        if (
          'calendarId' in request &&
          'calendarId' in result &&
          result.calendarId !== request.calendarId
        ) {
          resourceMismatch = true;
        }
        if ('eventId' in request && 'eventId' in result && result.eventId !== request.eventId) {
          resourceMismatch = true;
        }

        if (resourceMismatch) {
          const warning = isMutating
            ? '操作が反映されている可能性があるため、再試行する前に Google カレンダーを確認してください。'
            : undefined;

          setHistory((prev) => [
            {
              id: itemId,
              action,
              actionLabel: label,
              ok: false,
              googleStatus: null,
              reason: null,
              code: 'INVALID_RESPONSE',
              details: 'サーバー応答のリソースIDが一致しません。',
              warning,
            },
            ...prev,
          ]);
          return;
        }
        let details = '成功';
        if (result.action === 'insertCalendar') {
          details = `カレンダーを作成しました [ID: ${result.calendarId}]`;
        } else if (result.action === 'insertAcl') {
          details = 'writer 権限を付与しました';
        } else if (result.action === 'deleteCalendar') {
          details = '検証カレンダーを削除しました';
        } else if (result.action === 'insertCalendarList') {
          details = 'カレンダー一覧に追加しました';
        } else if (result.action === 'listEvents') {
          details = `予定件数: ${result.eventCount} 件 (さらに予定あり: ${result.hasMore ? 'はい' : 'いいえ'})`;
        } else if (result.action === 'insertEvent') {
          details = `テスト予定を作成しました [ID: ${result.eventId}]`;
        } else if (result.action === 'deleteEvent') {
          details = 'テスト予定を削除しました';
        }

        setHistory((prev) => [
          {
            id: itemId,
            action,
            actionLabel: label,
            ok: true,
            googleStatus: result.googleStatus ?? null,
            reason: null,
            code: null,
            details,
          },
          ...prev,
        ]);

        if (onSuccess) {
          if (result.action === 'insertCalendar') {
            onSuccess({
              calendarId: result.calendarId,
              receipt: result.receipt,
            });
          } else if (result.action === 'insertEvent') {
            onSuccess({
              calendarId: result.calendarId,
              eventId: result.eventId,
              receipt: result.receipt,
            });
          } else if (result.action === 'listEvents') {
            onSuccess({
              calendarId: result.calendarId,
              eventCount: result.eventCount,
              hasMore: result.hasMore,
            });
          } else {
            onSuccess({});
          }
        }
      } else {
        const warning =
          result.outcome === 'uncertain'
            ? '結果が不確定です。再試行する前に Google カレンダーを確認してください。'
            : undefined;

        setHistory((prev) => [
          {
            id: itemId,
            action,
            actionLabel: label,
            ok: false,
            googleStatus: result.googleStatus,
            reason: result.reason ?? null,
            code: result.code,
            details: 'Google カレンダー API の呼び出しに失敗しました。',
            warning,
          },
          ...prev,
        ]);
      }
    } catch {
      const warning = isMutating
        ? '通信エラーが発生しました。操作が反映されている可能性があるため、再試行する前に Google カレンダーを確認してください。'
        : undefined;

      setHistory((prev) => [
        {
          id: itemId,
          action,
          actionLabel: label,
          ok: false,
          googleStatus: null,
          reason: null,
          code: 'NETWORK_ERROR',
          details: '通信に失敗しました。',
          warning,
        },
        ...prev,
      ]);
    } finally {
      setIsSubmitting(null);
    }
  }

  // Operation Handlers
  async function handleInsertCalendar() {
    await executeOperation(
      ACTION_LABELS.insertCalendar,
      'insertCalendar',
      { action: 'insertCalendar' },
      (data) => {
        if (data.calendarId && data.receipt) {
          setCalendarReceipt({
            calendarId: data.calendarId,
            receipt: data.receipt,
          });
          if (!targetCalendarId) {
            setTargetCalendarId(data.calendarId);
          }
        }
      },
    );
  }

  async function handleInsertAcl() {
    if (!calendarReceipt) return;
    const trimmedEmail = aclEmail.trim();
    if (!trimmedEmail) return;

    await executeOperation(ACTION_LABELS.insertAcl, 'insertAcl', {
      action: 'insertAcl',
      calendarId: calendarReceipt.calendarId,
      email: trimmedEmail,
      receipt: calendarReceipt.receipt,
    });
  }

  async function handleInsertCalendarList() {
    const trimmedId = targetCalendarId.trim();
    if (!trimmedId || trimmedId.toLowerCase() === 'primary') return;

    await executeOperation(ACTION_LABELS.insertCalendarList, 'insertCalendarList', {
      action: 'insertCalendarList',
      calendarId: trimmedId,
    });
  }

  async function handleListEvents() {
    const trimmedId = targetCalendarId.trim();
    if (!trimmedId || trimmedId.toLowerCase() === 'primary') return;

    await executeOperation(ACTION_LABELS.listEvents, 'listEvents', {
      action: 'listEvents',
      calendarId: trimmedId,
    });
  }

  async function handleInsertEvent() {
    const trimmedId = targetCalendarId.trim();
    if (!trimmedId || trimmedId.toLowerCase() === 'primary') return;

    await executeOperation(
      ACTION_LABELS.insertEvent,
      'insertEvent',
      {
        action: 'insertEvent',
        calendarId: trimmedId,
      },
      (data) => {
        if (data.eventId && data.receipt) {
          setEventReceipt({
            calendarId: trimmedId,
            eventId: data.eventId,
            receipt: data.receipt,
          });
        }
      },
    );
  }

  async function handleDeleteEvent() {
    if (!eventReceipt) return;

    // Send original calendarId and eventId from receipt to preserve resource identity
    await executeOperation(
      ACTION_LABELS.deleteEvent,
      'deleteEvent',
      {
        action: 'deleteEvent',
        calendarId: eventReceipt.calendarId,
        eventId: eventReceipt.eventId,
        receipt: eventReceipt.receipt,
      },
      () => {
        setEventReceipt(null);
      },
    );
  }

  async function handleDeleteCalendar() {
    if (!calendarReceipt) return;

    await executeOperation(
      ACTION_LABELS.deleteCalendar,
      'deleteCalendar',
      {
        action: 'deleteCalendar',
        calendarId: calendarReceipt.calendarId,
        receipt: calendarReceipt.receipt,
      },
      () => {
        const deletedId = calendarReceipt.calendarId;
        setCalendarReceipt(null);
        // Clear own eventReceipt if it belongs to the deleted calendar
        if (eventReceipt && eventReceipt.calendarId === deletedId) {
          setEventReceipt(null);
        }
      },
    );
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback('コピーしました');
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch {
      setCopyFeedback('コピーに失敗しました');
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }

  if (initStatus === 'loading') {
    return (
      <main
        data-testid="spike-loading"
        className="min-h-screen bg-bg text-ink flex flex-col items-center justify-center p-[var(--spacing-md)] box-border"
      >
        <div className="text-sm text-muted">読み込み中...</div>
      </main>
    );
  }

  if (initStatus === 'disabled') {
    return (
      <main
        data-testid="spike-disabled-screen"
        className="min-h-screen bg-bg text-ink flex flex-col items-center justify-center p-[var(--spacing-md)] box-border"
      >
        <div className="max-w-[390px] w-full bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)] text-center box-border">
          <h1 className="text-base font-bold text-ink mb-[var(--spacing-sm)]">
            ページが見つかりません
          </h1>
          <p className="text-sm text-muted mb-[var(--spacing-md)]">
            この機能は現在無効化されています。
          </p>
          <Link
            to="/"
            className="inline-flex items-center justify-center min-h-[var(--tap-target-min)] px-[var(--spacing-md)] text-sm font-medium text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
          >
            ホームへ戻る
          </Link>
        </div>
      </main>
    );
  }

  if (initStatus === 'unauthorized') {
    return (
      <main
        data-testid="spike-unauthorized-screen"
        className="min-h-screen bg-bg text-ink flex flex-col items-center justify-center p-[var(--spacing-md)] box-border"
      >
        <div className="max-w-[390px] w-full bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)] text-center box-border">
          <h1 className="text-base font-bold text-ink mb-[var(--spacing-sm)]">
            ログインが必要です
          </h1>
          <p className="text-sm text-muted mb-[var(--spacing-md)]">
            この機能を利用するには Google アカウントでログインしてください。
          </p>
          <Link
            to="/"
            className="inline-flex items-center justify-center min-h-[var(--tap-target-min)] px-[var(--spacing-md)] text-sm font-medium bg-ink text-surface rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
          >
            ログイン画面へ
          </Link>
        </div>
      </main>
    );
  }

  if (initStatus === 'error') {
    return (
      <main
        data-testid="spike-error-screen"
        className="min-h-screen bg-bg text-ink flex flex-col items-center justify-center p-[var(--spacing-md)] box-border"
      >
        <div className="max-w-[390px] w-full bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)] text-center box-border">
          <h1 className="text-base font-bold text-ink mb-[var(--spacing-sm)]">接続エラー</h1>
          <p className="text-sm text-muted mb-[var(--spacing-md)]">
            情報の取得に失敗しました。再試行してください。
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center min-h-[var(--tap-target-min)] px-[var(--spacing-md)] text-sm font-medium bg-ink text-surface rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
          >
            再読み込み
          </button>
        </div>
      </main>
    );
  }

  return (
    <main
      data-testid="spike-calendar-sharing-screen"
      className="min-h-screen bg-bg text-ink py-[var(--spacing-md)] px-[var(--spacing-md)] flex flex-col items-center box-border"
    >
      <div className="w-full max-w-[390px] min-w-0 flex flex-col gap-[var(--spacing-md)]">
        {/* Header */}
        <header className="border-b border-line pb-[var(--spacing-sm)]">
          <div className="flex items-center justify-between">
            <h1 className="text-base font-bold text-ink m-0">カレンダー共有検証（スパイク）</h1>
            <Link
              to="/"
              className="text-sm text-accent min-h-[var(--tap-target-min)] inline-flex items-center px-[var(--spacing-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
            >
              ホーム
            </Link>
          </div>
          <div className="mt-[var(--spacing-xs)] text-sm text-muted">
            ログイン中:{' '}
            <span data-testid="current-user-display-name" className="font-medium text-ink">
              {userDisplayName}
            </span>
          </div>
        </header>

        {/* Warning banner */}
        <section
          aria-label="注意点"
          className="bg-deadline-tint border border-deadline rounded-[var(--radius-md)] p-[var(--spacing-sm)] text-xs text-deadline leading-relaxed"
        >
          <div className="font-semibold mb-[var(--spacing-2xs)]">検証用ツールの注意事項</div>
          <p className="m-0">
            作成したリソースの削除に必要な情報はブラウザのメモリ内のみで保持されます。ページのリロードや画面を閉じた場合は、Google
            カレンダー Web 画面から手動で削除してください。
          </p>
        </section>

        {/* Section 1: Account A operations (Create Calendar & ACL) */}
        <section
          data-testid="section-account-a"
          className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)] flex flex-col gap-[var(--spacing-md)]"
        >
          <h2 className="text-sm font-bold text-ink m-0">
            1. カレンダー作成・権限付与（アカウント A）
          </h2>

          <div className="flex flex-col gap-[var(--spacing-xs)]">
            <button
              type="button"
              data-testid="btn-insert-calendar"
              disabled={isSubmitting !== null || calendarReceipt !== null}
              onClick={handleInsertCalendar}
              className="min-h-[var(--tap-target-min)] w-full px-[var(--spacing-md)] text-sm font-medium bg-ink text-surface rounded-[var(--radius-sm)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
            >
              {isSubmitting === 'insertCalendar'
                ? 'カレンダー作成中...'
                : '1-a. 検証カレンダーを作成 (Danran spike)'}
            </button>
            {calendarReceipt ? (
              <div
                data-testid="created-calendar-info"
                className="mt-[var(--spacing-xs)] p-[var(--spacing-sm)] bg-bg border border-line rounded-[var(--radius-sm)] text-xs flex flex-col gap-[var(--spacing-xs)]"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-ink">作成済みカレンダーID:</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(calendarReceipt.calendarId)}
                    className="min-h-[var(--tap-target-min)] px-[var(--spacing-sm)] text-xs text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
                  >
                    IDをコピー
                  </button>
                </div>
                <div className="font-mono text-xs break-all bg-surface p-[var(--spacing-xs)] rounded-[var(--radius-sm)] border border-line text-ink">
                  {calendarReceipt.calendarId}
                </div>
                {copyFeedback && <span className="text-xs text-accent">{copyFeedback}</span>}
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-[var(--spacing-xs)]">
            <label htmlFor="acl-email-input" className="text-sm font-medium text-ink">
              共有先メールアドレス (アカウント B)
            </label>
            <input
              id="acl-email-input"
              data-testid="input-acl-email"
              type="email"
              value={aclEmail}
              onChange={(e) => setAclEmail(e.target.value)}
              placeholder="user-b@example.com"
              className="w-full min-w-0 min-h-[var(--tap-target-min)] px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-sm bg-surface text-ink border border-line rounded-[var(--radius-sm)] placeholder:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
            />
            <button
              type="button"
              data-testid="btn-insert-acl"
              disabled={isSubmitting !== null || calendarReceipt === null || !aclEmail.trim()}
              onClick={handleInsertAcl}
              className="min-h-[var(--tap-target-min)] w-full px-[var(--spacing-md)] text-sm font-medium bg-surface text-ink border border-line hover:bg-chip rounded-[var(--radius-sm)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
            >
              {isSubmitting === 'insertAcl'
                ? '権限付与中...'
                : '1-b. 共有先へ writer 権限を付与 (acl.insert)'}
            </button>
          </div>
        </section>

        {/* Section 2: Account B operations (CalendarList & Events) */}
        <section
          data-testid="section-account-b"
          className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)] flex flex-col gap-[var(--spacing-md)]"
        >
          <h2 className="text-sm font-bold text-ink m-0">2. カレンダーでの操作検証（A/B共通）</h2>

          <div className="flex flex-col gap-[var(--spacing-xs)]">
            <label htmlFor="target-calendar-id" className="text-sm font-medium text-ink">
              対象カレンダー ID
            </label>
            <input
              id="target-calendar-id"
              data-testid="input-target-calendar-id"
              type="text"
              value={targetCalendarId}
              onChange={(e) => setTargetCalendarId(e.target.value)}
              placeholder="xxxxxxxxxx@group.calendar.google.com"
              className="w-full min-w-0 min-h-[var(--tap-target-min)] px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-sm bg-surface text-ink border border-line rounded-[var(--radius-sm)] placeholder:text-muted font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
            />
            {calendarReceipt && targetCalendarId !== calendarReceipt.calendarId && (
              <button
                type="button"
                onClick={() => setTargetCalendarId(calendarReceipt.calendarId)}
                className="text-xs text-accent min-h-[var(--tap-target-min)] text-left px-[var(--spacing-xs)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
              >
                作成済みカレンダーIDを設定
              </button>
            )}
          </div>

          <div className="flex flex-col gap-[var(--spacing-sm)]">
            <button
              type="button"
              data-testid="btn-insert-calendar-list"
              disabled={
                isSubmitting !== null ||
                !targetCalendarId.trim() ||
                targetCalendarId.trim().toLowerCase() === 'primary'
              }
              onClick={handleInsertCalendarList}
              className="min-h-[var(--tap-target-min)] w-full px-[var(--spacing-md)] text-sm font-medium bg-surface text-ink border border-line hover:bg-chip rounded-[var(--radius-sm)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
            >
              {isSubmitting === 'insertCalendarList'
                ? '追加中...'
                : '2-a. カレンダー一覧に追加 (calendarList.insert)'}
            </button>

            <button
              type="button"
              data-testid="btn-list-events"
              disabled={
                isSubmitting !== null ||
                !targetCalendarId.trim() ||
                targetCalendarId.trim().toLowerCase() === 'primary'
              }
              onClick={handleListEvents}
              className="min-h-[var(--tap-target-min)] w-full px-[var(--spacing-md)] text-sm font-medium bg-surface text-ink border border-line hover:bg-chip rounded-[var(--radius-sm)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
            >
              {isSubmitting === 'listEvents' ? '取得中...' : '2-b. 予定件数を取得 (events.list)'}
            </button>

            <button
              type="button"
              data-testid="btn-insert-event"
              disabled={
                isSubmitting !== null ||
                !targetCalendarId.trim() ||
                targetCalendarId.trim().toLowerCase() === 'primary' ||
                eventReceipt !== null
              }
              onClick={handleInsertEvent}
              className="min-h-[var(--tap-target-min)] w-full px-[var(--spacing-md)] text-sm font-medium bg-surface text-ink border border-line hover:bg-chip rounded-[var(--radius-sm)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
            >
              {isSubmitting === 'insertEvent'
                ? '作成中...'
                : '2-c. テスト予定を作成 (events.insert)'}
            </button>

            {eventReceipt && (
              <div
                data-testid="created-event-info"
                className="p-[var(--spacing-sm)] bg-bg border border-line rounded-[var(--radius-sm)] text-xs flex flex-col gap-[var(--spacing-2xs)]"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-ink">作成済みイベントID:</span>
                </div>
                <span className="font-mono text-xs break-all bg-surface p-[var(--spacing-xs)] rounded-[var(--radius-sm)] border border-line text-ink">
                  {eventReceipt.eventId}
                </span>
                {eventReceipt.calendarId !== targetCalendarId && (
                  <span className="text-[11px] text-muted">
                    ※作成時カレンダー: {eventReceipt.calendarId}
                  </span>
                )}
              </div>
            )}

            <button
              type="button"
              data-testid="btn-delete-event"
              disabled={isSubmitting !== null || eventReceipt === null}
              onClick={handleDeleteEvent}
              className="min-h-[var(--tap-target-min)] w-full px-[var(--spacing-md)] text-sm font-medium bg-accent-tint text-accent border border-accent hover:opacity-90 rounded-[var(--radius-sm)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
            >
              {isSubmitting === 'deleteEvent'
                ? '予定削除中...'
                : '2-d. 作成したテスト予定を削除 (events.delete)'}
            </button>
          </div>
        </section>

        {/* Section 3: Final Cleanup (Account A) */}
        <section
          data-testid="section-cleanup"
          className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)] flex flex-col gap-[var(--spacing-md)]"
        >
          <h2 className="text-sm font-bold text-ink m-0">
            3. 検証後クリーンアップ（アカウント A）
          </h2>
          <p className="text-xs text-muted m-0 leading-relaxed">
            検証終了後、作成したカレンダーを削除します。画面を閉じた後や削除期限が切れた場合は
            Google カレンダー Web 画面から手動で削除してください。
          </p>
          <button
            type="button"
            data-testid="btn-delete-calendar"
            disabled={isSubmitting !== null || calendarReceipt === null}
            onClick={handleDeleteCalendar}
            className="min-h-[var(--tap-target-min)] w-full px-[var(--spacing-md)] text-sm font-medium bg-accent-tint text-accent border border-accent hover:opacity-90 rounded-[var(--radius-sm)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
          >
            {isSubmitting === 'deleteCalendar'
              ? 'カレンダー削除中...'
              : '3-a. 作成したカレンダーを削除 (calendars.delete)'}
          </button>
        </section>

        {/* Section 4: Operation History */}
        <section
          data-testid="section-history"
          aria-live="polite"
          className="bg-surface border border-line rounded-[var(--radius-md)] p-[var(--spacing-md)] flex flex-col gap-[var(--spacing-md)]"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-ink m-0">操作履歴 ({history.length} 件)</h2>
            {history.length > 0 && (
              <button
                type="button"
                onClick={() => setHistory([])}
                className="text-xs text-muted hover:text-ink min-h-[var(--tap-target-min)] px-[var(--spacing-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[var(--focus-offset)]"
              >
                履歴をクリア
              </button>
            )}
          </div>

          {history.length === 0 ? (
            <div
              data-testid="history-empty"
              className="text-sm text-muted text-center py-[var(--spacing-md)]"
            >
              上のボタンを押して操作を実行すると、結果がここに記録されます。
            </div>
          ) : (
            <div data-testid="history-list" className="flex flex-col gap-[var(--spacing-sm)]">
              {history.map((item) => (
                <div
                  key={item.id}
                  data-testid="history-item"
                  className={`border rounded-[var(--radius-sm)] p-[var(--spacing-sm)] text-xs flex flex-col gap-[var(--spacing-xs)] ${
                    item.ok
                      ? 'bg-surface border-line text-ink'
                      : 'bg-accent-tint border-accent text-accent'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-ink">{item.actionLabel}</span>
                    <span
                      data-testid="history-item-badge"
                      className={`px-[var(--spacing-xs)] py-[var(--spacing-2xs)] rounded-[var(--radius-sm)] text-xs font-bold ${
                        item.ok ? 'bg-chip text-ink border border-line' : 'bg-accent text-surface'
                      }`}
                    >
                      {item.ok ? '成功' : '失敗'}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-x-[var(--spacing-sm)] text-xs text-muted">
                    {item.googleStatus !== null && (
                      <span
                        data-testid="history-item-google-status"
                        className="font-mono font-medium text-ink"
                      >
                        Google HTTP: {item.googleStatus}
                      </span>
                    )}
                    {item.reason && (
                      <span data-testid="history-item-reason" className="font-mono text-ink">
                        理由: {item.reason}
                      </span>
                    )}
                    {item.code && <span className="font-mono">コード: {item.code}</span>}
                  </div>

                  {item.details && <div className="text-xs break-all text-ink">{item.details}</div>}

                  {item.warning && (
                    <div
                      data-testid="history-item-warning"
                      className="text-xs text-deadline font-medium bg-deadline-tint p-[var(--spacing-xs)] rounded-[var(--radius-sm)] border border-deadline"
                    >
                      {item.warning}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
