import { expect, test } from '@playwright/test';
import type { FamilyPublic } from '../src/shared/schemas/family';
import type { Routine, RoutineInstance } from '../src/shared/schemas/routines';

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
    skipHolidays: false,
    skipNewYear: false,
    autoSkipDue: false,
    status: 'ready',
    upcoming: { status: 'ready', instances: sampleInstances(`instance-${id}`) },
    ...fields,
  };
}

function instance(
  id: string,
  originalDate: string,
  status: RoutineInstance['status'] = 'normal',
  actualDate: string | null = originalDate,
  startTime = '17:00',
  endTime = '18:00',
  autoSkipReason: RoutineInstance['autoSkipReason'] = null,
): RoutineInstance {
  const originalStart = `${originalDate}T17:00:00+09:00`;
  const originalEnd = `${originalDate}T18:00:00+09:00`;
  return {
    id,
    originalStart,
    originalEnd,
    start: actualDate === null ? null : `${actualDate}T${startTime}:00+09:00`,
    end: actualDate === null ? null : `${actualDate}T${endTime}:00+09:00`,
    status,
    autoSkipReason,
  };
}

function sampleInstances(prefix: string): RoutineInstance[] {
  return [
    instance(`${prefix}-1`, '2026-10-13'),
    instance(`${prefix}-2`, '2026-10-20'),
    instance(`${prefix}-3`, '2026-10-27'),
    instance(`${prefix}-4`, '2026-11-03'),
  ];
}

