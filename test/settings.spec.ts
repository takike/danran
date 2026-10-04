import { env } from 'cloudflare:test';
import { closureDaySchema } from '@shared/schemas/closure';
import { familyDetailResponseSchema, familyErrorResponseSchema } from '@shared/schemas/family';
import {
  createClosureRangeResponseSchema,
  deleteClosureResponseSchema,
  settingsClosuresResponseSchema,
} from '@shared/schemas/settings';
import { addCalendarDays, getTodayDateKey } from '@shared/time';
import { SESSION_COOKIE_NAME } from '@worker/auth/config';
import { createSession } from '@worker/auth/session';
import { createDb } from '@worker/db';
import { closureDays, families, members, sessions, users } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { app } from '@worker/index';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { setSignedCookie } from 'hono/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'http://localhost:5173';
const SESSION_SECRET = 'settings-test-session-secret-with-enough-entropy';
const TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'settings-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'settings-google-client-secret',
  SESSION_SECRET,
  TOKEN_ENC_KEY: 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=',
};

async function signedCookie(rawToken: string): Promise<string> {
  const helper = new Hono();
  helper.get('/cookie', async (c) => {
    await setSignedCookie(c, SESSION_COOKIE_NAME, rawToken, SESSION_SECRET, {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 3600,
    });
    return c.text('ok');
  });
  const response = await helper.request('http://localhost/cookie');
  return response.headers.get('set-cookie')?.split(';')[0] ?? '';
}

