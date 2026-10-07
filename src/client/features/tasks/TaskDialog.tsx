import { TaskApiError, createTask, deleteTask, updateTask } from '@client/api/tasks';
import { useReloadProtection } from '@client/features/pwa/useReloadProtection';
import type { FamilyPublic } from '@shared/schemas/family';
import {
  type ManualTaskCreate,
  type Task,
  manualTaskCreateSchema,
  taskPatchSchema,
} from '@shared/schemas/tasks';
import { getTodayDateKey, toTokyoDateKey, toTokyoIsoString } from '@shared/time/date';
import { formatShortDate, formatWeekday } from '@shared/time/format';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { TASKS_QUERY_KEY } from './useTasks';

type Member = FamilyPublic['members'][number];
type DueKind = 'none' | 'date' | 'datetime';

const fieldClass =
  'mt-[var(--spacing-xs)] min-h-[var(--tap-target-min)] w-full min-w-0 rounded-[var(--radius-md)] border border-line bg-surface px-[var(--spacing-sm)] text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
const buttonClass =
  'inline-flex min-h-[var(--tap-target-min)] items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] px-[var(--spacing-md)] text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50';

function taskDueFields(task?: Task) {
  if (!task || task.due.kind === 'none' || task.due.kind === 'unknown') {
    return { dueKind: 'none' as DueKind, dueDate: getTodayDateKey(), dueTime: '20:00' };
  }
  if (task.due.kind === 'date') {
    return { dueKind: 'date' as DueKind, dueDate: task.due.dueAt, dueTime: '20:00' };
  }
  return {
    dueKind: 'datetime' as DueKind,
    dueDate: toTokyoDateKey(task.due.dueAt),
    dueTime: toTokyoIsoString(task.due.dueAt).slice(11, 16),
  };
}

function fixedErrorMessage(error: unknown): string {
  if (error instanceof TaskApiError) return error.message;
  return 'やることを保存できませんでした。通信状態を確認して、もう一度お試しください。';
}

function isSessionUnauthorized(error: unknown): boolean {
  return error instanceof TaskApiError && error.status === 401 && error.code !== 'REAUTH_REQUIRED';
}

function linkedEventDate(task: Task | undefined) {
  const linked = task?.linkedEvent;
  if (linked?.state !== 'ready') return null;
  const date =
    linked.time.kind === 'all-day' ? linked.time.start : toTokyoDateKey(linked.time.start);
  return `${formatShortDate(date)}（${formatWeekday(date)}）`;
}

