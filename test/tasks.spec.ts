import { env } from 'cloudflare:test';
import { createAbsenceTaskSourceRef } from '@shared/domain/absenceTask';
import {
  taskEventCandidatesResponseSchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
} from '@shared/schemas/tasks';
import { SESSION_COOKIE_NAME } from '@worker/auth/config';
import { encryptAesGcm } from '@worker/auth/crypto';
import { createSession } from '@worker/auth/session';
import { createDb } from '@worker/db';
import {
  eventMeta,
  families,
  googleTokens,
  members,
  routineSettings,
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
  const googleMethods: string[] = [];
  const refreshTokens: string[] = [];
  let failList = false;
  let failSecondPage = false;
  let repeatedPageToken = false;
  let candidatePages: Array<{ items: Record<string, unknown>[]; nextPageToken?: string }> | null =
    null;
  let cookie = '';

  beforeEach(async () => {
    storedEvents.clear();
    googleRequests.length = 0;
    googleMethods.length = 0;
    refreshTokens.length = 0;
    failList = false;
    failSecondPage = false;
    repeatedPageToken = false;
    candidatePages = null;
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
      googleMethods.push(request.method);
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
        if (failList || (failSecondPage && url.searchParams.has('pageToken')))
          return Response.json(
            { error: { code: 403, message: 'unavailable', errors: [{ reason: 'forbidden' }] } },
            { status: 403 },
          );
        if (candidatePages) {
          const pageToken = url.searchParams.get('pageToken');
          const pageNo = pageToken ? Number(pageToken.replace('page-', '')) : 0;
          return Response.json(candidatePages[pageNo] ?? { items: [] });
        }
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

  it('returns only valid, non-recurring family event candidates within the Tokyo date range', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T15:00:00.000Z'));
    await db.insert(members).values({
      id: 'mem_task_inactive',
      familyId: 'fam_tasks',
      userId: null,
      kind: 'child',
      name: '休止中',
      color: 'green',
      sortOrder: 2,
      status: 'pending',
    });
    const event = (
      id: string,
      start: Record<string, unknown>,
      end: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      status: 'confirmed',
      summary: `title-${id}`,
      description: 'must not leak',
      location: 'must not leak',
      attendees: [{ email: 'must-not-leak@example.test' }],
      start,
      end,
      extendedProperties: {
        private: {
          danran: '1',
          members: 'mem_task_child,mem_task_inactive,foreign-member',
          secret: 'must-not-leak',
        },
      },
      ...extra,
    });
    candidatePages = [
      {
        items: [
          event(
            'candidate_timed',
            { dateTime: '2026-10-11T00:30:00+09:00' },
            { dateTime: '2026-10-11T01:30:00+09:00' },
            { status: 'tentative' },
          ),
          event('candidate_all_day', { date: '2026-10-11' }, { date: '2026-10-12' }),
          event(
            'before_today',
            { dateTime: '2026-10-10T14:59:00Z' },
            { dateTime: '2026-10-10T15:30:00Z' },
          ),
          event(
            'at_today_start',
            { dateTime: '2026-10-10T15:00:00Z' },
            { dateTime: '2026-10-10T16:00:00Z' },
          ),
          event('at_end_boundary', { date: '2026-12-10' }, { date: '2026-12-11' }),
          event(
            'cancelled_event',
            { date: '2026-10-12' },
            { date: '2026-10-13' },
            { status: 'cancelled' },
          ),
          event(
            'recurring_instance',
            { date: '2026-10-12' },
            { date: '2026-10-13' },
            { recurringEventId: 'recurring_master' },
          ),
          event(
            'recurring_master',
            { date: '2026-10-12' },
            { date: '2026-10-13' },
            { recurrence: ['RRULE:FREQ=WEEKLY'] },
          ),
        ],
      },
    ];

    const beforeTasks = await db.select().from(tasks);
    const beforeMetadata = await db.select().from(eventMeta);
    const response = await request('GET', '/api/families/fam_tasks/tasks/event-candidates');
    expect(response.status, await response.clone().text()).toBe(200);
    const result = taskEventCandidatesResponseSchema.parse(await response.json());
    expect(result.hasMore).toBe(false);
    expect(result.events.map((candidate) => candidate.eventId)).toEqual([
      'at_today_start',
      'candidate_all_day',
      'candidate_timed',
    ]);
    expect(result.events[2]).toMatchObject({
      title: 'title-candidate_timed',
      time: { kind: 'timed', start: '2026-10-11T00:30:00+09:00' },
      memberIds: ['mem_task_child'],
    });
    expect(JSON.stringify(result)).not.toMatch(/description|location|attendees|email|secret/);
    expect(googleRequests).toHaveLength(1);
    const listUrl = new URL(googleRequests[0] ?? '');
    expect(listUrl.pathname).toBe(`/calendar/v3/calendars/${CALENDAR_ID}/events`);
    expect(listUrl.searchParams.get('timeMin')).toBe('2026-10-11T00:00:00+09:00');
    expect(listUrl.searchParams.get('timeMax')).toBe('2026-12-10T00:00:00+09:00');
    expect(listUrl.searchParams.get('singleEvents')).toBe('true');
    expect(listUrl.searchParams.get('orderBy')).toBe('startTime');
    expect(listUrl.searchParams.get('timeZone')).toBe('Asia/Tokyo');
    expect(listUrl.searchParams.get('showDeleted')).toBe('false');
    expect(listUrl.searchParams.get('maxResults')).toBe('2500');
    expect(googleMethods).toEqual(['GET']);
    expect(refreshTokens).toEqual(['task-caller-refresh-token']);
    expect(await db.select().from(tasks)).toEqual(beforeTasks);
    expect(await db.select().from(eventMeta)).toEqual(beforeMetadata);
  });

  it('stops after two pages and reports whether Google has another page', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T00:00:00+09:00'));
    candidatePages = [
      {
        items: [
          { id: 'candidate_page_one', start: { date: '2026-10-12' }, end: { date: '2026-10-13' } },
        ],
        nextPageToken: 'page-1',
      },
      {
        items: [
          { id: 'candidate_page_one', start: { date: '2026-10-12' }, end: { date: '2026-10-13' } },
          { id: 'candidate_page_two', start: { date: '2026-10-14' }, end: { date: '2026-10-15' } },
        ],
        nextPageToken: 'page-2',
      },
    ];
    const response = await request('GET', '/api/families/fam_tasks/tasks/event-candidates');
    expect(response.status).toBe(200);
    const result = taskEventCandidatesResponseSchema.parse(await response.json());
    expect(result.events.map((candidate) => candidate.eventId)).toEqual([
      'candidate_page_one',
      'candidate_page_two',
    ]);
    expect(result.hasMore).toBe(true);
    expect(googleRequests).toHaveLength(2);
    expect(new URL(googleRequests[1] ?? '').searchParams.get('pageToken')).toBe('page-1');
    expect(googleMethods).toEqual(['GET', 'GET']);
  });

  it('does not return partial candidates when a later Google page fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T00:00:00+09:00'));
    candidatePages = [
      {
        items: [
          { id: 'candidate_page_one', start: { date: '2026-10-12' }, end: { date: '2026-10-13' } },
        ],
        nextPageToken: 'page-1',
      },
    ];
    failSecondPage = true;
    const response = await request('GET', '/api/families/fam_tasks/tasks/event-candidates');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Family calendar access denied',
      code: 'CALENDAR_ACCESS_DENIED',
    });
    expect(googleRequests).toHaveLength(2);
  });

  it('returns a fixed Google error when the page contains an invalid event time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T00:00:00+09:00'));
    candidatePages = [
      {
        items: [
          {
            id: 'malformed_candidate',
            start: { date: '2026-10-12' },
            end: { dateTime: '2026-10-13T01:00:00Z' },
          },
        ],
      },
    ];
    const response = await request('GET', '/api/families/fam_tasks/tasks/event-candidates');
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Google Calendar request failed',
      code: 'GOOGLE_ERROR',
    });
  });

  it('uses existing family authorization and returns the fixed Google failure response', async () => {
    const unauthenticated = await app.request(
      `${ORIGIN}/api/families/fam_tasks/tasks/event-candidates`,
      {},
      TEST_ENV,
    );
    expect(unauthenticated.status).toBe(401);
    await db.insert(users).values([
      {
        id: 'usr_task_external_1',
        googleSub: 'sub-task-external-1',
        email: 'external-1@example.test',
        displayName: 'External one',
      },
      {
        id: 'usr_task_external_2',
        googleSub: 'sub-task-external-2',
        email: 'external-2@example.test',
        displayName: 'External two',
      },
    ]);
    await db.insert(families).values({
      id: 'fam_other',
      name: '他の家族',
      ownerUserId: 'usr_task_external_1',
      familyCalendarId: 'other_family_calendar',
      creationStatus: 'ready',
    });
    await db.insert(members).values({
      id: 'mem_task_caller_child',
      familyId: 'fam_other',
      userId: null,
      kind: 'child',
      name: '子ども',
      color: 'green',
      sortOrder: 0,
      status: 'active',
    });
    storedEvents.set('other_family_event', {
      id: 'other_family_event',
      summary: '他の家族の予定',
      start: { date: '2026-10-12' },
      end: { date: '2026-10-13' },
    });
    await db.insert(families).values({
      id: 'fam_nonmember',
      name: '非メンバー',
      ownerUserId: 'usr_task_external_2',
      familyCalendarId: 'nonmember_family_calendar',
      creationStatus: 'ready',
    });
    expect(
      (await request('GET', '/api/families/fam_nonmember/tasks/event-candidates')).status,
    ).toBe(404);
    expect((await request('GET', '/api/families/fam_other/tasks/event-candidates')).status).toBe(
      404,
    );
    expect(googleRequests).toHaveLength(0);

    await db.update(members).set({ status: 'pending' }).where(eq(members.id, 'mem_task_adult'));
    expect((await request('GET', '/api/families/fam_tasks/tasks/event-candidates')).status).toBe(
      404,
    );
    await db.update(members).set({ status: 'active' }).where(eq(members.id, 'mem_task_adult'));

    await db
      .update(families)
      .set({ familyCalendarId: null, creationStatus: 'creating' })
      .where(eq(families.id, 'fam_tasks'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T00:00:00+09:00'));
    expect((await request('GET', '/api/families/fam_tasks/tasks/event-candidates')).status).toBe(
      409,
    );
    await db
      .update(families)
      .set({ familyCalendarId: CALENDAR_ID, creationStatus: 'ready' })
      .where(eq(families.id, 'fam_tasks'));
    expect(googleRequests).toHaveLength(0);

    failList = true;
    const failed = await request('GET', '/api/families/fam_tasks/tasks/event-candidates');
    expect(failed.status).toBe(403);
    expect(await failed.json()).toEqual({
      error: 'Family calendar access denied',
      code: 'CALENDAR_ACCESS_DENIED',
    });
  });

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

  it('uses one bounded event list for absence titles and leaves task rows unchanged', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T03:00:00.000Z'));
    await db.insert(routineSettings).values({
      id: 'routine_absence_title',
      familyId: 'fam_tasks',
      calendarId: CALENDAR_ID,
      recurringEventId: 'routine_master_absence',
      category: 'lesson',
    });
    await db.insert(tasks).values({
      id: 'task_absence_title',
      familyId: 'fam_tasks',
      title: '欠席を連絡',
      dueAt: '2026-10-16',
      dueKind: 'date',
      doneAt: null,
      assigneeMemberId: null,
      eventMetaId: null,
      source: 'conflict',
      sourceRef: createAbsenceTaskSourceRef({
        routineSettingsId: 'routine_absence_title',
        originalStart: '2026-10-17T10:00:00+09:00',
      }),
    });
    storedEvents.set('routine_instance_absence', {
      id: 'routine_instance_absence',
      recurringEventId: 'routine_master_absence',
      status: 'confirmed',
      summary: 'ピアノ',
      start: { dateTime: '2026-10-17T10:00:00+09:00' },
      end: { dateTime: '2026-10-17T11:00:00+09:00' },
    });

    const beforeList = await db.select().from(tasks);
    repeatedPageToken = true;
    const response = await request('GET', '/api/families/fam_tasks/tasks');
    expect(response.status).toBe(200);
    const result = taskListResponseSchema.parse(await response.json());
    expect(result.tasks).toEqual([
      expect.objectContaining({
        id: 'task_absence_title',
        title: '「ピアノ」（10/17（土））に欠席を連絡',
        due: { kind: 'date', dueAt: '2026-10-16' },
        source: 'conflict',
        linkedEvent: { state: 'none' },
      }),
    ]);
    expect(googleRequests.filter((url) => url.includes('/events?'))).toHaveLength(1);
    expect(new URL(googleRequests[0] ?? '').searchParams.get('pageToken')).toBeNull();
    expect(googleMethods).toEqual(['GET']);
    expect(await db.select().from(tasks)).toEqual(beforeList);
    repeatedPageToken = false;

    await db.insert(tasks).values({
      id: 'task_absence_mixed_link',
      familyId: 'fam_tasks',
      title: '持ち物を準備',
      dueAt: null,
      dueKind: 'none',
      doneAt: null,
      assigneeMemberId: null,
      eventMetaId: 'meta_tasks_event',
      source: 'items',
      sourceRef: null,
    });
    googleRequests.length = 0;
    googleMethods.length = 0;
    const mixedResponse = await request('GET', '/api/families/fam_tasks/tasks');
    expect(mixedResponse.status).toBe(200);
    const mixedResult = taskListResponseSchema.parse(await mixedResponse.json());
    expect(mixedResult.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'task_absence_title',
          title: '「ピアノ」（10/17（土））に欠席を連絡',
        }),
        expect.objectContaining({
          id: 'task_absence_mixed_link',
          linkedEvent: expect.objectContaining({ state: 'ready', eventId: EVENT_ID }),
        }),
      ]),
    );
    expect(googleRequests.filter((url) => url.includes('/events?'))).toHaveLength(1);
    expect(googleRequests.every((url) => url.includes('/events?'))).toBe(true);
    expect(googleMethods).toEqual(['GET']);

    const linkedEvent = storedEvents.get(EVENT_ID);
    const laterRoutineEvent = storedEvents.get('routine_instance_absence');
    if (!linkedEvent || !laterRoutineEvent) throw new Error('Task list fixture event is missing');
    candidatePages = [
      { items: [linkedEvent], nextPageToken: 'page-1' },
      { items: [laterRoutineEvent] },
    ];
    googleRequests.length = 0;
    googleMethods.length = 0;
    const missingSeriesTitle = await request('GET', '/api/families/fam_tasks/tasks');
    expect(missingSeriesTitle.status).toBe(200);
    const missingTitleResult = taskListResponseSchema.parse(await missingSeriesTitle.json());
    expect(missingTitleResult.tasks.find((task) => task.id === 'task_absence_title')?.title).toBe(
      '10/17（土）の欠席を連絡',
    );
    expect(googleRequests.filter((url) => url.includes('/events?'))).toHaveLength(1);
    expect(new URL(googleRequests[0] ?? '').searchParams.get('pageToken')).toBeNull();
    candidatePages = null;

    failList = true;
    googleRequests.length = 0;
    googleMethods.length = 0;
    const failedLookup = await request('GET', '/api/families/fam_tasks/tasks');
    expect(failedLookup.status).toBe(200);
    const failedResult = taskListResponseSchema.parse(await failedLookup.json());
    expect(failedResult.tasks.find((task) => task.id === 'task_absence_title')?.title).toBe(
      '10/17（土）の欠席を連絡',
    );
    expect(googleRequests.filter((url) => url.includes('/events?'))).toHaveLength(1);
    expect(
      failedResult.tasks.find((task) => task.id === 'task_absence_mixed_link')?.linkedEvent,
    ).toEqual({
      state: 'unavailable',
      eventId: EVENT_ID,
    });
  });

  it('allows absence task assignee and done changes while rejecting other mutation fields and deletion', async () => {
    await db.insert(tasks).values({
      id: 'task_absence_mutable',
      familyId: 'fam_tasks',
      title: '欠席を連絡',
      dueAt: '2026-10-16',
      dueKind: 'date',
      doneAt: null,
      assigneeMemberId: null,
      eventMetaId: null,
      source: 'conflict',
      sourceRef: 'absence:v1:routine_mutable:2026-10-17T10%3A00%3A00%2B09%3A00',
    });
    const path = '/api/families/fam_tasks/tasks/task_absence_mutable';
    const allowed = await request('PATCH', path, {
      assigneeMemberId: 'mem_task_adult',
      done: true,
    });
    expect(allowed.status).toBe(200);
    const updated = taskMutationResponseSchema.parse(await allowed.json()).task;
    expect(updated.assigneeMemberId).toBe('mem_task_adult');
    expect(updated.doneAt).not.toBeNull();

    for (const body of [
      { title: 'changed' },
      { due: { kind: 'date', dueAt: '2026-10-18' } },
      { eventId: 'some_event' },
    ]) {
      const response = await request('PATCH', path, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'AUTO_TASK_IMMUTABLE' });
    }
    const deleted = await request('DELETE', path);
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toMatchObject({ code: 'AUTO_TASK_IMMUTABLE' });
  });

  it('returns 404 for an absence task stored in another family', async () => {
    await db.insert(users).values({
      id: 'usr_task_other_owner',
      googleSub: 'sub-task-other-owner',
      email: 'other@example.test',
      displayName: 'Other',
    });
    await db.insert(families).values({
      id: 'fam_tasks_other',
      name: 'Other family',
      ownerUserId: 'usr_task_other_owner',
      familyCalendarId: 'other-calendar',
      creationStatus: 'ready',
    });
    await db.insert(tasks).values({
      id: 'task_absence_other_family',
      familyId: 'fam_tasks_other',
      title: '欠席を連絡',
      dueAt: '2026-10-16',
      dueKind: 'date',
      source: 'conflict',
      sourceRef: 'absence:v1:other:2026-10-17T10%3A00%3A00%2B09%3A00',
    });
    const ownTask = {
      id: 'task_absence_owned_for_isolation',
      familyId: 'fam_tasks',
      title: '欠席を連絡',
      dueAt: '2026-10-16',
      dueKind: 'date' as const,
      source: 'conflict' as const,
      sourceRef: 'absence:v1:own:2026-10-17T10%3A00%3A00%2B09%3A00',
    };
    await db.insert(tasks).values(ownTask);
    const snapshot = await db.select().from(tasks).where(eq(tasks.id, 'task_absence_other_family'));

    const ownList = await request('GET', '/api/families/fam_tasks/tasks');
    expect(ownList.status).toBe(200);
    expect(JSON.stringify(await ownList.json())).not.toContain('task_absence_other_family');
    expect((await request('GET', '/api/families/fam_tasks_other/tasks')).status).toBe(404);
    const response = await request(
      'PATCH',
      '/api/families/fam_tasks/tasks/task_absence_other_family',
      { done: true },
    );
    expect(response.status).toBe(404);
    expect(
      (await request('DELETE', '/api/families/fam_tasks/tasks/task_absence_other_family')).status,
    ).toBe(404);
    expect(await db.select().from(tasks).where(eq(tasks.id, 'task_absence_other_family'))).toEqual(
      snapshot,
    );
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
