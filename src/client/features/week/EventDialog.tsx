import { EventApiError, createEvent, deleteEvent, updateEvent } from '@client/api/events';
import { MemberDot } from '@client/components/MemberDot';
import { useReloadProtection } from '@client/features/pwa/useReloadProtection';
import { dateKeySchema } from '@shared/schemas/date';
import {
  type CreateEventInput,
  type EventInput,
  type EventInputTime,
  createEventInputSchema,
  eventInputSchema,
} from '@shared/schemas/events';
import type { WeekEvent, WeekResponse } from '@shared/schemas/week';
import {
  exclusiveEndToInclusive,
  getDefaultEventTime,
  inclusiveEndToExclusive,
  toTokyoDateTimeInputValues,
} from '@shared/time';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';

type WeekMember = WeekResponse['members'][number];

function toItemFields(items: string[]): Array<{ key: string; value: string }> {
  return items.length
    ? items.map((value) => ({ key: crypto.randomUUID(), value }))
    : [{ key: crypto.randomUUID(), value: '' }];
}

interface EventDialogProps {
  familyId: string;
  userId: string;
  members: WeekMember[];
  event?: WeekEvent;
  selectedDate?: string;
  clientRequestId: string;
  onClose: () => void;
  onSaved: () => void;
  onUnauthorized: () => void;
}

function initialFields(event: WeekEvent | undefined, selectedDate: string | undefined) {
  if (!event) {
    const initial = getDefaultEventTime(
      selectedDate ? dateKeySchema.parse(selectedDate) : undefined,
    );
    if (initial.kind !== 'timed') throw new Error('Default event time must be timed');
    return {
      title: '',
      allDay: false,
      startDate: toTokyoDateTimeInputValues(initial.start).date,
      endDate: toTokyoDateTimeInputValues(initial.endExclusive).date,
      startTime: toTokyoDateTimeInputValues(initial.start).time,
      endTime: toTokyoDateTimeInputValues(initial.endExclusive).time,
      memberIds: [] as string[],
      assigneeMemberId: '',
      items: toItemFields([]),
      status: 'confirmed' as const,
    };
  }
  if (event.time.kind === 'all-day') {
    return {
      title: event.title,
      allDay: true,
      startDate: event.time.start,
      endDate: exclusiveEndToInclusive(event.time.endExclusive),
      startTime: '09:00',
      endTime: '10:00',
      memberIds: event.memberIds,
      assigneeMemberId: event.assigneeMemberId ?? '',
      items: toItemFields(event.items),
      status: event.status,
    };
  }
  return {
    title: event.title,
    allDay: false,
    startDate: toTokyoDateTimeInputValues(event.time.start).date,
    endDate: toTokyoDateTimeInputValues(event.time.endExclusive).date,
    startTime: toTokyoDateTimeInputValues(event.time.start).time,
    endTime: toTokyoDateTimeInputValues(event.time.endExclusive).time,
    memberIds: event.memberIds,
    assigneeMemberId: event.assigneeMemberId ?? '',
    items: toItemFields(event.items),
    status: event.status,
  };
}

function fixedErrorMessage(error: unknown): string {
  if (error instanceof EventApiError) return error.message;
  return '予定を保存できませんでした。通信状態を確認して、もう一度お試しください。';
}

const fieldClass =
  'mt-[var(--spacing-xs)] min-h-[var(--tap-target-min)] w-full rounded-[var(--radius-md)] border border-line bg-surface px-[var(--spacing-sm)] text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
const buttonClass =
  'inline-flex min-h-[var(--tap-target-min)] items-center justify-center rounded-[var(--radius-md)] px-[var(--spacing-md)] text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50';

