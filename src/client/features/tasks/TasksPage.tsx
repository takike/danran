import { FamilyApiError } from '@client/api/family';
import { TaskApiError, updateTask } from '@client/api/tasks';
import { AuthenticatedShell } from '@client/components/AuthenticatedShell';
import { MemberDot } from '@client/components/MemberDot';
import { OAuthNotices } from '@client/components/OAuthNotices';
import { Segmented } from '@client/components/Segmented';
import { useLogoutMutation, useSessionQuery } from '@client/features/auth/useSession';
import { useFamiliesQuery } from '@client/features/onboarding/useFamily';
import { useReloadProtection } from '@client/features/pwa/useReloadProtection';
import { TaskDialog } from '@client/features/tasks/TaskDialog';
import { TaskRow } from '@client/features/tasks/TaskRow';
import { TASKS_QUERY_KEY, useTasksQuery } from '@client/features/tasks/useTasks';
import { type EventCountdown, buildTaskPresentation } from '@shared/domain/taskPresentation';
import type { FamilyPublic } from '@shared/schemas/family';
import type { Task } from '@shared/schemas/tasks';
import { getTodayDateKey, toTokyoDateKey } from '@shared/time/date';
import { formatShortDate, formatWeekday } from '@shared/time/format';
import { useQueryClient } from '@tanstack/react-query';
import { CheckSquare, Plus, RefreshCw } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

const buttonClass =
  'inline-flex min-h-[var(--tap-target-min)] items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] px-[var(--spacing-md)] text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50';
const VIEW_OPTIONS = [
  { value: 'event', label: '予定ごと' },
  { value: 'due', label: '期限順' },
  { value: 'mine', label: '自分の担当' },
] as const;
type View = (typeof VIEW_OPTIONS)[number]['value'];
type Member = FamilyPublic['members'][number];
type ReadyEvent = Extract<Task['linkedEvent'], { state: 'ready' }>;

function TasksPlaceholder(): React.ReactElement {
  return (
    <output aria-label="やることを読み込み中" aria-live="polite" className="block">
      <span className="sr-only">やることを読み込み中...</span>
      <div
        data-testid="task-list-placeholder"
        aria-hidden="true"
        className="space-y-[var(--spacing-sm)]"
      >
        {[0, 1].map((item) => (
          <div
            key={item}
            className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]"
          >
            <div className="h-6 w-2/3 rounded-[var(--radius-sm)] bg-chip" />
            <div className="mt-[var(--spacing-md)] h-12 rounded-[var(--radius-sm)] bg-chip" />
            <div className="mt-[var(--spacing-xs)] h-12 rounded-[var(--radius-sm)] bg-chip" />
          </div>
        ))}
      </div>
    </output>
  );
}

function dateHeading(date: string): string {
  return `${formatShortDate(date)}（${formatWeekday(date)}）時点`;
}

function eventDate(event: ReadyEvent): string {
  const date = event.time.kind === 'all-day' ? event.time.start : toTokyoDateKey(event.time.start);
  return formatShortDate(date);
}

function countdownLabel(value: EventCountdown) {
  if (value.kind === 'today') return '今日';
  if (value.kind === 'ended') return '終了';
  return `あと ${value.days}日`;
}

function taskGroupProgress(completed: number, total: number): number {
  return total === 0 ? 0 : Math.round((completed / total) * 100);
}

function isSessionUnauthorized(error: unknown): boolean {
  return error instanceof TaskApiError && error.status === 401 && error.code !== 'REAUTH_REQUIRED';
}

