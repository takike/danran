import type { DateKey } from '@shared/schemas/date';
import { describe, expect, it } from 'vitest';
import { type FreeWindowsFamilyEvent, getFreeWindows } from './freeWindows';

const DATE = '2026-10-05' as DateKey;
const FULL_DAY = {
  start: '2026-10-05T08:00:00+09:00',
  end: '2026-10-05T20:00:00+09:00',
};

function timedEvent(
  start: string,
  end: string,
  memberIds: readonly string[],
  options: {
    assigneeMemberId?: string | null;
    status?: 'confirmed' | 'tentative';
    affectsAvailability?: boolean;
  } = {},
): FreeWindowsFamilyEvent {
  return {
    time: { kind: 'timed', start, endExclusive: end },
    memberIds: [...memberIds],
    assigneeMemberId: options.assigneeMemberId ?? null,
    status: options.status ?? 'confirmed',
    ...(options.affectsAvailability === undefined
      ? {}
      : { affectsAvailability: options.affectsAvailability }),
  };
}

describe('getFreeWindows', () => {
  it('returns the whole configured window when no member is busy', () => {
    const result = getFreeWindows({ date: DATE, memberIds: ['adult-a', 'child-a'] });

    expect(result).toEqual({
      memberBusy: [
        { memberId: 'adult-a', busy: [] },
        { memberId: 'child-a', busy: [] },
      ],
      commonFreeWindows: [FULL_DAY],
      totalFreeMinutes: 720,
    });
  });

  it('merges overlapping and touching intervals for each member', () => {
    const result = getFreeWindows({
      date: DATE,
      memberIds: ['adult-a'],
      personalBusy: {
        'adult-a': [
          { start: '2026-10-05T08:30:00+09:00', end: '2026-10-05T09:30:00+09:00' },
          { start: '2026-10-05T09:30:00+09:00', end: '2026-10-05T10:00:00+09:00' },
          { start: '2026-10-05T09:45:00+09:00', end: '2026-10-05T11:00:00+09:00' },
        ],
      },
    });

    expect(result.memberBusy).toEqual([
      {
        memberId: 'adult-a',
        busy: [{ start: '2026-10-05T08:30:00+09:00', end: '2026-10-05T11:00:00+09:00' }],
      },
    ]);
    expect(result.commonFreeWindows).toEqual([
      { start: '2026-10-05T08:00:00+09:00', end: '2026-10-05T08:30:00+09:00' },
      { start: '2026-10-05T11:00:00+09:00', end: '2026-10-05T20:00:00+09:00' },
    ]);
    expect(result.totalFreeMinutes).toBe(570);
  });

  it('clips outside and cross-midnight busy intervals to the JST day window', () => {
    const result = getFreeWindows({
      date: DATE,
      memberIds: ['adult-a'],
      personalBusy: {
        'adult-a': [
          { start: '2026-10-04T22:30:00+09:00', end: '2026-10-05T09:00:00+09:00' },
          { start: '2026-10-05T19:00:00+09:00', end: '2026-10-06T00:30:00+09:00' },
          // These UTC instants correspond to 08:00–10:00 on October 5 in Tokyo.
          { start: '2026-10-04T23:00:00Z', end: '2026-10-05T01:00:00Z' },
          { start: '2026-10-05T06:00:00+09:00', end: '2026-10-05T07:00:00+09:00' },
          { start: '2026-10-05T21:00:00+09:00', end: '2026-10-05T22:00:00+09:00' },
        ],
      },
    });

    expect(result.memberBusy).toEqual([
      {
        memberId: 'adult-a',
        busy: [
          { start: '2026-10-05T08:00:00+09:00', end: '2026-10-05T10:00:00+09:00' },
          { start: '2026-10-05T19:00:00+09:00', end: '2026-10-05T20:00:00+09:00' },
        ],
      },
    ]);
    expect(result.commonFreeWindows).toEqual([
      { start: '2026-10-05T10:00:00+09:00', end: '2026-10-05T19:00:00+09:00' },
    ]);
    expect(result.totalFreeMinutes).toBe(540);
  });

  it('keeps gaps of exactly the minimum length and drops shorter gaps', () => {
    const result = getFreeWindows({
      date: DATE,
      memberIds: ['adult-a'],
      minFreeMinutes: 30,
      personalBusy: {
        'adult-a': [{ start: '2026-10-05T08:30:00+09:00', end: '2026-10-05T19:31:00+09:00' }],
      },
    });

    expect(result.commonFreeWindows).toEqual([
      { start: '2026-10-05T08:00:00+09:00', end: '2026-10-05T08:30:00+09:00' },
    ]);
    expect(result.totalFreeMinutes).toBe(30);
  });

  it('treats a family event with no members as applying to every requested member', () => {
    const result = getFreeWindows({
      date: DATE,
      memberIds: ['adult-a', 'child-a'],
      familyEvents: [timedEvent('2026-10-05T12:00:00+09:00', '2026-10-05T13:30:00+09:00', [])],
    });

    expect(result.memberBusy).toEqual([
      {
        memberId: 'adult-a',
        busy: [{ start: '2026-10-05T12:00:00+09:00', end: '2026-10-05T13:30:00+09:00' }],
      },
      {
        memberId: 'child-a',
        busy: [{ start: '2026-10-05T12:00:00+09:00', end: '2026-10-05T13:30:00+09:00' }],
      },
    ]);
  });

  it('excludes tentative, all-day, and availability-exempt events, including their assignee buffers', () => {
    const result = getFreeWindows({
      date: DATE,
      memberIds: ['adult-a', 'adult-b'],
      assigneeBufferMinutes: 45,
      familyEvents: [
        timedEvent('2026-10-05T09:00:00+09:00', '2026-10-05T10:00:00+09:00', ['adult-a'], {
          assigneeMemberId: 'adult-b',
          status: 'tentative',
        }),
        {
          time: { kind: 'all-day', start: DATE, endExclusive: '2026-10-06' as DateKey },
          memberIds: ['adult-a', 'adult-b'],
          assigneeMemberId: 'adult-a',
          status: 'confirmed',
        },
        timedEvent('2026-10-05T14:00:00+09:00', '2026-10-05T15:00:00+09:00', ['adult-a'], {
          assigneeMemberId: 'adult-b',
          affectsAvailability: false,
        }),
      ],
    });

    expect(result.memberBusy).toEqual([
      { memberId: 'adult-a', busy: [] },
      { memberId: 'adult-b', busy: [] },
    ]);
    expect(result.commonFreeWindows).toEqual([FULL_DAY]);
    expect(result.totalFreeMinutes).toBe(720);
  });

  it('adds family events to the listed members and adds buffer only around the assignee event', () => {
    const result = getFreeWindows({
      date: DATE,
      memberIds: ['adult-a', 'adult-b'],
      assigneeBufferMinutes: 15,
      familyEvents: [
        timedEvent('2026-10-05T09:00:00+09:00', '2026-10-05T10:00:00+09:00', ['adult-a'], {
          assigneeMemberId: 'adult-b',
        }),
      ],
    });

    expect(result.memberBusy).toEqual([
      {
        memberId: 'adult-a',
        busy: [{ start: '2026-10-05T09:00:00+09:00', end: '2026-10-05T10:00:00+09:00' }],
      },
      {
        memberId: 'adult-b',
        busy: [{ start: '2026-10-05T08:45:00+09:00', end: '2026-10-05T10:15:00+09:00' }],
      },
    ]);
  });

  it('takes the complement of personal and family busy intervals across all members', () => {
    const result = getFreeWindows({
      date: DATE,
      memberIds: ['adult-a', 'adult-b'],
      personalBusy: {
        'adult-a': [{ start: '2026-10-05T09:00:00+09:00', end: '2026-10-05T10:00:00+09:00' }],
        'adult-b': [{ start: '2026-10-05T11:00:00+09:00', end: '2026-10-05T12:00:00+09:00' }],
      },
      familyEvents: [
        timedEvent('2026-10-05T13:00:00+09:00', '2026-10-05T14:00:00+09:00', ['adult-b']),
      ],
    });

    expect(result.commonFreeWindows).toEqual([
      { start: '2026-10-05T08:00:00+09:00', end: '2026-10-05T09:00:00+09:00' },
      { start: '2026-10-05T10:00:00+09:00', end: '2026-10-05T11:00:00+09:00' },
      { start: '2026-10-05T12:00:00+09:00', end: '2026-10-05T13:00:00+09:00' },
      { start: '2026-10-05T14:00:00+09:00', end: '2026-10-05T20:00:00+09:00' },
    ]);
    expect(result.totalFreeMinutes).toBe(540);
  });

  it('clips assignee buffers at both edges of the configured day window', () => {
    const result = getFreeWindows({
      date: DATE,
      memberIds: ['adult-a'],
      assigneeBufferMinutes: 30,
      familyEvents: [
        timedEvent('2026-10-05T08:10:00+09:00', '2026-10-05T08:30:00+09:00', [], {
          assigneeMemberId: 'adult-a',
        }),
        timedEvent('2026-10-05T19:45:00+09:00', '2026-10-05T20:00:00+09:00', [], {
          assigneeMemberId: 'adult-a',
        }),
      ],
    });

    expect(result.memberBusy).toEqual([
      {
        memberId: 'adult-a',
        busy: [
          { start: '2026-10-05T08:00:00+09:00', end: '2026-10-05T09:00:00+09:00' },
          { start: '2026-10-05T19:15:00+09:00', end: '2026-10-05T20:00:00+09:00' },
        ],
      },
    ]);
  });

  it('does not add busy data for an assignee outside the target list', () => {
    const result = getFreeWindows({
      date: DATE,
      memberIds: ['adult-a', 'child-a'],
      assigneeBufferMinutes: 30,
      familyEvents: [
        timedEvent('2026-10-05T09:00:00+09:00', '2026-10-05T10:00:00+09:00', ['adult-a'], {
          assigneeMemberId: 'adult-outside',
        }),
      ],
    });

    expect(result.memberBusy).toEqual([
      {
        memberId: 'adult-a',
        busy: [{ start: '2026-10-05T09:00:00+09:00', end: '2026-10-05T10:00:00+09:00' }],
      },
      { memberId: 'child-a', busy: [] },
    ]);
  });

  it('calculates a child’s busy time from family events without personal busy data', () => {
    const result = getFreeWindows({
      date: DATE,
      memberIds: ['child-a'],
      familyEvents: [
        timedEvent('2026-10-05T16:00:00+09:00', '2026-10-05T17:00:00+09:00', ['child-a']),
      ],
    });

    expect(result.memberBusy).toEqual([
      {
        memberId: 'child-a',
        busy: [{ start: '2026-10-05T16:00:00+09:00', end: '2026-10-05T17:00:00+09:00' }],
      },
    ]);
    expect(result.commonFreeWindows).toEqual([
      { start: '2026-10-05T08:00:00+09:00', end: '2026-10-05T16:00:00+09:00' },
      { start: '2026-10-05T17:00:00+09:00', end: '2026-10-05T20:00:00+09:00' },
    ]);
  });

  it('returns no common windows or minutes when there are no target members', () => {
    expect(
      getFreeWindows({
        date: DATE,
        memberIds: [],
        familyEvents: [timedEvent('invalid', 'invalid', [])],
      }),
    ).toEqual({ memberBusy: [], commonFreeWindows: [], totalFreeMinutes: 0 });
  });

  it('supports custom hours through midnight and totals fractional minutes without rounding', () => {
    const empty = getFreeWindows({
      date: DATE,
      memberIds: ['adult-a'],
      startHour: 22,
      endHour: 24,
    });
    expect(empty.commonFreeWindows).toEqual([
      { start: '2026-10-05T22:00:00+09:00', end: '2026-10-06T00:00:00+09:00' },
    ]);
    expect(empty.totalFreeMinutes).toBe(120);

    const fractional = getFreeWindows({
      date: DATE,
      memberIds: ['adult-a'],
      minFreeMinutes: 15,
      personalBusy: {
        'adult-a': [{ start: '2026-10-05T08:15:30+09:00', end: '2026-10-05T19:45:00+09:00' }],
      },
    });
    expect(fractional.commonFreeWindows).toEqual([
      { start: '2026-10-05T08:00:00+09:00', end: '2026-10-05T08:15:30+09:00' },
      { start: '2026-10-05T19:45:00+09:00', end: '2026-10-05T20:00:00+09:00' },
    ]);
    expect(fractional.totalFreeMinutes).toBe(30.5);
  });

  it('deduplicates target IDs in first-seen order and ignores unknown IDs', () => {
    const result = getFreeWindows({
      date: DATE,
      memberIds: ['adult-b', 'adult-a', 'adult-b'],
      personalBusy: {
        'unrequested-member': [{ start: 'not a time', end: 'not a time' }],
      },
      familyEvents: [
        timedEvent('2026-10-05T11:00:00+09:00', '2026-10-05T12:00:00+09:00', [
          'unknown-member',
          'adult-b',
          'adult-a',
          'adult-b',
        ]),
      ],
    });

    expect(result.memberBusy.map(({ memberId }) => memberId)).toEqual(['adult-b', 'adult-a']);
    expect(result.memberBusy.map(({ busy }) => busy)).toEqual([
      [{ start: '2026-10-05T11:00:00+09:00', end: '2026-10-05T12:00:00+09:00' }],
      [{ start: '2026-10-05T11:00:00+09:00', end: '2026-10-05T12:00:00+09:00' }],
    ]);
  });

  it('returns only interval and member data, and is deterministic without mutating frozen inputs', () => {
    const interval = Object.freeze({
      start: '2026-10-05T09:00:00+09:00',
      end: '2026-10-05T10:00:00+09:00',
    });
    const familyEvent = Object.freeze({
      id: 'private-event-id',
      title: 'Private event title',
      time: Object.freeze({
        kind: 'timed' as const,
        start: '2026-10-05T13:00:00+09:00',
        endExclusive: '2026-10-05T14:00:00+09:00',
      }),
      memberIds: Object.freeze(['adult-a']),
      assigneeMemberId: null,
      status: 'confirmed' as const,
      isRoutine: false,
      source: 'manual' as const,
      items: Object.freeze(['private item']),
    });
    const options = Object.freeze({
      date: DATE,
      memberIds: Object.freeze(['adult-a']),
      personalBusy: Object.freeze({ 'adult-a': Object.freeze([interval]) }),
      familyEvents: Object.freeze([familyEvent]),
    });

    const first = getFreeWindows(options);
    const second = getFreeWindows(options);

    expect(second).toEqual(first);
    expect(Object.keys(first).sort()).toEqual([
      'commonFreeWindows',
      'memberBusy',
      'totalFreeMinutes',
    ]);
    const memberResult = first.memberBusy.at(0);
    expect(memberResult).toBeDefined();
    if (!memberResult) throw new Error('Expected one member busy result');
    expect(Object.keys(memberResult).sort()).toEqual(['busy', 'memberId']);
    const memberInterval = memberResult.busy.at(0);
    expect(memberInterval).toBeDefined();
    if (!memberInterval) throw new Error('Expected one member busy interval');
    expect(Object.keys(memberInterval).sort()).toEqual(['end', 'start']);
    const commonInterval = first.commonFreeWindows.at(0);
    expect(commonInterval).toBeDefined();
    if (!commonInterval) throw new Error('Expected one common free interval');
    expect(Object.keys(commonInterval).sort()).toEqual(['end', 'start']);
    expect(JSON.stringify(first)).not.toContain('Private event title');
    expect(JSON.stringify(first)).not.toContain('private-event-id');
    expect(JSON.stringify(first)).not.toContain('private item');
  });

  it.each([
    {
      name: 'timezone-less start',
      interval: { start: '2026-10-05T09:00:00', end: '2026-10-05T10:00:00+09:00' },
    },
    {
      name: 'end before start',
      interval: { start: '2026-10-05T10:00:00+09:00', end: '2026-10-05T09:00:00+09:00' },
    },
    {
      name: 'empty interval',
      interval: { start: '2026-10-05T10:00:00+09:00', end: '2026-10-05T10:00:00+09:00' },
    },
  ])('rejects a used malformed or non-positive personal busy interval: $name', ({ interval }) => {
    expect(() =>
      getFreeWindows({
        date: DATE,
        memberIds: ['adult-a'],
        personalBusy: { 'adult-a': [interval] },
      }),
    ).toThrow();
  });

  it('rejects malformed or non-positive timed family events when they affect a requested member', () => {
    expect(() =>
      getFreeWindows({
        date: DATE,
        memberIds: ['adult-a'],
        familyEvents: [timedEvent('2026-10-05T09:00:00', '2026-10-05T10:00:00+09:00', ['adult-a'])],
      }),
    ).toThrow();
    expect(() =>
      getFreeWindows({
        date: DATE,
        memberIds: ['adult-a'],
        familyEvents: [
          timedEvent('2026-10-05T10:00:00+09:00', '2026-10-05T09:00:00+09:00', ['adult-a']),
        ],
      }),
    ).toThrow();
  });

  it('rejects invalid time-window, threshold, and buffer options', () => {
    const invalidOptions = [
      { startHour: -1 },
      { startHour: 8.5 },
      { startHour: 24, endHour: 24 },
      { startHour: 20, endHour: 20 },
      { startHour: 25, endHour: 26 },
      { endHour: 0 },
      { endHour: 24.5 },
      { minFreeMinutes: -1 },
      { minFreeMinutes: Number.NaN },
      { assigneeBufferMinutes: -0.1 },
      { assigneeBufferMinutes: Number.POSITIVE_INFINITY },
    ] as const;

    for (const overrides of invalidOptions) {
      expect(() => getFreeWindows({ date: DATE, memberIds: ['adult-a'], ...overrides })).toThrow();
    }
    expect(() =>
      getFreeWindows({ date: '2026-02-30' as DateKey, memberIds: ['adult-a'] }),
    ).toThrow();
  });
});
