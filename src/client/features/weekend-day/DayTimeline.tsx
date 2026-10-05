import { MemberDot } from '@client/components/MemberDot';
import { getColorCssVar } from '@client/features/onboarding/useFamily';
import type { BusyInterval } from '@shared/domain/busyIntervals';
import {
  DAY_PIXELS_PER_HOUR,
  DAY_TIMELINE_END_HOUR,
  DAY_TIMELINE_START_HOUR,
  type PositionedDayEvent,
  type WeekendDayLayout,
  getDayIntervalGeometry,
  getDayMemberColumnTracks,
  getDayMemberLaneCounts,
  getFreeBandHitGeometry,
} from '@shared/domain/weekendDay';
import type { DateKey } from '@shared/schemas/date';
import type { PersonalEvent } from '@shared/schemas/personal';
import type { WeekEvent, WeekResponse } from '@shared/schemas/week';
import { toTokyoIsoString } from '@shared/time/date';
import { formatEventTime } from '@shared/time/format';
import { KeyRound, Repeat, ShoppingBag } from 'lucide-react';
import type React from 'react';

type WeekMember = WeekResponse['members'][number];
type TimedEventTime = Extract<WeekEvent['time'], { kind: 'timed' }>;
function clock(instant: string): string {
  return toTokyoIsoString(instant).slice(11, 16);
}

function blockStyle(block: PositionedDayEvent<WeekEvent | PersonalEvent>): React.CSSProperties {
  return {
    top: `${block.geometry.top}px`,
    height: `${block.geometry.height}px`,
    left: `${(block.lane / block.laneCount) * 100}%`,
    width: `${100 / block.laneCount}%`,
  };
}

function eventTime(event: WeekEvent | PersonalEvent, date: DateKey): string {
  return formatEventTime(event.time, date);
}

