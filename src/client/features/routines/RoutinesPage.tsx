import {
  RoutineApiError,
  applyRoutineAutoSkips,
  createRoutine,
  deleteRoutine,
  fetchRoutines,
  updateRoutineSettings,
} from '@client/api/routines';
import { AuthenticatedShell } from '@client/components/AuthenticatedShell';
import { MemberDot } from '@client/components/MemberDot';
import { OAuthNotices } from '@client/components/OAuthNotices';
import { useLogoutMutation, useSessionQuery } from '@client/features/auth/useSession';
import { useFamiliesQuery } from '@client/features/onboarding/useFamily';
import { useReloadProtection } from '@client/features/pwa/useReloadProtection';
import { RoutineInstances } from '@client/features/routines/RoutineInstances';
import { formatRoutineRule } from '@shared/domain/routines';
import {
  type Routine,
  type RoutineInput,
  type RoutineInstance,
  type RoutineSettingsInput,
  type WeekdayCode,
  createRoutineInputSchema,
} from '@shared/schemas/routines';
import { getTodayDateKey, getWeekday } from '@shared/time';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, RefreshCw, Repeat, Trash2, X } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

const ROUTINE_QUERY_KEY = ['routines'] as const;
const WEEKDAY_OPTIONS: Array<{ code: WeekdayCode; day: number; label: string }> = [
  { code: 'MO', day: 1, label: '月曜' },
  { code: 'TU', day: 2, label: '火曜' },
  { code: 'WE', day: 3, label: '水曜' },
  { code: 'TH', day: 4, label: '木曜' },
  { code: 'FR', day: 5, label: '金曜' },
  { code: 'SA', day: 6, label: '土曜' },
  { code: 'SU', day: 0, label: '日曜' },
];
const CATEGORY_LABELS = { lesson: '習い事', housework: '家事代行', other: 'その他' } as const;
const buttonClass =
  'inline-flex min-h-[var(--tap-target-min)] items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] px-[var(--spacing-md)] text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50';
const fieldClass =
  'mt-[var(--spacing-xs)] min-h-[var(--tap-target-min)] w-full rounded-[var(--radius-md)] border border-line bg-surface px-[var(--spacing-sm)] text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
type Member = NonNullable<ReturnType<typeof useFamiliesQuery>['data']>[number]['members'][number];

