import { FamilyApiError } from '@client/api/family';
import {
  createFamilyClosures,
  deleteFamilyClosure,
  fetchFamilyClosures,
  updateFamilyMember,
} from '@client/api/settings';
import {
  FAMILIES_QUERY_KEY,
  MEMBER_COLOR_OPTIONS,
  getColorCssVar,
} from '@client/features/onboarding/useFamily';
import { useReloadProtection } from '@client/features/pwa/useReloadProtection';
import { PersonalCalendarsSettings } from '@client/features/settings/PersonalCalendarsSettings';
import { WEEK_QUERY_KEY } from '@client/features/week/useWeek';
import { expandClosureDateRange } from '@shared/domain/closureRange';
import { dateKeySchema } from '@shared/schemas/date';
import { type FamilyPublic, type MemberColor, memberColorSchema } from '@shared/schemas/family';
import { createClosureRangeInputSchema } from '@shared/schemas/settings';
import { getTodayDateKey } from '@shared/time';
import { formatFullDateLabel } from '@shared/time/format';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCw, Trash2, X } from 'lucide-react';
import type React from 'react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';

type Member = FamilyPublic['members'][number];
type ClosureResponse = Awaited<ReturnType<typeof fetchFamilyClosures>>;
type MemberDraft = { name: string; color: MemberColor };

const panelClass = 'rounded-[var(--radius-lg)] border border-line bg-surface p-[var(--spacing-md)]';
const fieldClass =
  'mt-[var(--spacing-2xs)] min-h-[var(--tap-target-min)] w-full rounded-[var(--radius-md)] border border-line bg-bg px-[var(--spacing-sm)] text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60';
const actionClass =
  'inline-flex min-h-[var(--tap-target-min)] items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] px-[var(--spacing-md)] text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50';

function fixedError(error: unknown, fallback: string): string {
  return error instanceof FamilyApiError ? error.message : fallback;
}

function memberIdTestId(prefix: string, memberId: string): string {
  return `${prefix}-${memberId}`;
}

interface FamilySettingsProps {
  userId: string;
  family: FamilyPublic;
}