function eventTargets(event: WeekEvent, members: readonly WeekMember[]): string {
  if (event.memberIds.length === 0) return '家族全員';
  const names = event.memberIds
    .map((id) => members.find((member) => member.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  return names.length ? names.join('・') : '家族全員';
}

function familyEventAccessibleLabel(
  event: WeekEvent,
  date: DateKey,
  members: readonly WeekMember[],
  assigneeMemberId: string | null,
): string {
  return [
    event.title,
    eventTime(event, date),
    `対象 ${eventTargets(event, members)}`,
    event.status === 'tentative' ? '候補' : undefined,
    event.isRoutine ? '繰り返し予定' : undefined,
    assigneeMemberId
      ? `担当 ${members.find((member) => member.id === assigneeMemberId)?.name ?? ''}`
      : undefined,
    event.items.length ? `持ち物 ${event.items.join('、')}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join('、');
}

function FamilyEventDetails({
  block,
  date,
  members,
  spanning = false,
}: {
  block: PositionedDayEvent<WeekEvent>;
  date: DateKey;
  members: readonly WeekMember[];
  spanning?: boolean;
}): React.ReactElement {
  const event = block.event;
  const assignee = event.assigneeMemberId
    ? members.find((member) => member.id === event.assigneeMemberId)
    : undefined;
  const isAssignedPlacement =
    block.column.isAssignee ||
    (spanning && event.memberIds.length === 0 && Boolean(event.assigneeMemberId));
  const labels = [
    event.status === 'tentative' ? '候補' : undefined,
    isAssignedPlacement ? `担当${assignee ? `：${assignee.name}` : ''}` : undefined,
  ].filter((label): label is string => Boolean(label));

  return (
    <>
      <span className="flex w-full min-w-0 items-center gap-[var(--spacing-2xs)] font-semibold">
        {event.isRoutine && <Repeat size={12} aria-label="繰り返し予定" className="shrink-0" />}
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{event.title}</span>
      </span>
      <span className="max-w-full break-words text-[length:var(--nav-caption-size)] text-muted [overflow-wrap:anywhere]">
        {eventTime(event, date)} · {eventTargets(event, members)}
      </span>
      {labels.length > 0 && (
        <span className="flex max-w-full flex-wrap gap-[var(--spacing-2xs)]">
          {labels.map((label) => (
            <span
              key={label}
              className="rounded-[var(--radius-sm)] bg-accent-tint px-[var(--spacing-2xs)] text-[length:var(--nav-caption-size)] text-accent"
            >
              {label}
            </span>
          ))}
        </span>
      )}
      {event.items.length > 0 && (
        <span className="flex min-w-0 max-w-full flex-wrap gap-[var(--spacing-2xs)]">
          {event.items.map((item, index) => (
            <span
              key={`${event.id}-item-${index}`}
              className="inline-flex min-w-0 items-center gap-[var(--spacing-2xs)] rounded-[var(--radius-sm)] bg-chip px-[var(--spacing-2xs)] text-[length:var(--nav-caption-size)]"
            >
              <ShoppingBag size={10} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{item}</span>
            </span>
          ))}
        </span>
      )}
    </>
  );
}

function FamilyEventButton({
  block,
  date,
  members,
  onEdit,
}: {
  block: PositionedDayEvent<WeekEvent>;
  date: DateKey;
  members: readonly WeekMember[];
  onEdit: (event: WeekEvent, trigger: HTMLButtonElement) => void;
}): React.ReactElement {
  const event = block.event;
  const member =
    block.column.memberIds.length === 1
      ? members.find((candidate) => candidate.id === block.column.memberIds[0])
      : undefined;
  const background =
    event.status === 'tentative'
      ? 'var(--surface)'
      : `color-mix(in srgb, var(--member-${member?.color ?? 'indigo'}) 14%, var(--surface))`;
  return (
    <button
      type="button"
      data-testid={`weekend-day-event-${event.id}-${member?.id ?? 'all'}`}
      aria-label={familyEventAccessibleLabel(event, date, members, block.column.assigneeMemberId)}
      onClick={(eventTarget) => onEdit(event, eventTarget.currentTarget)}
      className={`absolute z-20 flex min-h-[var(--tap-target-min)] flex-col items-start overflow-visible rounded-[var(--radius-sm)] border px-[var(--spacing-xs)] py-[var(--spacing-2xs)] text-left text-xs leading-tight shadow-[var(--week-card-shadow)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${event.status === 'tentative' ? 'border-accent bg-surface' : 'border-line'}`}
      style={{ ...blockStyle(block), backgroundColor: background }}
    >
      <FamilyEventDetails block={block} date={date} members={members} />
    </button>
  );
}

function SpanningFamilyEventButton({
  block,
  date,
  members,
  memberColumnTracks,
  onEdit,
}: {
  block: PositionedDayEvent<WeekEvent>;
  date: DateKey;
  members: readonly WeekMember[];
  memberColumnTracks: readonly string[];
  onEdit: (event: WeekEvent, trigger: HTMLButtonElement) => void;
}): React.ReactElement {
  const event = block.event;
  const background = event.status === 'tentative' ? 'var(--surface)' : 'var(--accent-tint)';
  const assignee = block.column.assigneeMemberId
    ? members.find((member) => member.id === block.column.assigneeMemberId)
    : undefined;
  const label = familyEventAccessibleLabel(event, date, members, block.column.assigneeMemberId);
  return (
    <button
      type="button"
      data-testid={`weekend-day-event-${event.id}-all`}
      aria-label={label}
      onClick={(eventTarget) => onEdit(event, eventTarget.currentTarget)}
      className="pointer-events-none absolute inset-x-0 z-20 grid overflow-visible border-0 bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      style={{
        top: `${block.geometry.top}px`,
        height: `${block.geometry.height}px`,
        gridTemplateColumns: memberColumnTracks.join(' '),
      }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-[var(--spacing-xs)] z-0 h-px bg-line"
      />
      {members.map((member, index) => (
        <span key={member.id} className="relative h-full min-w-0">
          {index > 0 && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-0 right-full top-[var(--spacing-xs)] h-px bg-line"
            />
          )}
          <span
            aria-hidden={index > 0}
            data-testid={`weekend-day-event-segment-${event.id}-${member.id}`}
            className={`pointer-events-auto absolute inset-y-0 z-10 flex min-h-[var(--tap-target-min)] flex-col overflow-visible rounded-[var(--radius-sm)] border px-[var(--spacing-xs)] py-[var(--spacing-2xs)] text-xs leading-tight shadow-[var(--week-card-shadow)] ${event.status === 'tentative' ? 'border-accent' : 'border-line'} ${index === 0 ? '' : 'justify-center'}`}
            style={{
              left: `${(block.lane / block.laneCount) * 100}%`,
              width: `${100 / block.laneCount}%`,
              backgroundColor: background,
              borderInlineStartWidth: index === 0 ? undefined : '0px',
              borderTopLeftRadius: index === 0 ? undefined : '0px',
              borderBottomLeftRadius: index === 0 ? undefined : '0px',
              borderTopRightRadius: index === members.length - 1 ? undefined : '0px',
              borderBottomRightRadius: index === members.length - 1 ? undefined : '0px',
            }}
          >
            {index === 0 ? (
              <FamilyEventDetails block={block} date={date} members={members} spanning />
            ) : (
              <span className="break-words text-[length:var(--nav-caption-size)] font-medium [overflow-wrap:anywhere]">
                家族全員{assignee ? ` · 担当 ${assignee.name}` : ''}
              </span>
            )}
          </span>
        </span>
      ))}
    </button>
  );
}

function PrivateEventBlock({
  block,
  date,
}: {
  block: PositionedDayEvent<PersonalEvent>;
  date: DateKey;
}): React.ReactElement {
  return (
    <div
      data-testid={`weekend-day-personal-event-${block.event.id}`}
      aria-label={`${block.event.title}、${eventTime(block.event, date)}、自分だけに見える予定`}
      className="absolute z-20 flex min-h-[var(--tap-target-min)] flex-col overflow-hidden rounded-[var(--radius-sm)] border border-dashed border-focus bg-surface px-[var(--spacing-xs)] py-[var(--spacing-2xs)] text-xs leading-tight"
      style={blockStyle(block)}
    >
      <span className="min-w-0 break-words font-semibold [overflow-wrap:anywhere]">
        {block.event.title}
      </span>
      <span className="text-[length:var(--nav-caption-size)] text-muted">
        {eventTime(block.event, date)}
      </span>
      <span className="mt-auto inline-flex items-center gap-[var(--spacing-2xs)] text-[length:var(--nav-caption-size)] text-muted">
        <KeyRound size={12} aria-hidden="true" />
        自分だけ
      </span>
    </div>
  );
}

function BusyStripe({
  date,
  interval,
  memberId,
  index,
}: {
  date: DateKey;
  interval: BusyInterval;
  memberId: string;
  index: number;
}): React.ReactElement | null {
  const geometry = getDayIntervalGeometry(date, interval);
  if (geometry.kind !== 'timeline') return null;
  return (
    <div
      data-testid={`weekend-day-personal-busy-${date}-${memberId}-${index}`}
      aria-hidden="true"
      className="absolute inset-x-[var(--spacing-2xs)] z-0 rounded-[var(--radius-sm)] opacity-75"
      style={{
        top: `${geometry.top}px`,
        height: `${geometry.height}px`,
        backgroundImage: 'var(--day-busy-pattern)',
      }}
    >
      <span className="pointer-events-none absolute left-[var(--spacing-xs)] top-[var(--spacing-2xs)] max-w-full truncate rounded-[var(--radius-sm)] bg-surface/80 px-[var(--spacing-2xs)] text-[length:var(--nav-caption-size)] font-semibold leading-tight text-ink">
        予定あり
      </span>
    </div>
  );
}

function PersonalStatus({
  member,
  layout,
}: {
  member: WeekMember;
  layout: WeekendDayLayout;
}): string | undefined {
  const row = layout.busyRows.find((candidate) => candidate.memberId === member.id);
  if (row?.status === 'not_shared') return '個人の予定は未共有';
  if (row?.status === 'unavailable') return '取得できませんでした';
  return undefined;
}

export function DayTimeline({
  date,
  members,
  layout,
  busyResponseReady,
  onEdit,
  onRoutineNotice,
  onAddFromFreeBand,
  firstFreeBandRef,
}: {
  date: DateKey;
  members: readonly WeekMember[];
  layout: WeekendDayLayout;
  busyResponseReady: boolean;
  onEdit: (event: WeekEvent, trigger: HTMLButtonElement) => void;
  onRoutineNotice: () => void;
  onAddFromFreeBand: (initialTime: TimedEventTime, trigger: HTMLButtonElement) => void;
  firstFreeBandRef: React.Ref<HTMLButtonElement>;
}): React.ReactElement {
  const memberLaneCounts = getDayMemberLaneCounts(members, [
    ...layout.familyBlocks,
    ...layout.personalBlocks,
  ]);
  const memberColumnTracks = getDayMemberColumnTracks(memberLaneCounts);
  const columns = ['var(--day-axis-column)', ...memberColumnTracks].join(' ');
  const totalHours = DAY_TIMELINE_END_HOUR - DAY_TIMELINE_START_HOUR;
  const renderFamilyBlock = (block: PositionedDayEvent<WeekEvent>, spanning = false) => {
    const onBlockEdit = (event: WeekEvent, trigger: HTMLButtonElement) => {
      if (event.isRoutine) onRoutineNotice();
      else onEdit(event, trigger);
    };
    if (spanning) {
      return (
        <SpanningFamilyEventButton
          key={`${block.event.id}-all`}
          block={block}
          date={date}
          members={members}
          memberColumnTracks={memberColumnTracks}
          onEdit={onBlockEdit}
        />
      );
    }
    return (
      <FamilyEventButton
        key={`${block.event.id}-${block.column.memberIds[0] ?? 'all'}-${block.column.isAssignee ? 'assignee' : 'target'}`}
        block={block}
        date={date}
        members={members}
        onEdit={onBlockEdit}
      />
    );
  };

  return (
    <section aria-label={`${date}の予定タイムライン`} className="min-w-0">
      <div
        data-testid="weekend-day-scroll"
        className="min-w-0 overflow-x-auto overscroll-x-contain rounded-[var(--radius-md)] border border-line bg-surface"
      >
        <div className="w-max">
          <div
            className="grid min-h-[var(--tap-target-min)] items-end"
            style={{ gridTemplateColumns: columns }}
          >
            <span aria-hidden="true" />
            {members.map((member) => {
              const status = busyResponseReady ? PersonalStatus({ member, layout }) : undefined;
              return (
                <div
                  key={member.id}
                  className="flex min-w-0 flex-col justify-end px-[var(--spacing-xs)] pb-[var(--spacing-xs)]"
                >
                  <MemberDot
                    name={member.name}
                    color={getColorCssVar(member.color)}
                    className="max-w-full truncate"
                  />
                  {status && (
                    <span className="mt-[var(--spacing-2xs)] break-words text-[length:var(--nav-caption-size)] leading-tight text-muted [overflow-wrap:anywhere]">
                      {status}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div
            data-testid="weekend-day-timeline"
            className="relative grid w-max"
            style={{ gridTemplateColumns: columns, height: 'var(--day-timeline-height)' }}
          >
            <div className="relative h-full text-right text-[length:var(--nav-caption-size)] tabular-nums text-muted">
              {Array.from({ length: totalHours + 1 }, (_, index) => {
                const hour = DAY_TIMELINE_START_HOUR + index;
                return (
                  <span
                    key={hour}
                    className="absolute right-[var(--spacing-xs)] -translate-y-1/2"
                    style={{ top: `${index * DAY_PIXELS_PER_HOUR}px` }}
                  >
                    {hour}
                  </span>
                );
              })}
            </div>
            {members.map((member) => {
              const row = layout.busyRows.find((candidate) => candidate.memberId === member.id);
              const memberFamilyBlocks = layout.familyBlocks.filter(
                (block) => !block.column.spansAll && block.column.memberIds.includes(member.id),
              );
              const memberPrivateBlocks = layout.personalBlocks.filter((block) =>
                block.column.memberIds.includes(member.id),
              );
              const status = busyResponseReady ? PersonalStatus({ member, layout }) : undefined;
              return (
                <div
                  key={member.id}
                  data-testid={`weekend-day-column-${member.id}`}
                  className="relative h-full border-l border-line bg-surface"
                >
                  {row?.status === 'ready' &&
                    row.busy.map((interval, index) => (
                      <BusyStripe
                        key={`${interval.start}-${interval.end}`}
                        date={date}
                        interval={interval}
                        memberId={member.id}
                        index={index}
                      />
                    ))}
                  {memberFamilyBlocks.map((block) => (
                    <FamilyEventButton
                      key={`${block.event.id}-${member.id}-${block.column.isAssignee ? 'assignee' : 'target'}`}
                      block={block}
                      date={date}
                      members={members}
                      onEdit={(event, trigger) => {
                        if (event.isRoutine) onRoutineNotice();
                        else onEdit(event, trigger);
                      }}
                    />
                  ))}
                  {memberPrivateBlocks.map((block) => (
                    <PrivateEventBlock key={block.event.id} block={block} date={date} />
                  ))}
                </div>
              );
            })}
            <div
              className="pointer-events-none absolute inset-y-0"
              style={{ left: 'var(--day-axis-column)', right: 0 }}
            >
              {Array.from({ length: totalHours + 1 }, (_, index) => (
                <span
                  key={`hour-line-${DAY_TIMELINE_START_HOUR + index}`}
                  aria-hidden="true"
                  className="absolute inset-x-0 border-t border-line"
                  style={{ top: `${index * DAY_PIXELS_PER_HOUR}px` }}
                />
              ))}
              {layout.freeBands.map((band, index) => {
                const hit = getFreeBandHitGeometry(band.geometry);
                return (
                  <button
                    key={`${band.start}-${band.end}`}
                    ref={index === 0 ? firstFreeBandRef : undefined}
                    type="button"
                    data-testid={`weekend-day-free-add-${index}`}
                    aria-label={`${clock(band.start)} から ${clock(band.end)} の空き時間に予定を追加`}
                    onClick={(event) => onAddFromFreeBand(band.initialTime, event.currentTarget)}
                    className="pointer-events-auto absolute left-0 right-0 overflow-visible rounded-[var(--radius-md)] border-0 bg-transparent p-0 text-left text-xs font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    style={{ top: `${hit.top}px`, height: `${hit.height}px` }}
                  >
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 z-10 rounded-[var(--radius-md)] border border-dashed border-accent bg-accent-tint/80"
                      style={{ top: `${hit.backgroundTop}px`, height: `${band.geometry.height}px` }}
                    />
                    <span
                      data-testid={`weekend-day-free-band-${index}`}
                      className="pointer-events-auto sticky left-0 top-0 z-30 flex min-h-[var(--tap-target-min)] w-fit items-center justify-center break-words rounded-[var(--radius-sm)] bg-surface/95 px-[var(--spacing-sm)] text-center shadow-[var(--week-card-shadow)] [overflow-wrap:anywhere]"
                      style={{
                        maxWidth: 'calc(100vw - var(--day-axis-column) - var(--spacing-lg))',
                      }}
                    >
                      みんな空き {clock(band.start)}–{clock(band.end)}
                    </span>
                  </button>
                );
              })}
              {layout.familyBlocks
                .filter((block) => block.column.spansAll)
                .map((block) => renderFamilyBlock(block, true))}
            </div>
          </div>
        </div>
      </div>

      {layout.hasNotSharedMember && busyResponseReady && (
        <p
          data-testid="weekend-day-not-shared"
          className="mt-[var(--spacing-sm)] mb-0 text-xs leading-relaxed text-muted"
        >
          個人の予定を共有していない人がいます。
        </p>
      )}
      {layout.hasUnavailableMember && busyResponseReady && (
        <p
          data-testid="weekend-day-unavailable"
          className="mt-[var(--spacing-sm)] mb-0 text-xs leading-relaxed text-muted"
        >
          空き状況を取得できない人がいるため、共通の空きは表示していません。
        </p>
      )}
      {layout.freeBands.length === 0 &&
        busyResponseReady &&
        !layout.hasUnavailableMember &&
        layout.kind === 'ready' && (
          <p
            data-testid="weekend-day-no-common"
            className="mt-[var(--spacing-sm)] mb-0 text-xs text-muted"
          >
            共通の空き時間はありません。
          </p>
        )}
      {layout.kind === 'day-error' && (
        <p
          role="alert"
          data-testid="weekend-day-layout-error"
          className="mt-[var(--spacing-sm)] mb-0 text-xs text-muted"
        >
          この日の予定を表示できませんでした。
        </p>
      )}
      <section aria-label="読み上げ用の予定と空きの一覧" className="sr-only">
        <h2>予定と空きの一覧</h2>
        <ul>
          {members.map((member) => {
            const row = layout.busyRows.find((candidate) => candidate.memberId === member.id);
            const appliesToMember = (event: WeekEvent) =>
              event.memberIds.length === 0 ||
              event.memberIds.includes(member.id) ||
              event.assigneeMemberId === member.id;
            const familyEvents = layout.familyBlocks
              .filter(
                (block) => block.column.spansAll || block.column.memberIds.includes(member.id),
              )
              .map(
                (block) =>
                  `${block.event.title} ${eventTime(block.event, date)}${block.column.isAssignee ? ' 担当' : ''}`,
              );
            const allDayFamilyEvents = layout.allDayFamilyEvents
              .filter(appliesToMember)
              .map((event) => `${event.title} 終日${event.isRoutine ? ' 繰り返し予定' : ''}`);
            const outsideFamilyEvents = layout.outsideFamilyEvents
              .filter(appliesToMember)
              .map(
                (event) =>
                  `${event.title} ${eventTime(event, date)}${event.isRoutine ? ' 繰り返し予定' : ''}`,
              );
            const personalEvents = layout.personalBlocks
              .filter((block) => block.column.memberIds.includes(member.id))
              .map((block) => `${block.event.title} ${eventTime(block.event, date)} 自分だけ`);
            const allDayPersonalEvents =
              layout.ownMemberId === member.id
                ? layout.allDayPersonalEvents.map((event) => `${event.title} 終日 自分だけ`)
                : [];
            const outsidePersonalEvents =
              layout.ownMemberId === member.id
                ? layout.outsidePersonalEvents.map(
                    (event) => `${event.title} ${eventTime(event, date)} 自分だけ`,
                  )
                : [];
            const eventReadouts = [
              ...familyEvents,
              ...allDayFamilyEvents,
              ...outsideFamilyEvents,
              ...personalEvents,
              ...allDayPersonalEvents,
              ...outsidePersonalEvents,
            ];
            return (
              <li key={`readout-${member.id}`}>
                {member.name}：
                {row?.status === 'unavailable'
                  ? '取得できませんでした'
                  : row?.status === 'not_shared'
                    ? '個人の予定は未共有です'
                    : row?.status === 'ready'
                      ? row.busy
                          .map(
                            (interval) =>
                              `${clock(interval.start)}–${clock(interval.end)} 予定あり`,
                          )
                          .join('、') || '予定ありの時間はありません'
                      : '個人の予定はありません'}
                {eventReadouts.length > 0 && <span>。{eventReadouts.join('、')}</span>}
              </li>
            );
          })}
          {layout.freeBands.map((band) => (
            <li key={`free-readout-${band.start}-${band.end}`}>
              共通の空き {clock(band.start)}–{clock(band.end)}
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
