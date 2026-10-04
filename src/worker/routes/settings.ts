import { canonicalClosureMemberIds, expandClosureDateRange } from '@shared/domain/closureRange';
import { compareFamilyMembers } from '@shared/domain/memberOrder';
import { closureDaySchema } from '@shared/schemas/closure';
import {
  type FamilyCreationStatus,
  type MemberColor,
  type MemberKind,
  familyDetailResponseSchema,
  familyErrorResponseSchema,
  familyIdSchema,
} from '@shared/schemas/family';
import {
  createClosureRangeInputSchema,
  createClosureRangeResponseSchema,
  deleteClosureResponseSchema,
  settingsClosuresResponseSchema,
  updateMemberInputSchema,
} from '@shared/schemas/settings';
import { getTodayDateKey } from '@shared/time/date';
import { getAuthConfig } from '@worker/auth/config';
import { getSessionUser } from '@worker/auth/session';
import { createDb } from '@worker/db';
import { closureDays, families, members } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { familySecurityMiddleware } from './families';

const MAX_CLOSURES = 200;
const MAX_MEMBER_IDS = 100;
type ClosureRecord = typeof closureDays.$inferSelect;
const bodyLimit16KiB = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) =>
    c.json(
      familyErrorResponseSchema.parse({ error: 'Payload Too Large', code: 'INVALID_INPUT' }),
      413,
    ),
});

type RouteContext = Context<{ Bindings: WorkerEnv }>;
type ErrorStatus = 400 | 401 | 404 | 413 | 500;
type ErrorCode = 'INVALID_INPUT' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'INTERNAL_ERROR';

export const settingsRoute = new Hono<{ Bindings: WorkerEnv }>();
settingsRoute.use('*', familySecurityMiddleware);

function errorResponse(c: RouteContext, status: ErrorStatus, code: ErrorCode) {
  const error = {
    INVALID_INPUT: 'Invalid settings request',
    UNAUTHORIZED: 'Unauthorized',
    NOT_FOUND: 'Family or member not found',
    INTERNAL_ERROR: 'Internal server error',
  }[code];
  return c.json(familyErrorResponseSchema.parse({ error, code }), status);
}

async function authorizeFamilyAdult(c: RouteContext) {
  const db = createDb(c.env.DB);
  const config = getAuthConfig(c.env);
  const session = await getSessionUser(c, db, config.sessionSecret);
  if (!session) return { response: errorResponse(c, 401, 'UNAUTHORIZED') } as const;

  const parsedFamilyId = familyIdSchema.safeParse(c.req.param('id'));
  if (!parsedFamilyId.success) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;

  const familyRows = await db.select().from(families).where(eq(families.id, parsedFamilyId.data));
  const family = familyRows[0];
  if (!family) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;

  const callerRows = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.familyId, family.id),
        eq(members.userId, session.user.id),
        eq(members.status, 'active'),
        eq(members.kind, 'adult'),
      ),
    );
  if (!callerRows[0]) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;

  return { db, family, caller: callerRows[0] } as const;
}

function mapFamily(
  family: typeof families.$inferSelect,
  activeMembers: (typeof members.$inferSelect)[],
) {
  return {
    id: family.id,
    name: family.name,
    familyCalendarId: family.familyCalendarId,
    ownerUserId: family.ownerUserId,
    creationStatus: family.creationStatus as FamilyCreationStatus,
    members: [...activeMembers].sort(compareFamilyMembers).map((member) => ({
      id: member.id,
      userId: member.userId,
      kind: member.kind as MemberKind,
      name: member.name,
      color: member.color as MemberColor,
      sortOrder: member.sortOrder,
    })),
  };
}

async function activeFamilyMembers(db: ReturnType<typeof createDb>, familyId: string) {
  return db
    .select()
    .from(members)
    .where(and(eq(members.familyId, familyId), eq(members.status, 'active')));
}

function isOpaqueId(value: string): boolean {
  return value.length > 0 && value === value.trim() && !value.includes('/');
}

function canonicalMembersKey(ids: readonly string[]): string {
  return JSON.stringify(canonicalClosureMemberIds(ids));
}