export function EventDialog({
  familyId,
  userId,
  members,
  event,
  selectedDate,
  clientRequestId,
  onClose,
  onSaved,
  onUnauthorized,
}: EventDialogProps): React.ReactElement {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const createInputRef = useRef<CreateEventInput | null>(null);
  const createdEventIdRef = useRef<string | null>(null);
  const historyEntryRef = useRef(false);
  const cleanupMarkerTimerRef = useRef<number | undefined>(undefined);
  const [fields, setFields] = useState(() => initialFields(event, selectedDate));
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useReloadProtection(true, isSaving || isDeleting);

  useEffect(() => {
    if (cleanupMarkerTimerRef.current !== undefined) {
      window.clearTimeout(cleanupMarkerTimerRef.current);
      cleanupMarkerTimerRef.current = undefined;
    }
    const dialog = dialogRef.current;
    if (!dialog) return;
    const marker = `event-dialog-${clientRequestId}`;
    dialog.showModal();
    if (window.history.state?.danranEventDialog !== marker) {
      window.history.pushState({ ...(window.history.state ?? {}), danranEventDialog: marker }, '');
      historyEntryRef.current = true;
    }
    window.setTimeout(() => titleRef.current?.focus(), 0);

    const handlePopState = () => {
      if (pendingRef.current) {
        window.history.pushState(
          { ...(window.history.state ?? {}), danranEventDialog: marker },
          '',
        );
        return;
      }
      onClose();
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (dialog.open) dialog.close();
      cleanupMarkerTimerRef.current = window.setTimeout(() => {
        if (window.history.state?.danranEventDialog !== marker) return;
        const historyState = { ...(window.history.state ?? {}) };
        historyState.danranEventDialog = undefined;
        window.history.replaceState(historyState, '');
      }, 0);
    };
  }, [clientRequestId, onClose]);

  const requestClose = () => {
    if (pendingRef.current) return;
    if (historyEntryRef.current && window.history.state?.danranEventDialog) window.history.back();
    else onClose();
  };

  const patchFields = <K extends keyof typeof fields>(key: K, value: (typeof fields)[K]) => {
    setFields((previous) => ({ ...previous, [key]: value }));
    setErrorMessage('');
  };

  const buildInput = (): EventInput => {
    let time: EventInputTime;
    if (fields.allDay) {
      time = {
        kind: 'all-day',
        start: dateKeySchema.parse(fields.startDate),
        endExclusive: inclusiveEndToExclusive(dateKeySchema.parse(fields.endDate)),
      };
    } else {
      time = {
        kind: 'timed',
        start: `${fields.startDate}T${fields.startTime}:00+09:00`,
        endExclusive: `${fields.endDate}T${fields.endTime}:00+09:00`,
      };
    }
    return {
      title: fields.title,
      time,
      memberIds: fields.memberIds,
      assigneeMemberId: fields.assigneeMemberId || null,
      items: fields.items.map((item) => item.value.trim()).filter(Boolean),
      status: fields.status,
    };
  };

  const beginPending = (saving: boolean) => {
    pendingRef.current = true;
    if (saving) setIsSaving(true);
    else setIsDeleting(true);
  };

  const finishPending = (saving: boolean) => {
    pendingRef.current = false;
    if (saving) setIsSaving(false);
    else setIsDeleting(false);
  };

  const handleError = (error: unknown) => {
    if (error instanceof EventApiError && error.status === 401 && error.code === 'UNAUTHORIZED') {
      onUnauthorized();
    }
    setErrorMessage(fixedErrorMessage(error));
  };

  const handleSubmit = async (submitEvent: React.FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault();
    if (pendingRef.current) return;
    beginPending(true);
    let saved = false;
    try {
      const parsedInput = eventInputSchema.safeParse(buildInput());
      if (!parsedInput.success) {
        throw new EventApiError('入力内容を確認してください。', 'INVALID_INPUT');
      }
      const input = parsedInput.data;
      if (event) await updateEvent(familyId, event.id, input);
      else if (createdEventIdRef.current) {
        await updateEvent(familyId, createdEventIdRef.current, input);
      } else {
        const createInput =
          createInputRef.current ?? createEventInputSchema.parse({ ...input, clientRequestId });
        createInputRef.current = createInput;
        const created = await createEvent(familyId, createInput);
        createdEventIdRef.current = created.eventId;
        if (
          JSON.stringify({ ...createInput, clientRequestId: undefined }) !== JSON.stringify(input)
        ) {
          await updateEvent(familyId, created.eventId, input);
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['week', userId, familyId] });
      saved = true;
    } catch (error: unknown) {
      handleError(error);
    } finally {
      finishPending(true);
    }
    if (saved) onSaved();
  };

  const handleDelete = async () => {
    if (!event || pendingRef.current) return;
    beginPending(false);
    let saved = false;
    try {
      await deleteEvent(familyId, event.id);
      await queryClient.invalidateQueries({ queryKey: ['week', userId, familyId] });
      saved = true;
    } catch (error: unknown) {
      handleError(error);
    } finally {
      finishPending(false);
    }
    if (saved) onSaved();
  };

  const adultMembers = members.filter((member) => member.kind === 'adult');

  return (
    <dialog
      ref={dialogRef}
      data-testid="event-dialog"
      aria-labelledby="event-dialog-title"
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
          <h2 id="event-dialog-title" className="m-0 text-lg font-semibold">
            {event ? '予定を編集' : '予定を追加'}
          </h2>
          <button
            type="button"
            aria-label="閉じる"
            onClick={requestClose}
            disabled={isSaving || isDeleting}
            className={`${buttonClass} w-[var(--tap-target-min)] bg-transparent p-0`}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <fieldset
          disabled={isSaving || isDeleting}
          className="m-0 flex min-w-0 flex-col gap-[var(--spacing-lg)] border-0 px-[var(--spacing-md)] py-[var(--spacing-lg)]"
        >
          {errorMessage && (
            <p
              role="alert"
              className="m-0 rounded-[var(--radius-md)] border border-accent bg-accent-tint p-[var(--spacing-sm)] text-sm text-ink"
            >
              {errorMessage}
            </p>
          )}

          <div>
            <label htmlFor="event-title" className="block text-sm font-semibold">
              タイトル
            </label>
            <input
              ref={titleRef}
              id="event-title"
              name="title"
              type="text"
              required
              maxLength={200}
              value={fields.title}
              onChange={(inputEvent) => patchFields('title', inputEvent.currentTarget.value)}
              className={fieldClass}
            />
          </div>

          <div className="rounded-[var(--radius-md)] border border-line bg-surface p-[var(--spacing-md)]">
            <label
              htmlFor="event-all-day"
              className="flex min-h-[var(--tap-target-min)] cursor-pointer items-center gap-[var(--spacing-sm)] text-sm font-semibold"
            >
              <input
                id="event-all-day"
                type="checkbox"
                checked={fields.allDay}
                onChange={(inputEvent) => patchFields('allDay', inputEvent.currentTarget.checked)}
                className="h-5 w-5 accent-[var(--accent)]"
              />
              終日
            </label>
            <div className="grid grid-cols-2 gap-[var(--spacing-sm)]">
              <div>
                <label htmlFor="event-start-date" className="block text-xs font-medium text-muted">
                  開始日
                </label>
                <input
                  id="event-start-date"
                  lang="ja"
                  type="date"
                  required
                  value={fields.startDate}
                  onChange={(inputEvent) =>
                    patchFields('startDate', inputEvent.currentTarget.value)
                  }
                  className={fieldClass}
                />
              </div>
              <div>
                <label htmlFor="event-end-date" className="block text-xs font-medium text-muted">
                  終了日
                </label>
                <input
                  id="event-end-date"
                  lang="ja"
                  type="date"
                  required
                  min={fields.startDate}
                  value={fields.endDate}
                  onChange={(inputEvent) => patchFields('endDate', inputEvent.currentTarget.value)}
                  className={fieldClass}
                />
              </div>
              {!fields.allDay && (
                <>
                  <div>
                    <label
                      htmlFor="event-start-time"
                      className="block text-xs font-medium text-muted"
                    >
                      開始時刻
                    </label>
                    <input
                      id="event-start-time"
                      lang="ja"
                      type="time"
                      required
                      value={fields.startTime}
                      onChange={(inputEvent) =>
                        patchFields('startTime', inputEvent.currentTarget.value)
                      }
                      className={fieldClass}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="event-end-time"
                      className="block text-xs font-medium text-muted"
                    >
                      終了時刻
                    </label>
                    <input
                      id="event-end-time"
                      lang="ja"
                      type="time"
                      required
                      value={fields.endTime}
                      onChange={(inputEvent) =>
                        patchFields('endTime', inputEvent.currentTarget.value)
                      }
                      className={fieldClass}
                    />
                  </div>
                </>
              )}
            </div>
            {fields.allDay && (
              <p className="mb-0 mt-[var(--spacing-xs)] text-xs text-muted">
                終了日は含めて指定してください。
              </p>
            )}
          </div>

          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-[var(--spacing-sm)] text-sm font-semibold">対象メンバー</legend>
            <div className="grid grid-cols-2 gap-[var(--spacing-sm)]">
              {members.map((member) => {
                const checked = fields.memberIds.includes(member.id);
                return (
                  <label
                    key={member.id}
                    className={`flex min-h-[var(--tap-target-min)] min-w-0 cursor-pointer items-center gap-[var(--spacing-sm)] rounded-[var(--radius-md)] border px-[var(--spacing-sm)] ${checked ? 'border-focus bg-surface' : 'border-line'}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(inputEvent) =>
                        patchFields(
                          'memberIds',
                          inputEvent.currentTarget.checked
                            ? [...fields.memberIds, member.id]
                            : fields.memberIds.filter((id) => id !== member.id),
                        )
                      }
                      className="h-5 w-5 shrink-0 accent-[var(--accent)]"
                    />
                    <MemberDot name={member.name} color={`var(--member-${member.color})`} />
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div>
            <label htmlFor="event-assignee" className="block text-sm font-semibold">
              担当（大人）
            </label>
            <select
              id="event-assignee"
              value={fields.assigneeMemberId}
              onChange={(inputEvent) =>
                patchFields('assigneeMemberId', inputEvent.currentTarget.value)
              }
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

          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-[var(--spacing-sm)] text-sm font-semibold">持ち物</legend>
            <div className="space-y-[var(--spacing-sm)]">
              {fields.items.map((item, index) => (
                <div key={item.key} className="flex items-center gap-[var(--spacing-sm)]">
                  <label htmlFor={`event-item-${item.key}`} className="sr-only">
                    持ち物 {index + 1}
                  </label>
                  <input
                    id={`event-item-${item.key}`}
                    type="text"
                    maxLength={100}
                    value={item.value}
                    onChange={(inputEvent) =>
                      patchFields(
                        'items',
                        fields.items.map((previous) =>
                          previous.key === item.key
                            ? { ...previous, value: inputEvent.currentTarget.value }
                            : previous,
                        ),
                      )
                    }
                    className={fieldClass}
                  />
                  <button
                    type="button"
                    aria-label={`持ち物 ${index + 1} を削除`}
                    disabled={fields.items.length === 1}
                    onClick={() =>
                      patchFields(
                        'items',
                        fields.items.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                    className={`${buttonClass} shrink-0 border border-line bg-surface px-[var(--spacing-sm)]`}
                  >
                    削除
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              disabled={fields.items.length >= 20}
              onClick={() =>
                patchFields('items', [...fields.items, { key: crypto.randomUUID(), value: '' }])
              }
              className={`${buttonClass} mt-[var(--spacing-sm)] border border-line bg-surface`}
            >
              持ち物を追加
            </button>
          </fieldset>

          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-[var(--spacing-sm)] text-sm font-semibold">状態</legend>
            <div className="grid grid-cols-2 gap-[var(--spacing-sm)]">
              {(
                [
                  { value: 'confirmed', label: '確定' },
                  { value: 'tentative', label: '候補' },
                ] as const
              ).map((option) => (
                <label
                  key={option.value}
                  className={`flex min-h-[var(--tap-target-min)] cursor-pointer items-center gap-[var(--spacing-sm)] rounded-[var(--radius-md)] border px-[var(--spacing-sm)] ${fields.status === option.value ? 'border-focus bg-surface' : 'border-line'}`}
                >
                  <input
                    type="radio"
                    name="event-status"
                    value={option.value}
                    checked={fields.status === option.value}
                    onChange={() => patchFields('status', option.value)}
                    className="h-5 w-5 accent-[var(--accent)]"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          {event && (
            <div className="rounded-[var(--radius-md)] border border-line p-[var(--spacing-md)]">
              {deleteConfirmation ? (
                <>
                  <p className="mt-0 mb-[var(--spacing-sm)] text-sm">
                    「{event.title}」を削除しますか？
                  </p>
                  <div className="flex flex-wrap gap-[var(--spacing-sm)]">
                    <button
                      type="button"
                      data-testid="confirm-delete-event"
                      disabled={isSaving || isDeleting}
                      onClick={() => void handleDelete()}
                      className={`${buttonClass} bg-accent text-surface`}
                    >
                      この予定を削除
                    </button>
                    <button
                      type="button"
                      disabled={isSaving || isDeleting}
                      onClick={() => setDeleteConfirmation(false)}
                      className={`${buttonClass} border border-line bg-surface`}
                    >
                      削除しない
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="delete-event"
                  disabled={isSaving || isDeleting}
                  onClick={() => setDeleteConfirmation(true)}
                  className={`${buttonClass} w-full border border-line bg-surface text-accent`}
                >
                  削除
                </button>
              )}
            </div>
          )}
        </fieldset>
        <footer className="fixed inset-x-0 bottom-0 mx-auto flex w-full max-w-[var(--app-max-width)] gap-[var(--spacing-sm)] border-t border-line bg-bg/95 p-[var(--spacing-md)] pb-[calc(env(safe-area-inset-bottom,0px)+var(--spacing-md))] backdrop-blur">
          <button
            type="button"
            disabled={isSaving || isDeleting}
            onClick={requestClose}
            className={`${buttonClass} flex-1 border border-line bg-surface`}
          >
            キャンセル
          </button>
          <button
            type="submit"
            data-testid="save-event"
            disabled={isSaving || isDeleting}
            className={`${buttonClass} flex-1 bg-accent text-surface`}
          >
            {isSaving ? '保存中…' : '保存'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