function RoutineDialog({
  familyId,
  userId,
  members,
  open,
  onClose,
  onSaved,
  onUnauthorized,
  isIdentityCurrent,
}: {
  familyId: string;
  userId: string;
  members: Member[];
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  onUnauthorized: () => void;
  isIdentityCurrent: () => boolean;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const today = getTodayDateKey();
  const weekday = getWeekday(today);
  const defaultWeekday = WEEKDAY_OPTIONS.find((option) => option.day === weekday)?.code ?? 'MO';
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const historyEntryRef = useRef(false);
  const requestIdRef = useRef<string | null>(null);
  const lockedInputRef = useRef<RoutineInput | null>(null);
  const [title, setTitle] = useState('');
  const [weekdays, setWeekdays] = useState<WeekdayCode[]>([defaultWeekday]);
  const [interval, setInterval] = useState<1 | 2>(1);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState('');
  const [hasEndDate, setHasEndDate] = useState(false);
  const [startTime, setStartTime] = useState('17:00');
  const [endTime, setEndTime] = useState('18:00');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [assigneeMemberId, setAssigneeMemberId] = useState('');
  const [category, setCategory] = useState<'lesson' | 'housework' | 'other'>('lesson');
  const [affectsAvailability, setAffectsAvailability] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [requestLocked, setRequestLocked] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useReloadProtection(open && (isDirty || requestLocked), open && isSaving);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!open) {
      if (dialog.open) dialog.close();
      return;
    }
    const marker = `routine-dialog-${crypto.randomUUID()}`;
    dialog.showModal();
    if (window.history.state?.danranRoutineDialog !== marker) {
      window.history.pushState(
        { ...(window.history.state ?? {}), danranRoutineDialog: marker },
        '',
      );
      historyEntryRef.current = true;
    }
    window.setTimeout(() => titleRef.current?.focus(), 0);
    const handlePopState = () => {
      if (pendingRef.current) {
        window.history.pushState(
          { ...(window.history.state ?? {}), danranRoutineDialog: marker },
          '',
        );
      } else onCloseRef.current();
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (dialog.open) dialog.close();
      window.setTimeout(() => {
        if (window.history.state?.danranRoutineDialog !== marker) return;
        const historyState = { ...(window.history.state ?? {}) };
        historyState.danranRoutineDialog = undefined;
        window.history.replaceState(historyState, '');
      }, 0);
    };
  }, [open]);
  const requestClose = () => {
    if (pendingRef.current) return;
    if (requestLocked) {
      setErrorMessage(
        '保存結果を確認できていません。閉じても入力は保持され、再度開けば同じ内容で再試行できます。',
      );
    }
    if (historyEntryRef.current && window.history.state?.danranRoutineDialog) window.history.back();
    else onCloseRef.current();
  };
  const changed = () => {
    setIsDirty(true);
    setErrorMessage('');
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRef.current) return;
    pendingRef.current = true;
    setIsSaving(true);
    setErrorMessage('');
    let saved = false;
    try {
      let input = lockedInputRef.current;
      if (!input) {
        const clientRequestId = requestIdRef.current ?? crypto.randomUUID();
        requestIdRef.current = clientRequestId;
        const parsed = createRoutineInputSchema.safeParse({
          title,
          weekdays,
          interval,
          startDate,
          endDate: hasEndDate ? endDate : null,
          startTime,
          endTime,
          memberIds,
          assigneeMemberId: assigneeMemberId || null,
          category,
          affectsAvailability,
          clientRequestId,
        });
        if (!parsed.success)
          throw new RoutineApiError('入力内容を確認してください。', 'INVALID_INPUT');
        input = parsed.data;
        lockedInputRef.current = input;
      }
      await createRoutine(familyId, input);
      if (!isIdentityCurrent()) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...ROUTINE_QUERY_KEY, userId, familyId] }),
        queryClient.invalidateQueries({ queryKey: ['week', userId, familyId] }),
        queryClient.invalidateQueries({ queryKey: ['week-busy', userId, familyId] }),
      ]);
      if (!isIdentityCurrent()) return;
      setIsDirty(false);
      setRequestLocked(false);
      requestIdRef.current = null;
      lockedInputRef.current = null;
      saved = true;
    } catch (error: unknown) {
      if (!isIdentityCurrent()) return;
      if (error instanceof RoutineApiError && error.status === 401) onUnauthorized();
      if (error instanceof RoutineApiError && error.code === 'INVALID_INPUT') {
        requestIdRef.current = null;
        lockedInputRef.current = null;
        setRequestLocked(false);
      } else if (!(error instanceof RoutineApiError) || !error.status || error.status >= 500) {
        setRequestLocked(true);
      } else {
        requestIdRef.current = null;
        lockedInputRef.current = null;
        setRequestLocked(false);
      }
      setErrorMessage(
        error instanceof RoutineApiError
          ? error.message
          : '繰り返し予定を保存できませんでした。通信状態を確認して、もう一度お試しください。',
      );
    } finally {
      pendingRef.current = false;
      if (isIdentityCurrent()) setIsSaving(false);
    }
    if (saved && isIdentityCurrent()) onSaved();
  };

  const disabled = isSaving || requestLocked;
  const adultMembers = members.filter((member) => member.kind === 'adult');
  return (
    <dialog
      ref={dialogRef}
      data-testid="routine-dialog"
      aria-labelledby="routine-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto border-0 bg-bg p-0 text-ink backdrop:bg-ink/40 sm:left-1/2 sm:right-auto sm:w-[min(100%,var(--app-max-width))] sm:-translate-x-1/2"
    >
      <form
        id="routine-form"
        onSubmit={handleSubmit}
        className="mx-auto min-h-dvh w-full max-w-[var(--app-max-width)] pb-[calc(var(--tab-bar-clearance)+var(--spacing-md))]"
      >
        <header className="sticky top-0 z-10 flex min-h-[var(--tap-target-min)] items-center justify-between border-b border-line bg-bg/95 px-[var(--spacing-md)] backdrop-blur">
          <h2 id="routine-dialog-title" className="m-0 text-lg font-semibold">
            繰り返し予定を追加
          </h2>
          <button
            type="button"
            aria-label="閉じる"
            onClick={requestClose}
            disabled={isSaving}
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
                  入力を変更せず、同じ内容で再試行してください。
                </span>
              )}
            </p>
          )}
          <div>
            <label htmlFor="routine-title" className="block text-sm font-semibold">
              タイトル
            </label>
            <input
              ref={titleRef}
              id="routine-title"
              data-testid="routine-form-title"
              type="text"
              required
              maxLength={200}
              value={title}
              onChange={(event) => {
                setTitle(event.currentTarget.value);
                changed();
              }}
              className={fieldClass}
            />
          </div>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-[var(--spacing-sm)] text-sm font-semibold">曜日</legend>
            <div className="grid grid-cols-4 gap-[var(--spacing-xs)]">
              {WEEKDAY_OPTIONS.map((option) => (
                <label
                  key={option.code}
                  className={`flex min-h-[var(--tap-target-min)] cursor-pointer items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] border px-[var(--spacing-xs)] text-sm ${weekdays.includes(option.code) ? 'border-focus bg-surface' : 'border-line'}`}
                >
                  <input
                    type="checkbox"
                    data-testid={`routine-weekday-${option.code}`}
                    checked={weekdays.includes(option.code)}
                    onChange={(event) => {
                      const next = event.currentTarget.checked
                        ? [...weekdays, option.code]
                        : weekdays.filter((day) => day !== option.code);
                      setWeekdays(
                        WEEKDAY_OPTIONS.map((item) => item.code).filter((day) =>
                          next.includes(day),
                        ),
                      );
                      changed();
                    }}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-[var(--spacing-sm)] text-sm font-semibold">間隔</legend>
            <div className="grid grid-cols-2 gap-[var(--spacing-sm)]">
              {(
                [
                  { value: 1, label: '毎週' },
                  { value: 2, label: '隔週' },
                ] as const
              ).map((option) => (
                <label
                  key={option.value}
                  className={`flex min-h-[var(--tap-target-min)] cursor-pointer items-center gap-[var(--spacing-sm)] rounded-[var(--radius-md)] border px-[var(--spacing-sm)] ${interval === option.value ? 'border-focus bg-surface' : 'border-line'}`}
                >
                  <input
                    type="radio"
                    data-testid={`routine-interval-${option.value}`}
                    name="routine-interval"
                    checked={interval === option.value}
                    onChange={() => {
                      setInterval(option.value);
                      changed();
                    }}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-md)]">
            <div className="grid grid-cols-2 gap-[var(--spacing-sm)]">
              <div>
                <label
                  htmlFor="routine-start-date"
                  className="block text-xs font-medium text-muted"
                >
                  開始日
                </label>
                <input
                  id="routine-start-date"
                  data-testid="routine-start-date"
                  lang="ja"
                  type="date"
                  required
                  value={startDate}
                  onChange={(event) => {
                    setStartDate(event.currentTarget.value);
                    changed();
                  }}
                  className={fieldClass}
                />
              </div>
              <div>
                <label
                  htmlFor="routine-start-time"
                  className="block text-xs font-medium text-muted"
                >
                  開始時刻
                </label>
                <input
                  id="routine-start-time"
                  data-testid="routine-start-time"
                  lang="ja"
                  type="time"
                  required
                  value={startTime}
                  onChange={(event) => {
                    setStartTime(event.currentTarget.value);
                    changed();
                  }}
                  className={fieldClass}
                />
              </div>
              <div>
                <label htmlFor="routine-end-time" className="block text-xs font-medium text-muted">
                  終了時刻
                </label>
                <input
                  id="routine-end-time"
                  data-testid="routine-end-time"
                  lang="ja"
                  type="time"
                  required
                  min={startTime}
                  value={endTime}
                  onChange={(event) => {
                    setEndTime(event.currentTarget.value);
                    changed();
                  }}
                  className={fieldClass}
                />
              </div>
              <div className="col-span-2">
                <label className="flex min-h-[var(--tap-target-min)] cursor-pointer items-center gap-[var(--spacing-sm)] text-sm">
                  <input
                    type="checkbox"
                    checked={hasEndDate}
                    onChange={(event) => {
                      setHasEndDate(event.currentTarget.checked);
                      changed();
                    }}
                    className="h-5 w-5 accent-[var(--accent)]"
                  />
                  終了日を指定する
                </label>
                {hasEndDate && (
                  <>
                    <label
                      htmlFor="routine-end-date"
                      className="block text-xs font-medium text-muted"
                    >
                      終了日
                    </label>
                    <input
                      id="routine-end-date"
                      data-testid="routine-end-date"
                      lang="ja"
                      type="date"
                      required
                      min={startDate}
                      value={endDate}
                      onChange={(event) => {
                        setEndDate(event.currentTarget.value);
                        changed();
                      }}
                      className={fieldClass}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-[var(--spacing-sm)] text-sm font-semibold">対象メンバー</legend>
            <p className="mt-0 mb-[var(--spacing-xs)] text-xs text-muted">
              選択しない場合は家族全員の予定です。
            </p>
            <div className="grid grid-cols-2 gap-[var(--spacing-sm)]">
              {members.map((member) => (
                <label
                  key={member.id}
                  htmlFor={`routine-member-${member.id}`}
                  className={`flex min-h-[var(--tap-target-min)] min-w-0 cursor-pointer items-center gap-[var(--spacing-sm)] rounded-[var(--radius-md)] border px-[var(--spacing-sm)] ${memberIds.includes(member.id) ? 'border-focus bg-surface' : 'border-line'}`}
                >
                  <input
                    id={`routine-member-${member.id}`}
                    type="checkbox"
                    data-testid={`routine-member-${member.id}`}
                    checked={memberIds.includes(member.id)}
                    onChange={(event) => {
                      setMemberIds(
                        event.currentTarget.checked
                          ? [...memberIds, member.id]
                          : memberIds.filter((id) => id !== member.id),
                      );
                      changed();
                    }}
                    className="h-5 w-5 shrink-0 accent-[var(--accent)]"
                  />
                  <MemberDot name={member.name} color={`var(--member-${member.color})`} />
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="routine-assignee" className="block text-sm font-semibold">
              担当（大人）
            </label>
            <select
              id="routine-assignee"
              data-testid="routine-assignee"
              value={assigneeMemberId}
              onChange={(event) => {
                setAssigneeMemberId(event.currentTarget.value);
                changed();
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
          <div>
            <label htmlFor="routine-category" className="block text-sm font-semibold">
              種類
            </label>
            <select
              id="routine-category"
              data-testid="routine-category"
              value={category}
              onChange={(event) => {
                setCategory(event.currentTarget.value as typeof category);
                changed();
              }}
              className={fieldClass}
            >
              <option value="lesson">習い事</option>
              <option value="housework">家事代行</option>
              <option value="other">その他</option>
            </select>
          </div>
          <label className="flex min-h-[var(--tap-target-min)] cursor-pointer items-center gap-[var(--spacing-sm)] rounded-[var(--radius-md)] border border-line bg-surface px-[var(--spacing-sm)] text-sm">
            <input
              type="checkbox"
              data-testid="routine-affects-availability"
              checked={affectsAvailability}
              onChange={(event) => {
                setAffectsAvailability(event.currentTarget.checked);
                changed();
              }}
              className="h-5 w-5 accent-[var(--accent)]"
            />
            家族の空き判定に含める
          </label>
        </fieldset>
        <div className="px-[var(--spacing-md)]">
          <button
            type="submit"
            form="routine-form"
            data-testid="routine-save"
            disabled={isSaving}
            className={`${buttonClass} w-full bg-accent text-surface`}
          >
            {isSaving ? '保存中...' : requestLocked ? '同じ内容で再試行' : '保存する'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export default function RoutinesPage(): React.ReactElement {
  const session = useSessionQuery();
  const logoutMutation = useLogoutMutation();
  const navigate = useNavigate();
  const user = session.isError ? undefined : session.data;
  const familiesQuery = useFamiliesQuery(session.isError ? undefined : user?.id);
  const queryClient = useQueryClient();
  const family = familiesQuery.data?.find(
    (item) => item.creationStatus === 'ready' && item.familyCalendarId,
  );
  const currentIdentity = user && family ? `${user.id}:${family.id}` : '';
  const identityRef = useRef('');
  const mountedRef = useRef(false);
  const previousIdentityRef = useRef(currentIdentity);
  identityRef.current = currentIdentity;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const routinesQuery = useQuery({
    queryKey: [...ROUTINE_QUERY_KEY, user?.id, family?.id] as const,
    queryFn: ({ signal }) =>
      family ? fetchRoutines(family.id, signal) : Promise.reject(new Error('Family is required')),
    enabled: Boolean(user?.id && family?.id),
    staleTime: 0,
    retry: false,
  });
  const [dialogEverOpened, setDialogEverOpened] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const deletePendingRef = useRef<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [busyRoutineIds, setBusyRoutineIds] = useState<Set<string>>(() => new Set());
  const busyRoutineIdsRef = useRef(new Set<string>());
  const attemptedAutoSkipsRef = useRef(new Set<string>());
  const retrySettingsRef = useRef<Record<string, RoutineSettingsInput>>({});
  const [autoSkipErrors, setAutoSkipErrors] = useState<Record<string, boolean>>({});
  const [autoApplyingRoutineIds, setAutoApplyingRoutineIds] = useState<Set<string>>(
    () => new Set(),
  );
  useReloadProtection(autoApplyingRoutineIds.size > 0, autoApplyingRoutineIds.size > 0);
  const [loginNavigating, setLoginNavigating] = useState(false);
  const loginNavigationRef = useRef(false);
  useEffect(() => {
    const resetLoginNavigation = () => {
      loginNavigationRef.current = false;
      setLoginNavigating(false);
    };
    window.addEventListener('pageshow', resetLoginNavigation);
    return () => window.removeEventListener('pageshow', resetLoginNavigation);
  }, []);
  useEffect(() => {
    if (previousIdentityRef.current === currentIdentity) return;
    previousIdentityRef.current = currentIdentity;
    setDialogEverOpened(false);
    setDialogOpen(false);
    setDeletingId(null);
    setIsDeleting(false);
    setDeleteError('');
    deletePendingRef.current = null;
    busyRoutineIdsRef.current = new Set();
    setBusyRoutineIds(new Set());
    setAutoSkipErrors({});
    setAutoApplyingRoutineIds(new Set());
    retrySettingsRef.current = {};
  }, [currentIdentity]);
  const openRoutineDialog = () => {
    setDialogEverOpened(true);
    setDialogOpen(true);
  };
  const beginLogin = () => {
    if (loginNavigationRef.current) return;
    loginNavigationRef.current = true;
    setLoginNavigating(true);
    window.location.assign('/api/auth/login');
  };
  const onUnauthorized = useCallback(() => {
    void logoutMutation.mutateAsync().catch(() => undefined);
  }, [logoutMutation.mutateAsync]);

  const setRoutineBusy = useCallback((routineId: string, busy: boolean) => {
    const next = new Set(busyRoutineIdsRef.current);
    if (busy) next.add(routineId);
    else next.delete(routineId);
    busyRoutineIdsRef.current = next;
    setBusyRoutineIds(next);
  }, []);

  const setRoutineAutoApplying = useCallback((routineId: string, applying: boolean) => {
    setAutoApplyingRoutineIds((current) => {
      const next = new Set(current);
      if (applying) next.add(routineId);
      else next.delete(routineId);
      return next;
    });
  }, []);

  const invalidateRoutineViews = useCallback(
    async (userId: string, familyId: string) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...ROUTINE_QUERY_KEY, userId, familyId] }),
        queryClient.invalidateQueries({ queryKey: ['week', userId, familyId] }),
        queryClient.invalidateQueries({ queryKey: ['week-busy', userId, familyId] }),
      ]);
    },
    [queryClient],
  );

  const applyAutoSkips = useCallback(
    async (routineId: string, identity: string) => {
      if (!mountedRef.current || identityRef.current !== identity || !family || !user) return;
      while (mountedRef.current && identityRef.current === identity) {
        const result = await applyRoutineAutoSkips(family.id, routineId);
        if (!mountedRef.current || identityRef.current !== identity) return;
        if (!result.hasMore) return;
      }
    },
    [family, user],
  );

  const handleRoutineSettings = async (
    routineId: string,
    settings: { skipHolidays: boolean; skipNewYear: boolean },
  ) => {
    if (!family || !user || busyRoutineIdsRef.current.has(routineId)) return;
    const identity = `${user.id}:${family.id}`;
    setRoutineBusy(routineId, true);
    setRoutineAutoApplying(routineId, true);
    attemptedAutoSkipsRef.current.add(`${identity}:${routineId}`);
    setAutoSkipErrors((current) => ({ ...current, [routineId]: false }));
    try {
      const firstBatch = await updateRoutineSettings(family.id, routineId, settings);
      if (!mountedRef.current || identityRef.current !== identity) return;
      if (firstBatch.hasMore) await applyAutoSkips(routineId, identity);
      if (!mountedRef.current || identityRef.current !== identity) return;
      delete retrySettingsRef.current[routineId];
      setAutoSkipErrors((current) => ({ ...current, [routineId]: false }));
      await invalidateRoutineViews(user.id, family.id);
    } catch (error: unknown) {
      if (!mountedRef.current || identityRef.current !== identity) return;
      if (error instanceof RoutineApiError && error.status === 401) onUnauthorized();
      setAutoSkipErrors((current) => ({ ...current, [routineId]: true }));
      // Read the saved flags to choose whether retry should save settings or only continue applying.
      try {
        await queryClient.cancelQueries({
          queryKey: [...ROUTINE_QUERY_KEY, user.id, family.id],
        });
        if (!mountedRef.current || identityRef.current !== identity) return;
        const refreshed = await fetchRoutines(family.id);
        if (!mountedRef.current || identityRef.current !== identity) return;
        queryClient.setQueryData([...ROUTINE_QUERY_KEY, user.id, family.id], refreshed);
        const saved = refreshed.routines.find((item) => item.id === routineId);
        if (
          saved?.skipHolidays === settings.skipHolidays &&
          saved.skipNewYear === settings.skipNewYear
        ) {
          delete retrySettingsRef.current[routineId];
        } else {
          retrySettingsRef.current[routineId] = settings;
        }
      } catch {
        if (!mountedRef.current || identityRef.current !== identity) return;
        retrySettingsRef.current[routineId] = settings;
        await queryClient.invalidateQueries({
          queryKey: [...ROUTINE_QUERY_KEY, user.id, family.id],
        });
      }
    } finally {
      if (mountedRef.current && identityRef.current === identity) {
        setRoutineBusy(routineId, false);
        setRoutineAutoApplying(routineId, false);
      }
    }
  };

  const retryAutoSkips = async (routineId: string) => {
    if (!family || !user || busyRoutineIdsRef.current.has(routineId)) return;
    const identity = `${user.id}:${family.id}`;
    setRoutineBusy(routineId, true);
    setRoutineAutoApplying(routineId, true);
    attemptedAutoSkipsRef.current.add(`${identity}:${routineId}`);
    setAutoSkipErrors((current) => ({ ...current, [routineId]: false }));
    try {
      const retrySettings = retrySettingsRef.current[routineId];
      if (retrySettings) {
        const firstBatch = await updateRoutineSettings(family.id, routineId, retrySettings);
        if (!mountedRef.current || identityRef.current !== identity) return;
        if (firstBatch.hasMore) await applyAutoSkips(routineId, identity);
      } else {
        await applyAutoSkips(routineId, identity);
      }
      if (!mountedRef.current || identityRef.current !== identity) return;
      delete retrySettingsRef.current[routineId];
      setAutoSkipErrors((current) => ({ ...current, [routineId]: false }));
      await invalidateRoutineViews(user.id, family.id);
    } catch (error: unknown) {
      if (!mountedRef.current || identityRef.current !== identity) return;
      if (error instanceof RoutineApiError && error.status === 401) onUnauthorized();
      setAutoSkipErrors((current) => ({ ...current, [routineId]: true }));
      const retrySettings = retrySettingsRef.current[routineId];
      if (retrySettings) {
        try {
          await queryClient.cancelQueries({
            queryKey: [...ROUTINE_QUERY_KEY, user.id, family.id],
          });
          if (!mountedRef.current || identityRef.current !== identity) return;
          const refreshed = await fetchRoutines(family.id);
          if (!mountedRef.current || identityRef.current !== identity) return;
          queryClient.setQueryData([...ROUTINE_QUERY_KEY, user.id, family.id], refreshed);
          const saved = refreshed.routines.find((item) => item.id === routineId);
          if (
            saved?.skipHolidays === retrySettings.skipHolidays &&
            saved.skipNewYear === retrySettings.skipNewYear
          ) {
            delete retrySettingsRef.current[routineId];
          }
        } catch {
          if (!mountedRef.current || identityRef.current !== identity) return;
          await queryClient.invalidateQueries({
            queryKey: [...ROUTINE_QUERY_KEY, user.id, family.id],
          });
        }
      }
    } finally {
      if (mountedRef.current && identityRef.current === identity) {
        setRoutineBusy(routineId, false);
        setRoutineAutoApplying(routineId, false);
      }
    }
  };

  useEffect(() => {
    if (!family || !user || !routinesQuery.data || isDeleting || deletePendingRef.current) return;
    const identity = `${user.id}:${family.id}`;
    for (const routine of routinesQuery.data.routines) {
      const attemptKey = `${identity}:${routine.id}`;
      if (
        routine.autoSkipDue &&
        routine.status === 'ready' &&
        !attemptedAutoSkipsRef.current.has(attemptKey) &&
        !busyRoutineIdsRef.current.has(routine.id)
      ) {
        attemptedAutoSkipsRef.current.add(attemptKey);
        setRoutineBusy(routine.id, true);
        setRoutineAutoApplying(routine.id, true);
        void applyAutoSkips(routine.id, identity)
          .then(async () => {
            if (!mountedRef.current || identityRef.current !== identity) return;
            setAutoSkipErrors((current) => ({ ...current, [routine.id]: false }));
            await invalidateRoutineViews(user.id, family.id);
          })
          .catch((error: unknown) => {
            if (!mountedRef.current || identityRef.current !== identity) return;
            if (error instanceof RoutineApiError && error.status === 401) onUnauthorized();
            setAutoSkipErrors((current) => ({ ...current, [routine.id]: true }));
          })
          .finally(() => {
            if (mountedRef.current && identityRef.current === identity) {
              setRoutineBusy(routine.id, false);
              setRoutineAutoApplying(routine.id, false);
            }
          });
      }
    }
  }, [
    applyAutoSkips,
    family,
    invalidateRoutineViews,
    isDeleting,
    onUnauthorized,
    routinesQuery.data,
    setRoutineBusy,
    setRoutineAutoApplying,
    user,
  ]);
  useEffect(() => {
    const unauthorizedError = [familiesQuery.error, routinesQuery.error].some(
      (error) => error instanceof RoutineApiError && error.status === 401,
    );
    if (unauthorizedError) onUnauthorized();
  }, [familiesQuery.error, onUnauthorized, routinesQuery.error]);
  const handleDelete = async (routineId: string) => {
    if (
      !family ||
      !user ||
      deletePendingRef.current !== null ||
      busyRoutineIdsRef.current.has(routineId)
    )
      return;
    const mutationIdentity = `${user.id}:${family.id}`;
    deletePendingRef.current = mutationIdentity;
    setIsDeleting(true);
    setDeleteError('');
    try {
      await deleteRoutine(family.id, routineId);
      if (identityRef.current !== mutationIdentity) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...ROUTINE_QUERY_KEY, user.id, family.id] }),
        queryClient.invalidateQueries({ queryKey: ['week', user.id, family.id] }),
        queryClient.invalidateQueries({ queryKey: ['week-busy', user.id, family.id] }),
      ]);
      if (identityRef.current !== mutationIdentity) return;
      setDeletingId(null);
    } catch (error: unknown) {
      if (identityRef.current !== mutationIdentity) return;
      if (error instanceof RoutineApiError && error.status === 401) onUnauthorized();
      setDeleteError(
        error instanceof RoutineApiError
          ? error.message
          : '繰り返し予定を削除できませんでした。時間をおいて再度お試しください。',
      );
    } finally {
      if (deletePendingRef.current === mutationIdentity) deletePendingRef.current = null;
      if (identityRef.current === mutationIdentity) setIsDeleting(false);
    }
  };

  if (
    session.isLoading ||
    (!session.isError && user && familiesQuery.isLoading && !familiesQuery.data)
  ) {
    return (
      <AuthenticatedShell activeTab="routines" onCapture={() => navigate('/import')}>
        <p aria-live="polite" className="text-sm text-muted">
          読み込み中...
        </p>
      </AuthenticatedShell>
    );
  }
  if (!user)
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-[var(--app-max-width)] flex-col bg-bg px-[var(--spacing-md)] py-[var(--spacing-lg)] text-ink">
        <OAuthNotices />
        <h1 className="m-0 text-2xl font-bold">繰り返し予定</h1>
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
              {loginNavigating ? '移動しています...' : 'Google でログイン'}
            </button>
          </>
        )}
      </main>
    );

  return (
    <AuthenticatedShell
      activeTab="routines"
      onCapture={() => navigate('/import')}
      mainTestId="routines-screen"
    >
      <OAuthNotices />
      <header className="mb-[var(--spacing-lg)] flex items-center justify-between gap-[var(--spacing-sm)]">
        <div className="min-w-0">
          <Link
            to="/"
            className="inline-flex min-h-[var(--tap-target-min)] items-center gap-[var(--spacing-xs)] rounded-[var(--radius-sm)] text-sm text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <ArrowLeft size={18} aria-hidden="true" />
            週に戻る
          </Link>
          <h1 className="mt-[var(--spacing-xs)] mb-0 text-2xl font-bold">繰り返し予定</h1>
        </div>
        <button
          type="button"
          data-testid="routine-add-button"
          onClick={openRoutineDialog}
          disabled={!family}
          className={`${buttonClass} shrink-0 bg-accent text-surface`}
        >
          <Plus size={18} aria-hidden="true" />
          追加
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
                繰り返し予定を使うには、先に家族カレンダーを準備してください。
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
      ) : routinesQuery.isError ? (
        <section
          role="alert"
          className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]"
        >
          <p className="m-0 text-sm">繰り返し予定を読み込めませんでした。</p>
          <button
            type="button"
            onClick={() => void routinesQuery.refetch()}
            className={`${buttonClass} mt-[var(--spacing-sm)] w-full border border-line`}
          >
            <RefreshCw size={16} aria-hidden="true" />
            再試行
          </button>
        </section>
      ) : routinesQuery.isLoading ? (
        <p aria-live="polite" className="text-sm text-muted">
          繰り返し予定を読み込み中...
        </p>
      ) : (routinesQuery.data?.routines.length ?? 0) === 0 ? (
        <section className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-lg)] text-center">
          <div className="mx-auto mb-[var(--spacing-md)] flex h-[var(--icon-size-lg)] w-[var(--icon-size-lg)] items-center justify-center rounded-[var(--radius-full)] bg-chip text-muted">
            <Repeat size={24} aria-hidden="true" />
          </div>
          <h2 className="m-0 text-base font-semibold">毎週の予定を登録できます</h2>
          <p className="mt-[var(--spacing-sm)] mb-0 text-sm leading-relaxed text-muted">
            習い事や家事代行など、繰り返す予定を家族カレンダーに追加します。
          </p>
          <button
            type="button"
            onClick={openRoutineDialog}
            className={`${buttonClass} mt-[var(--spacing-md)] w-full bg-accent text-surface`}
          >
            <Plus size={18} aria-hidden="true" />
            追加
          </button>
        </section>
      ) : (
        <ul data-testid="routine-list" className="m-0 list-none space-y-[var(--spacing-sm)] p-0">
          {routinesQuery.data?.routines.map((routine) => {
            const memberById = new Map(family.members.map((member) => [member.id, member]));
            const selectedMembers = routine.memberIds
              .map((id) => memberById.get(id))
              .filter((member): member is Member => Boolean(member));
            const assignee = routine.assigneeMemberId
              ? memberById.get(routine.assigneeMemberId)
              : undefined;
            const routineRule =
              routine.status === 'ready' &&
              routine.interval !== null &&
              routine.startTime !== null &&
              routine.endTime !== null
                ? formatRoutineRule({
                    weekdays: routine.weekdays,
                    interval: routine.interval,
                    startTime: routine.startTime,
                    endTime: routine.endTime,
                  })
                : routine.status === 'missing'
                  ? 'Google カレンダーで見つかりません'
                  : 'Google カレンダーで繰り返し設定を確認してください';
            return (
              <li
                key={routine.id}
                data-testid="routine-card"
                className="rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]"
              >
                <div className="flex items-start justify-between gap-[var(--spacing-sm)]">
                  <div className="min-w-0">
                    <h2 className="m-0 break-words text-base font-semibold">
                      {routine.title?.trim() || '（タイトルを読み込めませんでした）'}
                    </h2>
                    <p className="mt-[var(--spacing-xs)] mb-0 text-sm text-muted">{routineRule}</p>
                  </div>
                  <span className="shrink-0 rounded-[var(--radius-full)] bg-chip px-[var(--spacing-sm)] py-[var(--spacing-2xs)] text-xs font-medium">
                    {CATEGORY_LABELS[routine.category]}
                  </span>
                </div>
                {selectedMembers.length ? (
                  <div className="mt-[var(--spacing-sm)] flex flex-wrap gap-x-[var(--spacing-md)] gap-y-[var(--spacing-xs)]">
                    {selectedMembers.map((member) => (
                      <MemberDot
                        key={member.id}
                        name={member.name}
                        color={`var(--member-${member.color})`}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="mt-[var(--spacing-sm)] mb-0 text-xs text-muted">家族全員</p>
                )}
                {assignee && (
                  <p className="mt-[var(--spacing-sm)] mb-0 text-sm">担当：{assignee.name}</p>
                )}
                {!routine.affectsAvailability && (
                  <p className="mt-[var(--spacing-sm)] mb-0 text-sm text-muted">
                    家族の空き判定には影響しない
                  </p>
                )}
                {routine.status === 'ready' && (
                  <fieldset
                    disabled={busyRoutineIds.has(routine.id) || isDeleting}
                    className="mt-[var(--spacing-md)] m-0 grid gap-[var(--spacing-xs)] border-0 p-0"
                    aria-label="自動でお休みにする日"
                  >
                    <label className="flex min-h-[var(--tap-target-min)] cursor-pointer items-center gap-[var(--spacing-sm)] rounded-[var(--radius-md)] border border-line px-[var(--spacing-sm)] text-sm">
                      <input
                        type="checkbox"
                        data-testid={`routine-skip-holidays-${routine.id}`}
                        checked={routine.skipHolidays}
                        onChange={(event) =>
                          void handleRoutineSettings(routine.id, {
                            skipHolidays: event.currentTarget.checked,
                            skipNewYear: routine.skipNewYear,
                          })
                        }
                        className="h-5 w-5 shrink-0 accent-[var(--accent)]"
                      />
                      祝日はお休み
                    </label>
                    <label className="flex min-h-[var(--tap-target-min)] cursor-pointer items-center gap-[var(--spacing-sm)] rounded-[var(--radius-md)] border border-line px-[var(--spacing-sm)] text-sm">
                      <input
                        type="checkbox"
                        data-testid={`routine-skip-new-year-${routine.id}`}
                        checked={routine.skipNewYear}
                        onChange={(event) =>
                          void handleRoutineSettings(routine.id, {
                            skipHolidays: routine.skipHolidays,
                            skipNewYear: event.currentTarget.checked,
                          })
                        }
                        className="h-5 w-5 shrink-0 accent-[var(--accent)]"
                      />
                      年末年始はお休み（12/29〜1/3）
                    </label>
                    {autoApplyingRoutineIds.has(routine.id) && (
                      <p
                        data-testid={`routine-auto-skips-pending-${routine.id}`}
                        aria-live="polite"
                        className="m-0 text-xs text-muted"
                      >
                        適用中...
                      </p>
                    )}
                    {autoSkipErrors[routine.id] && !busyRoutineIds.has(routine.id) && (
                      <div className="rounded-[var(--radius-md)] bg-bg p-[var(--spacing-sm)]">
                        <p role="alert" className="m-0 text-xs text-muted">
                          自動のお休みを更新できませんでした。表示中の設定を確認して、もう一度お試しください。
                        </p>
                        <button
                          type="button"
                          data-testid={`routine-auto-skips-retry-${routine.id}`}
                          onClick={() => void retryAutoSkips(routine.id)}
                          className="mt-[var(--spacing-xs)] min-h-[var(--tap-target-min)] px-[var(--spacing-sm)] text-sm underline"
                        >
                          もう一度試す
                        </button>
                      </div>
                    )}
                  </fieldset>
                )}
                {routine.status === 'ready' && (
                  <RoutineInstances
                    key={`${user.id}:${family.id}:${routine.id}`}
                    familyId={family.id}
                    userId={user.id}
                    routineId={routine.id}
                    upcoming={routine.upcoming}
                    isSeriesDeleting={isDeleting}
                    isRoutineBusy={busyRoutineIds.has(routine.id)}
                    isIdentityCurrent={() => identityRef.current === currentIdentity}
                    onUnauthorized={onUnauthorized}
                    onPendingChange={(pending) => {
                      setRoutineBusy(routine.id, pending);
                    }}
                    onChanged={(instance: RoutineInstance) => {
                      const queryKey = [...ROUTINE_QUERY_KEY, user.id, family.id] as const;
                      queryClient.setQueryData<{ routines: Routine[] }>(queryKey, (current) => {
                        if (!current) return current;
                        return {
                          ...current,
                          routines: current.routines.map((item) => {
                            if (item.id !== routine.id || item.upcoming.status !== 'ready')
                              return item;
                            const hasInstance = item.upcoming.instances.some(
                              (row) => row.id === instance.id,
                            );
                            return {
                              ...item,
                              upcoming: {
                                ...item.upcoming,
                                instances: hasInstance
                                  ? item.upcoming.instances.map((row) =>
                                      row.id === instance.id
                                        ? { ...row, ...instance, conflicts: row.conflicts }
                                        : row,
                                    )
                                  : [
                                      ...item.upcoming.instances,
                                      { ...instance, conflicts: [] },
                                    ].slice(-4),
                              },
                            };
                          }),
                        };
                      });
                    }}
                  />
                )}
                {routine.status === 'missing' && (
                  <p className="mt-[var(--spacing-sm)] mb-0 text-sm text-accent">
                    Google カレンダーで見つかりません。予定を削除して登録し直してください。
                  </p>
                )}
                {routine.status === 'unsupported' && (
                  <p className="mt-[var(--spacing-sm)] mb-0 text-sm text-muted">
                    この繰り返し設定は Danran で表示できません。Google
                    カレンダー側で確認してください。
                  </p>
                )}
                {deletingId === routine.id ? (
                  <div className="mt-[var(--spacing-md)] rounded-[var(--radius-md)] border border-line bg-bg p-[var(--spacing-sm)]">
                    <p className="m-0 text-sm">
                      この繰り返し予定を、これまでの回も含めてすべて削除します
                    </p>
                    {deleteError && (
                      <p role="alert" className="mt-[var(--spacing-xs)] mb-0 text-sm text-accent">
                        {deleteError}
                      </p>
                    )}
                    <div className="mt-[var(--spacing-sm)] flex gap-[var(--spacing-sm)]">
                      <button
                        type="button"
                        data-testid={`routine-delete-confirm-${routine.id}`}
                        disabled={isDeleting || busyRoutineIds.has(routine.id)}
                        onClick={() => void handleDelete(routine.id)}
                        className={`${buttonClass} flex-1 bg-accent text-surface`}
                      >
                        {isDeleting ? '削除中...' : 'すべて削除'}
                      </button>
                      <button
                        type="button"
                        data-testid={`routine-delete-cancel-${routine.id}`}
                        disabled={isDeleting || busyRoutineIds.has(routine.id)}
                        onClick={() => {
                          setDeletingId(null);
                          setDeleteError('');
                        }}
                        className={`${buttonClass} flex-1 border border-line bg-surface`}
                      >
                        キャンセル
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-testid={`routine-delete-${routine.id}`}
                    disabled={isDeleting || busyRoutineIds.has(routine.id)}
                    onClick={() => {
                      setDeletingId(routine.id);
                      setDeleteError('');
                    }}
                    className={`${buttonClass} mt-[var(--spacing-md)] w-full border border-line bg-surface text-ink`}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                    削除
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {family && dialogEverOpened && (
        <RoutineDialog
          key={`${user.id}:${family.id}`}
          familyId={family.id}
          userId={user.id}
          members={family.members}
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          onSaved={() => {
            setDialogOpen(false);
            setDialogEverOpened(false);
          }}
          onUnauthorized={onUnauthorized}
          isIdentityCurrent={() => identityRef.current === currentIdentity}
        />
      )}
    </AuthenticatedShell>
  );
}
