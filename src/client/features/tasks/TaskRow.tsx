import { MemberDot } from '@client/components/MemberDot';
import { getTaskDueLabel } from '@shared/domain/taskPresentation';
import type { FamilyPublic } from '@shared/schemas/family';
import type { Task } from '@shared/schemas/tasks';
import { toTokyoDateKey } from '@shared/time/date';
import { formatShortDate, formatWeekday } from '@shared/time/format';
import type React from 'react';
import { useState } from 'react';

type Member = FamilyPublic['members'][number];

function taskSourceLabel(source: Task['source']): string | null {
  if (source === 'items') return '持ち物から自動';
  if (source === 'import') return 'プリントから';
  if (source === 'conflict') return '繰り返し予定の重複から';
  return null;
}

function linkedEventCaption(task: Task): string | null {
  if (task.linkedEvent.state !== 'ready') return null;
  const date =
    task.linkedEvent.time.kind === 'all-day'
      ? task.linkedEvent.time.start
      : toTokyoDateKey(task.linkedEvent.time.start);
  return `${task.linkedEvent.title} · ${formatShortDate(date)}（${formatWeekday(date)}）`;
}

export function TaskRow({
  task,
  members,
  now,
  busy,
  disableEdit = false,
  mutationError,
  showLinkedEvent = false,
  onToggleDone,
  onAssignee,
  onEdit,
}: {
  task: Task;
  members: Member[];
  now: Date | number;
  busy: boolean;
  disableEdit?: boolean;
  mutationError?: string;
  showLinkedEvent?: boolean;
  onToggleDone: (done: boolean) => Promise<boolean>;
  onAssignee: (assigneeMemberId: string | null) => Promise<boolean>;
  onEdit: (task: Task) => void;
}): React.ReactElement {
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const assignee = members.find((member) => member.id === task.assigneeMemberId);
  const adults = members.filter((member) => member.kind === 'adult');
  const due = getTaskDueLabel(task, now);
  const source = taskSourceLabel(task.source);
  const items =
    task.source === 'items' && task.linkedEvent.state === 'ready'
      ? task.linkedEvent.items.join('、')
      : '';
  const hasDone = task.doneAt !== null;

  const toggleDone = async (done: boolean) => {
    await onToggleDone(done);
  };

  const chooseAssignee = async (memberId: string | null) => {
    setAssigneeOpen(false);
    await onAssignee(memberId);
  };

  return (
    <li className="min-w-0 border-t border-line py-[var(--spacing-sm)] first:border-t-0">
      <div className="flex min-w-0 items-start gap-[var(--spacing-xs)]">
        <label className="flex min-h-[var(--tap-target-min)] min-w-[var(--tap-target-min)] shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] focus-within:ring-2 focus-within:ring-focus">
          <input
            type="checkbox"
            aria-label={`${task.title}を${hasDone ? '未完了に戻す' : '完了にする'}`}
            checked={hasDone}
            disabled={busy}
            onChange={(event) => void toggleDone(event.currentTarget.checked)}
            className="h-5 w-5 accent-[var(--accent)] disabled:opacity-50"
          />
        </label>
        <div className="min-w-0 flex-1 pt-[var(--spacing-xs)]">
          <div className="flex min-w-0 items-start gap-[var(--spacing-xs)]">
            {task.source === 'manual' ? (
              <button
                type="button"
                data-testid={`task-edit-${task.id}`}
                onClick={() => onEdit(task)}
                disabled={busy || disableEdit}
                className={`min-h-[var(--tap-target-min)] min-w-0 flex-1 text-left text-sm font-medium [overflow-wrap:anywhere] underline decoration-transparent underline-offset-2 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${hasDone ? 'text-muted line-through' : 'text-ink'}`}
              >
                {task.title}
              </button>
            ) : (
              <span
                className={`min-h-[var(--tap-target-min)] min-w-0 flex-1 pt-[var(--spacing-sm)] text-sm font-medium [overflow-wrap:anywhere] ${hasDone ? 'text-muted line-through' : 'text-ink'}`}
              >
                {task.title}
              </span>
            )}
            {hasDone && (
              <span className="shrink-0 pt-[var(--spacing-sm)] text-xs text-muted">済</span>
            )}
          </div>
          <div className="mt-[var(--spacing-2xs)] flex min-w-0 flex-wrap items-center gap-x-[var(--spacing-xs)] gap-y-[var(--spacing-2xs)] text-xs">
            {due.label && (
              <span className={due.urgency ? 'font-semibold text-deadline' : 'text-muted'}>
                {due.label}
              </span>
            )}
            {due.label && source && (
              <span className="text-muted" aria-hidden="true">
                ·
              </span>
            )}
            {source && <span className="text-muted">{source}</span>}
            {items && <span className="min-w-0 break-words text-muted">{items}</span>}
          </div>
          {showLinkedEvent && linkedEventCaption(task) && (
            <p className="mt-[var(--spacing-2xs)] mb-0 break-words text-xs text-muted">
              {linkedEventCaption(task)}
            </p>
          )}
          {mutationError && (
            <p role="alert" className="mt-[var(--spacing-xs)] mb-0 text-xs text-accent">
              {mutationError}
            </p>
          )}
          {assigneeOpen && (
            <fieldset
              disabled={busy}
              aria-label="担当を選択"
              className="mt-[var(--spacing-xs)] grid grid-cols-2 gap-[var(--spacing-xs)] rounded-[var(--radius-md)] border border-line bg-bg p-[var(--spacing-xs)]"
            >
              <legend className="sr-only">担当を選択</legend>
              <button
                type="button"
                onClick={() => void chooseAssignee(null)}
                className="min-h-[var(--tap-target-min)] rounded-[var(--radius-sm)] border border-dashed border-line bg-surface px-[var(--spacing-xs)] text-xs"
              >
                担当なし
              </button>
              {adults.map((member) => (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => void chooseAssignee(member.id)}
                  className="flex min-h-[var(--tap-target-min)] min-w-0 items-center justify-center rounded-[var(--radius-sm)] border border-line bg-surface px-[var(--spacing-xs)]"
                >
                  <MemberDot name={member.name} color={`var(--member-${member.color})`} />
                </button>
              ))}
            </fieldset>
          )}
        </div>
        <button
          type="button"
          data-testid={`task-assignee-${task.id}`}
          aria-label={assignee ? `担当を変更: ${assignee.name}` : '担当を決める'}
          aria-expanded={assigneeOpen}
          disabled={busy}
          onClick={() => setAssigneeOpen((open) => !open)}
          className={`mt-[var(--spacing-xs)] inline-flex min-h-[var(--tap-target-min)] min-w-[var(--tap-target-min)] max-w-[7rem] shrink-0 items-center justify-center rounded-[var(--radius-md)] px-[var(--spacing-xs)] text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 ${assignee ? 'border border-line bg-chip' : 'border border-dashed border-muted bg-transparent text-muted'}`}
        >
          {assignee ? (
            <MemberDot name={assignee.name} color={`var(--member-${assignee.color})`} />
          ) : (
            '担当'
          )}
        </button>
      </div>
    </li>
  );
}
