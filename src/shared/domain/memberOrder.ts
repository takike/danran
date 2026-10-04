export interface SortableFamilyMember {
  id: string;
  kind: 'adult' | 'child';
  sortOrder: number;
}

/** Orders members consistently even when older rows contain duplicate sort orders. */
export function compareFamilyMembers<T extends SortableFamilyMember>(a: T, b: T): number {
  const kindOrder = (a.kind === 'adult' ? 0 : 1) - (b.kind === 'adult' ? 0 : 1);
  if (kindOrder !== 0) return kindOrder;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
