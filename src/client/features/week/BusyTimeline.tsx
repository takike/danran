import {
  type BusyTimelineData,
  type BusyTimelineRow,
  formatBusyReadout,
  formatCommonFreeReadout,
  getTimelineBarSegments,
} from '@shared/domain/weekendTimeline';
import type { DateKey } from '@shared/schemas/date';
import { formatFullDateLabel } from '@shared/time/format';
import type React from 'react';
import { Link } from 'react-router-dom';

function MemberRow({
  date,
  member,
  selfMemberId,
}: {
  date: DateKey;
  member: BusyTimelineRow;
  selfMemberId?: string;
}): React.ReactElement {
  const unavailable = member.status === 'unavailable';
  const readout = unavailable
    ? `${member.name}：空き状況を取得できませんでした`
    : `${formatBusyReadout(member.name, member.busy)}${member.status === 'not-shared' ? '。個人の予定は未共有' : ''}`;
  const segments = unavailable ? [] : getTimelineBarSegments(date, member.busy);

  return (
    <li
      data-testid={`busy-row-${date}-${member.memberId}`}
      className="grid min-w-0 grid-cols-[minmax(0,var(--busy-name-column))_minmax(var(--busy-bar-min-width),1fr)] items-center gap-x-[var(--spacing-sm)] gap-y-[var(--spacing-2xs)]"
    >
      <div className="flex min-w-0 items-center gap-[var(--spacing-xs)]">
        <span
          aria-hidden="true"
          className="h-[var(--member-dot-size)] w-[var(--member-dot-size)] shrink-0 rounded-[var(--radius-full)]"
          style={{ backgroundColor: `var(--member-${member.color})` }}
        />
        <span className="min-w-0 truncate text-xs font-medium">{member.name}</span>
      </div>
      {unavailable ? (
        <span
          data-testid={`busy-unavailable-${date}-${member.memberId}`}
          className="min-w-0 text-xs text-muted"
        >
          取得できませんでした
        </span>
      ) : (
        <div
          aria-hidden="true"
          className="relative h-[var(--busy-bar-height)] min-w-[var(--busy-bar-min-width)] overflow-hidden rounded-[var(--radius-sm)] bg-chip"
        >
          {segments.map((segment, index) => (
            <span
              key={`${segment.start}-${segment.end}`}
              data-testid={`busy-segment-${date}-${member.memberId}-${index}`}
              className="absolute inset-y-0 rounded-[var(--radius-sm)] bg-muted"
              style={{ left: `${segment.leftPercent}%`, width: `${segment.widthPercent}%` }}
            />
          ))}
        </div>
      )}
      <p
        data-testid={`busy-row-label-${date}-${member.memberId}`}
        className="sr-only col-start-1 col-end-3 m-0"
      >
        {readout}
      </p>
      {member.status === 'not-shared' && (
        <div
          data-testid={`busy-not-shared-${date}-${member.memberId}`}
          className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-[var(--spacing-xs)]"
        >
          <span className="text-xs text-muted">個人の予定は未共有</span>
          {member.memberId === selfMemberId && (
            <Link
              to="/family"
              aria-label="家族タブで空き状況の共有を設定"
              className="inline-flex min-h-[var(--tap-target-min)] items-center rounded-[var(--radius-sm)] px-[var(--spacing-xs)] text-xs text-accent underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              家族タブ
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

function TimeScale(): React.ReactElement {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,var(--busy-name-column))_minmax(var(--busy-bar-min-width),1fr)] gap-x-[var(--spacing-sm)]">
      <span className="sr-only col-span-2">
        時間軸は8時から20時まで。目盛りは8時、12時、16時、20時です。
      </span>
      <div
        aria-hidden="true"
        className="col-start-2 flex min-w-[var(--busy-bar-min-width)] justify-between px-[var(--spacing-2xs)] text-[length:var(--busy-scale-font-size)] tabular-nums text-muted"
      >
        <span>8</span>
        <span>12</span>
        <span>16</span>
        <span>20</span>
      </div>
    </div>
  );
}

function CommonRow({
  date,
  windows,
}: {
  date: DateKey;
  windows: BusyTimelineData['commonFreeWindows'];
}): React.ReactElement {
  const segments = getTimelineBarSegments(date, windows);
  return (
    <li
      data-testid={`busy-common-row-${date}`}
      className="grid min-w-0 grid-cols-[minmax(0,var(--busy-name-column))_minmax(var(--busy-bar-min-width),1fr)] items-center gap-x-[var(--spacing-sm)] gap-y-[var(--spacing-2xs)] border-t border-line pt-[var(--spacing-sm)]"
    >
      <span className="min-w-0 truncate text-xs font-semibold text-accent">共通</span>
      <div
        aria-hidden="true"
        className="relative h-[var(--busy-bar-height)] min-w-[var(--busy-bar-min-width)] overflow-hidden rounded-[var(--radius-sm)] bg-accent-tint"
      >
        {segments.map((segment, index) => (
          <span
            key={`${segment.start}-${segment.end}`}
            data-testid={`busy-common-segment-${date}-${index}`}
            className="absolute inset-y-0 rounded-[var(--radius-sm)] bg-accent"
            style={{ left: `${segment.leftPercent}%`, width: `${segment.widthPercent}%` }}
          />
        ))}
      </div>
      <p data-testid={`busy-common-readout-${date}`} className="sr-only col-start-1 col-end-3 m-0">
        {formatCommonFreeReadout(windows)}
      </p>
    </li>
  );
}

export function BusyTimeline({
  date,
  data,
  selfMemberId,
}: {
  date: DateKey;
  data: BusyTimelineData;
  selfMemberId?: string;
}): React.ReactElement {
  const label = formatFullDateLabel(date);
  if (data.kind !== 'ready') {
    const testId = data.kind === 'loading' ? `busy-loading-${date}` : `busy-error-${date}`;
    const message =
      data.kind === 'loading'
        ? '空き状況を読み込み中...'
        : data.kind === 'day-error'
          ? 'この日の空き状況を表示できませんでした。'
          : '空き状況を読み込めませんでした。';
    return (
      <section
        data-testid={testId}
        aria-label={`${label}の空き状況`}
        aria-live="polite"
        className="mt-[var(--spacing-md)] rounded-[var(--radius-md)] bg-chip px-[var(--spacing-sm)] py-[var(--spacing-xs)] text-xs text-muted"
      >
        {message}
      </section>
    );
  }

  return (
    <section
      data-testid={`busy-timeline-${date}`}
      aria-label={`${label}の空き状況`}
      className="mt-[var(--spacing-md)] min-w-0 rounded-[var(--radius-md)] border border-line bg-bg p-[var(--spacing-sm)]"
    >
      <TimeScale />
      <ul className="m-0 grid min-w-0 list-none gap-y-[var(--spacing-xs)] p-0">
        {data.rows.map((member) => (
          <MemberRow
            key={member.memberId}
            date={date}
            member={member}
            selfMemberId={selfMemberId}
          />
        ))}
        {!data.hasUnavailableMember && <CommonRow date={date} windows={data.commonFreeWindows} />}
      </ul>
      {data.hasNotSharedMember && (
        <p
          data-testid={`busy-not-shared-summary-${date}`}
          className="mt-[var(--spacing-xs)] mb-0 text-xs leading-relaxed text-muted"
        >
          個人の予定を共有していない人がいます。
        </p>
      )}
      {data.hasUnavailableMember && (
        <p
          data-testid={`busy-unavailable-summary-${date}`}
          className="mt-[var(--spacing-xs)] mb-0 text-xs leading-relaxed text-muted"
        >
          空き状況を取得できない人がいるため、共通の空きは表示していません。
        </p>
      )}
    </section>
  );
}
