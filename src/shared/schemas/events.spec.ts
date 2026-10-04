import { describe, expect, it } from 'vitest';
import { createEventInputSchema, eventInputSchema } from './events';

const valid = {
  title: '  運動会  ',
  time: {
    kind: 'timed',
    start: '2026-10-05T09:00:00+09:00',
    endExclusive: '2026-10-05T10:00:00+09:00',
  },
  memberIds: ['m_child'],
  assigneeMemberId: null,
  items: [' 水筒 '],
  status: 'confirmed',
};

describe('event input schemas', () => {
  it('trims text and validates strict Tokyo time ranges', () => {
    expect(eventInputSchema.parse(valid)).toMatchObject({ title: '運動会', items: ['水筒'] });
    expect(
      eventInputSchema.safeParse({
        ...valid,
        time: { ...valid.time, endExclusive: '2026-10-05T09:00:00+09:00' },
      }).success,
    ).toBe(false);
    expect(
      eventInputSchema.safeParse({
        ...valid,
        time: { ...valid.time, start: '2026-10-05T00:00:00Z' },
      }).success,
    ).toBe(false);
  });

  it('limits items and requires a UUID for creation', () => {
    expect(
      eventInputSchema.safeParse({ ...valid, items: Array.from({ length: 21 }, () => 'item') })
        .success,
    ).toBe(false);
    expect(
      createEventInputSchema.safeParse({ ...valid, clientRequestId: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('rejects member metadata beyond the Google extended property limit', () => {
    const memberIds = Array.from({ length: 6 }, (_, index) => `${index}${'x'.repeat(190)}`);
    expect(eventInputSchema.safeParse({ ...valid, memberIds }).success).toBe(false);
  });
});