export function TaskDialog({
  familyId,
  userId,
  members,
  task,
  event,
  open,
  onClose,
  onSaved,
  onUnauthorized,
  isIdentityCurrent,
}: {
  familyId: string;
  userId: string;
  members: Member[];
  task?: Task;
  event?: Extract<Task['linkedEvent'], { state: 'ready' }>;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  onUnauthorized: () => void;
  isIdentityCurrent: () => boolean;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const historyMarkerRef = useRef<string | null>(null);
  const historyCleanupTimerRef = useRef<number | null>(null);
  const originalCreateRef = useRef<ManualTaskCreate | null>(null);
  const createdTaskIdRef = useRef<string | null>(null);
  const historyEntryRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialDue = taskDueFields(task);
  const [title, setTitle] = useState(task?.title ?? '');
  const [dueKind, setDueKind] = useState<DueKind>(initialDue.dueKind);
  const [dueDate, setDueDate] = useState(initialDue.dueDate);
  const [dueTime, setDueTime] = useState(initialDue.dueTime);
  const [assigneeMemberId, setAssigneeMemberId] = useState(task?.assigneeMemberId ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDirty, setIsDirty] = useState(Boolean(task));
  const [requestLocked, setRequestLocked] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const identity = `${userId}:${familyId}`;

  useReloadProtection(open && (isDirty || requestLocked), open && (isSaving || isDeleting));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!open) {
      if (dialog.open) dialog.close();
      return;
    }
    if (historyCleanupTimerRef.current !== null) {
      window.clearTimeout(historyCleanupTimerRef.current);
      historyCleanupTimerRef.current = null;
    }
    if (!historyMarkerRef.current) historyMarkerRef.current = `task-dialog-${crypto.randomUUID()}`;
    const marker = historyMarkerRef.current;
    dialog.showModal();
    if (window.history.state?.danranTaskDialog !== marker) {
      window.history.pushState({ ...(window.history.state ?? {}), danranTaskDialog: marker }, '');
      historyEntryRef.current = true;
    }
    window.setTimeout(() => titleRef.current?.focus(), 0);
    const handlePopState = () => {
      if (pendingRef.current) {
        window.history.pushState({ ...(window.history.state ?? {}), danranTaskDialog: marker }, '');
      } else onCloseRef.current();
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (dialog.open) dialog.close();
      historyCleanupTimerRef.current = window.setTimeout(() => {
        if (window.history.state?.danranTaskDialog !== marker) return;
        const state = { ...(window.history.state ?? {}) };
        state.danranTaskDialog = undefined;
        window.history.replaceState(state, '');
        historyEntryRef.current = false;
        historyCleanupTimerRef.current = null;
      }, 0);
    };
  }, [open]);

  const requestClose = () => {
    if (pendingRef.current) return;
    if (historyEntryRef.current && window.history.state?.danranTaskDialog) window.history.back();
    else onCloseRef.current();
  };

  const markChanged = () => {
    setIsDirty(true);
    setErrorMessage('');
  };

  const buildDue = () => {
    if (dueKind === 'none') return { kind: 'none' as const };
    if (dueKind === 'date') return { kind: 'date' as const, dueAt: dueDate };
    return { kind: 'datetime' as const, dueAt: `${dueDate}T${dueTime}:00+09:00` };
  };

  const buildPatch = () => ({
    title: title.trim(),
    due: buildDue(),
    assigneeMemberId: assigneeMemberId || null,
  });

  const finishSuccess = (savedTask?: Task, deletedTaskId?: string) => {
    if (!isIdentityCurrent()) return;
    const queryKey = [...TASKS_QUERY_KEY, userId, familyId] as const;
    queryClient.setQueryData<Task[]>(queryKey, (tasks) => {
      if (!tasks) return deletedTaskId ? [] : savedTask ? [savedTask] : [];
      if (deletedTaskId) return tasks.filter((item) => item.id !== deletedTaskId);
      if (!savedTask) return tasks;
      return tasks.some((item) => item.id === savedTask.id)
        ? tasks.map((item) => (item.id === savedTask.id ? savedTask : item))
        : [...tasks, savedTask];
    });
    setIsDirty(false);
    setRequestLocked(false);
    originalCreateRef.current = null;
    createdTaskIdRef.current = null;
    void queryClient.invalidateQueries({ queryKey });
    onSaved();
  };

  const handleSubmit = async (submitEvent: React.FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault();
    if (pendingRef.current) return;
    const latest = taskPatchSchema.safeParse(buildPatch());
    if (!latest.success) {
      setErrorMessage('入力内容を確認してください。');
      return;
    }
    pendingRef.current = true;
    setIsSaving(true);
    setErrorMessage('');
    try {
      let savedTask: Task;
      if (task) {
        savedTask = await updateTask(familyId, task.id, latest.data);
      } else if (createdTaskIdRef.current) {
        savedTask = await updateTask(familyId, createdTaskIdRef.current, latest.data);
      } else {
        const original =
          originalCreateRef.current ??
          manualTaskCreateSchema.parse({
            ...latest.data,
            eventId: event?.eventId ?? null,
            clientRequestId: crypto.randomUUID(),
          });
        originalCreateRef.current = original;
        const created = await createTask(familyId, original);
        if (!isIdentityCurrent()) return;
        createdTaskIdRef.current = created.id;
        if (
          JSON.stringify({
            title: original.title,
            due: original.due,
            assigneeMemberId: original.assigneeMemberId,
          }) !== JSON.stringify(latest.data)
        ) {
          savedTask = await updateTask(familyId, created.id, latest.data);
        } else {
          savedTask = created;
        }
      }
      if (!isIdentityCurrent()) return;
      finishSuccess(savedTask);
    } catch (error: unknown) {
      if (!isIdentityCurrent()) return;
      if (isSessionUnauthorized(error)) onUnauthorized();
      if (error instanceof TaskApiError && error.code === 'INVALID_INPUT') {
        if (error.status === 400 && !createdTaskIdRef.current) originalCreateRef.current = null;
        setRequestLocked(false);
      } else if (!(error instanceof TaskApiError) || !error.status || error.status >= 500) {
        setRequestLocked(true);
      } else {
        // A definite client rejection means the frozen create request was not committed.
        if (!createdTaskIdRef.current) originalCreateRef.current = null;
        setRequestLocked(false);
      }
      setErrorMessage(fixedErrorMessage(error));
    } finally {
      pendingRef.current = false;
      if (isIdentityCurrent()) setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!task || pendingRef.current) return;
    pendingRef.current = true;
    setIsDeleting(true);
    setErrorMessage('');
    try {
      await deleteTask(familyId, task.id);
      if (!isIdentityCurrent()) return;
      finishSuccess(undefined, task.id);
    } catch (error: unknown) {
      if (!isIdentityCurrent()) return;
      if (isSessionUnauthorized(error)) onUnauthorized();
      setErrorMessage(fixedErrorMessage(error));
    } finally {
      pendingRef.current = false;
      if (isIdentityCurrent()) setIsDeleting(false);
    }
  };

  const adultMembers = members.filter((member) => member.kind === 'adult');
  const dateLabel = task
    ? linkedEventDate(task)
    : event
      ? (() => {
          const date =
            event.time.kind === 'all-day' ? event.time.start : toTokyoDateKey(event.time.start);
          return `${formatShortDate(date)}（${formatWeekday(date)}）`;
        })()
      : null;
  const linkedTitle = task?.linkedEvent.state === 'ready' ? task.linkedEvent.title : event?.title;
  const disabled = isSaving || isDeleting;

  return (
    <dialog
      ref={dialogRef}
      data-testid="task-dialog"
      aria-labelledby="task-dialog-title"
      onCancel={(cancelEvent) => {
        cancelEvent.preventDefault();
        requestClose();
      }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto border-0 bg-bg p-0 text-ink backdrop:bg-ink/40 sm:left-1/2 sm:right-auto sm:w-[min(100%,var(--app-max-width))] sm:-translate-x-1/2"
    >
      <form
        onSubmit={handleSubmit}
        className="mx-auto min-h-dvh w-full max-w-[var(--app-max-width)] pb-[calc(var(--tab-bar-clearance)+var(--spacing-md))]"
      >
        <header className="sticky top-0 z-10 flex min-h-[var(--tap-target-min)] items-center justify-between border-b border-line bg-bg/95 px-[var(--spacing-md)] backdrop-blur">
          <h2 id="task-dialog-title" className="m-0 text-lg font-semibold">
            {task ? 'やることを編集' : 'やることを追加'}
          </h2>
          <button
            type="button"
            aria-label="閉じる"
            onClick={requestClose}
            disabled={disabled}
            className={`${buttonClass} w-[var(--tap-target-min)] bg-transparent p-0`}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <fieldset
          disabled={disabled}
          className="m-0 flex min-w-0 flex-col gap-[var(--spacing-lg)] border-0 px-[var(--spacing-md)] py-[var(--spacing-lg)]"
        >
          {errorMessage && (
            <p
              role="alert"
              className="m-0 rounded-[var(--radius-md)] border border-accent bg-accent-tint p-[var(--spacing-sm)] text-sm text-ink"
            >
              {errorMessage}
              {requestLocked && (
                <span className="mt-[var(--spacing-xs)] block">
                  保存結果を確認してから再試行してください。入力を変更しても、まずは同じ登録を確認します。
                </span>
              )}
            </p>
          )}
          {(linkedTitle || dateLabel) && (
            <div className="rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-sm)] text-sm">
              <span className="block min-w-0 font-semibold [overflow-wrap:anywhere]">
                {linkedTitle}
              </span>
              {dateLabel && <span className="block text-muted">{dateLabel}</span>}
            </div>
          )}
          <div>
            <label htmlFor="task-title" className="block text-sm font-semibold">
              タイトル
            </label>
            <input
              ref={titleRef}
              id="task-title"
              data-testid="task-form-title"
              type="text"
              required
              minLength={1}
              maxLength={200}
              value={title}
              onChange={(changeEvent) => {
                setTitle(changeEvent.currentTarget.value);
                markChanged();
              }}
              className={fieldClass}
            />
          </div>
          <fieldset className="m-0 border-0 p-0">
            <legend className="sr-only">期限</legend>
            <label htmlFor="task-due-kind" className="block text-sm font-semibold">
              期限
            </label>
            <select
              id="task-due-kind"
              data-testid="task-due-kind"
              value={dueKind}
              onChange={(changeEvent) => {
                setDueKind(changeEvent.currentTarget.value as DueKind);
                markChanged();
              }}
              className={fieldClass}
            >
              <option value="none">期限なし</option>
              <option value="date">日付</option>
              <option value="datetime">日時</option>
            </select>
            {dueKind !== 'none' && (
              <div
                className={`mt-[var(--spacing-sm)] grid ${dueKind === 'datetime' ? 'grid-cols-2' : 'grid-cols-1'} gap-[var(--spacing-sm)]`}
              >
                <div>
                  <label htmlFor="task-due-date" className="block text-xs font-medium text-muted">
                    日付
                  </label>
                  <input
                    id="task-due-date"
                    data-testid="task-due-date"
                    type="date"
                    lang="ja"
                    required
                    value={dueDate}
                    onChange={(changeEvent) => {
                      setDueDate(changeEvent.currentTarget.value);
                      markChanged();
                    }}
                    className={fieldClass}
                  />
                </div>
                {dueKind === 'datetime' && (
                  <div>
                    <label htmlFor="task-due-time" className="block text-xs font-medium text-muted">
                      時刻
                    </label>
                    <input
                      id="task-due-time"
                      data-testid="task-due-time"
                      type="time"
                      lang="ja"
                      required
                      value={dueTime}
                      onChange={(changeEvent) => {
                        setDueTime(changeEvent.currentTarget.value);
                        markChanged();
                      }}
                      className={fieldClass}
                    />
                  </div>
                )}
              </div>
            )}
          </fieldset>
          <div>
            <label htmlFor="task-assignee" className="block text-sm font-semibold">
              担当
            </label>
            <select
              id="task-assignee"
              data-testid="task-form-assignee"
              value={assigneeMemberId}
              onChange={(changeEvent) => {
                setAssigneeMemberId(changeEvent.currentTarget.value);
                markChanged();
              }}
              className={fieldClass}
            >
              <option value="">担当なし</option>
              {adultMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </div>
          {task && deleteConfirmation && (
            <div className="rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-sm)]">
              <p className="m-0 text-sm">このやることを削除しますか？</p>
              <div className="mt-[var(--spacing-sm)] flex gap-[var(--spacing-sm)]">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void handleDelete()}
                  className={`${buttonClass} flex-1 bg-accent text-surface`}
                >
                  {isDeleting ? '削除中…' : '削除する'}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setDeleteConfirmation(false)}
                  className={`${buttonClass} flex-1 border border-line bg-surface`}
                >
                  戻る
                </button>
              </div>
            </div>
          )}
          {task && !deleteConfirmation && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setDeleteConfirmation(true)}
              className={`${buttonClass} w-full border border-line bg-surface`}
            >
              削除
            </button>
          )}
        </fieldset>
        <div className="px-[var(--spacing-md)]">
          <button
            type="submit"
            data-testid="task-save"
            disabled={disabled}
            className={`${buttonClass} w-full bg-accent text-surface`}
          >
            {isSaving ? '保存中…' : requestLocked ? '同じ登録を確認して再試行' : '保存する'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
