import { env } from 'cloudflare:test';
import { closureDaySchema, createClosureDaySchema } from '@shared/schemas/closure';
import { type Database, closureDays, createDb } from '@worker/db';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('closureDays schema & D1 storage', () => {
  let db: Database;

  beforeEach(() => {
    db = createDb(env.DB);
  });

  afterEach(async () => {
    await db.delete(closureDays);
  });

  describe('Zod boundary schemas', () => {
    it('validates a complete closure day record and preserves exact IDs', () => {
      const valid = {
        id: 'cls_01',
        familyId: 'fam_01',
        date: '2026-10-06',
        label: 'Autumn Daycare In-Service',
        memberIds: ['mem_child_1'],
      };
      const parsed = closureDaySchema.parse(valid);
      expect(parsed).toEqual(valid);
      expect(parsed.id).toBe('cls_01');
      expect(parsed.familyId).toBe('fam_01');
      expect(parsed.memberIds).toEqual(['mem_child_1']);
    });

    it('rejects stored closure records with missing memberIds', () => {
      // Stored data must explicitly require memberIds to prevent silent family-wide expansion
      expect(() =>
        closureDaySchema.parse({
          id: 'cls_01',
          familyId: 'fam_01',
          date: '2026-10-06',
          label: 'Daycare Holiday',
        }),
      ).toThrow();
    });

    it('createClosureDaySchema defaults memberIds to empty array when omitted', () => {
      const input = {
        familyId: 'fam_01',
        date: '2026-10-06',
        label: 'Nursery Founder Holiday',
      };
      const parsed = createClosureDaySchema.parse(input);
      expect(parsed.memberIds).toEqual([]);
    });

    it('rejects identifiers with leading or trailing whitespace', () => {
      const base = {
        id: 'cls_01',
        familyId: 'fam_01',
        date: '2026-10-06',
        label: 'Staff Training',
        memberIds: ['mem_01'],
      };

      expect(() => closureDaySchema.parse({ ...base, id: ' cls_01' })).toThrow();
      expect(() => closureDaySchema.parse({ ...base, id: 'cls_01 ' })).toThrow();
      expect(() => closureDaySchema.parse({ ...base, familyId: ' fam_01' })).toThrow();
      expect(() => closureDaySchema.parse({ ...base, memberIds: [' mem_01'] })).toThrow();
    });

    it('rejects blank labels and invalid dates', () => {
      expect(() =>
        closureDaySchema.parse({
          id: 'cls_01',
          familyId: 'fam_01',
          date: '2026-02-30', // Invalid calendar date
          label: 'Daycare Holiday',
          memberIds: [],
        }),
      ).toThrow();

      expect(() =>
        closureDaySchema.parse({
          id: 'cls_01',
          familyId: 'fam_01',
          date: '2026-10-06',
          label: '   ', // Blank label
          memberIds: [],
        }),
      ).toThrow();
    });

    it('rejects duplicate memberIds', () => {
      expect(() =>
        createClosureDaySchema.parse({
          familyId: 'fam_01',
          date: '2026-10-06',
          label: 'School Trip Closure',
          memberIds: ['mem_child_1', 'mem_child_1'],
        }),
      ).toThrow();
    });

    it('rejects unknown fields on creation (.strict())', () => {
      expect(() =>
        createClosureDaySchema.parse({
          familyId: 'fam_01',
          date: '2026-10-06',
          label: 'School Trip Closure',
          unknownField: 'unexpected',
        }),
      ).toThrow();
    });
  });

  describe('D1 table CRUD and JSON array roundtrip', () => {
    it('inserts and queries closureDays with JSON member_ids array', async () => {
      const synthFamilyId = 'fam_synth_closure_test';

      const familyWideRecord = {
        id: 'cls_synth_fam_wide',
        familyId: synthFamilyId,
        date: '2026-10-06',
        label: 'Daycare Construction Day',
        memberIds: [] as string[],
      };

      const memberSpecificRecord = {
        id: 'cls_synth_member_spec',
        familyId: synthFamilyId,
        date: '2026-10-07',
        label: 'Kindergarten Parent Observation',
        memberIds: ['mem_child_1', 'mem_child_2'],
      };

      // 1. Insert
      await db.insert(closureDays).values(familyWideRecord);
      await db.insert(closureDays).values(memberSpecificRecord);

      // 2. Select with composite familyId + date filter
      const foundFamilyWide = await db
        .select()
        .from(closureDays)
        .where(and(eq(closureDays.familyId, synthFamilyId), eq(closureDays.date, '2026-10-06')));

      expect(foundFamilyWide).toHaveLength(1);
      expect(foundFamilyWide[0]?.label).toBe('Daycare Construction Day');
      expect(foundFamilyWide[0]?.memberIds).toEqual([]);

      const foundMemberSpec = await db
        .select()
        .from(closureDays)
        .where(and(eq(closureDays.familyId, synthFamilyId), eq(closureDays.date, '2026-10-07')));

      expect(foundMemberSpec).toHaveLength(1);
      expect(foundMemberSpec[0]?.label).toBe('Kindergarten Parent Observation');
      expect(foundMemberSpec[0]?.memberIds).toEqual(['mem_child_1', 'mem_child_2']);

      // 3. Delete fixture
      await db.delete(closureDays).where(eq(closureDays.familyId, synthFamilyId));

      const afterDelete = await db
        .select()
        .from(closureDays)
        .where(eq(closureDays.familyId, synthFamilyId));
      expect(afterDelete).toHaveLength(0);
    });
  });
});
