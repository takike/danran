import { expect, test } from '@playwright/test';
import type { DateKey } from '../src/shared/schemas/date';
import { createEventInputSchema, eventInputSchema } from '../src/shared/schemas/events';
import type { WeekEvent, WeekResponse } from '../src/shared/schemas/week';
import { getWeekday } from '../src/shared/time/date';
import { getWeekRange } from '../src/shared/time/week';

test.use({
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  timezoneId: 'UTC',
  locale: 'ja-JP',
});

const FAMILY_ID = 'fam_synthetic';
const BASE_WEEK = '2026-10-05' as DateKey;
const MEMBERS: WeekResponse['members'] = [
  { id: 'mem_adult_a', name: 'メンバー甲', color: 'indigo', kind: 'adult', sortOrder: 0 },
  { id: 'mem_adult_b', name: 'メンバー乙', color: 'green', kind: 'adult', sortOrder: 1 },
  { id: 'mem_child', name: 'メンバー丙', color: 'ochre', kind: 'child', sortOrder: 2 },
];

const ONE_TIME_EVENT: WeekEvent = {
  id: 'evt_picnic',
  title: '公園ピクニック',
  time: {
    kind: 'timed',
    start: '2026-10-10T10:00:00+09:00',
    endExclusive: '2026-10-10T12:00:00+09:00',
  },
  memberIds: ['mem_adult_a', 'mem_child'],
  assigneeMemberId: 'mem_adult_b',
  status: 'tentative',
  isRoutine: false,
  source: 'manual',
  items: ['水筒'],
};

const RECURRING_EVENT: WeekEvent = {
  ...ONE_TIME_EVENT,
  id: 'evt_routine',
  title: 'スイミング',
  time: {
    kind: 'timed',
    start: '2026-10-07T17:00:00+09:00',
    endExclusive: '2026-10-07T18:00:00+09:00',
  },
  isRoutine: true,
};

function buildWeek(events: WeekEvent[]): WeekResponse {
  const range = getWeekRange(BASE_WEEK);
  const days = range.days.map((date) => {
    const dayEvents = events.filter((event) => {
      if (event.time.kind === 'all-day')
        return event.time.start <= date && date < event.time.endExclusive;
      const start = event.time.start.slice(0, 10);
      const end = event.time.endExclusive.slice(0, 10);
      return (
        start <= date &&
        date <= end &&
        !(end === date && event.time.endExclusive.endsWith('T00:00:00+09:00'))
      );
    });
    const weekday = getWeekday(date);
    return {
      date,
      weekday,
      holidayName: null,
      closures: [],
      layout:
        weekday === 0 || weekday === 6
          ? ('weekend-card' as const)
          : dayEvents.some((event) => !event.isRoutine)
            ? ('expanded' as const)
            : ('compact' as const),
      eventIds: dayEvents.map((event) => event.id),
    };
  });
  return {
    family: { id: FAMILY_ID, name: 'サンプル家' },
    members: MEMBERS,
    week: {
      start: range.start,
      endInclusive: range.endInclusive,
      prevWeekStart: range.prevWeekStart,
      nextWeekStart: range.nextWeekStart,
      today: '2026-10-07',
    },
    days: [...days].reverse(),
    events,
  };
}

