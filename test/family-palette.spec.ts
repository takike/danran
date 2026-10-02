import { env } from 'cloudflare:test';
import {
  MEMBER_COLORS,
  MEMBER_COLOR_LABELS,
  type MemberColor,
  memberColorSchema,
  reconcileFamilyInputSchema,
  reconcileFamilyResponseSchema,
} from '@shared/schemas/family';
import {
  aclListOptionsSchema,
  googleAclListPageResponseSchema,
  googleCalendarListEntrySchema,
} from '@shared/schemas/google-calendar';
import { createDb } from '@worker/db';
import { families, googleTokens, members, oauthStates, sessions, users } from '@worker/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function required<T>(value: T | null | undefined, message = 'Required value missing'): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

describe('PR-11: Neutral Member Palette, Schema Validation & Database Constraints', () => {
  const db = createDb(env.DB);

  beforeEach(async () => {
    await db.delete(oauthStates);
    await db.delete(sessions);
    await db.delete(googleTokens);
    await db.delete(members);
    await db.delete(families);
    await db.delete(users);
  });

  afterEach(async () => {
    try {
      await db.delete(oauthStates);
      await db.delete(sessions);
      await db.delete(googleTokens);
      await db.delete(members);
      await db.delete(families);
      await db.delete(users);
    } catch {
      // Ignore cleanup error
    }
  });

  describe('1. Shared Palette Enum & Japanese Labels', () => {
    it('defines exactly the 8 neutral colors in the specified order', () => {
      const expectedColors: readonly MemberColor[] = [
        'indigo',
        'green',
        'ochre',
        'purple',
        'coral',
        'teal',
        'rose',
        'slate',
      ];
      expect(MEMBER_COLORS).toEqual(expectedColors);
      expect(MEMBER_COLORS.length).toBe(8);
    });

    it('memberColorSchema accepts all 8 neutral colors', () => {
      for (const color of MEMBER_COLORS) {
        const parsed = memberColorSchema.safeParse(color);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data).toBe(color);
        }
      }
    });

    it('memberColorSchema strictly rejects legacy role-based and invalid colors', () => {
      const legacyRoles = ['papa', 'mama', 'daughter', 'son', 'father', 'mother', 'child'];
      for (const legacy of legacyRoles) {
        const parsed = memberColorSchema.safeParse(legacy);
        expect(parsed.success).toBe(false);
      }

      expect(memberColorSchema.safeParse('').success).toBe(false);
      expect(memberColorSchema.safeParse('red').success).toBe(false);
      expect(memberColorSchema.safeParse(123).success).toBe(false);
      expect(memberColorSchema.safeParse(null).success).toBe(false);
    });

    it('MEMBER_COLOR_LABELS maps all 8 neutral colors to exact Japanese names', () => {
      expect(MEMBER_COLOR_LABELS.indigo).toBe('藍');
      expect(MEMBER_COLOR_LABELS.green).toBe('深緑');
      expect(MEMBER_COLOR_LABELS.ochre).toBe('黄土');
      expect(MEMBER_COLOR_LABELS.purple).toBe('紫');
      expect(MEMBER_COLOR_LABELS.coral).toBe('珊瑚');
      expect(MEMBER_COLOR_LABELS.teal).toBe('青緑');
      expect(MEMBER_COLOR_LABELS.rose).toBe('薔薇');
      expect(MEMBER_COLOR_LABELS.slate).toBe('石板');
      expect(Object.keys(MEMBER_COLOR_LABELS).length).toBe(8);
    });

    it('reconcileFamilyInputSchema validates empty object strictly', () => {
      expect(reconcileFamilyInputSchema.safeParse({}).success).toBe(true);
      expect(reconcileFamilyInputSchema.safeParse({ extra: 'field' }).success).toBe(false);
      expect(reconcileFamilyInputSchema.safeParse(null).success).toBe(false);
    });

    it('reconcileFamilyResponseSchema validates compliant familyDetail payload', () => {
      const validPayload = {
        family: {
          id: 'fam_12345',
          name: '我が家',
          familyCalendarId: 'cal_abcdef',
          ownerUserId: 'usr_owner',
          creationStatus: 'ready',
          members: [
            {
              id: 'mem_1',
              userId: 'usr_owner',
              kind: 'adult',
              name: '太郎',
              color: 'indigo',
              sortOrder: 0,
            },
          ],
        },
      };
      const result = reconcileFamilyResponseSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });
  });

  describe('2. D1 Database Palette & CHECK Constraints', () => {
    it('successfully persists members with each of the 8 neutral colors', async () => {
      const ownerId = `usr_${crypto.randomUUID()}`;
      await db.insert(users).values({
        id: ownerId,
        googleSub: `sub-${crypto.randomUUID()}`,
        email: 'owner@example.test',
        displayName: 'オーナー',
      });

      const familyId = `fam_${crypto.randomUUID()}`;
      await db.insert(families).values({
        id: familyId,
        name: 'カラーテスト家族',
        ownerUserId: ownerId,
        creationStatus: 'ready',
      });

      // Insert 8 members (1 adult owner + 7 children) covering all 8 colors
      for (let i = 0; i < MEMBER_COLORS.length; i++) {
        const color = required(MEMBER_COLORS[i]);
        const memberId = `mem_${crypto.randomUUID()}`;
        if (i === 0) {
          await db.insert(members).values({
            id: memberId,
            familyId,
            userId: ownerId,
            kind: 'adult',
            name: `メンバー_${color}`,
            color,
            sortOrder: i,
            status: 'active',
          });
        } else {
          await db.insert(members).values({
            id: memberId,
            familyId,
            userId: null,
            kind: 'child',
            name: `メンバー_${color}`,
            color,
            sortOrder: i,
            status: 'active',
          });
        }
      }

      const memberRows = await db.select().from(members).where(eq(members.familyId, familyId));
      expect(memberRows.length).toBe(8);

      const insertedColors = memberRows.map((m) => m.color).sort();
      const expectedSorted = [...MEMBER_COLORS].sort();
      expect(insertedColors).toEqual(expectedSorted);
    });

    it('rejects insertion of legacy role colors and invalid strings via CHECK constraint', async () => {
      const ownerId = `usr_${crypto.randomUUID()}`;
      await db.insert(users).values({
        id: ownerId,
        googleSub: `sub-${crypto.randomUUID()}`,
        email: 'owner@example.test',
        displayName: 'オーナー',
      });

      const familyId = `fam_${crypto.randomUUID()}`;
      await db.insert(families).values({
        id: familyId,
        name: '制約テスト家族',
        ownerUserId: ownerId,
        creationStatus: 'ready',
      });

      // Attempt inserting legacy role 'papa'
      await expect(
        db.insert(members).values({
          id: `mem_${crypto.randomUUID()}`,
          familyId,
          userId: ownerId,
          kind: 'adult',
          name: 'パパ',
          color: 'papa' as unknown as MemberColor,
          sortOrder: 0,
          status: 'active',
        }),
      ).rejects.toThrow();

      // Attempt inserting arbitrary color 'invalid_color'
      await expect(
        db.insert(members).values({
          id: `mem_${crypto.randomUUID()}`,
          familyId,
          userId: null,
          kind: 'child',
          name: '子ども',
          color: 'invalid_color' as unknown as MemberColor,
          sortOrder: 1,
          status: 'active',
        }),
      ).rejects.toThrow();
    });
  });

  describe('3. D1 Database calendarCreationId Default & Persistence', () => {
    it('automatically generates a 32-character hex calendarCreationId when not specified', async () => {
      const ownerId = `usr_${crypto.randomUUID()}`;
      await db.insert(users).values({
        id: ownerId,
        googleSub: `sub-${crypto.randomUUID()}`,
        email: 'owner@example.test',
        displayName: 'オーナー',
      });

      const familyId = `fam_${crypto.randomUUID()}`;
      await db.insert(families).values({
        id: familyId,
        name: '自動生成テスト家族',
        ownerUserId: ownerId,
        creationStatus: 'creating',
      });

      const familyRows = await db.select().from(families).where(eq(families.id, familyId));
      expect(familyRows.length).toBe(1);
      const row = required(familyRows[0]);
      expect(row.calendarCreationId).toBeDefined();
      expect(typeof row.calendarCreationId).toBe('string');
      expect(row.calendarCreationId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('persists explicit calendarCreationId when provided', async () => {
      const ownerId = `usr_${crypto.randomUUID()}`;
      await db.insert(users).values({
        id: ownerId,
        googleSub: `sub-${crypto.randomUUID()}`,
        email: 'owner@example.test',
        displayName: 'オーナー',
      });

      const explicitCreationId = 'custom_creation_id_12345';
      const familyId = `fam_${crypto.randomUUID()}`;
      await db.insert(families).values({
        id: familyId,
        name: '明示指定テスト家族',
        ownerUserId: ownerId,
        calendarCreationId: explicitCreationId,
        creationStatus: 'creating',
      });

      const familyRows = await db.select().from(families).where(eq(families.id, familyId));
      const row = required(familyRows[0]);
      expect(row.calendarCreationId).toBe(explicitCreationId);
    });
  });

  describe('4. Google Calendar Schema Extensions', () => {
    it('googleCalendarListEntrySchema parses description and dataOwner without stripping', () => {
      const rawEntry = {
        id: 'cal_danran_family_1',
        summary: 'Danran（家族名）',
        description: 'danran-family:fam_123;creation:abcde12345',
        dataOwner: 'owner@example.test',
        timeZone: 'Asia/Tokyo',
        accessRole: 'owner',
      };

      const parsed = googleCalendarListEntrySchema.parse(rawEntry);
      expect(parsed.id).toBe('cal_danran_family_1');
      expect(parsed.summary).toBe('Danran（家族名）');
      expect(parsed.description).toBe('danran-family:fam_123;creation:abcde12345');
      expect(parsed.dataOwner).toBe('owner@example.test');
      expect(parsed.accessRole).toBe('owner');
    });

    it('aclListOptionsSchema validates maxResults range (1..250) and pageToken strictly', () => {
      expect(aclListOptionsSchema.parse({ maxResults: 1 }).maxResults).toBe(1);
      expect(aclListOptionsSchema.parse({ maxResults: 250 }).maxResults).toBe(250);
      expect(aclListOptionsSchema.parse({ maxResults: 100, pageToken: 'p1' })).toEqual({
        maxResults: 100,
        pageToken: 'p1',
      });

      expect(aclListOptionsSchema.safeParse({ maxResults: 0 }).success).toBe(false);
      expect(aclListOptionsSchema.safeParse({ maxResults: 251 }).success).toBe(false);
      expect(aclListOptionsSchema.safeParse({ maxResults: -5 }).success).toBe(false);
      expect(aclListOptionsSchema.safeParse({ unknownField: true }).success).toBe(false);
    });

    it('googleAclListPageResponseSchema parses items and optional nextPageToken', () => {
      const rawAclPage = {
        items: [
          {
            id: 'user:member@example.test',
            role: 'writer',
            scope: {
              type: 'user',
              value: 'member@example.test',
            },
          },
        ],
        nextPageToken: 'next_page_token_xyz',
      };

      const parsed = googleAclListPageResponseSchema.parse(rawAclPage);
      expect(parsed.items.length).toBe(1);
      const rule = required(parsed.items[0]);
      expect(rule.role).toBe('writer');
      expect(rule.scope.value).toBe('member@example.test');
      expect(parsed.nextPageToken).toBe('next_page_token_xyz');
    });
  });
});