function TaskGroup({
  title,
  header,
  tasks,
  members,
  now,
  busyTaskIds,
  mutationErrors,
  onToggleDone,
  onAssignee,
  onEdit,
  children,
  testId,
}: {
  title: string;
  header?: React.ReactNode;
  tasks: Task[];
  members: Member[];
  now: Date | number;
  busyTaskIds: Set<string>;
  mutationErrors: Record<string, string>;
  onToggleDone: (taskId: string, done: boolean) => Promise<boolean>;
  onAssignee: (taskId: string, assigneeMemberId: string | null) => Promise<boolean>;
  onEdit: (task: Task) => void;
  children?: React.ReactNode;
  testId?: string;
}): React.ReactElement {
  const completedCount = tasks.filter((task) => task.doneAt !== null).length;
  const taskLabel = tasks.map((task) => task.id).join(',');
  return (
    <section
      data-testid={testId}
      className="min-w-0 rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]"
    >
      {header ?? (
        <h2 className="m-0 min-w-0 text-base font-semibold [overflow-wrap:anywhere]">{title}</h2>
      )}
      <div className="mt-[var(--spacing-sm)] flex items-center justify-between gap-[var(--spacing-sm)]">
        <div
          aria-hidden="true"
          className="h-[var(--spacing-xs)] min-w-0 flex-1 overflow-hidden rounded-[var(--radius-full)] bg-chip"
        >
          <div
            className="h-full rounded-[var(--radius-full)] bg-member-teal"
            style={{ width: `${taskGroupProgress(completedCount, tasks.length)}%` }}
          />
        </div>
        <span className="shrink-0 text-xs text-muted">
          {completedCount}/{tasks.length} 完了
        </span>
      </div>
      <ul data-task-group={taskLabel} className="mt-[var(--spacing-xs)] m-0 list-none p-0">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            members={members}
            now={now}
            busy={busyTaskIds.has(task.id)}
            disableEdit={busyTaskIds.size > 0}
            mutationError={mutationErrors[task.id]}
            onToggleDone={(done) => onToggleDone(task.id, done)}
            onAssignee={(memberId) => onAssignee(task.id, memberId)}
            onEdit={onEdit}
          />
        ))}
      </ul>
      {children}
    </section>
  );
}

function TaskCards({
  tasks,
  members,
  now,
  busyTaskIds,
  mutationErrors,
  onToggleDone,
  onAssignee,
  onEdit,
  showLinked = false,
  emptyMessage,
}: {
  tasks: Task[];
  members: Member[];
  now: Date | number;
  busyTaskIds: Set<string>;
  mutationErrors: Record<string, string>;
  onToggleDone: (taskId: string, done: boolean) => Promise<boolean>;
  onAssignee: (taskId: string, assigneeMemberId: string | null) => Promise<boolean>;
  onEdit: (task: Task) => void;
  showLinked?: boolean;
  emptyMessage?: string;
}): React.ReactElement {
  if (tasks.length === 0)
    return (
      <p className="m-0 rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)] text-sm text-muted">
        {emptyMessage ?? '表示するやることはありません。'}
      </p>
    );
  const openTasks = tasks.filter((task) => task.doneAt === null);
  const doneTasks = tasks.filter((task) => task.doneAt !== null);
  const renderList = (rows: Task[]) => (
    <ul className="m-0 list-none rounded-[var(--radius-lg)] border border-line bg-surface px-[var(--spacing-sm)] py-[var(--spacing-xs)]">
      {rows.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          members={members}
          now={now}
          busy={busyTaskIds.has(task.id)}
          disableEdit={busyTaskIds.size > 0}
          mutationError={mutationErrors[task.id]}
          showLinkedEvent={showLinked}
          onToggleDone={(done) => onToggleDone(task.id, done)}
          onAssignee={(memberId) => onAssignee(task.id, memberId)}
          onEdit={onEdit}
        />
      ))}
    </ul>
  );
  return (
    <div className="space-y-[var(--spacing-md)]">
      {openTasks.length > 0 && renderList(openTasks)}
      {doneTasks.length > 0 && (
        <section aria-labelledby="completed-tasks-heading" className="space-y-[var(--spacing-xs)]">
          <h2 id="completed-tasks-heading" className="m-0 text-sm font-semibold text-muted">
            完了
          </h2>
          {renderList(doneTasks)}
        </section>
      )}
    </div>
  );
}

function Summary({
  values,
}: { values: { dueTodayOrEarlier: number; dueThisWeek: number; unassigned: number } }) {
  return (
    <div aria-label="やることのサマリー" className="flex flex-wrap gap-[var(--spacing-xs)]">
      <span className="inline-flex min-h-[var(--tap-target-min)] items-center rounded-[var(--radius-full)] bg-accent px-[var(--spacing-md)] text-sm font-semibold text-surface">
        今日まで {values.dueTodayOrEarlier}
      </span>
      <span className="inline-flex min-h-[var(--tap-target-min)] items-center rounded-[var(--radius-full)] border border-line bg-surface px-[var(--spacing-md)] text-sm">
        今週 {values.dueThisWeek}
      </span>
      <span className="inline-flex min-h-[var(--tap-target-min)] items-center rounded-[var(--radius-full)] border border-line bg-surface px-[var(--spacing-md)] text-sm">
        担当未定 {values.unassigned}
      </span>
    </div>
  );
}