async function mockEventApis(page: import('@playwright/test').Page) {
  let events = [ONE_TIME_EVENT, RECURRING_EVENT];
  let eventSequence = 0;
  const createBodies: ReturnType<typeof createEventInputSchema.parse>[] = [];
  const updateBodies: ReturnType<typeof eventInputSchema.parse>[] = [];
  const updateMethods: string[] = [];
  let deleteCalls = 0;

  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'usr_synthetic', email: 'private@example.test', displayName: 'テスト利用者' },
      }),
    });
  });
  await page.route('**/api/families', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        families: [
          {
            id: FAMILY_ID,
            name: 'サンプル家',
            familyCalendarId: 'cal_synthetic',
            ownerUserId: 'usr_synthetic',
            creationStatus: 'ready',
            members: [],
          },
        ],
      }),
    });
  });
  await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/week/personal')) {
      const familyWeek = buildWeek(events);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          family: { id: FAMILY_ID },
          memberId: 'mem_event_adult',
          week: familyWeek.week,
          status: 'authorization_required',
          events: [],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildWeek(events)),
    });
  });
  await page.route(`**/api/families/${FAMILY_ID}/events`, async (route) => {
    const body = createEventInputSchema.parse(route.request().postDataJSON());
    createBodies.push(body);
    eventSequence++;
    const created: WeekEvent = {
      id: `evt_created_${eventSequence}`,
      title: body.title,
      time: body.time,
      memberIds: body.memberIds,
      assigneeMemberId: body.assigneeMemberId,
      status: body.status,
      isRoutine: false,
      source: 'manual',
      items: body.items,
    };
    events = [...events, created];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ eventId: created.id }),
    });
  });
  await page.route(`**/api/families/${FAMILY_ID}/events/*`, async (route) => {
    const eventId = new URL(route.request().url()).pathname.split('/').at(-1);
    if (route.request().method() === 'PATCH') {
      const body = eventInputSchema.parse(route.request().postDataJSON());
      updateBodies.push(body);
      updateMethods.push(route.request().method());
      const existing = events.find((event) => event.id === eventId);
      if (!existing) throw new Error('Expected mocked event to exist');
      events = events.map((event) =>
        event.id === eventId
          ? {
              ...event,
              title: body.title,
              time: body.time,
              memberIds: body.memberIds,
              assigneeMemberId: body.assigneeMemberId,
              status: body.status,
              items: body.items,
            }
          : event,
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ eventId }),
      });
      return;
    }
    if (route.request().method() === 'DELETE') {
      deleteCalls++;
      events = events.filter((event) => event.id !== eventId);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    }
  });
  return {
    createBodies,
    updateBodies,
    updateMethods,
    removeEvent: (eventId: string) => {
      events = events.filter((event) => event.id !== eventId);
    },
    get deleteCalls() {
      return deleteCalls;
    },
  };
}

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document, JSON.stringify(widths)).toBeLessThanOrEqual(widths.viewport);
}

async function expectVisibleTargetsAtLeast44px(page: import('@playwright/test').Page) {
  const controls = page.locator(
    'dialog button:visible, dialog input:visible:not([type="checkbox"]):not([type="radio"]), dialog select:visible',
  );
  for (const control of await controls.all()) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    if (bounds) {
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.width).toBeGreaterThanOrEqual(44);
    }
  }
  const choiceInputs = page.locator(
    'dialog input[type="checkbox"]:visible, dialog input[type="radio"]:visible',
  );
  for (const input of await choiceInputs.all()) {
    const label = input.locator('xpath=ancestor::label[1]');
    const bounds = await label.boundingBox();
    expect(bounds).not.toBeNull();
    if (bounds) {
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.width).toBeGreaterThanOrEqual(44);
    }
  }
}

