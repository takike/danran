import { env } from 'cloudflare:test';
import { SESSION_COOKIE_NAME } from '@worker/auth/config';
import { encryptAesGcm } from '@worker/auth/crypto';
import { createSession } from '@worker/auth/session';
import { createDb } from '@worker/db';
import {
  families,
  googleTokens,
  members,
  routineAutoSkips,
  routineSettings,
  sessions,
  users,
} from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { app } from '@worker/index';
import { Hono } from 'hono';
import { setSignedCookie } from 'hono/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'http://localhost:5173';
const SESSION_SECRET = 'routine-auto-skip-test-session-secret';
const AES_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const CALENDAR_ID = 'auto_skip_family_calendar';
const ROUTINE_ID = 'auto_skip_routine';
const MASTER_ID = 'auto_skip_master';
const FAMILY_ID = 'auto_skip_family';
const API_BASE = `/api/families/${FAMILY_ID}/routines/${ROUTINE_ID}`;
const TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'routine-auto-skip-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'routine-auto-skip-google-client-secret',
  SESSION_SECRET,
  TOKEN_ENC_KEY: AES_KEY,
};

type TestEvent = Record<string, unknown>;
type PatchFailure = 'none' | 'reject-before' | 'commit-then-reject';

const db = createDb(env.DB);
const events = new Map<string, TestEvent>();
let patchFailure: PatchFailure = 'none';
let patchCount = 0;
let patchBodies: Record<string, unknown>[] = [];
let patchUrls: URL[] = [];
let instanceRequests: URL[] = [];
let calendarAuthorizations: string[] = [];
let refreshTokens: string[] = [];
let eventGetCount = 0;
let googleOperations: string[] = [];
let hideCancelledFromRange = false;
let googleFetchCount = 0;

