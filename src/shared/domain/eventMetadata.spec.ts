import { describe, expect, it } from 'vitest';
import { buildDanranPrivateProperties, toGoogleEventTimes } from './eventMetadata';

const input = {
  title: '運動会',
  time: {
    kind: 'timed' as const,
    start: '2026-10-05T09:00:00+09:00',
    endExclusive: '2026-10-05T10:00:00+09:00',
  },
  memberIds: ['m_child', 'm_adult', 'm_child'],
  assigneeMemberId: 'm_adult',
  items: ['水筒'],
  status: 'tentative' as const,
};

describe('event metadata helpers', () => {
  it('creates canonical private metadata with deduplicated members', () => {
    expect(buildDanranPrivateProperties(input)).toEqual({
      danran: '1',
      members: 'm_child,m_adult',
      assignee: 'm_adult',
      status: 'tentative',
      source: 'manual',
    });
  });

  it('maps all-day time using the exclusive Google end date', () => {
    expect(
      toGoogleEventTimes({ kind: 'all-day', start: '2026-10-05', endExclusive: '2026-10-06' }),
    ).toEqual({ start: { date: '2026-10-05' }, end: { date: '2026-10-06' } });
  });
});