test.describe('Task 1-8: family event editing', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Date.now = () => Date.parse('2026-10-07T12:00:00+09:00');
    });
  });

  test('creates, edits, and deletes a one-time event; blocks duplicate save and renders 390px form screenshot', async ({
    page,
  }) => {
    const api = await mockEventApis(page);
    let releaseCreate: (() => void) | undefined;
    let createStarted: (() => void) | undefined;
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    await page.route(`**/api/families/${FAMILY_ID}/events`, async (route) => {
      const body = createEventInputSchema.parse(route.request().postDataJSON());
      api.createBodies.push(body);
      createStarted?.();
      await createGate;
      const created: WeekEvent = {
        id: 'evt_created',
        title: body.title,
        time: body.time,
        memberIds: body.memberIds,
        assigneeMemberId: body.assigneeMemberId,
        status: body.status,
        isRoutine: false,
        source: 'manual',
        items: body.items,
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ eventId: created.id }),
      });
    });

    await page.goto('/?week=2026-10-05');
    const addButton = page.getByRole('button', { name: '予定を追加', exact: true });
    await expect(addButton).toBeVisible();
    await expect(page.getByTestId('add-event-2026-10-10')).toHaveAttribute(
      'aria-label',
      '10月10日に予定を追加',
    );
    await page.getByTestId('add-event-2026-10-10').click();
    const dialog = page.getByTestId('event-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('開始日')).toHaveValue('2026-10-10');
    await expect(dialog.getByLabel('終了日')).toHaveValue('2026-10-10');
    const title = dialog.getByLabel('タイトル');
    await expect(title).toBeFocused();
    await title.fill('動物園へ行く');
    await dialog.getByLabel('開始日').fill('2026-10-10');
    await dialog.getByLabel('終了日').fill('2026-10-10');
    await dialog.getByLabel('開始時刻').fill('09:30');
    await dialog.getByLabel('終了時刻').fill('12:00');
    await dialog.getByRole('checkbox', { name: 'メンバー丙' }).check();
    await dialog.getByLabel('担当（大人）').selectOption('mem_adult_a');
    await dialog.locator('input[maxlength="100"]').first().fill('お弁当');
    await dialog.getByRole('button', { name: '持ち物を追加' }).click();
    await dialog.locator('input[maxlength="100"]').nth(1).fill('レジャーシート');
    await dialog.getByRole('radio', { name: '候補' }).check();
    await expectNoHorizontalOverflow(page);
    await expectVisibleTargetsAtLeast44px(page);
    if (process.env.DANRAN_SCREENSHOTS === '1') {
      const fullDialogHeight = await dialog.evaluate((element) =>
        Math.ceil(element.scrollHeight + 96),
      );
      await page.setViewportSize({ width: 390, height: fullDialogHeight });
      await dialog.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: 'docs/screenshots/event-form.png' });
      await page.setViewportSize({ width: 390, height: 844 });
    }

    const save = dialog.getByTestId('save-event');
    await save.click();
    await createStartedPromise;
    await expect(save).toBeDisabled();
    await save.click({ force: true });
    expect(api.createBodies).toHaveLength(1);
    releaseCreate?.();
    await expect(dialog).toHaveCount(0);
    expect(api.createBodies[0]?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(api.createBodies[0]).toMatchObject({
      title: '動物園へ行く',
      time: {
        kind: 'timed',
        start: '2026-10-10T09:30:00+09:00',
        endExclusive: '2026-10-10T12:00:00+09:00',
      },
      memberIds: ['mem_child'],
      assigneeMemberId: 'mem_adult_a',
      items: ['お弁当', 'レジャーシート'],
      status: 'tentative',
    });

    await page.getByTestId('edit-event-evt_picnic').click();
    const editDialog = page.getByTestId('event-dialog');
    await editDialog.getByLabel('タイトル').fill('公園と図書館');
    await editDialog.locator('input[maxlength="100"]').first().fill('水筒');
    await editDialog.getByRole('radio', { name: '確定' }).check();
    await editDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(editDialog).toHaveCount(0);
    expect(api.updateMethods).toEqual(['PATCH']);
    expect(api.updateBodies[0]).toMatchObject({
      title: '公園と図書館',
      memberIds: ['mem_adult_a', 'mem_child'],
      assigneeMemberId: 'mem_adult_b',
      items: ['水筒'],
      status: 'confirmed',
    });

    await page.getByTestId('edit-event-evt_picnic').click();
    const deleteDialog = page.getByTestId('event-dialog');
    await deleteDialog.getByRole('button', { name: '削除', exact: true }).click();
    await expect(deleteDialog.getByText('「公園と図書館」を削除しますか？')).toBeVisible();
    await expect(deleteDialog.getByTestId('confirm-delete-event')).toBeVisible();
    await deleteDialog.getByRole('button', { name: '削除しない' }).click();
    await expect(deleteDialog.getByText('「公園と図書館」を削除しますか？')).toHaveCount(0);
    await deleteDialog.getByRole('button', { name: '削除', exact: true }).click();
    let deleteCalls = 0;
    let releaseDelete: (() => void) | undefined;
    let deleteStarted: (() => void) | undefined;
    const deleteStartedPromise = new Promise<void>((resolve) => {
      deleteStarted = resolve;
    });
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    await page.route(`**/api/families/${FAMILY_ID}/events/*`, async (route) => {
      if (route.request().method() !== 'DELETE') {
        await route.fallback();
        return;
      }
      deleteCalls++;
      deleteStarted?.();
      await deleteGate;
      api.removeEvent('evt_picnic');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    const confirmDelete = deleteDialog.getByTestId('confirm-delete-event');
    await confirmDelete.click();
    await deleteStartedPromise;
    await expect(confirmDelete).toBeDisabled();
    await confirmDelete.click({ force: true });
    releaseDelete?.();
    await expect(deleteDialog).toHaveCount(0);
    expect(deleteCalls).toBe(1);
    expect(api.deleteCalls).toBe(0);
    await expect(page.getByRole('button', { name: '予定を追加', exact: true })).toBeFocused();
  });

  test('retains input on a fixed API error and reuses the same client request UUID on retry', async ({
    page,
  }) => {
    const api = await mockEventApis(page);
    let postCount = 0;
    await page.route(`**/api/families/${FAMILY_ID}/events`, async (route) => {
      const body = createEventInputSchema.parse(route.request().postDataJSON());
      api.createBodies.push(body);
      postCount++;
      if (postCount === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'GOOGLE_TEMPORARY_ERROR',
            error: 'Google Calendar is temporarily unavailable',
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ eventId: 'evt_retry' }),
      });
    });
    await page.goto('/?week=2026-10-05');
    await page.getByRole('button', { name: '予定を追加', exact: true }).click();
    const dialog = page.getByTestId('event-dialog');
    await dialog.getByLabel('タイトル').fill('入力を保つ予定');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'Google カレンダーとの通信に一時的な問題があります。時間をおいて再度お試しください。',
    );
    await expect(dialog.getByRole('alert')).not.toContainText(
      'Google Calendar is temporarily unavailable',
    );
    await expect(dialog.getByLabel('タイトル')).toHaveValue('入力を保つ予定');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(postCount).toBe(2);
    expect(api.createBodies[0]?.clientRequestId).toBe(api.createBodies[1]?.clientRequestId);
  });

  test('an ambiguous create retry replays the original POST before patching the latest form values', async ({
    page,
  }) => {
    await mockEventApis(page);
    const posts: ReturnType<typeof createEventInputSchema.parse>[] = [];
    const patches: ReturnType<typeof eventInputSchema.parse>[] = [];
    await page.route(`**/api/families/${FAMILY_ID}/events`, async (route) => {
      const body = createEventInputSchema.parse(route.request().postDataJSON());
      posts.push(body);
      if (posts.length === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'GOOGLE_TEMPORARY_ERROR',
            error: 'synthetic ambiguous timeout',
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ eventId: 'evt_ambiguous' }),
      });
    });
    await page.route(`**/api/families/${FAMILY_ID}/events/*`, async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.fallback();
        return;
      }
      patches.push(eventInputSchema.parse(route.request().postDataJSON()));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ eventId: 'evt_ambiguous' }),
      });
    });
    await page.goto('/?week=2026-10-05');
    await page.getByRole('button', { name: '予定を追加', exact: true }).click();
    const dialog = page.getByTestId('event-dialog');
    const title = dialog.getByLabel('タイトル');
    await title.fill('最初に送った内容');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await title.fill('修正後のタイトル');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.title).toBe('修正後のタイトル');
  });

  test('a failed PATCH retries PATCH without creating another event', async ({ page }) => {
    await mockEventApis(page);
    let postCount = 0;
    const patchBodies: ReturnType<typeof eventInputSchema.parse>[] = [];
    await page.route(`**/api/families/${FAMILY_ID}/events`, async (route) => {
      postCount++;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'INTERNAL_ERROR', error: 'unexpected create' }),
      });
    });
    await page.route(`**/api/families/${FAMILY_ID}/events/*`, async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.fallback();
        return;
      }
      patchBodies.push(eventInputSchema.parse(route.request().postDataJSON()));
      if (patchBodies.length === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'GOOGLE_TEMPORARY_ERROR',
            error: 'synthetic update timeout',
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ eventId: 'evt_picnic' }),
      });
    });
    await page.goto('/?week=2026-10-05');
    await page.getByTestId('edit-event-evt_picnic').click();
    const dialog = page.getByTestId('event-dialog');
    await dialog.getByLabel('タイトル').fill('編集保存を再試行');
    await dialog.getByTestId('save-event').click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByTestId('save-event').click();
    await expect(dialog).toHaveCount(0);
    expect(postCount).toBe(0);
    expect(patchBodies).toHaveLength(2);
    expect(patchBodies[0]).toEqual(patchBodies[1]);
  });

  test('converts an inclusive all-day end to the exclusive API date and supports removing an item row', async ({
    page,
  }) => {
    const api = await mockEventApis(page);
    await page.goto('/?week=2026-10-05');
    await expect(page.getByTestId('add-event-2026-10-10')).toHaveAttribute(
      'aria-label',
      '10月10日に予定を追加',
    );
    await page.getByTestId('add-event-2026-10-10').click();
    const dialog = page.getByTestId('event-dialog');
    await dialog.getByLabel('タイトル').fill('終日の運動会');
    await dialog.getByLabel('終日').check();
    await dialog.getByLabel('開始日').fill('2026-10-10');
    await dialog.getByLabel('終了日').fill('2026-10-10');
    await dialog.getByRole('button', { name: '持ち物を追加' }).click();
    expect(await dialog.locator('input[maxlength="100"]').count()).toBe(2);
    await dialog.getByRole('button', { name: '持ち物 2 を削除' }).click();
    expect(await dialog.locator('input[maxlength="100"]').count()).toBe(1);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.createBodies[0]?.time).toEqual({
      kind: 'all-day',
      start: '2026-10-10',
      endExclusive: '2026-10-11',
    });
  });

  test('edits timed events to all-day and back to timed with the correct API date range', async ({
    page,
  }) => {
    const api = await mockEventApis(page);
    await page.goto('/?week=2026-10-05');
    await page.getByTestId('edit-event-evt_picnic').click();
    const allDayDialog = page.getByTestId('event-dialog');
    await expect(allDayDialog.getByLabel('終日')).not.toBeChecked();
    await allDayDialog.getByLabel('終日').check();
    await expect(allDayDialog.getByLabel('開始時刻')).toHaveCount(0);
    await allDayDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(allDayDialog).toHaveCount(0);
    expect(api.updateBodies[0]?.time).toEqual({
      kind: 'all-day',
      start: '2026-10-10',
      endExclusive: '2026-10-11',
    });

    await page.getByTestId('edit-event-evt_picnic').click();
    const timedDialog = page.getByTestId('event-dialog');
    await expect(timedDialog.getByLabel('終日')).toBeChecked();
    await timedDialog.getByLabel('終日').uncheck();
    await timedDialog.getByLabel('開始時刻').fill('14:30');
    await timedDialog.getByLabel('終了時刻').fill('16:00');
    await timedDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(timedDialog).toHaveCount(0);
    expect(api.updateBodies[1]?.time).toEqual({
      kind: 'timed',
      start: '2026-10-10T14:30:00+09:00',
      endExclusive: '2026-10-10T16:00:00+09:00',
    });
  });

  test('rejects reversed time ranges with a fixed message while preserving the entered values', async ({
    page,
  }) => {
    await mockEventApis(page);
    let requestCount = 0;
    await page.route(`**/api/families/${FAMILY_ID}/events`, async (route) => {
      requestCount++;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'INVALID_INPUT', error: 'private validation detail' }),
      });
    });
    await page.goto('/?week=2026-10-05');
    await page.getByTestId('add-event-2026-10-08').click();
    const dialog = page.getByTestId('event-dialog');
    await dialog.getByLabel('タイトル').fill('逆転した時間');
    await dialog.getByLabel('開始時刻').fill('12:00');
    await dialog.getByLabel('終了時刻').fill('11:00');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('入力内容を確認してください。');
    await expect(dialog.getByLabel('タイトル')).toHaveValue('逆転した時間');
    await expect(dialog.getByLabel('開始時刻')).toHaveValue('12:00');
    await expect(dialog.getByLabel('終了時刻')).toHaveValue('11:00');
    expect(requestCount).toBe(0);
  });

  test('a later week-query failure leaves an open event draft editable', async ({ page }) => {
    await mockEventApis(page);
    let weekCalls = 0;
    await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/week/personal')) {
        await route.fallback();
        return;
      }
      if (url.pathname.endsWith('/week/busy')) {
        const familyWeek = buildWeek([ONE_TIME_EVENT, RECURRING_EVENT]);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            family: { id: FAMILY_ID },
            week: familyWeek.week,
            members: [],
          }),
        });
        return;
      }
      if (!url.pathname.endsWith('/week')) {
        await route.fallback();
        return;
      }
      weekCalls++;
      if (weekCalls === 1) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(buildWeek([ONE_TIME_EVENT, RECURRING_EVENT])),
        });
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'GOOGLE_TEMPORARY_ERROR', error: 'private week response' }),
      });
    });
    await page.goto('/?week=2026-10-05');
    await page.getByRole('button', { name: '予定を追加', exact: true }).click();
    const dialog = page.getByTestId('event-dialog');
    await dialog.getByLabel('タイトル').fill('週の取得に失敗しても残す入力');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      window.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => weekCalls).toBe(2);
    await expect(page.getByRole('alert')).toContainText('週の予定を取得できませんでした');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('タイトル')).toHaveValue('週の取得に失敗しても残す入力');
    await expect(dialog.getByText('private week response')).toHaveCount(0);
  });

  test('validates required title before sending and shows recurrence guidance instead of opening its editor', async ({
    page,
  }) => {
    const api = await mockEventApis(page);
    await page.goto('/?week=2026-10-05');
    await page.getByRole('button', { name: '予定を追加', exact: true }).click();
    const dialog = page.getByTestId('event-dialog');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog.getByLabel('タイトル')).toBeFocused();
    expect(api.createBodies).toHaveLength(0);
    await dialog.getByRole('button', { name: 'キャンセル' }).click();
    await page.getByTestId('edit-event-evt_routine').click();
    await expect(page.getByTestId('routine-event-notice')).toContainText(
      '繰り返し予定の変更は準備中です。',
    );
    await expect(page.getByTestId('event-dialog')).toHaveCount(0);
  });

  test('Escape and browser Back close the dialog and restore focus; the form fits 390px and 445px', async ({
    page,
  }) => {
    await mockEventApis(page);
    await page.goto('/?week=2026-10-05');
    const addButton = page.getByRole('button', { name: '予定を追加', exact: true });
    await addButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('event-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('event-dialog')).toHaveCount(0);
    await expect(addButton).toBeFocused();

    await addButton.click();
    await expect(page.getByTestId('event-dialog')).toBeVisible();
    await page.evaluate(() => window.history.back());
    await expect(page.getByTestId('event-dialog')).toHaveCount(0);
    await expect(addButton).toBeFocused();

    for (const width of [390, 445]) {
      await page.setViewportSize({ width, height: 844 });
      await addButton.click();
      await expect(page.getByTestId('event-dialog')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectVisibleTargetsAtLeast44px(page);
      const bounds = await page.getByTestId('event-dialog').boundingBox();
      expect(bounds?.width).toBeLessThanOrEqual(width);
      await page.getByRole('button', { name: 'キャンセル' }).click();
      await expect(page.getByTestId('event-dialog')).toHaveCount(0);
    }
  });

  test('saving clears the dialog history entry so browser Back returns to the previous week', async ({
    page,
  }) => {
    await mockEventApis(page);
    await page.goto('/?week=2026-10-05');
    await page.getByRole('button', { name: '次の週' }).click();
    const nextWeekStart = getWeekRange(BASE_WEEK).nextWeekStart;
    await expect(page).toHaveURL(new RegExp(`week=${nextWeekStart}`));
    await page.getByRole('button', { name: '予定を追加', exact: true }).click();
    const dialog = page.getByTestId('event-dialog');
    await dialog.getByLabel('タイトル').fill('履歴を保つ予定');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => window.history.back());
    await expect(page).toHaveURL(/week=2026-10-05/);
    await expect(page.getByTestId('event-dialog')).toHaveCount(0);
  });
});