export default function TasksPage(): React.ReactElement {
  const session = useSessionQuery();
  const logoutMutation = useLogoutMutation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = session.isError ? undefined : session.data;
  const familiesQuery = useFamiliesQuery(session.isError ? undefined : user?.id);
  const familyAccessLost =
    familiesQuery.error instanceof FamilyApiError &&
    [401, 403, 404].includes(familiesQuery.error.status ?? 0);
  const family = familyAccessLost
    ? undefined
    : familiesQuery.data?.find((item) => item.creationStatus === 'ready' && item.familyCalendarId);
  const identity = user && family ? `${user.id}:${family.id}` : '';
  const identityRef = useRef(identity);
  const mountedRef = useRef(false);
  const previousIdentityRef = useRef(identity);
  const pendingMutationCountRef = useRef(new Map<string, number>());
  identityRef.current = identity;
  const tasksQuery = useTasksQuery(user?.id, family?.id, () => {
    return (pendingMutationCountRef.current.get(identity) ?? 0) === 0;
  });
  const taskQueryKey = family && user ? ([...TASKS_QUERY_KEY, user.id, family.id] as const) : null;
  const [view, setView] = useState<View>('event');
  const [busyTaskIds, setBusyTaskIds] = useState<Set<string>>(() => new Set());
  const [mutationErrors, setMutationErrors] = useState<Record<string, string>>({});
  const busyTaskIdsRef = useRef(new Set<string>());
  const [dialogEverOpened, setDialogEverOpened] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTask, setDialogTask] = useState<Task | undefined>();
  const [dialogEvent, setDialogEvent] = useState<ReadyEvent | undefined>();
  const [dialogKey, setDialogKey] = useState('');
  const [dialogIdentity, setDialogIdentity] = useState('');
  const [loginNavigating, setLoginNavigating] = useState(false);
  const loginNavigationRef = useRef(false);
  const now = Date.now();
  const today = getTodayDateKey(now);
  const presentation = useMemo(
    () =>
      buildTaskPresentation(tasksQuery.data ?? [], {
        now,
        currentMemberId: family?.members.find((member) => member.userId === user?.id)?.id ?? '',
      }),
    [family?.members, now, tasksQuery.data, user?.id],
  );
  const members = family?.members ?? [];

  useReloadProtection(busyTaskIds.size > 0, busyTaskIds.size > 0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (previousIdentityRef.current === identity) return;
    const oldIdentity = previousIdentityRef.current;
    previousIdentityRef.current = identity;
    const [oldUserId, oldFamilyId] = oldIdentity.split(':');
    if (oldUserId && oldFamilyId) {
      const oldKey = [...TASKS_QUERY_KEY, oldUserId, oldFamilyId] as const;
      void (async () => {
        await queryClient.cancelQueries({ queryKey: oldKey });
        queryClient.removeQueries({ queryKey: oldKey });
      })();
    }
    setView('event');
    setDialogEverOpened(false);
    setDialogOpen(false);
    setDialogTask(undefined);
    setDialogEvent(undefined);
    setBusyTaskIds(new Set());
    setMutationErrors({});
    busyTaskIdsRef.current = new Set();
  }, [identity, queryClient]);

  useEffect(() => {
    const resetLoginNavigation = () => {
      loginNavigationRef.current = false;
      setLoginNavigating(false);
    };
    window.addEventListener('pageshow', resetLoginNavigation);
    return () => window.removeEventListener('pageshow', resetLoginNavigation);
  }, []);

  const onUnauthorized = useCallback(() => {
    void logoutMutation.mutateAsync().catch(() => undefined);
  }, [logoutMutation.mutateAsync]);

  useEffect(() => {
    const unauthorized =
      (familiesQuery.error instanceof FamilyApiError && familiesQuery.error.status === 401) ||
      isSessionUnauthorized(tasksQuery.error);
    if (unauthorized) onUnauthorized();
  }, [familiesQuery.error, onUnauthorized, tasksQuery.error]);

  const beginLogin = () => {
    if (loginNavigationRef.current) return;
    loginNavigationRef.current = true;
    setLoginNavigating(true);
    window.location.assign('/api/auth/login');
  };

  const setTaskBusy = (taskId: string, busy: boolean) => {
    const next = new Set(busyTaskIdsRef.current);
    if (busy) next.add(taskId);
    else next.delete(taskId);
    busyTaskIdsRef.current = next;
    setBusyTaskIds(next);
  };

  const mutateTask = async (
    taskId: string,
    patch: { done?: boolean; assigneeMemberId?: string | null },
  ): Promise<boolean> => {
    if (
      !family ||
      !user ||
      !taskQueryKey ||
      !mountedRef.current ||
      identityRef.current !== identity ||
      busyTaskIdsRef.current.has(taskId)
    )
      return false;
    const mutationIdentity = identity;
    const key = taskQueryKey;
    setTaskBusy(taskId, true);
    setMutationErrors((current) => {
      const next = { ...current };
      delete next[taskId];
      return next;
    });
    const pending = pendingMutationCountRef.current.get(mutationIdentity) ?? 0;
    pendingMutationCountRef.current.set(mutationIdentity, pending + 1);
    let succeeded = false;
    let previousTask: Task | undefined;
    try {
      if (pending === 0) await queryClient.cancelQueries({ queryKey: key });
      if (!mountedRef.current || identityRef.current !== mutationIdentity) return false;
      const current = queryClient.getQueryData<Task[]>(key) ?? [];
      previousTask = current.find((task) => task.id === taskId);
      if (!previousTask) return false;
      const optimistic: Task = {
        ...previousTask,
        ...(patch.done === undefined
          ? {}
          : { doneAt: patch.done ? Math.floor(Date.now() / 1000) : null }),
        ...(patch.assigneeMemberId === undefined
          ? {}
          : { assigneeMemberId: patch.assigneeMemberId }),
      };
      queryClient.setQueryData<Task[]>(
        key,
        current.map((task) => (task.id === taskId ? optimistic : task)),
      );
      const result = await updateTask(family.id, taskId, patch);
      if (!mountedRef.current || identityRef.current !== mutationIdentity) return false;
      queryClient.setQueryData<Task[]>(key, (rows) =>
        rows?.map((task) => (task.id === taskId ? result : task)),
      );
      succeeded = true;
    } catch (error: unknown) {
      if (!mountedRef.current || identityRef.current !== mutationIdentity) return false;
      const currentRows = queryClient.getQueryData<Task[]>(key);
      const rollbackTask = previousTask;
      if (rollbackTask && currentRows)
        queryClient.setQueryData<Task[]>(
          key,
          currentRows.map((task) => (task.id === taskId ? rollbackTask : task)),
        );
      setMutationErrors((current) => ({
        ...current,
        [taskId]:
          patch.done === undefined
            ? '担当を保存できませんでした。もう一度お試しください。'
            : '完了状態を保存できませんでした。もう一度お試しください。',
      }));
      if (isSessionUnauthorized(error)) onUnauthorized();
    } finally {
      const remaining = Math.max(
        0,
        (pendingMutationCountRef.current.get(mutationIdentity) ?? 1) - 1,
      );
      pendingMutationCountRef.current.set(mutationIdentity, remaining);
      if (mountedRef.current && identityRef.current === mutationIdentity)
        setTaskBusy(taskId, false);
      if (remaining === 0 && identityRef.current === mutationIdentity) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    }
    return succeeded;
  };

  const openCreate = (event?: ReadyEvent) => {
    setDialogIdentity(identity);
    setDialogKey(crypto.randomUUID());
    setDialogTask(undefined);
    setDialogEvent(event);
    setDialogEverOpened(true);
    setDialogOpen(true);
  };
  const openEdit = (task: Task) => {
    setDialogIdentity(identity);
    setDialogKey(crypto.randomUUID());
    setDialogTask(task);
    setDialogEvent(undefined);
    setDialogEverOpened(true);
    setDialogOpen(true);
  };

  const isTaskAccessLost =
    tasksQuery.error instanceof TaskApiError &&
    [401, 403, 404].includes(tasksQuery.error.status ?? 0);
  const taskRows = tasksQuery.data ?? [];

  if (
    session.isLoading ||
    (!session.isError && user && familiesQuery.isLoading && !familiesQuery.data)
  ) {
    return (
      <AuthenticatedShell activeTab="tasks" onCapture={() => navigate('/import')}>
        <p aria-live="polite" className="text-sm text-muted">
          読み込み中...
        </p>
      </AuthenticatedShell>
    );
  }

  if (!user) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-[var(--app-max-width)] flex-col bg-bg px-[var(--spacing-md)] py-[var(--spacing-lg)] text-ink">
        <OAuthNotices />
        <h1 className="m-0 text-2xl font-bold">やること</h1>
        {session.isError ? (
          <>
            <p role="alert" className="mt-[var(--spacing-md)] text-sm text-muted">
              認証サービスに接続できませんでした。
            </p>
            <button
              type="button"
              onClick={() => void session.refetch()}
              className={`${buttonClass} mt-[var(--spacing-md)] w-full border border-line`}
            >
              再試行
            </button>
          </>
        ) : (
          <>
            <p className="mt-[var(--spacing-md)] text-sm text-muted">
              続けるには Google でログインしてください。
            </p>
            <button
              type="button"
              disabled={loginNavigating}
              onClick={beginLogin}
              className={`${buttonClass} mt-[var(--spacing-md)] w-full bg-accent text-surface`}
            >
              {loginNavigating ? '移動しています…' : 'Google でログイン'}
            </button>
          </>
        )}
      </main>
    );
  }

  return (
    <AuthenticatedShell
      activeTab="tasks"
      onCapture={() => navigate('/import')}
      mainTestId="tasks-screen"
    >
      <OAuthNotices />
      <header className="mb-[var(--spacing-md)] flex items-end justify-between gap-[var(--spacing-sm)]">
        <div className="min-w-0">
          <p className="m-0 text-sm text-muted">{dateHeading(today)}</p>
          <h1 className="mt-[var(--spacing-xs)] mb-0 text-2xl font-bold">やること</h1>
        </div>
        <button
          type="button"
          aria-label="やることを追加"
          data-testid="task-add-button"
          disabled={!family || busyTaskIds.size > 0}
          onClick={() => openCreate()}
          className={`${buttonClass} min-w-[var(--tap-target-min)] shrink-0 bg-accent px-[var(--spacing-sm)] text-surface`}
        >
          <Plus size={20} aria-hidden="true" />
        </button>
      </header>

      {!family ? (
        <section className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]">
          {familiesQuery.isError ? (
            <>
              <p role="alert" className="m-0 text-sm">
                家族情報を読み込めませんでした。
              </p>
              <button
                type="button"
                onClick={() => void familiesQuery.refetch()}
                className={`${buttonClass} mt-[var(--spacing-sm)] w-full border border-line`}
              >
                <RefreshCw size={16} aria-hidden="true" />
                再試行
              </button>
            </>
          ) : (
            <>
              <p className="m-0 text-sm">
                やることを使うには、先に家族カレンダーを準備してください。
              </p>
              <Link
                to="/onboarding"
                className={`${buttonClass} mt-[var(--spacing-md)] w-full border border-line`}
              >
                家族の設定
              </Link>
            </>
          )}
        </section>
      ) : (
        <>
          <div className="mb-[var(--spacing-md)] overflow-x-auto">
            <Segmented
              name="tasks-view"
              label="やることの表示"
              options={[...VIEW_OPTIONS]}
              value={view}
              onChange={setView}
              className="w-full"
            />
          </div>
          {tasksQuery.data && !familyAccessLost && !isTaskAccessLost && (
            <div className="mb-[var(--spacing-md)]">
              <Summary values={presentation.summary} />
            </div>
          )}
          {tasksQuery.isError && (!tasksQuery.data || isTaskAccessLost) ? (
            <section
              role="alert"
              className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]"
            >
              <p className="m-0 text-sm">やることを読み込めませんでした。</p>
              <button
                type="button"
                onClick={() => void tasksQuery.refetch()}
                className={`${buttonClass} mt-[var(--spacing-sm)] w-full border border-line bg-surface`}
              >
                <RefreshCw size={16} aria-hidden="true" />
                再試行
              </button>
            </section>
          ) : tasksQuery.isLoading ? (
            <TasksPlaceholder />
          ) : taskRows.length === 0 ? (
            <section className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-lg)] text-center">
              {tasksQuery.isError && !isTaskAccessLost && (
                <div className="mb-[var(--spacing-md)]">
                  <output className="block text-sm text-muted">
                    最新の一覧を取得できませんでした。表示中の内容を続けています。
                  </output>
                  <button
                    type="button"
                    onClick={() => void tasksQuery.refetch()}
                    className={`${buttonClass} mt-[var(--spacing-xs)] w-full border border-line bg-surface`}
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    再試行
                  </button>
                </div>
              )}
              <div className="mx-auto mb-[var(--spacing-md)] flex h-[var(--icon-size-lg)] w-[var(--icon-size-lg)] items-center justify-center rounded-[var(--radius-full)] bg-chip text-muted">
                <CheckSquare size={24} aria-hidden="true" />
              </div>
              <h2 className="m-0 text-base font-semibold">家族のやることをまとめて管理</h2>
              <p className="mt-[var(--spacing-sm)] mb-0 text-sm leading-relaxed text-muted">
                予定に紐づく準備や、手動のやることをここで確認できます。
              </p>
              <button
                type="button"
                onClick={() => openCreate()}
                className={`${buttonClass} mt-[var(--spacing-md)] w-full bg-accent text-surface`}
              >
                <Plus size={18} aria-hidden="true" />
                やることを追加
              </button>
            </section>
          ) : (
            <>
              {tasksQuery.isError && !isTaskAccessLost && (
                <div className="mb-[var(--spacing-sm)] rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-sm)]">
                  <output className="block text-sm text-muted">
                    最新の一覧を取得できませんでした。前回の表示を続けています。
                  </output>
                  <button
                    type="button"
                    onClick={() => void tasksQuery.refetch()}
                    className={`${buttonClass} mt-[var(--spacing-xs)] w-full border border-line bg-surface`}
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    再試行
                  </button>
                </div>
              )}
              {view === 'event' ? (
                <div data-testid="tasks-event-view" className="space-y-[var(--spacing-sm)]">
                  {presentation.readyGroups.map((group) => {
                    const groupEvent: ReadyEvent = {
                      state: 'ready',
                      eventId: group.eventId,
                      title: group.title,
                      time: group.time,
                      memberIds: group.memberIds,
                      items: group.items,
                    };
                    const targets = group.memberIds
                      .map((id) => members.find((member) => member.id === id))
                      .filter((member): member is Member => Boolean(member));
                    const soon =
                      group.countdown.kind === 'today' ||
                      (group.countdown.kind === 'days' && group.countdown.days <= 3);
                    const groupHeader = (
                      <div className="mb-[var(--spacing-sm)] flex min-w-0 items-start justify-between gap-[var(--spacing-xs)]">
                        <div className="min-w-0">
                          <h2 className="m-0 min-w-0 text-base font-semibold [overflow-wrap:anywhere]">
                            {eventDate(groupEvent)} {group.title}
                          </h2>
                          {targets.length > 0 && (
                            <div className="mt-[var(--spacing-xs)] flex flex-wrap gap-x-[var(--spacing-sm)] gap-y-[var(--spacing-xs)]">
                              {targets.map((member) => (
                                <MemberDot
                                  key={member.id}
                                  name={member.name}
                                  color={`var(--member-${member.color})`}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                        <span
                          className={`shrink-0 rounded-[var(--radius-full)] px-[var(--spacing-sm)] py-[var(--spacing-2xs)] text-xs font-semibold ${soon ? 'bg-accent-tint text-accent' : 'bg-chip text-muted'}`}
                        >
                          {countdownLabel(group.countdown)}
                        </span>
                      </div>
                    );
                    return (
                      <TaskGroup
                        key={group.eventId}
                        title={group.title}
                        header={groupHeader}
                        tasks={group.tasks}
                        members={members}
                        now={now}
                        busyTaskIds={busyTaskIds}
                        mutationErrors={mutationErrors}
                        onToggleDone={(id, done) => mutateTask(id, { done })}
                        onAssignee={(id, assigneeMemberId) => mutateTask(id, { assigneeMemberId })}
                        onEdit={openEdit}
                        testId="task-event-group"
                      >
                        <button
                          type="button"
                          data-testid={`task-add-to-event-${group.eventId}`}
                          disabled={busyTaskIds.size > 0}
                          onClick={() => openCreate(groupEvent)}
                          className="mt-[var(--spacing-sm)] min-h-[var(--tap-target-min)] w-full rounded-[var(--radius-md)] border border-dashed border-line bg-transparent px-[var(--spacing-sm)] text-left text-sm text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
                        >
                          ＋ この予定にやることを追加
                        </button>
                      </TaskGroup>
                    );
                  })}
                  {presentation.missingTasks.length > 0 && (
                    <TaskGroup
                      title="予定が見つかりません"
                      tasks={presentation.missingTasks}
                      members={members}
                      now={now}
                      busyTaskIds={busyTaskIds}
                      mutationErrors={mutationErrors}
                      onToggleDone={(id, done) => mutateTask(id, { done })}
                      onAssignee={(id, assigneeMemberId) => mutateTask(id, { assigneeMemberId })}
                      onEdit={openEdit}
                      testId="task-missing-group"
                    />
                  )}
                  {presentation.unavailableTasks.length > 0 && (
                    <TaskGroup
                      title="予定の情報を取得できませんでした"
                      tasks={presentation.unavailableTasks}
                      members={members}
                      now={now}
                      busyTaskIds={busyTaskIds}
                      mutationErrors={mutationErrors}
                      onToggleDone={(id, done) => mutateTask(id, { done })}
                      onAssignee={(id, assigneeMemberId) => mutateTask(id, { assigneeMemberId })}
                      onEdit={openEdit}
                      testId="task-unavailable-group"
                    >
                      <button
                        type="button"
                        onClick={() => void tasksQuery.refetch()}
                        className={`${buttonClass} mt-[var(--spacing-sm)] w-full border border-line bg-surface`}
                      >
                        <RefreshCw size={16} aria-hidden="true" />
                        再試行
                      </button>
                    </TaskGroup>
                  )}
                  {presentation.unlinkedTasks.length > 0 && (
                    <details className="rounded-[var(--radius-lg)] border border-dashed border-line bg-surface px-[var(--spacing-md)]">
                      <summary className="flex min-h-[var(--tap-target-min)] cursor-pointer items-center text-sm font-medium">
                        予定に紐づかないやること（{presentation.unlinkedTasks.length}件）
                      </summary>
                      <div className="pb-[var(--spacing-sm)]">
                        <TaskCards
                          tasks={presentation.unlinkedTasks}
                          members={members}
                          now={now}
                          busyTaskIds={busyTaskIds}
                          mutationErrors={mutationErrors}
                          onToggleDone={(id, done) => mutateTask(id, { done })}
                          onAssignee={(id, assigneeMemberId) =>
                            mutateTask(id, { assigneeMemberId })
                          }
                          onEdit={openEdit}
                        />
                      </div>
                    </details>
                  )}
                </div>
              ) : view === 'due' ? (
                <div data-testid="tasks-due-view">
                  <TaskCards
                    tasks={presentation.orderedTasks}
                    members={members}
                    now={now}
                    busyTaskIds={busyTaskIds}
                    mutationErrors={mutationErrors}
                    onToggleDone={(id, done) => mutateTask(id, { done })}
                    onAssignee={(id, assigneeMemberId) => mutateTask(id, { assigneeMemberId })}
                    onEdit={openEdit}
                    showLinked
                    emptyMessage="やることはありません。"
                  />
                </div>
              ) : (
                <div data-testid="tasks-mine-view">
                  <TaskCards
                    tasks={presentation.mineTasks}
                    members={members}
                    now={now}
                    busyTaskIds={busyTaskIds}
                    mutationErrors={mutationErrors}
                    onToggleDone={(id, done) => mutateTask(id, { done })}
                    onAssignee={(id, assigneeMemberId) => mutateTask(id, { assigneeMemberId })}
                    onEdit={openEdit}
                    showLinked
                    emptyMessage="あなたが担当のやることはありません。"
                  />
                </div>
              )}
            </>
          )}
        </>
      )}

      {family && dialogEverOpened && dialogKey && dialogIdentity === identity && (
        <TaskDialog
          key={dialogKey}
          familyId={family.id}
          userId={user.id}
          members={family.members}
          task={dialogTask}
          event={dialogEvent}
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          onSaved={() => {
            setDialogOpen(false);
            setDialogEverOpened(false);
          }}
          onUnauthorized={onUnauthorized}
          isIdentityCurrent={() => mountedRef.current && identityRef.current === identity}
        />
      )}
    </AuthenticatedShell>
  );
}