describe('family settings API', () => {
  const db = createDb(env.DB);
  let callCookie = '';
  let familyId = '';
  let adultId = '';
  let childId = '';

  async function request(path: string, method = 'GET', body?: unknown, cookie = callCookie) {
    return app.request(
      `${ORIGIN}${path}`,
      {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(method === 'GET' ? {} : { Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      TEST_ENV,
    );
  }

  beforeEach(async () => {
    await db.delete(closureDays);
    await db.delete(members);
    await db.delete(families);
    await db.delete(sessions);
    await db.delete(users);

    await db.insert(users).values([
      {
        id: 'settings_owner',
        googleSub: 'settings-sub-owner',
        email: 'owner@example.test',
        displayName: 'Owner',
      },
      {
        id: 'settings_adult',
        googleSub: 'settings-sub-adult',
        email: 'adult@example.test',
        displayName: 'Adult',
      },
      {
        id: 'settings_other',
        googleSub: 'settings-sub-other',
        email: 'other@example.test',
        displayName: 'Other',
      },
      {
        id: 'settings_pending',
        googleSub: 'settings-sub-pending',
        email: 'pending@example.test',
        displayName: 'Pending',
      },
    ]);
    familyId = 'settings_family';
    adultId = 'settings_adult_member';
    childId = 'settings_child_member';
    await db.insert(families).values([
      {
        id: familyId,
        name: 'Settings Family',
        ownerUserId: 'settings_owner',
        familyCalendarId: null,
        creationStatus: 'creating',
        calendarCreationId: 'settings-create',
      },
      {
        id: 'settings_other_family',
        name: 'Other Family',
        ownerUserId: 'settings_other',
        familyCalendarId: null,
        creationStatus: 'ready',
        calendarCreationId: 'settings-create-other',
      },
    ]);
    await db.insert(members).values([
      {
        id: 'settings_owner_member',
        familyId,
        userId: 'settings_owner',
        kind: 'adult',
        name: 'Owner',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      },
      {
        id: adultId,
        familyId,
        userId: 'settings_adult',
        kind: 'adult',
        name: 'Adult',
        color: 'teal',
        sortOrder: 1,
        status: 'active',
      },
      {
        id: childId,
        familyId,
        userId: null,
        kind: 'child',
        name: 'Child',
        color: 'ochre',
        sortOrder: 2,
        status: 'active',
      },
      {
        id: 'settings_pending_member',
        familyId,
        userId: 'settings_pending',
        kind: 'adult',
        name: 'Pending',
        color: 'rose',
        sortOrder: 3,
        status: 'pending',
      },
      {
        id: 'settings_foreign_member',
        familyId: 'settings_other_family',
        userId: 'settings_other',
        kind: 'adult',
        name: 'Other',
        color: 'slate',
        sortOrder: 0,
        status: 'active',
      },
    ]);
    const session = await createSession(db, 'settings_adult');
    callCookie = await signedCookie(session.rawToken);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows a non-owner active adult to change only active same-family member name and color', async () => {
    const response = await request(`/api/families/${familyId}/members/${childId}`, 'PATCH', {
      name: 'こども',
      color: 'purple',
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = familyDetailResponseSchema.parse(await response.json());
    expect(body.family.members.map((member) => member.id)).toEqual([
      'settings_owner_member',
      adultId,
      childId,
    ]);
    const updated = body.family.members.find((member) => member.id === childId);
    expect(updated).toMatchObject({
      kind: 'child',
      userId: null,
      name: 'こども',
      color: 'purple',
      sortOrder: 2,
    });
    const stored = await db.select().from(members).where(eq(members.id, childId));
    expect(stored[0]).toMatchObject({
      familyId,
      kind: 'child',
      userId: null,
      sortOrder: 2,
      status: 'active',
    });
    expect(stored[0]?.name).toBe('こども');
    expect(stored[0]?.color).toBe('purple');

    const adultResponse = await request(`/api/families/${familyId}/members/${adultId}`, 'PATCH', {
      name: '大人の表示名',
      color: 'slate',
    });
    expect(adultResponse.status).toBe(200);
    const adultBody = familyDetailResponseSchema.parse(await adultResponse.json());
    expect(adultBody.family.members.find((member) => member.id === adultId)).toMatchObject({
      userId: 'settings_adult',
      kind: 'adult',
      name: '大人の表示名',
      color: 'slate',
      sortOrder: 1,
    });
  });

  it('returns 401 without a session, 404 for nonmembers and invalid targets, and 400 for strict input failures', async () => {
    const anonymous = await request(`/api/families/${familyId}/closures`, 'GET', undefined, '');
    expect(anonymous.status).toBe(401);
    const noMembershipSession = await createSession(db, 'settings_other');
    const noMembershipCookie = await signedCookie(noMembershipSession.rawToken);
    const nonmember = await request(
      `/api/families/${familyId}/closures`,
      'GET',
      undefined,
      noMembershipCookie,
    );
    expect(nonmember.status).toBe(404);
    const pendingSession = await createSession(db, 'settings_pending');
    const pendingCookie = await signedCookie(pendingSession.rawToken);
    const pendingCaller = await request(
      `/api/families/${familyId}/closures`,
      'GET',
      undefined,
      pendingCookie,
    );
    expect(pendingCaller.status).toBe(404);
    for (const target of ['settings_foreign_member', 'settings_pending_member', 'missing']) {
      const response = await request(`/api/families/${familyId}/members/${target}`, 'PATCH', {
        name: 'Changed',
        color: 'rose',
      });
      expect(response.status).toBe(404);
    }
    for (const body of [
      { name: ' No trim ', color: 'indigo' },
      { name: 'Valid', color: 'unknown' },
      { name: 'Valid', color: 'indigo', kind: 'adult' },
    ]) {
      const response = await request(`/api/families/${familyId}/members/${childId}`, 'PATCH', body);
      expect(response.status).toBe(400);
    }

    const noCsrf = await app.request(
      `${ORIGIN}/api/families/${familyId}/members/${childId}`,
      {
        method: 'PATCH',
        headers: { Origin: ORIGIN, Cookie: callCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Blocked', color: 'indigo' }),
      },
      TEST_ENV,
    );
    expect(noCsrf.status).toBe(403);
    expect(familyErrorResponseSchema.parse(await noCsrf.json()).code).toBe('FORBIDDEN');

    const tooLarge = await app.request(
      `${ORIGIN}/api/families/${familyId}/closures`,
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          Cookie: callCookie,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ startDate: '2026-10-10', label: 'x'.repeat(17_000), memberIds: [] }),
      },
      TEST_ENV,
    );
    expect(tooLarge.status).toBe(413);
  });

  it('creates inclusive closure ranges once, validates member IDs, and lists sorted upcoming rows', async () => {
    const startDate = addCalendarDays(getTodayDateKey(), 2);
    const endDate = addCalendarDays(startDate, 2);
    const payload = { startDate, endDate, label: '  園の休み  ', memberIds: [childId, childId] };
    const first = await request(`/api/families/${familyId}/closures`, 'POST', payload);
    expect(first.status).toBe(201);
    const created = createClosureRangeResponseSchema.parse(await first.json());
    for (const row of created.closures) closureDaySchema.parse(row);
    expect(created.closures.map((row) => row.date)).toEqual([
      startDate,
      addCalendarDays(startDate, 1),
      endDate,
    ]);
    expect(
      created.closures.every(
        (row) => row.label === '園の休み' && row.memberIds.join(',') === childId,
      ),
    ).toBe(true);

    const replay = await request(`/api/families/${familyId}/closures`, 'POST', payload);
    expect(replay.status).toBe(201);
    expect(createClosureRangeResponseSchema.parse(await replay.json()).closures).toEqual(
      created.closures,
    );
    const saved = await db.select().from(closureDays).where(eq(closureDays.familyId, familyId));
    expect(saved).toHaveLength(3);

    const reversedIds = await request(`/api/families/${familyId}/closures`, 'POST', {
      startDate,
      label: '園の休み',
      memberIds: [childId],
    });
    expect(reversedIds.status).toBe(201);
    expect(createClosureRangeResponseSchema.parse(await reversedIds.json()).closures[0]).toEqual(
      created.closures[0],
    );
    for (const body of [
      { startDate, endDate: addCalendarDays(startDate, 31), label: 'Long', memberIds: [] },
      { startDate, label: 'Invalid target', memberIds: ['settings_foreign_member'] },
      { startDate, label: 'Invalid target', memberIds: ['settings_pending_member'] },
      { startDate, label: 'Invalid date', memberIds: [], extra: true },
    ]) {
      const invalid = await request(`/api/families/${familyId}/closures`, 'POST', body);
      expect(invalid.status).toBe(400);
    }

    await db.insert(closureDays).values({
      id: 'settings_past',
      familyId,
      date: addCalendarDays(getTodayDateKey(), -1),
      label: 'Past',
      memberIds: [],
    });
    const listing = await request(`/api/families/${familyId}/closures`);
    expect(listing.status).toBe(200);
    const listed = settingsClosuresResponseSchema.parse(await listing.json());
    expect(listed.closures.map((row) => row.date)).toEqual([
      startDate,
      addCalendarDays(startDate, 1),
      endDate,
    ]);
    expect(listed.hasMore).toBe(false);
  });

  it('accepts exactly 31 days, rejects overlong ranges, and deletes only same-family rows idempotently', async () => {
    const startDate = addCalendarDays(getTodayDateKey(), 1);
    const response = await request(`/api/families/${familyId}/closures`, 'POST', {
      startDate,
      endDate: addCalendarDays(startDate, 30),
      label: '31 days',
      memberIds: [],
    });
    expect(response.status).toBe(201);
    expect(createClosureRangeResponseSchema.parse(await response.json()).closures).toHaveLength(31);

    await db.insert(closureDays).values({
      id: 'foreign_closure',
      familyId: 'settings_other_family',
      date: startDate,
      label: 'Foreign',
      memberIds: [],
    });
    const foreignDelete = await request(
      `/api/families/${familyId}/closures/foreign_closure`,
      'DELETE',
    );
    expect(foreignDelete.status).toBe(200);
    expect(deleteClosureResponseSchema.parse(await foreignDelete.json())).toEqual({ ok: true });
    expect(
      await db.select().from(closureDays).where(eq(closureDays.id, 'foreign_closure')),
    ).toHaveLength(1);
    const missingDelete = await request(`/api/families/${familyId}/closures/absent`, 'DELETE');
    expect(missingDelete.status).toBe(200);
    const firstId = (
      await db
        .select()
        .from(closureDays)
        .where(and(eq(closureDays.familyId, familyId), eq(closureDays.date, startDate)))
    )[0]?.id;
    if (!firstId) throw new Error('Expected inserted closure');
    const ownedDelete = await request(`/api/families/${familyId}/closures/${firstId}`, 'DELETE');
    expect(ownedDelete.status).toBe(200);
    expect(deleteClosureResponseSchema.parse(await ownedDelete.json())).toEqual({ ok: true });
    expect(await db.select().from(closureDays).where(eq(closureDays.id, firstId))).toHaveLength(0);
  });

  it('deduplicates legacy rows regardless of target ID order and concurrent identical submissions', async () => {
    const startDate = addCalendarDays(getTodayDateKey(), 3);
    const legacy = {
      id: 'legacy-closure-random-id',
      familyId,
      date: startDate,
      label: 'Same targets',
      memberIds: ['settings_owner_member', childId],
    };
    await db.insert(closureDays).values(legacy);
    const legacyRequest = await request(`/api/families/${familyId}/closures`, 'POST', {
      startDate,
      label: 'Same targets',
      memberIds: [childId, 'settings_owner_member', childId],
    });
    expect(createClosureRangeResponseSchema.parse(await legacyRequest.json()).closures[0]?.id).toBe(
      legacy.id,
    );
    expect(await db.select().from(closureDays).where(eq(closureDays.date, startDate))).toHaveLength(
      1,
    );

    const concurrentDate = addCalendarDays(startDate, 1);
    const payload = { startDate: concurrentDate, label: 'Concurrent', memberIds: [childId] };
    const [first, second] = await Promise.all([
      request(`/api/families/${familyId}/closures`, 'POST', payload),
      request(`/api/families/${familyId}/closures`, 'POST', payload),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstRow = createClosureRangeResponseSchema.parse(await first.json()).closures[0];
    const secondRow = createClosureRangeResponseSchema.parse(await second.json()).closures[0];
    expect(firstRow?.id).toBe(secondRow?.id);
    expect(
      await db.select().from(closureDays).where(eq(closureDays.date, concurrentDate)),
    ).toHaveLength(1);
  });

  it('limits the closure list to 200 while including today and reporting more rows', async () => {
    const today = getTodayDateKey();
    const statements = Array.from({ length: 201 }, (_, index) =>
      db.insert(closureDays).values({
        id: `settings_list_${String(index).padStart(3, '0')}`,
        familyId,
        date: index === 0 ? today : addCalendarDays(today, 1),
        label: `Closure ${index}`,
        memberIds: [],
      }),
    );
    await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
    const response = await request(`/api/families/${familyId}/closures`);
    expect(response.status).toBe(200);
    const result = settingsClosuresResponseSchema.parse(await response.json());
    expect(result.closures).toHaveLength(200);
    expect(result.closures[0]?.date).toBe(today);
    expect(result.hasMore).toBe(true);
  });

  it('validates all 100 supported member targets in binding-safe chunks', async () => {
    const targetIds = Array.from({ length: 100 }, (_, index) => `settings_extra_child_${index}`);
    const rows = targetIds.map((id, index) => ({
      id,
      familyId,
      userId: null,
      kind: 'child' as const,
      name: `Child ${index}`,
      color: 'green' as const,
      sortOrder: index + 10,
      status: 'active' as const,
    }));
    for (let index = 0; index < rows.length; index += 50) {
      const batch = rows.slice(index, index + 50).map((row) => db.insert(members).values(row));
      await db.batch(batch as [(typeof batch)[number], ...typeof batch]);
    }

    const startDate = addCalendarDays(getTodayDateKey(), 5);
    const response = await request(`/api/families/${familyId}/closures`, 'POST', {
      startDate,
      label: 'Large member set',
      memberIds: [...targetIds].reverse(),
    });
    expect(response.status).toBe(201);
    expect(
      createClosureRangeResponseSchema.parse(await response.json()).closures[0]?.memberIds,
    ).toEqual([...targetIds].sort());
  });

  it('performs no external fetches and rejects unsupported years, invalid dates, and reversed ranges', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({})));
    vi.stubGlobal('fetch', fetchMock);
    for (const startDate of ['1969-12-31', '2051-01-01', '2026-02-30']) {
      const response = await request(`/api/families/${familyId}/closures`, 'POST', {
        startDate,
        label: 'Invalid',
        memberIds: [],
      });
      expect(response.status).toBe(400);
    }
    const reversed = await request(`/api/families/${familyId}/closures`, 'POST', {
      startDate: '2026-10-11',
      endDate: '2026-10-10',
      label: 'Invalid',
      memberIds: [],
    });
    expect(reversed.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