describe('Task 3-3 routine automatic skip API', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T03:00:00.000Z'));
    events.clear();
    patchFailure = 'none';
    patchCount = 0;
    patchBodies = [];
    patchUrls = [];
    instanceRequests = [];
    calendarAuthorizations = [];
    refreshTokens = [];
    eventGetCount = 0;
    googleOperations = [];
    hideCancelledFromRange = false;
    googleFetchCount = 0;
    await db.delete(routineAutoSkips);
    await db.delete(routineSettings);
    await db.delete(members);
    await db.delete(families);
    await db.delete(googleTokens);
    await db.delete(sessions);
    await db.delete(users);
    vi.stubGlobal('fetch', async (source: RequestInfo | URL, init?: RequestInit) => {
      const request = source instanceof Request ? source : new Request(source, init);
      googleFetchCount += 1;
      if (request.url === 'https://oauth2.googleapis.com/token') {
        const form = await request.clone().formData();
        refreshTokens.push(form.get('refresh_token')?.toString() ?? '');
        return Response.json({
          access_token: 'routine-auto-skip-access',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }

      const url = new URL(request.url);
      if (!url.pathname.startsWith(`/calendar/v3/calendars/${CALENDAR_ID}/events`)) {
        throw new Error(`Unexpected Google request ${request.method} ${url.pathname}`);
      }
      calendarAuthorizations.push(request.headers.get('Authorization') ?? '');
      const segments = url.pathname.split('/').filter(Boolean);
      const eventId = decodeURIComponent(segments.at(-1) ?? '');

      if (request.method === 'GET' && url.pathname.endsWith('/instances')) {
        instanceRequests.push(url);
        googleOperations.push('instances');
        const masterId = decodeURIComponent(segments.at(-2) ?? '');
        const requestedOriginalStart = url.searchParams.get('originalStart');
        const min = Date.parse(url.searchParams.get('timeMin') ?? '');
        const max = Date.parse(url.searchParams.get('timeMax') ?? '');
        const all = [...events.values()].filter((event) => {
          if (event.recurringEventId !== masterId) return false;
          if (hideCancelledFromRange && !requestedOriginalStart && event.status === 'cancelled')
            return false;
          const original = event.originalStartTime as { dateTime?: string } | undefined;
          const start = event.start as { dateTime?: string } | undefined;
          const end = event.end as { dateTime?: string } | undefined;
          const originalStart = original?.dateTime;
          if (!originalStart) return false;
          if (requestedOriginalStart) {
            return Date.parse(originalStart) === Date.parse(requestedOriginalStart);
          }
          const rangeStart = event.status === 'cancelled' ? originalStart : start?.dateTime;
          const rangeEnd = event.status === 'cancelled' ? originalStart : end?.dateTime;
          if (!rangeStart || !rangeEnd) return false;
          return Date.parse(rangeStart) < max && Date.parse(rangeEnd) >= min;
        });
        const pageSize = Number(url.searchParams.get('maxResults') ?? 250);
        const page = Number(url.searchParams.get('pageToken')?.slice(1) ?? 0);
        const items = all.slice(page * pageSize, (page + 1) * pageSize).map((event) =>
          event.status === 'cancelled'
            ? {
                id: event.id,
                recurringEventId: event.recurringEventId,
                originalStartTime: event.originalStartTime,
                status: 'cancelled',
              }
            : event,
        );
        return Response.json({
          items,
          ...((page + 1) * pageSize < all.length ? { nextPageToken: `p${page + 1}` } : {}),
        });
      }

      if (request.method === 'GET') {
        const event = events.get(eventId);
        eventGetCount += 1;
        return event
          ? Response.json(event)
          : Response.json(
              { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } },
              { status: 404 },
            );
      }

      if (request.method === 'PATCH') {
        patchCount += 1;
        patchUrls.push(url);
        googleOperations.push('patch');
        const body = (await request.json()) as Record<string, unknown>;
        patchBodies.push(body);
        const current = events.get(eventId);
        if (!current) {
          return Response.json(
            { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } },
            { status: 404 },
          );
        }
        if (patchFailure === 'reject-before') {
          return Response.json(
            { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } },
            { status: 403 },
          );
        }
        const start = body.start as Record<string, unknown> | undefined;
        const end = body.end as Record<string, unknown> | undefined;
        const updated: TestEvent = {
          ...current,
          ...(typeof body.status === 'string' ? { status: body.status } : {}),
          ...(start ? { start: { dateTime: start.dateTime, timeZone: start.timeZone } } : {}),
          ...(end ? { end: { dateTime: end.dateTime, timeZone: end.timeZone } } : {}),
        };
        events.set(eventId, updated);
        if (patchFailure === 'commit-then-reject') {
          return Response.json(
            { error: { code: 500, message: 'Unavailable', errors: [{ reason: 'backendError' }] } },
            { status: 500 },
          );
        }
        return Response.json(updated);
      }
      throw new Error(`Unexpected Google request ${request.method} ${request.url}`);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      await env.DB.prepare('DROP TRIGGER IF EXISTS fail_auto_skip_insert').run();
      await env.DB.prepare('DROP TRIGGER IF EXISTS fail_auto_skip_delete').run();
      await env.DB.prepare('DROP TRIGGER IF EXISTS fail_auto_skip_override').run();
      await db.delete(routineAutoSkips);
      await db.delete(routineSettings);
      await db.delete(members);
      await db.delete(families);
      await db.delete(googleTokens);
      await db.delete(sessions);
      await db.delete(users);
    } catch {
      /* The next test starts with clean domain rows. */
    }
  });

  async function cookieFor(rawToken: string): Promise<string> {
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
    return (
      (await cookieApp.request('http://localhost/')).headers.get('set-cookie')?.split(';')[0] ?? ''
    );
  }

  async function addUser(id: string, refreshToken: string): Promise<string> {
    await db.insert(users).values({
      id,
      googleSub: `${id}-sub`,
      email: `${id}@example.test`,
      displayName: id,
    });
    await db.insert(googleTokens).values({
      userId: id,
      refreshTokenEnc: await encryptAesGcm(refreshToken, AES_KEY, `google-refresh:${id}`),
      scopes: 'openid email profile https://www.googleapis.com/auth/calendar.app.created',
    });
    const { rawToken } = await createSession(db, id);
    return cookieFor(rawToken);
  }

  async function fixture(options?: {
    skipHolidays?: boolean;
    skipNewYear?: boolean;
    autoSkipAppliedUntil?: string | null;
  }): Promise<{ cookie: string; routineId: string }> {
    const cookie = await addUser('auto_skip_owner', 'auto-skip-owner-refresh');
    await db.insert(families).values({
      id: FAMILY_ID,
      name: 'テスト家族',
      ownerUserId: 'auto_skip_owner',
      familyCalendarId: CALENDAR_ID,
      creationStatus: 'ready',
    });
    await db.insert(members).values({
      id: 'auto_skip_adult',
      familyId: FAMILY_ID,
      userId: 'auto_skip_owner',
      kind: 'adult',
      name: '大人',
      color: 'indigo',
      status: 'active',
    });
    await db.insert(routineSettings).values({
      id: ROUTINE_ID,
      familyId: FAMILY_ID,
      calendarId: CALENDAR_ID,
      recurringEventId: MASTER_ID,
      category: 'lesson',
      skipHolidays: options?.skipHolidays ?? false,
      skipNewYear: options?.skipNewYear ?? false,
      autoSkipAppliedUntil: options?.autoSkipAppliedUntil ?? null,
    });
    events.set(MASTER_ID, {
      id: MASTER_ID,
      summary: 'テストの習い事',
      status: 'confirmed',
      start: { dateTime: '2026-10-06T17:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-10-06T18:00:00+09:00', timeZone: 'Asia/Tokyo' },
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU'],
      extendedProperties: { private: { danran: '1' } },
    });
    return { cookie, routineId: ROUTINE_ID };
  }

  function addInstance(
    id: string,
    originalDate: string,
    options?: {
      startDate?: string;
      startTime?: string;
      endDate?: string;
      endTime?: string;
      status?: 'confirmed' | 'cancelled';
    },
  ) {
    const startDate = options?.startDate ?? originalDate;
    const endDate = options?.endDate ?? startDate;
    events.set(id, {
      id,
      recurringEventId: MASTER_ID,
      originalStartTime: {
        dateTime: `${originalDate}T17:00:00+09:00`,
        timeZone: 'Asia/Tokyo',
      },
      start: {
        dateTime: `${startDate}T${options?.startTime ?? '17:00'}:00+09:00`,
        timeZone: 'Asia/Tokyo',
      },
      end: {
        dateTime: `${endDate}T${options?.endTime ?? '18:00'}:00+09:00`,
        timeZone: 'Asia/Tokyo',
      },
      status: options?.status ?? 'confirmed',
      extendedProperties: { private: { members: 'auto_skip_child', assignee: 'auto_skip_adult' } },
    });
  }

  function apiRequest(method: 'GET' | 'POST' | 'PATCH', path: string, cookie = '', body?: unknown) {
    return app.request(
      `${ORIGIN}${path}`,
      {
        method,
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': 'XMLHttpRequest',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      TEST_ENV,
    );
  }

  async function setSettings(cookie: string, skipHolidays: boolean, skipNewYear: boolean) {
    return apiRequest('PATCH', `${API_BASE}/settings`, cookie, { skipHolidays, skipNewYear });
  }

  async function addAppliedRecord(
    id: string,
    originalStart: string,
    reason: 'holiday' | 'new_year',
  ) {
    await db.insert(routineAutoSkips).values({
      id,
      routineSettingsId: ROUTINE_ID,
      originalStart,
      reason,
      status: 'applied',
    });
  }

  it('cancels only ordinary eligible instances with the caller token and records holiday priority', async () => {
    await fixture();
    await addUser('auto_skip_invitee', 'auto-skip-invitee-refresh');
    await db.insert(members).values({
      id: 'auto_skip_invitee_member',
      familyId: FAMILY_ID,
      userId: 'auto_skip_invitee',
      kind: 'adult',
      name: '招待された大人',
      color: 'purple',
      status: 'active',
    });
    const cookie = await cookieFor((await createSession(db, 'auto_skip_invitee')).rawToken);
    addInstance('holiday_november', '2026-11-03');
    addInstance('new_year_december', '2026-12-29');
    addInstance('new_year_january', '2027-01-01');
    addInstance('already_cancelled_holiday', '2026-11-23', { status: 'cancelled' });
    addInstance('moved_holiday', '2026-10-12', { startDate: '2026-10-13' });
    addInstance('changed_duration_holiday', '2027-01-11', { endTime: '19:00' });
    addInstance('ordinary_day', '2026-10-07');

    const enabled = await setSettings(cookie, true, true);
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({ skipHolidays: true, skipNewYear: true, hasMore: false });
    expect(patchBodies).toEqual([
      { status: 'cancelled' },
      { status: 'cancelled' },
      { status: 'cancelled' },
    ]);
    expect(events.get('holiday_november')?.status).toBe('cancelled');
    expect(events.get('new_year_december')?.status).toBe('cancelled');
    expect(events.get('new_year_january')?.status).toBe('cancelled');
    expect(events.get('already_cancelled_holiday')?.status).toBe('cancelled');
    expect(events.get('moved_holiday')?.status).toBe('confirmed');
    expect(events.get('changed_duration_holiday')?.status).toBe('confirmed');
    expect(events.get('ordinary_day')?.status).toBe('confirmed');
    expect(patchUrls.every((url) => url.searchParams.get('sendUpdates') === 'none')).toBe(true);
    expect(refreshTokens.length).toBeGreaterThan(0);
    expect(refreshTokens.every((token) => token === 'auto-skip-invitee-refresh')).toBe(true);
    expect(refreshTokens).not.toContain('auto-skip-owner-refresh');
    expect(instanceRequests[0]?.searchParams.get('timeMin')).toBe('2026-10-06T00:00:00+09:00');
    expect(instanceRequests[0]?.searchParams.get('timeMax')).toBe('2027-04-08T00:00:00+09:00');
    expect(instanceRequests[0]?.searchParams.get('timeZone')).toBe('Asia/Tokyo');
    expect(instanceRequests[0]?.searchParams.get('showDeleted')).toBe('true');
    expect(
      calendarAuthorizations.every((value) => value === 'Bearer routine-auto-skip-access'),
    ).toBe(true);

    const ledger = await db.select().from(routineAutoSkips);
    expect(
      ledger.map(({ originalStart, reason, status }) => ({ originalStart, reason, status })),
    ).toEqual([
      { originalStart: '2026-11-03T17:00:00+09:00', reason: 'holiday', status: 'applied' },
      { originalStart: '2026-12-29T17:00:00+09:00', reason: 'new_year', status: 'applied' },
      { originalStart: '2027-01-01T17:00:00+09:00', reason: 'holiday', status: 'applied' },
    ]);
    expect(ledger[0]).not.toHaveProperty('title');
  });

  it('restores only automatic future skips and removes past automatic history without a Google patch', async () => {
    const { cookie } = await fixture({ skipHolidays: true, skipNewYear: true });
    addInstance('auto_future', '2026-11-03', { status: 'cancelled' });
    addInstance('manual_future', '2026-11-23', { status: 'cancelled' });
    addInstance('auto_past', '2026-10-01', { status: 'cancelled' });
    await addAppliedRecord('ledger_auto_future', '2026-11-03T17:00:00+09:00', 'holiday');
    await addAppliedRecord('ledger_auto_past', '2026-10-01T17:00:00+09:00', 'holiday');

    const disabled = await setSettings(cookie, false, false);
    expect(disabled.status).toBe(200);
    expect(patchBodies).toEqual([
      {
        status: 'confirmed',
        start: { date: null, dateTime: '2026-11-03T17:00:00+09:00', timeZone: 'Asia/Tokyo' },
        end: { date: null, dateTime: '2026-11-03T18:00:00+09:00', timeZone: 'Asia/Tokyo' },
      },
    ]);
    expect(events.get('auto_future')?.status).toBe('confirmed');
    expect(events.get('manual_future')?.status).toBe('cancelled');
    expect(events.get('auto_past')?.status).toBe('cancelled');
    expect((await db.select().from(routineAutoSkips)).map(({ id }) => id)).toEqual([]);
  });

  it('updates the January 1 reason without repatching, then preserves manual restore and move overrides', async () => {
    const { cookie } = await fixture({ skipHolidays: true, skipNewYear: true });
    addInstance('jan1', '2027-01-01', { status: 'cancelled' });
    await addAppliedRecord('ledger_jan1', '2027-01-01T17:00:00+09:00', 'holiday');

    const holidaysOff = await setSettings(cookie, false, true);
    expect(holidaysOff.status).toBe(200);
    expect(patchCount).toBe(0);
    expect((await db.select().from(routineAutoSkips))[0]?.reason).toBe('new_year');

    const holidayOff = await setSettings(cookie, false, false);
    expect(holidayOff.status).toBe(200);
    expect(patchCount).toBe(1);
    events.delete('jan1');
    addInstance('manual_restore', '2026-11-03', { status: 'cancelled' });
    await addAppliedRecord('ledger_manual_restore', '2026-11-03T17:00:00+09:00', 'holiday');
    const manualRestore = await apiRequest(
      'POST',
      `${API_BASE}/instances/manual_restore/restore`,
      cookie,
      {},
    );
    expect(manualRestore.status).toBe(200);
    expect(
      (await db.select().from(routineAutoSkips)).find((row) => row.id === 'ledger_manual_restore')
        ?.status,
    ).toBe('overridden');
    const afterManualRestore = patchCount;
    expect((await setSettings(cookie, true, false)).status).toBe(200);
    expect((await apiRequest('POST', `${API_BASE}/auto-skips/apply`, cookie, {})).status).toBe(200);
    expect(patchCount).toBe(afterManualRestore);

    addInstance('manual_move', '2026-11-23', { status: 'cancelled' });
    await addAppliedRecord('ledger_manual_move', '2026-11-23T17:00:00+09:00', 'holiday');
    const moved = await apiRequest('POST', `${API_BASE}/instances/manual_move/move`, cookie, {
      date: '2026-11-24',
      startTime: '18:00',
      endTime: '19:00',
    });
    expect(moved.status).toBe(200);
    expect(
      (await db.select().from(routineAutoSkips)).find((row) => row.id === 'ledger_manual_move')
        ?.status,
    ).toBe('overridden');
    const afterManualMove = patchCount;
    expect((await setSettings(cookie, false, false)).status).toBe(200);
    expect((await setSettings(cookie, true, false)).status).toBe(200);
    expect((await apiRequest('POST', `${API_BASE}/auto-skips/apply`, cookie, {})).status).toBe(200);
    expect(patchCount).toBe(afterManualMove);
    expect(events.get('manual_move')).toMatchObject({
      status: 'confirmed',
      start: { dateTime: '2026-11-24T18:00:00+09:00' },
      end: { dateTime: '2026-11-24T19:00:00+09:00' },
    });
  });

  it('limits combined restores and cancellations to twenty changes and continues idempotently', async () => {
    const { cookie } = await fixture({ skipHolidays: true, skipNewYear: false });
    const dates: string[] = [];
    for (let day = 7; day <= 26; day += 1) {
      const date = `2026-10-${String(day).padStart(2, '0')}`;
      dates.push(date);
      addInstance(`restore_${day}`, date, { status: 'cancelled' });
      await addAppliedRecord(`ledger_${day}`, `${date}T17:00:00+09:00`, 'holiday');
    }
    addInstance('remaining_new_year', '2027-01-02');

    const first = await setSettings(cookie, false, true);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ skipHolidays: false, skipNewYear: true, hasMore: true });
    expect(patchCount).toBe(20);
    expect(
      (await db.select().from(routineAutoSkips)).filter((row) => row.status === 'applied'),
    ).toHaveLength(0);
    expect(events.get('remaining_new_year')?.status).toBe('confirmed');

    const second = await apiRequest('POST', `${API_BASE}/auto-skips/apply`, cookie, {});
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ skipHolidays: false, skipNewYear: true, hasMore: false });
    expect(patchCount).toBe(21);
    expect(events.get('remaining_new_year')?.status).toBe('cancelled');
    const beforeRetry = patchCount;
    const retry = await apiRequest('POST', `${API_BASE}/auto-skips/apply`, cookie, {});
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ skipHolidays: false, skipNewYear: true, hasMore: false });
    expect(patchCount).toBe(beforeRetry);
    expect(dates).toHaveLength(20);
  });

  it('stays within the per-request Google budget while restoring twenty missing instances', async () => {
    const { cookie } = await fixture();
    for (let day = 7; day <= 27; day += 1) {
      const date = `2026-10-${String(day).padStart(2, '0')}`;
      addInstance(`missing_cancelled_${day}`, date, { status: 'cancelled' });
      await addAppliedRecord(`ledger_missing_${day}`, `${date}T17:00:00+09:00`, 'holiday');
    }
    hideCancelledFromRange = true;

    const first = await apiRequest('POST', `${API_BASE}/auto-skips/apply`, cookie, {});
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ skipHolidays: false, skipNewYear: false, hasMore: true });
    expect(patchCount).toBe(20);
    expect(instanceRequests).toHaveLength(21); // one bounded list plus twenty exact lookups
    expect(calendarAuthorizations).toHaveLength(42); // master + list + exact lookups + patches
    expect(googleFetchCount).toBe(43); // Calendar calls plus one access-token refresh
    expect(googleFetchCount).toBeLessThanOrEqual(48);
    expect(refreshTokens).toEqual(['auto-skip-owner-refresh']);
    expect(
      (await db.select().from(routineAutoSkips)).filter((row) => row.status === 'applied'),
    ).toHaveLength(1);

    const second = await apiRequest('POST', `${API_BASE}/auto-skips/apply`, cookie, {});
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      skipHolidays: false,
      skipNewYear: false,
      hasMore: false,
    });
    expect(patchCount).toBe(21);
    expect(events.get('missing_cancelled_27')?.status).toBe('confirmed');
    expect(
      (await db.select().from(routineAutoSkips)).filter((row) => row.status === 'applied'),
    ).toHaveLength(0);
  });

  it('finishes every instance page before patching eligible occurrences', async () => {
    const { cookie } = await fixture();
    for (let index = 0; index < 250; index += 1) {
      addInstance(`ordinary_page_${index}`, '2026-10-07');
    }
    addInstance('holiday_second_page', '2026-11-03');

    const response = await setSettings(cookie, true, false);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      skipHolidays: true,
      skipNewYear: false,
      hasMore: false,
    });
    expect(instanceRequests).toHaveLength(2);
    expect(instanceRequests[1]?.searchParams.get('pageToken')).toBe('p1');
    expect(patchBodies).toEqual([{ status: 'cancelled' }]);
    expect(googleOperations).toEqual(['instances', 'instances', 'patch']);
  });

  it('recovers from ledger failures, definite Google rejection, and ambiguous committed updates', async () => {
    const { cookie } = await fixture();
    addInstance('failure_case', '2026-11-03');
    await env.DB.prepare(
      "CREATE TRIGGER fail_auto_skip_insert BEFORE INSERT ON routine_auto_skips BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    ).run();
    expect((await setSettings(cookie, true, false)).status).toBe(500);
    expect(patchCount).toBe(0);
    expect((await db.select().from(routineSettings))[0]?.skipHolidays).toBe(true);
    await env.DB.prepare('DROP TRIGGER fail_auto_skip_insert').run();

    patchFailure = 'reject-before';
    expect((await apiRequest('POST', `${API_BASE}/auto-skips/apply`, cookie, {})).status).toBe(403);
    expect(
      (await db.select().from(routineAutoSkips)).filter((row) => row.status === 'applied'),
    ).toHaveLength(0);
    patchFailure = 'commit-then-reject';
    expect((await apiRequest('POST', `${API_BASE}/auto-skips/apply`, cookie, {})).status).toBe(503);
    expect(events.get('failure_case')?.status).toBe('cancelled');
    expect(
      (await db.select().from(routineAutoSkips)).filter((row) => row.status === 'applied'),
    ).toHaveLength(1);

    patchFailure = 'none';
    const recovered = await apiRequest('POST', `${API_BASE}/auto-skips/apply`, cookie, {});
    expect(recovered.status).toBe(200);
    expect(patchCount).toBeGreaterThan(1);
    expect(
      (await db.select().from(routineAutoSkips)).filter((row) => row.status === 'applied'),
    ).toHaveLength(1);

    await env.DB.prepare(
      "UPDATE routine_auto_skips SET status = 'overridden' WHERE original_start = ?",
    )
      .bind('2026-11-03T17:00:00+09:00')
      .run();
    addInstance('restore_d1_failure', '2026-11-23', { status: 'cancelled' });
    await addAppliedRecord('ledger_restore_d1_failure', '2026-11-23T17:00:00+09:00', 'holiday');
    await env.DB.prepare(
      "CREATE TRIGGER fail_auto_skip_delete BEFORE DELETE ON routine_auto_skips BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    ).run();
    expect((await setSettings(cookie, false, false)).status).toBe(500);
    expect(events.get('restore_d1_failure')?.status).toBe('confirmed');
    await env.DB.prepare('DROP TRIGGER fail_auto_skip_delete').run();
    const patchesAfterRestore = patchCount;
    expect((await apiRequest('POST', `${API_BASE}/auto-skips/apply`, cookie, {})).status).toBe(200);
    expect(patchCount).toBe(patchesAfterRestore);
    expect(
      (await db.select().from(routineAutoSkips)).some(
        (row) => row.id === 'ledger_restore_d1_failure',
      ),
    ).toBe(false);
  }, 20_000);

  it('returns read-only settings, due thresholds, and auto skip reasons', async () => {
    const { cookie } = await fixture({ skipHolidays: true, skipNewYear: false });
    const additional = [
      { id: 'due_null', until: null, enabled: true },
      { id: 'due_before', until: '2027-03-04', enabled: true },
      { id: 'due_boundary', until: '2027-03-05', enabled: true },
      { id: 'not_due', until: '2027-03-06', enabled: true },
      { id: 'disabled', until: null, enabled: false },
    ];
    for (const [index, row] of additional.entries()) {
      const masterId = `master_${row.id}`;
      await db.insert(routineSettings).values({
        id: row.id,
        familyId: FAMILY_ID,
        calendarId: CALENDAR_ID,
        recurringEventId: masterId,
        category: 'lesson',
        skipHolidays: row.enabled,
        autoSkipAppliedUntil: row.until,
      });
      events.set(masterId, {
        id: masterId,
        summary: `繰り返し${index}`,
        status: 'confirmed',
        start: { dateTime: '2026-10-06T17:00:00+09:00', timeZone: 'Asia/Tokyo' },
        end: { dateTime: '2026-10-06T18:00:00+09:00', timeZone: 'Asia/Tokyo' },
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU'],
      });
    }
    addInstance('reason_instance', '2026-11-03', { status: 'cancelled' });
    await addAppliedRecord('ledger_reason', '2026-11-03T17:00:00+09:00', 'holiday');

    const patchCountBefore = patchCount;
    const response = await apiRequest('GET', `/api/families/${FAMILY_ID}/routines`, cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      routines: Array<{
        id: string;
        skipHolidays: boolean;
        skipNewYear: boolean;
        autoSkipDue: boolean;
        upcoming: { instances: Array<{ id: string; autoSkipReason: string | null }> };
      }>;
    };
    const routinesById = new Map(body.routines.map((row) => [row.id, row]));
    expect(routinesById.get(ROUTINE_ID)?.upcoming.instances).toContainEqual(
      expect.objectContaining({ id: 'reason_instance', autoSkipReason: 'holiday' }),
    );
    expect(routinesById.get('due_null')?.autoSkipDue).toBe(true);
    expect(routinesById.get('due_before')?.autoSkipDue).toBe(true);
    expect(routinesById.get('due_boundary')?.autoSkipDue).toBe(false);
    expect(routinesById.get('not_due')?.autoSkipDue).toBe(false);
    expect(routinesById.get('disabled')?.autoSkipDue).toBe(false);
    expect(routinesById.get(ROUTINE_ID)).toMatchObject({ skipHolidays: true, skipNewYear: false });
    expect(patchCount).toBe(patchCountBefore);
  });

  it('rejects unauthenticated, nonmember, foreign routine, and malformed mutation requests', async () => {
    const { cookie } = await fixture();
    expect(
      (
        await apiRequest('PATCH', `${API_BASE}/settings`, '', {
          skipHolidays: true,
          skipNewYear: false,
        })
      ).status,
    ).toBe(401);

    await addUser('auto_skip_stranger', 'stranger-refresh');
    const { rawToken } = await createSession(db, 'auto_skip_stranger');
    const strangerCookie = await cookieFor(rawToken);
    expect(
      (await apiRequest('POST', `${API_BASE}/auto-skips/apply`, strangerCookie, {})).status,
    ).toBe(404);

    await db.insert(users).values({
      id: 'foreign_owner',
      googleSub: 'foreign-owner-sub',
      email: 'foreign@example.test',
      displayName: 'Foreign',
    });
    await db.insert(families).values({
      id: 'foreign_family',
      name: '別の家族',
      ownerUserId: 'foreign_owner',
      familyCalendarId: 'foreign_calendar',
      creationStatus: 'ready',
    });
    await db.insert(routineSettings).values({
      id: 'foreign_routine',
      familyId: 'foreign_family',
      calendarId: 'foreign_calendar',
      recurringEventId: 'foreign_master',
      category: 'lesson',
    });
    expect(
      (
        await apiRequest(
          'POST',
          `/api/families/${FAMILY_ID}/routines/foreign_routine/auto-skips/apply`,
          cookie,
          {},
        )
      ).status,
    ).toBe(404);

    expect(
      (await apiRequest('PATCH', `${API_BASE}/settings`, cookie, { skipHolidays: true })).status,
    ).toBe(400);
    expect(
      (
        await apiRequest('PATCH', `${API_BASE}/settings`, cookie, {
          skipHolidays: true,
          skipNewYear: false,
          extra: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await apiRequest('POST', `${API_BASE}/auto-skips/apply`, cookie, { extra: true })).status,
    ).toBe(400);
    const badOrigin = await app.request(
      `${ORIGIN}${API_BASE}/settings`,
      {
        method: 'PATCH',
        headers: {
          Origin: 'https://attacker.example',
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ skipHolidays: true, skipNewYear: false }),
      },
      TEST_ENV,
    );
    expect(badOrigin.status).toBe(403);
    const missingRequestHeader = await app.request(
      `${ORIGIN}${API_BASE}/settings`,
      {
        method: 'PATCH',
        headers: {
          Origin: ORIGIN,
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ skipHolidays: true, skipNewYear: false }),
      },
      TEST_ENV,
    );
    expect(missingRequestHeader.status).toBe(403);
    expect(patchCount).toBe(0);
    expect(
      (await db.select().from(routineSettings)).find((row) => row.id === ROUTINE_ID)?.skipHolidays,
    ).toBe(false);
  });

  it('does not partially mutate instances when pagination is truncated', async () => {
    const { cookie } = await fixture();
    for (let index = 0; index < 1001; index += 1) {
      addInstance(`truncated_${index}`, '2026-11-03');
    }
    const response = await setSettings(cookie, true, false);
    expect(response.status).toBe(503);
    expect(patchCount).toBe(0);
    expect(instanceRequests).toHaveLength(4);
    expect(await db.select().from(routineAutoSkips)).toHaveLength(0);
  });

  it('keeps an instance protected if its manual override record cannot be persisted', async () => {
    const { cookie } = await fixture({ skipHolidays: true });
    addInstance('restore_with_failure', '2026-11-03', { status: 'cancelled' });
    await addAppliedRecord('ledger_restore_failure', '2026-11-03T17:00:00+09:00', 'holiday');
    await env.DB.prepare(
      "CREATE TRIGGER fail_auto_skip_override BEFORE UPDATE OF status ON routine_auto_skips WHEN NEW.status = 'overridden' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    ).run();
    const restorePath = `${API_BASE}/instances/restore_with_failure/restore`;
    expect((await apiRequest('POST', restorePath, cookie, {})).status).toBe(500);
    expect(patchCount).toBe(0);
    expect((await db.select().from(routineAutoSkips))[0]?.status).toBe('applied');

    await env.DB.prepare('DROP TRIGGER fail_auto_skip_override').run();
    expect((await apiRequest('POST', restorePath, cookie, {})).status).toBe(200);
    expect(events.get('restore_with_failure')?.status).toBe('confirmed');
    expect((await db.select().from(routineAutoSkips))[0]?.status).toBe('overridden');
    const patchesAfterManualRestore = patchCount;
    expect((await setSettings(cookie, false, false)).status).toBe(200);
    expect((await setSettings(cookie, true, false)).status).toBe(200);
    expect((await apiRequest('POST', `${API_BASE}/auto-skips/apply`, cookie, {})).status).toBe(200);
    expect(patchCount).toBe(patchesAfterManualRestore);
  });
});