async function deterministicClosureId(
  familyId: string,
  date: string,
  label: string,
  memberIds: readonly string[],
): Promise<string> {
  const key = JSON.stringify([
    'danran-closure',
    familyId,
    date,
    label,
    canonicalClosureMemberIds(memberIds),
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function findMatchingClosures(
  rows: ClosureRecord[],
  dates: readonly string[],
  label: string,
  memberIds: readonly string[],
) {
  const targetKey = canonicalMembersKey(memberIds);
  const matches = new Map<string, ClosureRecord>();
  for (const row of rows) {
    if (
      !dates.includes(row.date) ||
      row.label !== label ||
      !Array.isArray(row.memberIds) ||
      !row.memberIds.every((id) => typeof id === 'string') ||
      canonicalMembersKey(row.memberIds) !== targetKey
    ) {
      continue;
    }
    const current = matches.get(row.date);
    if (!current || row.id < current.id) matches.set(row.date, row);
  }
  return matches;
}

settingsRoute.patch('/:id/members/:memberId', bodyLimit16KiB, async (c) => {
  const auth = await authorizeFamilyAdult(c);
  if ('response' in auth) return auth.response;

  const memberId = c.req.param('memberId');
  if (!isOpaqueId(memberId)) return errorResponse(c, 404, 'NOT_FOUND');
  const targetRows = await auth.db
    .select()
    .from(members)
    .where(
      and(
        eq(members.id, memberId),
        eq(members.familyId, auth.family.id),
        eq(members.status, 'active'),
      ),
    );
  if (!targetRows[0]) return errorResponse(c, 404, 'NOT_FOUND');

  const body = updateMemberInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return errorResponse(c, 400, 'INVALID_INPUT');
  await auth.db
    .update(members)
    .set({ name: body.data.name, color: body.data.color })
    .where(
      and(
        eq(members.id, targetRows[0].id),
        eq(members.familyId, auth.family.id),
        eq(members.status, 'active'),
      ),
    );
  const rows = await activeFamilyMembers(auth.db, auth.family.id);
  return c.json(familyDetailResponseSchema.parse({ family: mapFamily(auth.family, rows) }), 200);
});

settingsRoute.get('/:id/closures', async (c) => {
  const auth = await authorizeFamilyAdult(c);
  if ('response' in auth) return auth.response;

  const rows = await auth.db
    .select()
    .from(closureDays)
    .where(and(eq(closureDays.familyId, auth.family.id), gte(closureDays.date, getTodayDateKey())))
    .orderBy(asc(closureDays.date), asc(closureDays.id))
    .limit(MAX_CLOSURES + 1);
  const hasMore = rows.length > MAX_CLOSURES;
  const closures = rows.slice(0, MAX_CLOSURES).map((row) => closureDaySchema.parse(row));
  return c.json(settingsClosuresResponseSchema.parse({ closures, hasMore }), 200);
});

settingsRoute.post('/:id/closures', bodyLimit16KiB, async (c) => {
  const auth = await authorizeFamilyAdult(c);
  if ('response' in auth) return auth.response;

  const body = createClosureRangeInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return errorResponse(c, 400, 'INVALID_INPUT');
  if (body.data.memberIds.length > MAX_MEMBER_IDS) return errorResponse(c, 400, 'INVALID_INPUT');

  let dates: string[];
  try {
    dates = expandClosureDateRange(body.data.startDate, body.data.endDate);
  } catch {
    return errorResponse(c, 400, 'INVALID_INPUT');
  }

  const memberIds = canonicalClosureMemberIds(body.data.memberIds);
  if (memberIds.length > 0) {
    const activeIds = new Set<string>();
    for (let offset = 0; offset < memberIds.length; offset += 98) {
      const chunk = memberIds.slice(offset, offset + 98);
      const activeRows = await auth.db
        .select({ id: members.id })
        .from(members)
        .where(
          and(
            eq(members.familyId, auth.family.id),
            eq(members.status, 'active'),
            inArray(members.id, chunk),
          ),
        );
      for (const row of activeRows) activeIds.add(row.id);
    }
    if (memberIds.some((id) => !activeIds.has(id))) return errorResponse(c, 400, 'INVALID_INPUT');
  }

  const existingRows = await auth.db
    .select()
    .from(closureDays)
    .where(and(eq(closureDays.familyId, auth.family.id), inArray(closureDays.date, dates)))
    .orderBy(asc(closureDays.date), asc(closureDays.id));
  const matching = findMatchingClosures(existingRows, dates, body.data.label, memberIds);
  const newRows: (typeof closureDays.$inferInsert)[] = [];
  for (const date of dates) {
    if (matching.has(date)) continue;
    newRows.push({
      id: await deterministicClosureId(auth.family.id, date, body.data.label, memberIds),
      familyId: auth.family.id,
      date,
      label: body.data.label,
      memberIds,
    });
  }

  if (newRows.length > 0) {
    const statements = newRows.map((row) =>
      auth.db.insert(closureDays).values(row).onConflictDoNothing({ target: closureDays.id }),
    );
    await auth.db.batch(statements as [(typeof statements)[number], ...typeof statements]);
  }

  const savedRows =
    newRows.length === 0
      ? existingRows
      : await auth.db
          .select()
          .from(closureDays)
          .where(and(eq(closureDays.familyId, auth.family.id), inArray(closureDays.date, dates)))
          .orderBy(asc(closureDays.date), asc(closureDays.id));
  const savedMatching = findMatchingClosures(savedRows, dates, body.data.label, memberIds);
  const closures = dates.map((date) => {
    const row = savedMatching.get(date);
    if (!row) throw new Error('Closure row could not be persisted');
    return closureDaySchema.parse(row);
  });
  return c.json(createClosureRangeResponseSchema.parse({ closures }), 201);
});

settingsRoute.delete('/:id/closures/:closureId', bodyLimit16KiB, async (c) => {
  const auth = await authorizeFamilyAdult(c);
  if ('response' in auth) return auth.response;
  const closureId = c.req.param('closureId');
  if (!isOpaqueId(closureId)) return errorResponse(c, 404, 'NOT_FOUND');

  await auth.db
    .delete(closureDays)
    .where(and(eq(closureDays.id, closureId), eq(closureDays.familyId, auth.family.id)));
  return c.json(deleteClosureResponseSchema.parse({ ok: true }), 200);
});
