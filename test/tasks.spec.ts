import { env } from 'cloudflare:test';
import { taskListResponseSchema, taskMutationResponseSchema } from '@shared/schemas/tasks';
import { SESSION_COOKIE_NAME } from '@worker/auth/config';
import { encryptAesGcm } from '@worker/auth/crypto';
import { createSession } from '@worker/auth/session';
import { createDb } from '@worker/db';
import {
  eventMeta,
  families,
  googleTokens,
  members,
  sessions,
  tasks,
  users,
} from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { app } from '@worker/index';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { setSignedCookie } from 'hono/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'http://localhost:5173';
const SESSION_SECRET = 'tasks-test-session-secret-with-enough-entropy';
const AES_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const CALENDAR_ID = 'family_calendar_tasks';
const EVENT_ID = 'task_event_0001';
const TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'tasks-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'tasks-google-client-secret',
  SESSION_SECRET,
  TOKEN_ENC_KEY: AES_KEY,
};

describe('Task 5-1 task API', () => {
  const db = createDb(env.DB);
  const storedEvents = new Map<string, Record<string, unknown>>();
  const googleRequests: string[] = [];
  const refreshTokens: string[] = [];
  let failList = false;
  let repeatedPageToken = false;
  let cookie = '';

  beforeEach(async () => {
    storedEvents.clear();
    googleRequests.length = 0;
    refreshTokens.length = 0;
    failList = false;
    repeatedPageToken = false;
    await db.delete(tasks);
    await db.delete(eventMeta);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);

    await db.insert(users).values({
      id: 'usr_task_caller',
      googleSub: 'sub-task-caller',
      email: 'caller@example.test',
      displayName: 'Caller',
    });
    await db.insert(users).values({
      id: 'usr_task_owner',
      googleSub: 'sub-task-owner',
      email: 'owner@example.test',
      displayName: 'Owner',
    });
    const refreshTokenEnc = await encryptAesGcm(
      'task-caller-refresh-token',
      AES_KEY,
      'google-refresh:usr_task_caller',
    );
    await db.insert(googleTokens).values({
      userId: 'usr_task_caller',
      refreshTokenEnc,
      scopes: 'openid email profile https://www.googleapis.com/auth/calendar.app.created',
    });
    await db.insert(families).values({
      id: 'fam_tasks',
      name: 'テスト家族',
      ownerUserId: 'usr_task_owner',
      familyCalendarId: CALENDAR_ID,
      creationStatus: 'ready',
    });
    await db.insert(members).values([
      {
        id: 'mem_task_owner',
        familyId: 'fam_tasks',
        userId: 'usr_task_owner',
        kind: 'adult',
        name: 'オーナー',
        color: 'purple',
        sortOrder: 0,
        status: 'active',
      },
      {
        id: 'mem_task_adult',
        familyId: 'fam_tasks',
        userId: 'usr_task_caller',
        kind: 'adult',
        name: '大人',
        color: 'indigo',
        sortOrder: 0,
        status: 'active',
      },
      {
        id: 'mem_task_child',
        familyId: 'fam_tasks',
        userId: null,
        kind: 'child',
        name: '子ども',
        color: 'green',
        sortOrder: 1,
        status: 'active',
      },
    ]);
    const { rawToken } = await createSession(db, 'usr_task_caller');
    const cookieApp = new Hono();
    cookieApp.get('/', async (c) => {
      await setSignedCookie(c, SESSION_COOKIE_NAME, rawToken, SESSION_SECRET, {
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      });
      return c.text('ok');
    });
    cookie =
      (await (await cookieApp.request('http://localhost/')).headers.get('set-cookie'))?.split(
        ';',
      )[0] ?? '';

    storedEvents.set(EVENT_ID, {
      id: EVENT_ID,
      status: 'confirmed',
      summary: '運動会',
      description: 'private description',
      location: 'private location',
      attendees: [{ email: 'private@example.test' }],
      creator: { email: 'creator@example.test' },
      start: { dateTime: '2026-10-05T00:00:00Z' },
      end: { dateTime: '2026-10-05T01:00:00Z' },
      extendedProperties: {
        private: { danran: '1', members: 'mem_task_child', secret: 'do-not-return' },
      },
    });
    await db.insert(eventMeta).values({
      id: 'meta_tasks_event',
      familyId: 'fam_tasks',
      calendarId: CALENDAR_ID,
      eventId: EVENT_ID,
      recurringEventId: null,
      originalStart: null,
      itemsJson: '["水筒"]',
      assigneeMemberId: null,
      status: 'confirmed',
      source: 'manual',
      importJobId: null,
    });

    vi.stubGlobal('fetch', async (source: RequestInfo | URL, init?: RequestInit) => {
      const request = source instanceof Request ? source : new Request(source, init);
      if (request.url === 'https://oauth2.googleapis.com/token') {
        const formData = await request.clone().formData();
        refreshTokens.push(formData.get('refresh_token')?.toString() ?? '');
        return Response.json({
          access_token: 'task-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      const url = new URL(request.url);
      googleRequests.push(url.href);
      const eventMatch = url.pathname.match(
        new RegExp(`/calendar/v3/calendars/${CALENDAR_ID}/events/([^/]+)$`),
      );
      if (eventMatch) {
        const eventId = decodeURIComponent(eventMatch[1] ?? '');
        const event = storedEvents.get(eventId);
        return event
          ? Response.json(event)
          : Response.json(
              { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } },
              { status: 404 },
            );
      }
      if (
        url.pathname === `/calendar/v3/calendars/${CALENDAR_ID}/events` &&
        request.method === 'GET'
      ) {
        if (failList)
          return Response.json(
            { error: { code: 403, message: 'unavailable', errors: [{ reason: 'forbidden' }] } },
            { status: 403 },
          );
        return Response.json({
          items: [...storedEvents.values()],
          ...(repeatedPageToken ? { nextPageToken: 'repeat-token' } : {}),
        });
      }
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    try {
      await db.delete(tasks);
      await db.delete(eventMeta);
      await db.delete(members);
      await db.delete(families);
      await db.delete(googleTokens);
      await db.delete(sessions);
      await db.delete(users);
    } catch {
      /* the next test also clears shared D1 state */
    }
  });

  async function request(method: string, path: string, body?: unknown, csrf = true) {
    return app.request(
      `${ORIGIN}${path}`,
      {
        method,
        headers: {
          ...(method === 'GET'
            ? {}
            : { Origin: ORIGIN, ...(csrf ? { 'X-Requested-With': 'XMLHttpRequest' } : {}) }),
          Cookie: cookie,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      TEST_ENV,
    );
  }

  it('returns linked event allowlists in one list traversal and computes automatic due without D1 writes', async () => {
    await db.insert(tasks).values([
      {
        id: 'task_items_meta_tasks_event',
        familyId: 'fam_tasks',
        title: '持ち物を準備',
        dueAt: null,
        dueKind: 'none',
        doneAt: null,
        assigneeMemberId: null,
        eventMetaId: 'meta_tasks_event',
        source: 'items',
        sourceRef: null,
      },
      {
        id: 'task_manual_one',
        familyId: 'fam_tasks',
        title: '買い物',
        dueAt: '2026-10-04',
        dueKind: 'date',
        doneAt: null,
        assigneeMemberId: 'mem_task_adult',
        eventMetaId: 'meta_tasks_event',
        source: 'manual',
        sourceRef: null,
      },
    ]);
    const beforeTasks = await db.select().from(tasks);
    const beforeMetadata = await db.select().from(eventMeta);
    const response = await request('GET', '/api/families/fam_tasks/tasks');
    expect(response.status).toBe(200);
    const result = taskListResponseSchema.parse(await response.json());
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]?.due).toEqual({ kind: 'datetime', dueAt: '2026-10-04T20:00:00+09:00' });
    expect(result.tasks[0]?.linkedEvent).toMatchObject({
      state: 'ready',
      eventId: EVENT_ID,
      title: '運動会',
      memberIds: ['mem_task_child'],
      items: ['水筒'],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /description|location|secret|private|email|attendees|creator/,
    );
    expect(googleRequests.filter((url) => url.includes('/events?'))).toHaveLength(1);
    expect(googleRequests.every((url) => url.includes(`/calendars/${CALENDAR_ID}/`))).toBe(true);
    expect(refreshTokens).toEqual(['task-caller-refresh-token']);
    expect(await db.select().from(tasks)).toEqual(beforeTasks);
    expect(await db.select().from(eventMeta)).toEqual(beforeMetadata);

    const changedEvent = storedEvents.get(EVENT_ID);
    if (!changedEvent) throw new Error('Expected the test event to exist');
    storedEvents.set(EVENT_ID, {
      ...changedEvent,
      start: { dateTime: '2026-10-06T00:00:00Z' },
      end: { dateTime: '2026-10-06T01:00:00Z' },
    });
    await db.update(eventMeta).set({ itemsJson: '[]' }).where(eq(eventMeta.id, 'meta_tasks_event'));
    const afterStaleTask = taskListResponseSchema.parse(
      await (await request('GET', '/api/families/fam_tasks/tasks')).json(),
    );
    expect(afterStaleTask.tasks[0]?.due).toEqual({
      kind: 'datetime',
      dueAt: '2026-10-05T20:00:00+09:00',
    });
    expect(afterStaleTask.tasks[0]?.linkedEvent).toMatchObject({
      state: 'ready',
      items: [],
      time: { kind: 'timed', start: '2026-10-06T09:00:00+09:00' },
    });
    expect(
      (await db.select().from(tasks).where(eq(tasks.id, 'task_items_meta_tasks_event')))[0]?.dueAt,
    ).toBeNull();
  });

  it('returns unavailable linked information and unknown automatic due after Google lookup failure', async () => {
    await db.insert(tasks).values({
      id: 'task_items_meta_tasks_event',
      familyId: 'fam_tasks',
      title: '持ち物を準備',
      dueAt: null,
      dueKind: 'none',
      eventMetaId: 'meta_tasks_event',
      source: 'items',
      sourceRef: null,
    });
    failList = true;
    const response = await request('GET', '/api/families/fam_tasks/tasks');
    expect(response.status).toBe(200);
    const result = taskListResponseSchema.parse(await response.json());
    expect(result.tasks[0]?.due).toEqual({ kind: 'unknown' });
    expect(result.tasks[0]?.linkedEvent).toEqual({ state: 'unavailable', eventId: EVENT_ID });
  });

  it('returns a fully scanned missing event and includes completions through the 14-day boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00+09:00'));
    await db.insert(tasks).values([
      {
        id: 'task_missing_event',
        familyId: 'fam_tasks',
        title: 'missing',
        dueKind: 'none',
        eventMetaId: 'meta_tasks_event',
        source: 'manual',
        sourceRef: null,
      },
      {
        id: 'task_done_boundary',
        familyId: 'fam_tasks',
        title: 'recent',
        dueKind: 'none',
        doneAt: Math.floor(Date.now() / 1000) - 14 * 86400,
        source: 'manual',
        sourceRef: null,
      },
      {
        id: 'task_done_old',
        familyId: 'fam_tasks',
        title: 'old',
        dueKind: 'none',
        doneAt: Math.floor(Date.now() / 1000) - 14 * 86400 - 1,
        source: 'manual',
        sourceRef: null,
      },
    ]);
    storedEvents.delete(EVENT_ID);
    const response = await request('GET', '/api/families/fam_tasks/tasks');
    const result = taskListResponseSchema.parse(await response.json());
    expect(result.tasks.map((task) => task.id).sort()).toEqual([
      'task_done_boundary',
      'task_missing_event',
    ]);
    expect(result.tasks.find((task) => task.id === 'task_missing_event')?.linkedEvent).toEqual({
      state: 'missing',
      eventId: EVENT_ID,
    });
    storedEvents.set(EVENT_ID, { id: EVENT_ID, status: 'cancelled' });
    const cancelled = taskListResponseSchema.parse(
      await (await request('GET', '/api/families/fam_tasks/tasks')).json(),
    );
    expect(cancelled.tasks.find((task) => task.id === 'task_missing_event')?.linkedEvent).toEqual({
      state: 'missing',
      eventId: EVENT_ID,
    });
  });

  it('returns unavailable instead of missing when the bounded Google page traversal cycles', async () => {
    await db.insert(tasks).values({
      id: 'task_items_meta_tasks_event',
      familyId: 'fam_tasks',
      title: '持ち物を準備',
      dueKind: 'none',
      eventMetaId: 'meta_tasks_event',
      source: 'items',
      sourceRef: null,
    });
    storedEvents.clear();
    repeatedPageToken = true;
    const response = await request('GET', '/api/families/fam_tasks/tasks');
    const result = taskListResponseSchema.parse(await response.json());
    expect(response.status).toBe(200);
    expect(result.tasks[0]?.linkedEvent).toEqual({ state: 'unavailable', eventId: EVENT_ID });
  });

  it('creates idempotently, rejects child assignees and recurring masters, and keeps original fields', async () => {
    const payload = {
      title: '牛乳を買う',
      due: { kind: 'none' },
      assigneeMemberId: 'mem_task_adult',
      eventId: null,
      clientRequestId: '123e4567-e89b-42d3-a456-426614174000',
    };
    const first = await request('POST', '/api/families/fam_tasks/tasks', payload);
    expect(first.status).toBe(201);
    const firstTask = taskMutationResponseSchema.parse(await first.json()).task;
    const retry = await request('POST', '/api/families/fam_tasks/tasks', {
      ...payload,
      title: '別の内容',
    });
    expect(retry.status).toBe(200);
    expect(taskMutationResponseSchema.parse(await retry.json()).task).toEqual(firstTask);
    expect((await db.select().from(tasks)).filter((task) => task.source === 'manual')).toHaveLength(
      1,
    );

    const child = await request('POST', '/api/families/fam_tasks/tasks', {
      ...payload,
      clientRequestId: '123e4567-e89b-42d3-a456-426614174001',
      assigneeMemberId: 'mem_task_child',
    });
    expect(child.status).toBe(400);

    storedEvents.set('task_master_0001', {
      id: 'task_master_0001',
      summary: '繰り返し',
      recurrence: ['RRULE:FREQ=WEEKLY'],
      start: { dateTime: '2026-10-05T00:00:00Z' },
      end: { dateTime: '2026-10-05T01:00:00Z' },
    });
    const masterLink = await request('POST', '/api/families/fam_tasks/tasks', {
      ...payload,
      clientRequestId: '123e4567-e89b-42d3-a456-426614174002',
      eventId: 'task_master_0001',
    });
    expect(masterLink.status).toBe(409);

    const instanceId = 'task_instance_0001';
    storedEvents.set(instanceId, {
      id: instanceId,
      summary: '繰り返し予定の1回',
      recurringEventId: 'task_master_0001',
      start: { dateTime: '2026-10-05T00:00:00Z' },
      end: { dateTime: '2026-10-05T01:00:00Z' },
    });
    const linked = await request('POST', '/api/families/fam_tasks/tasks', {
      ...payload,
      clientRequestId: '123e4567-e89b-42d3-a456-426614174003',
      eventId: instanceId,
    });
    expect(linked.status).toBe(201);
    const linkedTask = taskMutationResponseSchema.parse(await linked.json()).task;
    expect(linkedTask.linkedEvent).toMatchObject({
      state: 'ready',
      eventId: instanceId,
    });
    const edited = await request('PATCH', `/api/families/fam_tasks/tasks/${linkedTask.id}`, {
      title: '手動の変更',
      due: { kind: 'date', dueAt: '2026-10-10' },
      eventId: null,
    });
    expect(edited.status).toBe(200);
    expect(taskMutationResponseSchema.parse(await edited.json()).task).toMatchObject({
      title: '手動の変更',
      due: { kind: 'date', dueAt: '2026-10-10' },
      linkedEvent: { state: 'none' },
    });
    expect((await request('DELETE', `/api/families/fam_tasks/tasks/${linkedTask.id}`)).status).toBe(
      200,
    );
  });

  it('rejects forged calendar fields and hides another family task', async () => {
    const payload = {
      title: '予定',
      due: { kind: 'none' },
      assigneeMemberId: null,
      eventId: EVENT_ID,
      calendarId: 'attacker-calendar',
      clientRequestId: '123e4567-e89b-42d3-a456-426614174010',
    };
    expect((await request('POST', '/api/families/fam_tasks/tasks', payload)).status).toBe(400);
    await db.insert(users).values({
      id: 'usr_other_family',
      googleSub: 'sub-other-family',
      email: 'other@example.test',
      displayName: 'Other',
    });
    await db.insert(families).values({
      id: 'fam_other',
      name: '別の家族',
      ownerUserId: 'usr_other_family',
      familyCalendarId: 'other_calendar',
      creationStatus: 'ready',
    });
    await db.insert(tasks).values({
      id: 'task_other_family',
      familyId: 'fam_other',
      title: 'secret',
      dueKind: 'none',
      source: 'manual',
      sourceRef: null,
    });
    expect((await request('GET', '/api/families/fam_other/tasks')).status).toBe(404);
    expect(
      (await request('PATCH', '/api/families/fam_other/tasks/task_other_family', { done: true }))
        .status,
    ).toBe(404);
    expect(
      (await request('DELETE', '/api/families/fam_other/tasks/task_other_family')).status,
    ).toBe(404);
    const ownFamilyList = taskListResponseSchema.parse(
      await (await request('GET', '/api/families/fam_tasks/tasks')).json(),
    );
    expect(ownFamilyList.tasks.some((task) => task.id === 'task_other_family')).toBe(false);
    expect(
      (await request('PATCH', '/api/families/fam_tasks/tasks/task_other_family', { done: true }))
        .status,
    ).toBe(404);
    expect(
      (await request('DELETE', '/api/families/fam_tasks/tasks/task_other_family')).status,
    ).toBe(404);
    expect(
      (await db.select().from(tasks).where(eq(tasks.id, 'task_other_family')))[0]?.doneAt,
    ).toBeNull();
  });

  it.each([
    [
      {
        title: '',
        due: { kind: 'none' },
        assigneeMemberId: null,
        clientRequestId: '123e4567-e89b-42d3-a456-426614174020',
      },
    ],
    [
      {
        title: 'x'.repeat(201),
        due: { kind: 'none' },
        assigneeMemberId: null,
        clientRequestId: '123e4567-e89b-42d3-a456-426614174021',
      },
    ],
    [
      {
        title: '日付',
        due: { kind: 'date', dueAt: '2026-02-30' },
        assigneeMemberId: null,
        clientRequestId: '123e4567-e89b-42d3-a456-426614174022',
      },
    ],
    [{ title: 'UUID', due: { kind: 'none' }, assigneeMemberId: null, clientRequestId: 'invalid' }],
  ])('rejects invalid task payloads', async (payload) => {
    expect((await request('POST', '/api/families/fam_tasks/tasks', payload)).status).toBe(400);
  });

  it('allows assignee and completion changes for every task source', async () => {
    await db.insert(tasks).values([
      {
        id: 'task_import',
        familyId: 'fam_tasks',
        title: 'import',
        dueKind: 'none',
        source: 'import',
        sourceRef: null,
      },
      {
        id: 'task_conflict',
        familyId: 'fam_tasks',
        title: 'conflict',
        dueKind: 'none',
        source: 'conflict',
        sourceRef: null,
      },
      {
        id: 'task_items_meta_tasks_event',
        familyId: 'fam_tasks',
        title: '持ち物を準備',
        dueKind: 'none',
        eventMetaId: 'meta_tasks_event',
        source: 'items',
        sourceRef: null,
      },
    ]);
    for (const id of ['task_import', 'task_conflict', 'task_items_meta_tasks_event']) {
      expect(
        (
          await request('PATCH', `/api/families/fam_tasks/tasks/${id}`, {
            assigneeMemberId: 'mem_task_adult',
            done: true,
          })
        ).status,
      ).toBe(200);
      const [completed] = await db.select().from(tasks).where(eq(tasks.id, id));
      expect(completed?.doneAt).not.toBeNull();
      expect(completed?.assigneeMemberId).toBe('mem_task_adult');
      expect(
        (await request('PATCH', `/api/families/fam_tasks/tasks/${id}`, { done: false })).status,
      ).toBe(200);
      const [reopened] = await db.select().from(tasks).where(eq(tasks.id, id));
      expect(reopened?.doneAt).toBeNull();
    }
  });

  it('enforces authentication and the 16 KiB mutation limit', async () => {
    const unauthenticated = await app.request(
      `${ORIGIN}/api/families/fam_tasks/tasks`,
      {},
      TEST_ENV,
    );
    expect(unauthenticated.status).toBe(401);
    const tooLarge = await app.request(
      `${ORIGIN}/api/families/fam_tasks/tasks`,
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ payload: 'x'.repeat(17 * 1024) }),
      },
      TEST_ENV,
    );
    expect(tooLarge.status).toBe(413);
  });

  it('repeats completion without changing doneAt, rejects automatic edits/deletes, and enforces CSRF', async () => {
    await db.insert(tasks).values([
      {
        id: 'task_manual_done',
        familyId: 'fam_tasks',
        title: '手動',
        dueKind: 'none',
        source: 'manual',
        sourceRef: null,
      },
      {
        id: 'task_items_meta_tasks_event',
        familyId: 'fam_tasks',
        title: '持ち物を準備',
        dueKind: 'none',
        eventMetaId: 'meta_tasks_event',
        source: 'items',
        sourceRef: null,
      },
    ]);
    const forbidden = await request(
      'PATCH',
      '/api/families/fam_tasks/tasks/task_manual_done',
      { done: true },
      false,
    );
    expect(forbidden.status).toBe(403);
    expect(
      (await request('PATCH', '/api/families/fam_tasks/tasks/task_manual_done', { done: true }))
        .status,
    ).toBe(200);
    const [afterFirst] = await db.select().from(tasks).where(eq(tasks.id, 'task_manual_done'));
    expect(afterFirst?.doneAt).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(
      (await request('PATCH', '/api/families/fam_tasks/tasks/task_manual_done', { done: true }))
        .status,
    ).toBe(200);
    const [afterRepeat] = await db.select().from(tasks).where(eq(tasks.id, 'task_manual_done'));
    expect(afterRepeat?.doneAt).toBe(afterFirst?.doneAt);
    expect(
      (
        await request('PATCH', '/api/families/fam_tasks/tasks/task_items_meta_tasks_event', {
          title: '変更',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request('PATCH', '/api/families/fam_tasks/tasks/task_items_meta_tasks_event', {
          due: { kind: 'none' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request('PATCH', '/api/families/fam_tasks/tasks/task_items_meta_tasks_event', {
          eventId: null,
        })
      ).status,
    ).toBe(409);
    expect(
      (await request('DELETE', '/api/families/fam_tasks/tasks/task_items_meta_tasks_event')).status,
    ).toBe(409);
    expect((await request('DELETE', '/api/families/fam_tasks/tasks/task_manual_done')).status).toBe(
      200,
    );
  });
});
