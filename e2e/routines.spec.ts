import { expect, test } from '@playwright/test';
import type { FamilyPublic } from '../src/shared/schemas/family';
import type { Routine } from '../src/shared/schemas/routines';

test.use({
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  timezoneId: 'UTC',
  locale: 'ja-JP',
});

const FAMILY_ID = 'fam_routines';
const OWNER_ID = 'usr_routine_owner';
const FAMILY: FamilyPublic = {
  id: FAMILY_ID,
  name: 'ルーティンサンプル家',
  familyCalendarId: 'cal_routines',
  ownerUserId: OWNER_ID,
  creationStatus: 'ready',
  members: [
    {
      id: 'mem_adult_a',
      userId: OWNER_ID,
      kind: 'adult',
      name: '大人甲',
      color: 'indigo',
      sortOrder: 0,
    },
    {
      id: 'mem_adult_b',
      userId: 'usr_routine_partner',
      kind: 'adult',
      name: '大人乙',
      color: 'green',
      sortOrder: 1,
    },
    {
      id: 'mem_child_a',
      userId: null,
      kind: 'child',
      name: '子ども甲',
      color: 'ochre',
      sortOrder: 2,
    },
    {
      id: 'mem_child_b',
      userId: null,
      kind: 'child',
      name: '子ども乙',
      color: 'purple',
      sortOrder: 3,
    },
  ],
};

function routine(
  overrides: Omit<Partial<Routine>, 'id' | 'title'> & { id: string; title: string | null },
): Routine {
  const { id, title, ...fields } = overrides;
  return {
    id,
    title,
    weekdays: ['TU'],
    interval: 1,
    startDate: '2026-10-13',
    endDate: null,
    startTime: '17:00',
    endTime: '18:00',
    memberIds: ['mem_child_a'],
    assigneeMemberId: 'mem_adult_a',
    category: 'lesson',
    affectsAvailability: true,
    status: 'ready',
    ...fields,
  };
}

function jsonResponse(status: number, body: unknown) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function mockRoutineApis(
  page: import('@playwright/test').Page,
  options: { routines?: Routine[] } = {},
) {
  let routines = [...(options.routines ?? [])];
  const createBodies: Array<Record<string, unknown>> = [];
  const deletedIds: string[] = [];
  let listCalls = 0;
  await page.route('**/api/auth/me', (route) =>
    route.fulfill(
      jsonResponse(200, {
        user: { id: OWNER_ID, email: 'routine@example.test', displayName: '大人甲' },
      }),
    ),
  );
  await page.route('**/api/families', (route) =>
    route.fulfill(jsonResponse(200, { families: [FAMILY] })),
  );
  await page.route(`**/api/families/${FAMILY_ID}/routines**`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      listCalls++;
      await route.fulfill(jsonResponse(200, { routines }));
      return;
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      createBodies.push(body);
      const result = routine({
        id: `routine_created_${createBodies.length}`,
        title: typeof body.title === 'string' ? body.title : '新しいルーティン',
      });
      routines = [...routines, result];
      await route.fulfill(
        jsonResponse(200, { routineId: result.id, eventId: 'evt_routine_created' }),
      );
      return;
    }
    const routineId = new URL(request.url()).pathname.split('/').at(-1) ?? '';
    deletedIds.push(routineId);
    routines = routines.filter((item) => item.id !== routineId);
    await route.fulfill(jsonResponse(200, { ok: true }));
  });
  return {
    createBodies,
    deletedIds,
    get listCalls() {
      return listCalls;
    },
    setRoutines: (next: Routine[]) => {
      routines = [...next];
    },
  };
}

async function openRoutinePage(page: import('@playwright/test').Page) {
  await page.goto('/routines');
  await expect(page.getByTestId('routines-screen')).toBeVisible();
}

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(metrics.document).toBeLessThanOrEqual(metrics.viewport);
}

