import { describe, expect, it } from 'vitest';
import { canonicalClosureMemberIds, expandClosureDateRange } from './closureRange';

describe('expandClosureDateRange', () => {
  it('expands a single day and an inclusive range', () => {
    expect(expandClosureDateRange('2026-10-04')).toEqual(['2026-10-04']);
    expect(expandClosureDateRange('2026-10-04', '2026-10-06')).toEqual([
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
    ]);
  });

  it('handles leap days and the maximum range', () => {
    expect(expandClosureDateRange('2028-02-28', '2028-03-01')).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
    expect(expandClosureDateRange('2026-01-01', '2026-01-31')).toHaveLength(31);
  });

  it('rejects invalid, reversed, overlong, and unsupported dates', () => {
    expect(() => expandClosureDateRange('2026-02-30')).toThrow();
    expect(() => expandClosureDateRange('2026-10-05', '2026-10-04')).toThrow(RangeError);
    expect(() => expandClosureDateRange('2026-01-01', '2026-02-01')).toThrow(RangeError);
    expect(() => expandClosureDateRange('1969-12-31')).toThrow(RangeError);
    expect(() => expandClosureDateRange('2051-01-01')).toThrow(RangeError);
  });
});

describe('canonicalClosureMemberIds', () => {
  it('deduplicates and sorts target IDs so order does not affect identity', () => {
    expect(canonicalClosureMemberIds(['member-b', 'member-a', 'member-b'])).toEqual([
      'member-a',
      'member-b',
    ]);
  });
});