export function FamilySettings({ userId, family }: FamilySettingsProps): React.ReactElement {
  const queryClient = useQueryClient();
  const today = getTodayDateKey();
  const [memberDrafts, setMemberDrafts] = useState<Record<string, MemberDraft>>({});
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState('');
  const [label, setLabel] = useState('');
  const [targetMemberIds, setTargetMemberIds] = useState<string[]>([]);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const operationLockRef = useRef(false);

  const closuresQueryKey = ['closures', userId, family.id] as const;
  const closuresQuery = useQuery<ClosureResponse, Error>({
    queryKey: closuresQueryKey,
    queryFn: ({ signal }) => fetchFamilyClosures(family.id, signal),
    enabled: Boolean(userId && family.id),
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const invalidateSettings = async () => {
    await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: [...FAMILIES_QUERY_KEY, userId] }),
      queryClient.invalidateQueries({ queryKey: [...WEEK_QUERY_KEY, userId, family.id] }),
      queryClient.invalidateQueries({ queryKey: closuresQueryKey }),
    ]);
  };

  const updateMemberMutation = useMutation({
    mutationFn: ({ memberId, draft }: { memberId: string; draft: MemberDraft }) =>
      updateFamilyMember(family.id, memberId, draft),
    onSuccess: async (updatedFamily, variables) => {
      queryClient.setQueryData<FamilyPublic[]>([...FAMILIES_QUERY_KEY, userId], (current) =>
        current?.map((item) => (item.id === updatedFamily.id ? updatedFamily : item)),
      );
      const updatedMember = updatedFamily.members.find(
        (member) => member.id === variables.memberId,
      );
      if (updatedMember) {
        setMemberDrafts((current) => {
          const next = { ...current };
          delete next[updatedMember.id];
          return next;
        });
      }
      await invalidateSettings();
    },
  });
  const createClosureMutation = useMutation({
    mutationFn: () =>
      createFamilyClosures(family.id, {
        startDate,
        ...(endDate ? { endDate } : {}),
        label,
        memberIds: targetMemberIds,
      }),
    onSuccess: async () => {
      setStartDate(today);
      setEndDate('');
      setLabel('');
      setTargetMemberIds([]);
      setErrorMessage(null);
      await invalidateSettings();
    },
  });
  const deleteClosureMutation = useMutation({
    mutationFn: (closureId: string) => deleteFamilyClosure(family.id, closureId),
    onSuccess: async () => {
      setDeleteTargetId(null);
      setErrorMessage(null);
      await invalidateSettings();
    },
  });

  const pending =
    updateMemberMutation.isPending ||
    createClosureMutation.isPending ||
    deleteClosureMutation.isPending;
  const membersDirty = family.members.some((member) => {
    const draft = memberDrafts[member.id];
    return draft !== undefined && (draft.name !== member.name || draft.color !== member.color);
  });
  const closureDirty =
    label.length > 0 || endDate.length > 0 || startDate !== today || targetMemberIds.length > 0;
  useReloadProtection(membersDirty || closureDirty || pending, pending);

  const beginOperation = (): boolean => {
    if (operationLockRef.current) return false;
    operationLockRef.current = true;
    return true;
  };
  const releaseOperation = (): void => {
    operationLockRef.current = false;
  };

  const handleMemberSave = async (memberId: string): Promise<void> => {
    if (!beginOperation()) return;
    setErrorMessage(null);
    const draft = memberDrafts[memberId];
    if (!draft) {
      releaseOperation();
      return;
    }
    try {
      await updateMemberMutation.mutateAsync({ memberId, draft });
    } catch (error: unknown) {
      setErrorMessage(
        fixedError(error, 'メンバー情報を保存できませんでした。再度お試しください。'),
      );
    } finally {
      releaseOperation();
    }
  };

  const handleClosureSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!beginOperation()) return;
    setErrorMessage(null);
    const parsed = createClosureRangeInputSchema.safeParse({
      startDate,
      ...(endDate ? { endDate } : {}),
      label,
      memberIds: targetMemberIds,
    });
    if (!parsed.success) {
      setErrorMessage('日付・ラベル・対象を確認してください。期間は31日以内で入力してください。');
      releaseOperation();
      return;
    }
    try {
      expandClosureDateRange(parsed.data.startDate, parsed.data.endDate);
    } catch {
      setErrorMessage('日付・ラベル・対象を確認してください。期間は31日以内で入力してください。');
      releaseOperation();
      return;
    }
    try {
      await createClosureMutation.mutateAsync();
    } catch (error: unknown) {
      setErrorMessage(
        fixedError(error, '休園日を登録できませんでした。入力を確認して再度お試しください。'),
      );
    } finally {
      releaseOperation();
    }
  };

  const handleDeleteClosure = async (closureId: string): Promise<void> => {
    if (!beginOperation()) return;
    setErrorMessage(null);
    try {
      await deleteClosureMutation.mutateAsync(closureId);
    } catch (error: unknown) {
      setErrorMessage(fixedError(error, '休園日を削除できませんでした。再度お試しください。'));
    } finally {
      releaseOperation();
    }
  };

  const colorUsers = new Map<MemberColor, Array<{ id: string; name: string }>>();
  for (const member of family.members) {
    const draft = memberDrafts[member.id];
    const draftColor = draft?.color ?? member.color;
    const names = colorUsers.get(draftColor) ?? [];
    names.push({ id: member.id, name: draft?.name ?? member.name });
    colorUsers.set(draftColor, names);
  }

  const toggleTargetMember = (memberId: string): void => {
    setTargetMemberIds((current) =>
      current.includes(memberId) ? current.filter((id) => id !== memberId) : [...current, memberId],
    );
  };

  const saveMemberDraft = (member: Member, draft: MemberDraft): void => {
    setMemberDrafts((current) => {
      const next = { ...current };
      if (draft.name === member.name && draft.color === member.color) {
        delete next[member.id];
      } else {
        next[member.id] = draft;
      }
      return next;
    });
  };

  return (
    <div
      className="mt-[var(--spacing-lg)] space-y-[var(--spacing-lg)]"
      data-testid="family-settings"
    >
      {errorMessage && (
        <p role="alert" data-testid="settings-error" className="m-0 text-sm text-accent">
          {errorMessage}
        </p>
      )}
      <section className={panelClass} data-testid="member-settings">
        <h2 className="m-0 text-base font-semibold">メンバー</h2>
        <p className="mt-[var(--spacing-xs)] mb-0 text-xs leading-relaxed text-muted">
          表示名と色は週ビューにも反映されます。色は複数のメンバーで使えます。
        </p>
        <div className="mt-[var(--spacing-md)] space-y-[var(--spacing-md)]">
          {family.members.map((member) => {
            const draft = memberDrafts[member.id] ?? { name: member.name, color: member.color };
            const namesUsingColor = colorUsers.get(draft.color) ?? [];
            const draftIsDirty =
              memberDrafts[member.id] !== undefined &&
              (draft.name !== member.name || draft.color !== member.color);
            return (
              <form
                key={member.id}
                data-testid={`member-row-${member.id}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleMemberSave(member.id);
                }}
                className="rounded-[var(--radius-md)] border border-line p-[var(--spacing-sm)]"
              >
                <p className="m-0 text-xs font-semibold text-muted">
                  {member.kind === 'adult' ? '大人' : '子ども'}
                </p>
                <label
                  className="mt-[var(--spacing-sm)] block text-sm font-medium"
                  htmlFor={`member-name-${member.id}`}
                >
                  表示名（{member.name}）
                </label>
                <input
                  id={`member-name-${member.id}`}
                  data-testid={memberIdTestId('member-name', member.id)}
                  className={fieldClass}
                  type="text"
                  value={draft.name}
                  maxLength={80}
                  disabled={pending}
                  onChange={(event) => {
                    const name = event.currentTarget.value;
                    saveMemberDraft(member, { ...draft, name });
                  }}
                />
                <label
                  className="mt-[var(--spacing-sm)] block text-sm font-medium"
                  htmlFor={`member-color-${member.id}`}
                >
                  色（{member.name}）
                </label>
                <div className="mt-[var(--spacing-2xs)] flex items-center gap-[var(--spacing-sm)]">
                  <span
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 rounded-full border border-line"
                    style={{ backgroundColor: getColorCssVar(draft.color) }}
                  />
                  <select
                    id={`member-color-${member.id}`}
                    data-testid={memberIdTestId('member-color', member.id)}
                    className={`${fieldClass} mt-0 min-w-0 flex-1`}
                    value={draft.color}
                    disabled={pending}
                    onChange={(event) => {
                      const parsed = memberColorSchema.safeParse(event.currentTarget.value);
                      if (parsed.success) {
                        saveMemberDraft(member, { ...draft, color: parsed.data });
                      }
                    }}
                  >
                    {MEMBER_COLOR_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                        {colorUsers.get(option.value)?.some((item) => item.id !== member.id)
                          ? `（使用中：${colorUsers
                              .get(option.value)
                              ?.filter((item) => item.id !== member.id)
                              .map((item) => item.name)
                              .join('、')}）`
                          : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="mt-[var(--spacing-xs)] mb-0 text-xs text-muted">
                  {namesUsingColor.length > 0
                    ? `この色を使用中：${namesUsingColor.map((item) => item.name).join('、')}`
                    : 'この色は未使用です。'}
                </p>
                <button
                  type="submit"
                  data-testid={memberIdTestId('save-member', member.id)}
                  disabled={pending || !draftIsDirty}
                  className={`${actionClass} mt-[var(--spacing-sm)] w-full bg-accent text-surface hover:opacity-90`}
                >
                  <Check size={16} aria-hidden="true" />
                  保存
                </button>
              </form>
            );
          })}
        </div>
      </section>

      <PersonalCalendarsSettings userId={userId} familyId={family.id} />

      <section className={panelClass} data-testid="closure-settings">
        <h2 className="m-0 text-base font-semibold">休園日</h2>
        <p className="mt-[var(--spacing-xs)] mb-0 text-xs leading-relaxed text-muted">
          登録した日は週ビューで週末カードとして表示されます。対象を選ばない場合は家族全員が対象です。
        </p>

        {closuresQuery.isLoading ? (
          <p aria-live="polite" className="mt-[var(--spacing-md)] mb-0 text-sm text-muted">
            休園日を読み込み中...
          </p>
        ) : closuresQuery.isError ? (
          <div
            role="alert"
            className="mt-[var(--spacing-md)] rounded-[var(--radius-md)] border border-line p-[var(--spacing-sm)]"
          >
            <p className="m-0 text-sm">休園日を読み込めませんでした。</p>
            <button
              type="button"
              data-testid="retry-closures"
              onClick={() => void closuresQuery.refetch()}
              className={`${actionClass} mt-[var(--spacing-xs)] border border-line text-ink hover:bg-chip`}
            >
              <RefreshCw size={16} aria-hidden="true" />
              再試行
            </button>
          </div>
        ) : (closuresQuery.data?.closures.length ?? 0) === 0 ? (
          <p className="mt-[var(--spacing-md)] mb-0 text-sm text-muted">
            登録済みの休園日はありません。
          </p>
        ) : (
          <>
            <ul
              aria-label="休園日の一覧"
              className="mt-[var(--spacing-md)] mb-0 space-y-[var(--spacing-sm)] p-0 list-none"
            >
              {closuresQuery.data?.closures.map((closure) => {
                const targetNames = closure.memberIds
                  .map((id) => family.members.find((member) => member.id === id)?.name)
                  .filter((name): name is string => name !== undefined);
                return (
                  <li
                    key={closure.id}
                    data-testid={`closure-row-${closure.id}`}
                    className="rounded-[var(--radius-md)] border border-line p-[var(--spacing-sm)]"
                  >
                    <p className="m-0 text-sm font-semibold">{formatFullDateLabel(closure.date)}</p>
                    <p className="mt-[var(--spacing-2xs)] mb-0 break-words text-sm [overflow-wrap:anywhere]">
                      {closure.label}
                    </p>
                    <p className="mt-[var(--spacing-2xs)] mb-0 text-xs text-muted">
                      対象：
                      {closure.memberIds.length === 0
                        ? '家族全員'
                        : [
                            ...targetNames,
                            ...(targetNames.length < closure.memberIds.length ? ['対象不明'] : []),
                          ].join('、')}
                    </p>
                    {deleteTargetId === closure.id ? (
                      <fieldset
                        aria-label={`${closure.label}の削除確認`}
                        className="mt-[var(--spacing-sm)] rounded-[var(--radius-sm)] bg-chip p-[var(--spacing-sm)]"
                      >
                        <p className="m-0 text-sm">この休園日を削除しますか？</p>
                        <div className="mt-[var(--spacing-xs)] flex gap-[var(--spacing-sm)]">
                          <button
                            type="button"
                            data-testid={`confirm-delete-closure-${closure.id}`}
                            disabled={pending}
                            onClick={() => void handleDeleteClosure(closure.id)}
                            className={`${actionClass} flex-1 bg-accent text-surface`}
                          >
                            <Trash2 size={16} aria-hidden="true" />
                            削除を確定
                          </button>
                          <button
                            type="button"
                            data-testid={`cancel-delete-closure-${closure.id}`}
                            disabled={pending}
                            onClick={() => setDeleteTargetId(null)}
                            className={`${actionClass} border border-line text-ink hover:bg-surface`}
                          >
                            <X size={16} aria-hidden="true" />
                            戻る
                          </button>
                        </div>
                      </fieldset>
                    ) : (
                      <button
                        type="button"
                        data-testid={`delete-closure-${closure.id}`}
                        aria-label={`${closure.label}を削除`}
                        disabled={pending}
                        onClick={() => setDeleteTargetId(closure.id)}
                        className={`${actionClass} mt-[var(--spacing-sm)] w-full border border-line text-ink hover:bg-chip`}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                        削除
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {closuresQuery.data?.hasMore && (
              <p className="mt-[var(--spacing-sm)] mb-0 text-xs text-muted">
                休園日は最大200件まで表示しています。
              </p>
            )}
          </>
        )}

        <form
          data-testid="closure-form"
          onSubmit={(event) => void handleClosureSubmit(event)}
          className="mt-[var(--spacing-lg)] border-t border-line pt-[var(--spacing-md)]"
        >
          <h3 className="m-0 text-sm font-semibold">休園日を追加</h3>
          <label
            className="mt-[var(--spacing-sm)] block text-sm font-medium"
            htmlFor="closure-start-date"
          >
            開始日
          </label>
          <input
            id="closure-start-date"
            data-testid="closure-start-date"
            className={fieldClass}
            type="date"
            value={startDate}
            min="1970-01-01"
            max="2050-12-31"
            disabled={pending}
            onChange={(event) => {
              const parsed = dateKeySchema.safeParse(event.currentTarget.value);
              if (parsed.success) setStartDate(parsed.data);
            }}
          />
          <label
            className="mt-[var(--spacing-sm)] block text-sm font-medium"
            htmlFor="closure-end-date"
          >
            終了日（1日の場合は省略できます）
          </label>
          <input
            id="closure-end-date"
            data-testid="closure-end-date"
            className={fieldClass}
            type="date"
            value={endDate}
            min="1970-01-01"
            max="2050-12-31"
            disabled={pending}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === '' || dateKeySchema.safeParse(value).success) setEndDate(value);
            }}
          />
          <label
            className="mt-[var(--spacing-sm)] block text-sm font-medium"
            htmlFor="closure-label"
          >
            ラベル
          </label>
          <input
            id="closure-label"
            data-testid="closure-label"
            className={fieldClass}
            type="text"
            value={label}
            maxLength={40}
            autoComplete="off"
            disabled={pending}
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
          <fieldset disabled={pending} className="mt-[var(--spacing-md)] min-w-0 border-0 p-0">
            <legend className="text-sm font-medium">対象メンバー</legend>
            <p className="mt-[var(--spacing-2xs)] mb-0 text-xs text-muted">
              選択なしは家族全員です。
            </p>
            <div className="mt-[var(--spacing-xs)] space-y-[var(--spacing-2xs)]">
              {family.members.map((member) => (
                <label
                  key={member.id}
                  htmlFor={`closure-member-${member.id}`}
                  className="flex min-h-[var(--tap-target-min)] items-center gap-[var(--spacing-sm)] rounded-[var(--radius-sm)] px-[var(--spacing-xs)] text-sm hover:bg-chip"
                >
                  <input
                    id={`closure-member-${member.id}`}
                    data-testid={`closure-member-${member.id}`}
                    type="checkbox"
                    checked={targetMemberIds.includes(member.id)}
                    onChange={() => toggleTargetMember(member.id)}
                    className="h-5 w-5 accent-accent"
                  />
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 rounded-full border border-line"
                    style={{ backgroundColor: getColorCssVar(member.color) }}
                  />
                  {member.name}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="submit"
            data-testid="add-closure"
            disabled={pending || label.trim().length === 0}
            className={`${actionClass} mt-[var(--spacing-md)] w-full bg-accent text-surface hover:opacity-90`}
          >
            休園日を追加
          </button>
        </form>
      </section>

      <section className={panelClass}>
        <h2 className="m-0 text-base font-semibold">家族の設定</h2>
        <p className="mt-[var(--spacing-xs)] mb-0 text-xs leading-relaxed text-muted">
          家族の作成や招待の設定を変更できます。
        </p>
        <Link
          data-testid="onboarding-link"
          to="/onboarding"
          className={`${actionClass} mt-[var(--spacing-md)] w-full border border-line text-ink hover:bg-chip`}
        >
          家族の設定
        </Link>
      </section>
    </div>
  );
}