async function expectVisibleTargetsAtLeast44px(page: import('@playwright/test').Page) {
  for (const button of await page.getByRole('button').all()) {
    if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
}

test.describe('Task 3-1: recurring routines', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Date.now = () => Date.parse('2026-10-07T12:00:00+09:00');
    });
  });

  test('shows an empty list and a multi-routine list, including missing Google events', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page);
    await openRoutinePage(page);
    await expect(page.getByRole('heading', { name: '毎週の予定を登録できます' })).toBeVisible();
    await expect(page.getByTestId('routine-add-button')).toBeVisible();
    await expect(page.getByRole('heading', { name: '準備中', exact: true })).toHaveCount(0);

    api.setRoutines([
      routine({ id: 'routine-piano', title: 'ピアノ', weekdays: ['TU', 'FR'] }),
      routine({
        id: 'routine-cleaning',
        title: null,
        weekdays: [],
        interval: null,
        startDate: null,
        endDate: null,
        startTime: null,
        endTime: null,
        memberIds: [],
        assigneeMemberId: null,
        category: 'housework',
        affectsAvailability: false,
        status: 'missing',
      }),
    ]);
    await page.reload();
    await expect(page.getByText('ピアノ', { exact: true })).toBeVisible();
    await expect(
      page.getByText('（タイトルを読み込めませんでした）', { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('routine-card')).toHaveCount(2);
    const missingCard = page
      .locator('[data-testid="routine-card"]')
      .filter({ hasText: '（タイトルを読み込めませんでした）' });
    await expect(missingCard).toContainText('Google カレンダーで見つかりません');
    await expect(missingCard).toContainText('家族の空き判定には影響しない');
    await expect(missingCard).toContainText('予定を削除して登録し直してください');
    expect(api.listCalls).toBeGreaterThanOrEqual(2);
    if (process.env.DANRAN_SCREENSHOTS === '1') {
      api.setRoutines([
        routine({ id: 'routine-piano', title: 'ピアノ', weekdays: ['TU', 'FR'] }),
        routine({
          id: 'routine-cleaning',
          title: '家事代行',
          weekdays: ['SA'],
          interval: 2,
          category: 'housework',
          affectsAvailability: false,
        }),
      ]);
      await page.reload();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId('routine-card')).toHaveCount(2);
      await expect(page.getByText('ピアノ', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '家事代行', exact: true })).toBeVisible();
      const biweeklyCard = page.getByTestId('routine-card').filter({ hasText: '隔週' });
      await expect(biweeklyCard).toContainText('隔週 土');
      await page.screenshot({ path: 'docs/screenshots/s4-routines.png' });
    }
  });

  test('validates the form and retries an unchanged, locked request once after a failed save', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page);
    let postCalls = 0;
    let releaseFirstResponse: (() => void) | undefined;
    let firstPostStarted: (() => void) | undefined;
    const firstPostStartedPromise = new Promise<void>((resolve) => {
      firstPostStarted = resolve;
    });
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });
    await page.route(`**/api/families/${FAMILY_ID}/routines`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      postCalls++;
      api.createBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      if (postCalls === 1) {
        firstPostStarted?.();
        await firstResponseGate;
        await route.fulfill(
          jsonResponse(503, {
            code: 'GOOGLE_TEMPORARY_ERROR',
            error: 'Google Calendar is temporarily unavailable',
          }),
        );
        return;
      }
      api.setRoutines([routine({ id: 'routine_saved', title: '隔週の水泳' })]);
      await route.fulfill(jsonResponse(200, { routineId: 'routine_saved', eventId: 'evt_saved' }));
    });

    await openRoutinePage(page);
    await page.getByRole('button', { name: '追加', exact: true }).first().click();
    const dialog = page.getByTestId('routine-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('routine-save').click();
    await expect(dialog.getByTestId('routine-form-title')).toBeFocused();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    expect(postCalls).toBe(0);

    await dialog.getByTestId('routine-form-title').fill('隔週の水泳');
    await dialog.getByTestId('routine-end-time').fill('16:30');
    await dialog.getByTestId('routine-save').click();
    await expect(dialog.getByTestId('routine-end-time')).toBeFocused();
    expect(postCalls).toBe(0);
    await dialog.getByTestId('routine-end-time').fill('18:30');
    await dialog.getByTestId('routine-weekday-WE').uncheck();
    await dialog.getByTestId('routine-weekday-MO').check();
    await dialog.getByTestId('routine-weekday-FR').check();
    await dialog.getByTestId('routine-interval-2').check();
    await dialog.getByTestId('routine-start-date').fill('2026-10-07');
    await dialog.getByTestId('routine-start-time').fill('17:00');
    await dialog.getByTestId('routine-member-mem_adult_b').check();
    await dialog.getByTestId('routine-member-mem_child_b').check();
    await dialog.getByTestId('routine-assignee').selectOption('mem_adult_b');
    await dialog.getByTestId('routine-category').selectOption('lesson');
    await dialog.getByTestId('routine-affects-availability').uncheck();
    if (process.env.DANRAN_SCREENSHOTS === '1') {
      const fullFormHeight = await dialog.evaluate((element) => element.scrollHeight);
      await page.setViewportSize({ width: 390, height: Math.ceil(fullFormHeight) });
      await page.screenshot({ path: 'docs/screenshots/routine-form.png' });
    }

    const save = dialog.getByTestId('routine-save');
    const saveRequest = save.click();
    await firstPostStartedPromise;
    await expect(save).toBeDisabled();
    await expect(dialog.getByTestId('routine-form-title')).toBeDisabled();
    await dialog.getByTestId('routine-save').evaluate((button) => {
      (button as HTMLButtonElement).click();
    });
    expect(postCalls).toBe(1);
    releaseFirstResponse?.();
    await saveRequest;

    await expect(dialog.getByRole('alert')).toContainText('一時的');
    await expect(dialog.getByTestId('routine-form-title')).toHaveValue('隔週の水泳');
    await expect(dialog.getByTestId('routine-form-title')).toBeDisabled();
    const firstBody = api.createBodies[0];
    expect(firstBody).toMatchObject({
      title: '隔週の水泳',
      weekdays: ['MO', 'FR'],
      interval: 2,
      startDate: '2026-10-07',
      startTime: '17:00',
      endTime: '18:30',
      endDate: null,
      memberIds: ['mem_adult_b', 'mem_child_b'],
      assigneeMemberId: 'mem_adult_b',
      category: 'lesson',
      affectsAvailability: false,
    });
    expect(firstBody?.clientRequestId).toEqual(expect.any(String));

    await save.click();
    await expect(dialog).toHaveCount(0);
    expect(postCalls).toBe(2);
    expect(api.createBodies[1]).toEqual(firstBody);
    await expect(page.getByText('隔週の水泳', { exact: true })).toBeVisible();
  });

  test('deletes a whole series only after inline confirmation and can cancel safely', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-delete', title: 'ロボット教室' })],
    });
    await openRoutinePage(page);
    const card = page.locator('[data-testid="routine-card"]').filter({ hasText: 'ロボット教室' });
    await card.getByTestId('routine-delete-routine-delete').click();
    await expect(card).toContainText('これまでの回も含めてすべて削除します');
    await expect(card.getByTestId('routine-delete-confirm-routine-delete')).toBeVisible();
    await card.getByTestId('routine-delete-cancel-routine-delete').click();
    await expect(card).toContainText('ロボット教室');
    expect(api.deletedIds).toEqual([]);

    await card.getByTestId('routine-delete-routine-delete').click();
    await card.getByTestId('routine-delete-confirm-routine-delete').click();
    await expect(page.getByText('ロボット教室', { exact: true })).toHaveCount(0);
    expect(api.deletedIds).toEqual(['routine-delete']);
  });

  test('starts a fresh form and uses a new request UUID after each successful creation', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page);
    await openRoutinePage(page);
    await page.getByTestId('routine-add-button').click();
    const firstDialog = page.getByTestId('routine-dialog');
    await firstDialog.getByTestId('routine-form-title').fill('最初の習い事');
    await firstDialog.getByTestId('routine-save').click();
    await expect(firstDialog).toHaveCount(0);
    await expect(page.getByText('最初の習い事', { exact: true })).toBeVisible();

    await page.getByTestId('routine-add-button').click();
    const nextDialog = page.getByTestId('routine-dialog');
    await expect(nextDialog.getByTestId('routine-form-title')).toHaveValue('');
    await expect(nextDialog.getByTestId('routine-start-time')).toHaveValue('17:00');
    await expect(nextDialog.getByTestId('routine-end-time')).toHaveValue('18:00');
    await expect(nextDialog.getByTestId('routine-interval-1')).toBeChecked();
    await nextDialog.getByTestId('routine-form-title').fill('次の家族ルーティン');
    await nextDialog.getByTestId('routine-weekday-WE').uncheck();
    await nextDialog.getByTestId('routine-weekday-MO').check();
    await nextDialog.getByTestId('routine-save').click();
    await expect(nextDialog).toHaveCount(0);
    await expect(page.getByText('次の家族ルーティン', { exact: true })).toBeVisible();

    expect(api.createBodies).toHaveLength(2);
    expect(api.createBodies[0]?.title).toBe('最初の習い事');
    expect(api.createBodies[1]?.title).toBe('次の家族ルーティン');
    expect(api.createBodies[0]?.clientRequestId).toEqual(expect.any(String));
    expect(api.createBodies[1]?.clientRequestId).toEqual(expect.any(String));
    expect(api.createBodies[1]?.clientRequestId).not.toBe(api.createBodies[0]?.clientRequestId);
  });

  test('fits 390px and 445px, keeps controls at least 44px, and only the routine tab is ready', async ({
    page,
  }) => {
    await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-long', title: '家族みんなで参加する長めの習い事' })],
    });
    await openRoutinePage(page);
    for (const width of [390, 445]) {
      await page.setViewportSize({ width, height: 844 });
      await expectNoHorizontalOverflow(page);
      await expectVisibleTargetsAtLeast44px(page);
      await page.getByTestId('routine-add-button').click();
      await expect(page.getByTestId('routine-dialog')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectVisibleTargetsAtLeast44px(page);
      await page.getByRole('button', { name: '閉じる' }).click();
      await expect(page.getByTestId('routine-dialog')).toBeHidden();
    }
    const navigation = page.getByRole('navigation', { name: 'メインナビゲーション' });
    await expect(navigation.getByRole('link', { name: /繰り返し/ })).toBeVisible();
    await expect(navigation.getByRole('link', { name: /繰り返し/ })).not.toContainText('準備中');
    await expect(navigation.getByRole('link', { name: /やること/ })).toContainText('準備中');
    await expect(navigation.getByText('準備中', { exact: true })).toHaveCount(2);
  });
});
