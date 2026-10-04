import { describe, expect, it } from 'vitest';
import { compareFamilyMembers } from './memberOrder';

describe('compareFamilyMembers', () => {
  it('orders adults before children, then by sort order and id', () => {
    const members = [
      { id: 'child-b', kind: 'child' as const, sortOrder: 0 },
      { id: 'adult-b', kind: 'adult' as const, sortOrder: 2 },
      { id: 'adult-z', kind: 'adult' as const, sortOrder: 1 },
      { id: 'child-a', kind: 'child' as const, sortOrder: 0 },
      { id: 'adult-a', kind: 'adult' as const, sortOrder: 1 },
    ];

    expect(members.sort(compareFamilyMembers).map(({ id }) => id)).toEqual([
      'adult-a',
      'adult-z',
      'adult-b',
      'child-a',
      'child-b',
    ]);
  });
});
