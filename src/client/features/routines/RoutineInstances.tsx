import { RoutineApiError, updateRoutineInstance } from '@client/api/routines';
import { useReloadProtection } from '@client/features/pwa/useReloadProtection';
import { formatRoutineInstanceChip } from '@shared/domain/routineInstances';
import type { RoutineInstance, RoutineUpcoming } from '@shared/schemas/routines';
import { toTokyoDateKey, toTokyoIsoString } from '@shared/time';
import { useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { useRef, useState } from 'react';

const buttonBaseClass =
  'inline-flex min-h-[var(--tap-target-min)] items-center justify-center gap-[var(--spacing-xs)] rounded-[var(--radius-md)] border px-[var(--spacing-sm)] text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButtonClass = `${buttonBaseClass} border-line bg-surface text-ink`;
const primaryButtonClass = `${buttonBaseClass} border-accent bg-accent text-surface`;
const fieldClass =
  'mt-[var(--spacing-2xs)] min-h-[var(--tap-target-min)] w-full rounded-[var(--radius-md)] border border-line bg-surface px-[var(--spacing-sm)] text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
const OPERATION_ERROR = '変更を保存できませんでした。時間をおいて再度お試しください。';

function timeLabel(instant: string): string {
  return toTokyoIsoString(instant).slice(11, 16);
}

function initialMoveValue(instance: RoutineInstance): {
  date: string;
  startTime: string;
  endTime: string;
} {
  return {
    date: toTokyoDateKey(instance.originalStart),
    startTime: timeLabel(instance.originalStart),
    endTime: timeLabel(instance.originalEnd),
  };
}

export function RoutineInstances({
  familyId,
  userId,
  routineId,
  upcoming,
  isIdentityCurrent,
  onUnauthorized,
  onChanged,
  onPendingChange,
  isSeriesDeleting,
}: {
  familyId: string;
  userId: string;
  routineId: string;
  upcoming: RoutineUpcoming;
  isIdentityCurrent: () => boolean;
  onUnauthorized: () => void;
  onChanged: (instance: RoutineInstance) => void;
  onPendingChange: (pending: boolean) => void;
  isSeriesDeleting: boolean;
}): React.ReactElement | null {
  const pendingRef = useRef(false);
  const [selected, setSelected] = useState<RoutineInstance | null>(null);
  const [moveFormOpen, setMoveFormOpen] = useState(false);
  const [moveValue, setMoveValue] = useState({ date: '', startTime: '', endTime: '' });
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();
  const controlsDisabled = pending || isSeriesDeleting;
  useReloadProtection((moveFormOpen && dirty) || pending, pending);

  async function perform(action: 'skip' | 'restore' | 'move') {
    if (!selected || pendingRef.current || isSeriesDeleting) return;
    if (
      action === 'move' &&
      (!moveValue.date ||
        !moveValue.startTime ||
        !moveValue.endTime ||
        moveValue.endTime <= moveValue.startTime)
    ) {
      setError('日付と時刻を確認してください。');
      return;
    }
    const identity = `${userId}:${familyId}`;
    pendingRef.current = true;
    setPending(true);
    onPendingChange(true);
    setError('');
    try {
      const response = await updateRoutineInstance(
        familyId,
        routineId,
        selected.id,
        action,
        action === 'move' ? moveValue : undefined,
      );
      if (!isIdentityCurrent() || identity !== `${userId}:${familyId}`) return;
      await queryClient.cancelQueries({ queryKey: ['routines', userId, familyId] });
      if (!isIdentityCurrent()) return;
      onChanged(response.instance);
      setSelected(null);
      setMoveFormOpen(false);
      setDirty(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['week', userId, familyId] }),
        queryClient.invalidateQueries({ queryKey: ['week-busy', userId, familyId] }),
      ]);
    } catch (cause: unknown) {
      if (!isIdentityCurrent()) return;
      if (cause instanceof RoutineApiError && cause.status === 401) onUnauthorized();
      setError(OPERATION_ERROR);
    } finally {
      pendingRef.current = false;
      if (isIdentityCurrent()) {
        setPending(false);
        onPendingChange(false);
      }
    }
  }

  if (upcoming.status === 'unavailable') {
    return (
      <p className="mt-[var(--spacing-md)] mb-0 text-sm text-muted">
        直近の回を取得できませんでした。
        <button
          type="button"
          className="ml-[var(--spacing-xs)] min-h-[var(--tap-target-min)] min-w-[var(--tap-target-min)] underline"
          onClick={() =>
            void queryClient.invalidateQueries({ queryKey: ['routines', userId, familyId] })
          }
        >
          再試行
        </button>
      </p>
    );
  }
  if (!upcoming.instances.length) return null;

  return (
    <section
      className="mt-[var(--spacing-md)] border-t border-line pt-[var(--spacing-sm)]"
      aria-label="直近の予定"
    >
      <p className="mb-[var(--spacing-xs)] mt-0 text-xs font-semibold text-muted">直近の回</p>
      <div className="flex flex-wrap gap-[var(--spacing-xs)]">
        {upcoming.instances.map((instance) => (
          <button
            key={instance.id}
            type="button"
            data-testid={`routine-instance-chip-${instance.id}`}
            aria-pressed={selected?.id === instance.id}
            disabled={controlsDisabled}
            onClick={() => {
              setSelected(selected?.id === instance.id ? null : instance);
              setMoveFormOpen(false);
              setDirty(false);
              setError('');
            }}
            className={`${buttonBaseClass} ${selected?.id === instance.id ? 'border-focus ring-1 ring-focus' : 'border-line'} bg-surface text-ink max-w-full text-left`}
          >
            <span className={instance.status === 'skipped' ? 'line-through decoration-2' : ''}>
              {formatRoutineInstanceChip(instance)}
            </span>
          </button>
        ))}
      </div>
      {selected && (
        <div
          data-testid={`routine-instance-actions-${selected.id}`}
          className="mt-[var(--spacing-sm)] rounded-[var(--radius-md)] border border-line bg-bg p-[var(--spacing-sm)]"
        >
          <p className="m-0 text-sm font-semibold">{formatRoutineInstanceChip(selected)}</p>
          {error && (
            <p role="alert" className="mt-[var(--spacing-xs)] mb-0 text-sm text-accent">
              {error}
            </p>
          )}
          {moveFormOpen ? (
            <form
              className="mt-[var(--spacing-sm)] space-y-[var(--spacing-sm)]"
              onSubmit={(event) => {
                event.preventDefault();
                void perform('move');
              }}
            >
              <div>
                <label
                  htmlFor={`routine-instance-date-${selected.id}`}
                  className="block text-sm font-semibold"
                >
                  日付
                </label>
                <input
                  id={`routine-instance-date-${selected.id}`}
                  data-testid="routine-instance-move-date"
                  type="date"
                  required
                  disabled={controlsDisabled}
                  value={moveValue.date}
                  onChange={(event) => {
                    setMoveValue({ ...moveValue, date: event.currentTarget.value });
                    setDirty(true);
                  }}
                  className={fieldClass}
                />
              </div>
              <div className="grid grid-cols-2 gap-[var(--spacing-sm)]">
                <div>
                  <label
                    htmlFor={`routine-instance-start-${selected.id}`}
                    className="block text-sm font-semibold"
                  >
                    開始
                  </label>
                  <input
                    id={`routine-instance-start-${selected.id}`}
                    data-testid="routine-instance-move-start"
                    type="time"
                    required
                    disabled={controlsDisabled}
                    value={moveValue.startTime}
                    onChange={(event) => {
                      setMoveValue({ ...moveValue, startTime: event.currentTarget.value });
                      setDirty(true);
                    }}
                    className={fieldClass}
                  />
                </div>
                <div>
                  <label
                    htmlFor={`routine-instance-end-${selected.id}`}
                    className="block text-sm font-semibold"
                  >
                    終了
                  </label>
                  <input
                    id={`routine-instance-end-${selected.id}`}
                    data-testid="routine-instance-move-end"
                    type="time"
                    required
                    disabled={controlsDisabled}
                    value={moveValue.endTime}
                    onChange={(event) => {
                      setMoveValue({ ...moveValue, endTime: event.currentTarget.value });
                      setDirty(true);
                    }}
                    className={fieldClass}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-[var(--spacing-sm)]">
                <button
                  type="submit"
                  data-testid="routine-instance-move-save"
                  disabled={controlsDisabled}
                  className={primaryButtonClass}
                >
                  {pending ? '保存中...' : '保存'}
                </button>
                <button
                  type="button"
                  data-testid="routine-instance-move-cancel"
                  disabled={controlsDisabled}
                  onClick={() => {
                    setMoveFormOpen(false);
                    setDirty(false);
                    setError('');
                  }}
                  className={secondaryButtonClass}
                >
                  やめる
                </button>
              </div>
            </form>
          ) : (
            <div className="mt-[var(--spacing-sm)] grid grid-cols-1 gap-[var(--spacing-xs)]">
              {selected.status === 'normal' && (
                <button
                  type="button"
                  data-testid="routine-instance-skip"
                  disabled={controlsDisabled}
                  onClick={() => void perform('skip')}
                  className={secondaryButtonClass}
                >
                  この回を休む
                </button>
              )}
              {selected.status === 'skipped' && (
                <button
                  type="button"
                  data-testid="routine-instance-restore"
                  disabled={controlsDisabled}
                  onClick={() => void perform('restore')}
                  className={secondaryButtonClass}
                >
                  休みを取り消す
                </button>
              )}
              {selected.status === 'moved' && (
                <button
                  type="button"
                  data-testid="routine-instance-restore"
                  disabled={controlsDisabled}
                  onClick={() => void perform('restore')}
                  className={secondaryButtonClass}
                >
                  振替を取り消す（元の日時に戻す）
                </button>
              )}
              <button
                type="button"
                data-testid={
                  selected.status === 'moved'
                    ? 'routine-instance-change-move'
                    : 'routine-instance-set-move'
                }
                disabled={controlsDisabled}
                onClick={() => {
                  setMoveValue(initialMoveValue(selected));
                  setMoveFormOpen(true);
                  setDirty(false);
                  setError('');
                }}
                className={secondaryButtonClass}
              >
                {selected.status === 'moved' ? '振替先を変える' : '振替を設定'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