function jsonResponse(status: number, body: unknown) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function mockRoutineApis(
  page: import('@playwright/test').Page,
  options: {
    routines?: Routine[];
    failNextInstanceMutation?: boolean;
    holdInstanceMutation?: boolean;
  } = {},
) {
  let routines = [...(options.routines ?? [])];
  const createBodies: Array<Record<string, unknown>> = [];
  const deletedIds: string[] = [];
  const instanceMutations: Array<{
    routineId: string;
    instanceId: string;
    action: string;
    body: unknown;
  }> = [];
  const settingsMutations: Array<{ routineId: string; body: unknown }> = [];
  const autoSkipMutations: string[] = [];
  let listCalls = 0;
  let failNextInstanceMutation = options.failNextInstanceMutation ?? false;
  let signalInstanceMutationStarted: () => void = () => {};
  let releaseInstanceMutation: () => void = () => {};
  const instanceMutationStarted = new Promise<void>((resolve) => {
    signalInstanceMutationStarted = resolve;
  });
  const instanceMutationGate = new Promise<void>((resolve) => {
    releaseInstanceMutation = resolve;
  });
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
    const pathname = new URL(request.url()).pathname;
    const settingsMatch = pathname.match(/\/routines\/([^/]+)\/settings$/);
    if (request.method() === 'PATCH' && settingsMatch) {
      const routineId = settingsMatch[1] ?? '';
      const body = request.postDataJSON() as { skipHolidays: boolean; skipNewYear: boolean };
      settingsMutations.push({ routineId, body });
      routines = routines.map((item) =>
        item.id === routineId
          ? { ...item, skipHolidays: body.skipHolidays, skipNewYear: body.skipNewYear }
          : item,
      );
      await route.fulfill(
        jsonResponse(200, {
          skipHolidays: body.skipHolidays,
          skipNewYear: body.skipNewYear,
          hasMore: false,
        }),
      );
      return;
    }
    if (request.method() === 'POST') {
      const applyMatch = pathname.match(/\/routines\/([^/]+)\/auto-skips\/apply$/);
      if (applyMatch) {
        autoSkipMutations.push(applyMatch[1] ?? '');
        await route.fulfill(
          jsonResponse(200, { skipHolidays: false, skipNewYear: false, hasMore: false }),
        );
        return;
      }
      const instanceMatch = pathname.match(
        /\/routines\/([^/]+)\/instances\/([^/]+)\/(skip|restore|move)$/,
      );
      if (instanceMatch) {
        const [, routineId = '', instanceId = '', action = ''] = instanceMatch;
        const body = request.postDataJSON() as unknown;
        instanceMutations.push({ routineId, instanceId, action, body });
        if (options.holdInstanceMutation) {
          signalInstanceMutationStarted();
          await instanceMutationGate;
        }
        if (failNextInstanceMutation) {
          failNextInstanceMutation = false;
          await route.fulfill(
            jsonResponse(502, { code: 'GOOGLE_ERROR', error: 'Google Calendar failed' }),
          );
          return;
        }
        const item = routines.find((candidate) => candidate.id === routineId);
        const current = item?.upcoming.instances.find((candidate) => candidate.id === instanceId);
        if (!item || !current) {
          await route.fulfill(jsonResponse(404, { code: 'NOT_FOUND', error: 'Not found' }));
          return;
        }
        let updated: RoutineInstance;
        if (action === 'skip') {
          updated = { ...current, start: null, end: null, status: 'skipped', autoSkipReason: null };
        } else if (action === 'restore') {
          updated = {
            ...current,
            start: current.originalStart,
            end: current.originalEnd,
            status: 'normal',
          };
        } else {
          const move = body as { date: string; startTime: string; endTime: string };
          updated = {
            ...current,
            start: `${move.date}T${move.startTime}:00+09:00`,
            end: `${move.date}T${move.endTime}:00+09:00`,
            status: 'moved',
          };
        }
        routines = routines.map((candidate) =>
          candidate.id !== routineId
            ? candidate
            : {
                ...candidate,
                upcoming: {
                  ...candidate.upcoming,
                  instances: candidate.upcoming.instances.map((entry) =>
                    entry.id === instanceId ? updated : entry,
                  ),
                },
              },
        );
        await route.fulfill(jsonResponse(200, { instance: updated }));
        return;
      }
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
    instanceMutations,
    settingsMutations,
    autoSkipMutations,
    instanceMutationStarted,
    releaseInstanceMutation,
    get listCalls() {
      return listCalls;
    },
    setRoutines: (next: Routine[]) => {
      routines = [...next];
    },
    setFailNextInstanceMutation: () => {
      failNextInstanceMutation = true;
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

async function expectButtonPalette(
  button: import('@playwright/test').Locator,
  backgroundToken: 'accent' | 'surface',
  textToken: 'ink' | 'surface',
) {
  const colors = await button.evaluate(
    (element, tokens) => {
      const resolveToken = (token: string) => {
        const probe = document.createElement('span');
        probe.style.color = `var(--${token})`;
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      const styles = getComputedStyle(element);
      return {
        background: styles.backgroundColor,
        text: styles.color,
        expectedBackground: resolveToken(tokens.background),
        expectedText: resolveToken(tokens.text),
      };
    },
    { background: backgroundToken, text: textToken },
  );
  expect(colors.background).not.toBe(colors.text);
  expect(colors.background).toBe(colors.expectedBackground);
  expect(colors.text).toBe(colors.expectedText);
}

test.describe('Task 3-1: recurring routines', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Date.now = () => Date.parse('2026-10-06T12:00:00+09:00');
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
        routine({
          id: 'routine-piano',
          title: 'ピアノ',
          weekdays: ['TU'],
          skipHolidays: true,
          skipNewYear: true,
          upcoming: {
            status: 'ready',
            instances: [
              instance('piano-normal', '2026-10-13'),
              instance('piano-skipped', '2026-11-03', 'skipped', null, '17:00', '18:00', 'holiday'),
              instance(
                'piano-year-end',
                '2026-12-29',
                'skipped',
                null,
                '17:00',
                '18:00',
                'new_year',
              ),
              instance('piano-next', '2027-01-12'),
            ],
          },
        }),
        routine({
          id: 'routine-cleaning',
          title: '家事代行',
          weekdays: ['SA'],
          interval: 2,
          upcoming: {
            status: 'ready',
            instances: [
              instance('cleaning-1', '2026-10-17'),
              instance('cleaning-2', '2026-10-31'),
              instance('cleaning-3', '2026-11-14'),
              instance('cleaning-4', '2026-11-28'),
            ],
          },
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
      const pianoCard = page.getByTestId('routine-card').filter({ hasText: 'ピアノ' });
      await expect(pianoCard.getByTestId('routine-instance-chip-piano-normal')).toContainText(
        '10/13',
      );
      await expect(pianoCard.getByTestId('routine-instance-chip-piano-skipped')).toContainText(
        'お休み',
      );
      await expect(pianoCard.getByTestId('routine-instance-chip-piano-skipped')).toContainText(
        '11/3（火） お休み（祝日）',
      );
      await expect(pianoCard.getByTestId('routine-instance-chip-piano-year-end')).toContainText(
        '12/29（火） お休み（年末年始）',
      );
      const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: 390, height: fullHeight });
      await page.screenshot({ path: 'docs/screenshots/s4-routines.png', fullPage: true });
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
    for (const weekday of ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']) {
      await dialog.getByTestId(`routine-weekday-${weekday}`).uncheck();
    }
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
    await expect(dialog).toBeHidden();
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
    await expect(firstDialog).toBeHidden();
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
    await expect(nextDialog).toBeHidden();
    await expect(page.getByText('次の家族ルーティン', { exact: true })).toBeVisible();

    expect(api.createBodies).toHaveLength(2);
    expect(api.createBodies[0]?.title).toBe('最初の習い事');
    expect(api.createBodies[1]?.title).toBe('次の家族ルーティン');
    expect(api.createBodies[0]?.clientRequestId).toEqual(expect.any(String));
    expect(api.createBodies[1]?.clientRequestId).toEqual(expect.any(String));
    expect(api.createBodies[1]?.clientRequestId).not.toBe(api.createBodies[0]?.clientRequestId);
  });

  test('shows four upcoming states and supports skip, restore, move, change, and restore without false updates', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [
        routine({
          id: 'routine-instances',
          title: 'ピアノ',
          upcoming: {
            status: 'ready',
            instances: [
              instance('instance-normal', '2026-10-13'),
              instance('instance-skipped', '2026-10-20', 'skipped', null),
              instance('instance-moved', '2026-10-27', 'moved', '2026-10-29'),
              instance('instance-next', '2026-11-03'),
            ],
          },
        }),
      ],
    });
    await openRoutinePage(page);
    const card = page.getByTestId('routine-card').filter({ hasText: 'ピアノ' });
    const normal = card.getByTestId('routine-instance-chip-instance-normal');
    const skipped = card.getByTestId('routine-instance-chip-instance-skipped');
    const moved = card.getByTestId('routine-instance-chip-instance-moved');
    await expect(card.locator('[data-testid^="routine-instance-chip-"]')).toHaveCount(4);
    await expect(normal).toContainText('10/13');
    await expect(skipped).toContainText('お休み');
    await expect(moved).toContainText('10/27');
    await expect(moved).toContainText('10/29');

    await normal.click();
    const normalActions = card.getByTestId('routine-instance-actions-instance-normal');
    await normalActions.getByTestId('routine-instance-skip').evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(card.getByTestId('routine-instance-chip-instance-normal')).toContainText('お休み');
    expect(api.instanceMutations).toHaveLength(1);
    expect(api.instanceMutations[0]).toMatchObject({
      routineId: 'routine-instances',
      instanceId: 'instance-normal',
      action: 'skip',
      body: {},
    });

    await card.getByTestId('routine-instance-chip-instance-normal').click();
    await card
      .getByTestId('routine-instance-actions-instance-normal')
      .getByTestId('routine-instance-restore')
      .click();
    await expect(card.getByTestId('routine-instance-chip-instance-normal')).not.toContainText(
      'お休み',
    );

    await skipped.click();
    await card
      .getByTestId('routine-instance-actions-instance-skipped')
      .getByTestId('routine-instance-restore')
      .click();
    await expect(card.getByTestId('routine-instance-chip-instance-skipped')).not.toContainText(
      'お休み',
    );

    await card.getByTestId('routine-instance-chip-instance-normal').click();
    const normalMove = card.getByTestId('routine-instance-actions-instance-normal');
    await normalMove.getByTestId('routine-instance-set-move').click();
    await expect(normalMove.getByTestId('routine-instance-move-date')).toHaveValue('2026-10-13');
    await normalMove.getByTestId('routine-instance-move-date').fill('2026-10-16');
    await normalMove.getByTestId('routine-instance-move-start').fill('18:00');
    await normalMove.getByTestId('routine-instance-move-end').fill('19:30');
    await normalMove.getByTestId('routine-instance-move-save').click();
    await expect(card.getByTestId('routine-instance-chip-instance-normal')).toContainText('10/16');
    expect(api.instanceMutations.at(-1)).toMatchObject({
      action: 'move',
      body: { date: '2026-10-16', startTime: '18:00', endTime: '19:30' },
    });
    await card.getByTestId('routine-instance-chip-instance-normal').click();
    await card
      .getByTestId('routine-instance-actions-instance-normal')
      .getByTestId('routine-instance-restore')
      .click();
    await expect(card.getByTestId('routine-instance-chip-instance-normal')).toContainText('10/13');

    await moved.click();
    const movedActions = card.getByTestId('routine-instance-actions-instance-moved');
    await movedActions.getByTestId('routine-instance-change-move').click();
    await movedActions.getByTestId('routine-instance-move-date').fill('2026-10-30');
    await movedActions.getByTestId('routine-instance-move-start').fill('19:00');
    await movedActions.getByTestId('routine-instance-move-end').fill('20:00');
    await movedActions.getByTestId('routine-instance-move-save').click();
    await expect(card.getByTestId('routine-instance-chip-instance-moved')).toContainText('10/30');
    await card.getByTestId('routine-instance-chip-instance-moved').click();
    await card
      .getByTestId('routine-instance-actions-instance-moved')
      .getByTestId('routine-instance-restore')
      .click();
    await expect(card.getByTestId('routine-instance-chip-instance-moved')).toContainText('10/27');
    await expect(card.getByTestId('routine-instance-chip-instance-moved')).not.toContainText(
      '10/30',
    );
    expect(api.instanceMutations).toHaveLength(7);
    expect(api.instanceMutations.at(-1)).toMatchObject({ action: 'restore', body: {} });
  });

  test('keeps move save and cancel readable while saving', async ({ page }) => {
    const api = await mockRoutineApis(page, {
      holdInstanceMutation: true,
      routines: [
        routine({
          id: 'routine-move-colors',
          title: 'ピアノ',
          upcoming: {
            status: 'ready',
            instances: [instance('instance-move-colors', '2026-10-13')],
          },
        }),
      ],
    });
    await openRoutinePage(page);
    const card = page.getByTestId('routine-card');
    await card.getByTestId('routine-instance-chip-instance-move-colors').click();
    const actions = card.getByTestId('routine-instance-actions-instance-move-colors');
    await actions.getByTestId('routine-instance-set-move').click();
    const save = actions.getByTestId('routine-instance-move-save');
    const cancel = actions.getByTestId('routine-instance-move-cancel');
    await expect(save).toHaveText('保存');
    await expectButtonPalette(save, 'accent', 'surface');
    await expect(cancel).toHaveText('やめる');
    await expectButtonPalette(cancel, 'surface', 'ink');

    const saveRequest = save.click();
    await api.instanceMutationStarted;
    await expect(save).toHaveText('保存中...');
    await expect(save).toBeDisabled();
    await expectButtonPalette(save, 'accent', 'surface');
    await expect(cancel).toBeDisabled();
    await expectButtonPalette(cancel, 'surface', 'ink');
    api.releaseInstanceMutation();
    await saveRequest;
    expect(api.instanceMutations).toHaveLength(1);
  });

  test('keeps the prior chip state after a failed operation and offers retry after unavailable upcoming data', async ({
    page,
  }) => {
    const unavailable = routine({
      id: 'routine-unavailable',
      title: '水泳',
      upcoming: { status: 'unavailable', instances: [] },
    });
    const api = await mockRoutineApis(page, {
      routines: [
        routine({
          id: 'routine-error',
          title: 'ピアノ',
          upcoming: { status: 'ready', instances: [instance('instance-error', '2026-10-13')] },
        }),
        unavailable,
      ],
      failNextInstanceMutation: true,
    });
    await openRoutinePage(page);
    const errorCard = page.getByTestId('routine-card').filter({ hasText: 'ピアノ' });
    const chip = errorCard.getByTestId('routine-instance-chip-instance-error');
    await expect(chip).toContainText('10/13');
    await chip.click();
    const actions = errorCard.getByTestId('routine-instance-actions-instance-error');
    await actions.getByTestId('routine-instance-skip').click();
    await expect(actions.getByRole('alert')).toHaveText(
      '変更を保存できませんでした。時間をおいて再度お試しください。',
    );
    await expect(chip).toContainText('10/13');
    await expect(chip).not.toContainText('お休み');
    expect(api.instanceMutations).toHaveLength(1);

    const unavailableCard = page.getByTestId('routine-card').filter({ hasText: '水泳' });
    await expect(unavailableCard).toContainText('直近の回を取得できませんでした。');
    const retry = unavailableCard.getByRole('button', { name: '再試行' });
    const callsBeforeRetry = api.listCalls;
    await retry.click();
    await expect(retry).toBeVisible();
    await expect.poll(() => api.listCalls).toBeGreaterThan(callsBeforeRetry);
  });

  test('saves holiday settings and continues 20-item batches while locking the routine card', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [
        routine({
          id: 'routine-holidays',
          title: 'ピアノ',
          upcoming: { status: 'ready', instances: [instance('holiday-instance', '2026-10-13')] },
        }),
      ],
    });
    let applyCalls = 0;
    let releaseApply: (() => void) | undefined;
    let applyStarted: (() => void) | undefined;
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const applyStartedPromise = new Promise<void>((resolve) => {
      applyStarted = resolve;
    });
    await page.route(
      `**/api/families/${FAMILY_ID}/routines/routine-holidays/settings`,
      async (route) => {
        const body = route.request().postDataJSON() as {
          skipHolidays: boolean;
          skipNewYear: boolean;
        };
        api.settingsMutations.push({ routineId: 'routine-holidays', body });
        api.setRoutines([
          routine({
            id: 'routine-holidays',
            title: 'ピアノ',
            skipHolidays: body.skipHolidays,
            skipNewYear: body.skipNewYear,
            upcoming: { status: 'ready', instances: [instance('holiday-instance', '2026-10-13')] },
          }),
        ]);
        await route.fulfill(jsonResponse(200, { ...body, hasMore: !body.skipNewYear }));
      },
    );
    await page.route(
      `**/api/families/${FAMILY_ID}/routines/routine-holidays/auto-skips/apply`,
      async (route) => {
        applyCalls++;
        if (applyCalls === 1) {
          applyStarted?.();
          await applyGate;
          await route.fulfill(
            jsonResponse(200, { skipHolidays: true, skipNewYear: false, hasMore: true }),
          );
        } else {
          await route.fulfill(
            jsonResponse(200, { skipHolidays: true, skipNewYear: false, hasMore: false }),
          );
        }
      },
    );

    await openRoutinePage(page);
    const card = page.getByTestId('routine-card').filter({ hasText: 'ピアノ' });
    const holidayToggle = card.getByTestId('routine-skip-holidays-routine-holidays');
    const chip = card.getByTestId('routine-instance-chip-holiday-instance');
    const request = holidayToggle.click();
    await applyStartedPromise;
    await expect(card.getByTestId('routine-auto-skips-pending-routine-holidays')).toHaveText(
      '適用中...',
    );
    await expect(holidayToggle).toBeDisabled();
    await expect(card.getByTestId('routine-skip-new-year-routine-holidays')).toBeDisabled();
    await expect(chip).toBeDisabled();
    releaseApply?.();
    await request;
    await expect(card.getByTestId('routine-auto-skips-pending-routine-holidays')).toHaveCount(0);

    expect(api.settingsMutations).toEqual([
      { routineId: 'routine-holidays', body: { skipHolidays: true, skipNewYear: false } },
    ]);
    expect(applyCalls).toBe(2);
    await expect(holidayToggle).toBeChecked();
    const newYearToggle = card.getByTestId('routine-skip-new-year-routine-holidays');
    await newYearToggle.click();
    await expect(newYearToggle).toBeChecked();
    expect(api.settingsMutations).toHaveLength(2);
    expect(api.settingsMutations[1]).toEqual({
      routineId: 'routine-holidays',
      body: { skipHolidays: true, skipNewYear: true },
    });
    expect(applyCalls).toBe(2);
    await expect(card.getByTestId('routine-auto-skips-pending-routine-holidays')).toHaveCount(0);
  });

  test('refreshes persisted flags after a failed apply and retries without toggling them again', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-retry', title: '水泳' })],
    });
    let applyCalls = 0;
    await page.route(
      `**/api/families/${FAMILY_ID}/routines/routine-retry/settings`,
      async (route) => {
        const body = route.request().postDataJSON() as {
          skipHolidays: boolean;
          skipNewYear: boolean;
        };
        api.settingsMutations.push({ routineId: 'routine-retry', body });
        api.setRoutines([routine({ id: 'routine-retry', title: '水泳', ...body })]);
        await route.fulfill(
          jsonResponse(502, { code: 'GOOGLE_ERROR', error: 'Google Calendar failed' }),
        );
      },
    );
    await page.route(
      `**/api/families/${FAMILY_ID}/routines/routine-retry/auto-skips/apply`,
      async (route) => {
        applyCalls++;
        await route.fulfill(
          jsonResponse(200, { skipHolidays: true, skipNewYear: false, hasMore: false }),
        );
      },
    );

    await openRoutinePage(page);
    const card = page.getByTestId('routine-card').filter({ hasText: '水泳' });
    const holidayToggle = card.getByTestId('routine-skip-holidays-routine-retry');
    await holidayToggle.click();
    await expect(holidayToggle).toBeChecked();
    const retry = card.getByTestId('routine-auto-skips-retry-routine-retry');
    await expect(retry).toBeVisible();
    await expect(card.getByRole('alert')).toContainText('表示中の設定を確認');
    await retry.click();
    await expect(retry).toHaveCount(0);
    expect(api.settingsMutations).toHaveLength(1);
    expect(applyCalls).toBe(1);
    await expect(holidayToggle).toBeChecked();
  });

  test('retry resubmits the selected flags if a failed settings request did not persist them', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-save-retry', title: '水泳' })],
    });
    let settingsCalls = 0;
    await page.route(
      `**/api/families/${FAMILY_ID}/routines/routine-save-retry/settings`,
      async (route) => {
        settingsCalls++;
        const body = route.request().postDataJSON() as {
          skipHolidays: boolean;
          skipNewYear: boolean;
        };
        api.settingsMutations.push({ routineId: 'routine-save-retry', body });
        if (settingsCalls === 1) {
          await route.fulfill(
            jsonResponse(502, { code: 'GOOGLE_ERROR', error: 'Google Calendar failed' }),
          );
          return;
        }
        api.setRoutines([routine({ id: 'routine-save-retry', title: '水泳', ...body })]);
        await route.fulfill(jsonResponse(200, { ...body, hasMore: false }));
      },
    );
    await page.route(
      `**/api/families/${FAMILY_ID}/routines/routine-save-retry/auto-skips/apply`,
      async (route) => {
        await route.fulfill(
          jsonResponse(200, { skipHolidays: true, skipNewYear: false, hasMore: false }),
        );
      },
    );

    await openRoutinePage(page);
    const card = page.getByTestId('routine-card').filter({ hasText: '水泳' });
    const holidayToggle = card.getByTestId('routine-skip-holidays-routine-save-retry');
    await holidayToggle.click();
    await expect(holidayToggle).not.toBeChecked();
    const retry = card.getByTestId('routine-auto-skips-retry-routine-save-retry');
    await retry.click();
    await expect(holidayToggle).toBeChecked();
    await expect(retry).toHaveCount(0);
    expect(settingsCalls).toBe(2);
    expect(api.settingsMutations).toHaveLength(2);
  });

  test('after retry saves flags but application fails, it displays saved flags and retries application only', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-save-then-apply', title: '英語' })],
    });
    let settingsCalls = 0;
    let applyCalls = 0;
    await page.route(
      `**/api/families/${FAMILY_ID}/routines/routine-save-then-apply/settings`,
      async (route) => {
        settingsCalls++;
        const body = route.request().postDataJSON() as {
          skipHolidays: boolean;
          skipNewYear: boolean;
        };
        api.settingsMutations.push({ routineId: 'routine-save-then-apply', body });
        if (settingsCalls === 1) {
          await route.fulfill(
            jsonResponse(502, { code: 'GOOGLE_ERROR', error: 'Google Calendar failed' }),
          );
          return;
        }
        api.setRoutines([routine({ id: 'routine-save-then-apply', title: '英語', ...body })]);
        await route.fulfill(jsonResponse(200, { ...body, hasMore: true }));
      },
    );
    await page.route(
      `**/api/families/${FAMILY_ID}/routines/routine-save-then-apply/auto-skips/apply`,
      async (route) => {
        applyCalls++;
        api.autoSkipMutations.push('routine-save-then-apply');
        if (applyCalls === 1) {
          await route.fulfill(
            jsonResponse(502, { code: 'GOOGLE_ERROR', error: 'Google Calendar failed' }),
          );
        } else {
          await route.fulfill(
            jsonResponse(200, { skipHolidays: true, skipNewYear: false, hasMore: false }),
          );
        }
      },
    );

    await openRoutinePage(page);
    const card = page.getByTestId('routine-card').filter({ hasText: '英語' });
    const holidayToggle = card.getByTestId('routine-skip-holidays-routine-save-then-apply');
    await holidayToggle.click();
    const firstRetry = card.getByTestId('routine-auto-skips-retry-routine-save-then-apply');
    await expect(firstRetry).toBeVisible();
    await firstRetry.click();
    const secondRetry = card.getByTestId('routine-auto-skips-retry-routine-save-then-apply');
    await expect(holidayToggle).toBeChecked();
    await expect(secondRetry).toBeVisible();
    await secondRetry.click();
    await expect(secondRetry).toHaveCount(0);
    expect(settingsCalls).toBe(2);
    expect(applyCalls).toBe(2);
    expect(api.settingsMutations).toHaveLength(2);
    expect(api.autoSkipMutations).toEqual(['routine-save-then-apply', 'routine-save-then-apply']);
    await expect(holidayToggle).toBeChecked();
  });

  test('applies due routines once per visit and shows the server-provided skip reason', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [
        routine({
          id: 'routine-due',
          title: 'ピアノ',
          skipHolidays: true,
          autoSkipDue: true,
          upcoming: {
            status: 'ready',
            instances: [
              instance(
                'instance-holiday',
                '2026-10-13',
                'skipped',
                null,
                '17:00',
                '18:00',
                'holiday',
              ),
              instance(
                'instance-year-end',
                '2026-12-29',
                'skipped',
                null,
                '17:00',
                '18:00',
                'new_year',
              ),
            ],
          },
        }),
      ],
    });
    await openRoutinePage(page);
    const card = page.getByTestId('routine-card').filter({ hasText: 'ピアノ' });
    const holidayChip = card.getByTestId('routine-instance-chip-instance-holiday');
    await expect(holidayChip).toContainText('10/13（火） お休み（祝日）');
    await expect(card.getByTestId('routine-instance-chip-instance-year-end')).toContainText(
      '12/29（火） お休み（年末年始）',
    );
    await expect.poll(() => api.autoSkipMutations.length).toBe(1);
    await expect(card.getByTestId('routine-auto-skips-pending-routine-due')).toHaveCount(0);
    // A successful list refresh still has autoSkipDue in this fixture; it must not relaunch the apply.
    await page.waitForTimeout(100);
    expect(api.autoSkipMutations).toEqual(['routine-due']);
  });

  test('shows a quiet retry after background catch-up fails and does not auto-retry on refresh', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-mount-retry', title: '体操', autoSkipDue: true })],
    });
    let applyAttempts = 0;
    await page.route(
      `**/api/families/${FAMILY_ID}/routines/routine-mount-retry/auto-skips/apply`,
      async (route) => {
        applyAttempts++;
        api.autoSkipMutations.push('routine-mount-retry');
        if (applyAttempts === 1) {
          await route.fulfill(
            jsonResponse(502, { code: 'GOOGLE_ERROR', error: 'Google Calendar failed' }),
          );
        } else {
          await route.fulfill(
            jsonResponse(200, { skipHolidays: false, skipNewYear: false, hasMore: false }),
          );
        }
      },
    );
    await openRoutinePage(page);
    const card = page.getByTestId('routine-card').filter({ hasText: '体操' });
    const retry = card.getByTestId('routine-auto-skips-retry-routine-mount-retry');
    await expect(retry).toBeVisible();
    expect(applyAttempts).toBe(1);
    await retry.click();
    await expect(retry).toHaveCount(0);
    expect(applyAttempts).toBe(2);
    expect(api.autoSkipMutations).toEqual(['routine-mount-retry', 'routine-mount-retry']);
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
