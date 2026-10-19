import { expect, test } from '@playwright/test';
import { getRoutineInstanceStatus } from '../src/shared/domain/routineInstances';
import type { FamilyPublic } from '../src/shared/schemas/family';
import type {
  Routine,
  RoutineInstance,
  RoutineUpcomingInstance,
} from '../src/shared/schemas/routines';

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
    upcoming: {
      status: 'ready',
      conflictsStatus: 'ready',
      instances: sampleInstances(`instance-${id}`),
    },
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
): RoutineUpcomingInstance {
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
    conflicts: [],
  };
}

function sampleInstances(prefix: string): RoutineUpcomingInstance[] {
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
  let accountUserId = OWNER_ID;
  let nextListError: number | null = null;
  let heldListResponse: {
    started: Promise<void>;
    release: () => void;
    startedResolve: () => void;
    gate: Promise<void>;
    holdAllRequests: boolean;
  } | null = null;
  let failNextInstanceMutation = options.failNextInstanceMutation ?? false;
  let signalInstanceMutationStarted: () => void = () => {};
  let releaseInstanceMutation: () => void = () => {};
  const instanceMutationBarriers: Array<{
    started: Promise<void>;
    release: () => void;
    startedResolve: () => void;
    gate: Promise<void>;
  }> = [];
  const instanceMutationStarted = new Promise<void>((resolve) => {
    signalInstanceMutationStarted = resolve;
  });
  const instanceMutationGate = new Promise<void>((resolve) => {
    releaseInstanceMutation = resolve;
  });
  await page.route('**/api/auth/me', (route) =>
    route.fulfill(
      jsonResponse(200, {
        user: { id: accountUserId, email: 'routine@example.test', displayName: '大人甲' },
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
      if (nextListError !== null) {
        const status = nextListError;
        nextListError = null;
        await route.fulfill(jsonResponse(status, { code: 'NOT_FOUND', error: 'Not found' }));
        return;
      }
      const held = heldListResponse;
      if (held) {
        if (!held.holdAllRequests) heldListResponse = null;
        held.startedResolve();
        await held.gate;
      }
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
        const nextMutationBarrier = instanceMutationBarriers.shift();
        if (nextMutationBarrier) {
          nextMutationBarrier.startedResolve();
          await nextMutationBarrier.gate;
          await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
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
            status: getRoutineInstanceStatus({
              originalStart: current.originalStart,
              originalEnd: current.originalEnd,
              start: current.originalStart,
              end: current.originalEnd,
            }),
            autoSkipReason: null,
          };
        } else {
          const move = body as { date: string; startTime: string; endTime: string };
          const start = `${move.date}T${move.startTime}:00+09:00`;
          const end = `${move.date}T${move.endTime}:00+09:00`;
          updated = {
            ...current,
            start,
            end,
            status: getRoutineInstanceStatus({
              originalStart: current.originalStart,
              originalEnd: current.originalEnd,
              start,
              end,
            }),
            autoSkipReason: null,
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
                    entry.id === instanceId
                      ? {
                          ...updated,
                          conflicts:
                            action === 'skip' ||
                            (action === 'move' &&
                              (body as { date: string; startTime: string }).startTime >= '18:00')
                              ? []
                              : entry.conflicts,
                        }
                      : entry,
                  ),
                },
              },
        );
        const mutationInstance: RoutineInstance = {
          id: updated.id,
          originalStart: updated.originalStart,
          originalEnd: updated.originalEnd,
          start: updated.start,
          end: updated.end,
          status: updated.status,
          autoSkipReason: updated.autoSkipReason,
        };
        await route.fulfill(jsonResponse(200, { instance: mutationInstance }));
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
    setAccountUserId: (next: string) => {
      accountUserId = next;
    },
    failNextRoutineList: (status: number) => {
      nextListError = status;
    },
    holdNextListResponse: () => {
      let startedResolve!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      heldListResponse = { started, release, startedResolve, gate, holdAllRequests: false };
      return { started, release };
    },
    holdAllListResponses: () => {
      let startedResolve!: () => void;
      let releaseGate!: () => void;
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      // Keep both the old identity's refetch and the new identity's list pending through the switch.
      const held = {
        started,
        release: () => {
          if (heldListResponse === held) heldListResponse = null;
          releaseGate();
        },
        startedResolve,
        gate,
        holdAllRequests: true,
      };
      heldListResponse = held;
      return { started, release: held.release };
    },
    holdNextInstanceMutation: () => {
      let startedResolve!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      instanceMutationBarriers.push({ started, release, startedResolve, gate });
      return { started, release };
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

async function mockTasksList(page: import('@playwright/test').Page) {
  let calls = 0;
  await page.route(`**/api/families/${FAMILY_ID}/tasks`, (route) =>
    route.fulfill(jsonResponse(200, { tasks: [] })).then(() => {
      calls += 1;
    }),
  );
  return {
    get calls() {
      return calls;
    },
  };
}

async function triggerVisibilityCycle(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    window.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    window.dispatchEvent(new Event('visibilitychange'));
  });
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
            conflictsStatus: 'ready',
            instances: [
              {
                ...instance('piano-normal', '2026-10-13'),
                conflicts: [
                  {
                    id: 'event-sports-day',
                    title: '運動会',
                    time: {
                      kind: 'timed',
                      start: '2026-10-13T17:00:00+09:00',
                      endExclusive: '2026-10-13T18:00:00+09:00',
                    },
                  },
                ],
              },
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
            conflictsStatus: 'ready',
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
      await expect(pianoCard.getByTestId('routine-instance-chip-piano-normal')).toContainText(
        '重複',
      );
      await pianoCard.getByTestId('routine-instance-chip-piano-normal').click();
      await expect(pianoCard.getByTestId('routine-conflicts-piano-normal')).toContainText(
        '10/13（火）は『運動会』 17:00–18:00と重なっています',
      );
      await pianoCard.getByTestId('routine-instance-chip-piano-normal').click();
      await expect(pianoCard.getByTestId('routine-instance-actions-piano-normal')).toHaveCount(0);
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
            conflictsStatus: 'ready',
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

  test('shows the absence task notice after a successful lesson skip and clears it after restore or move', async ({
    page,
  }) => {
    const tasksList = await mockTasksList(page);
    const api = await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-lesson-absence', title: 'ピアノ' })],
    });
    await page.goto('/tasks');
    await expect(page.getByTestId('tasks-screen')).toBeVisible();
    await expect.poll(() => tasksList.calls).toBe(1);
    await page
      .getByRole('navigation', { name: 'メインナビゲーション' })
      .getByRole('link', { name: '繰り返し', exact: true })
      .click();
    await expect(page.getByTestId('routines-screen')).toBeVisible();
    const card = page.getByTestId('routine-card').filter({ hasText: 'ピアノ' });
    const instanceChip = card.getByTestId(
      'routine-instance-chip-instance-routine-lesson-absence-1',
    );

    await instanceChip.click();
    const heldMutation = api.holdNextInstanceMutation();
    await card
      .getByTestId('routine-instance-actions-instance-routine-lesson-absence-1')
      .getByTestId('routine-instance-skip')
      .click();
    await heldMutation.started;
    await expect(page.getByTestId('routine-absence-task-notice')).toHaveCount(0);
    heldMutation.release();
    const notice = page.getByTestId('routine-absence-task-notice');
    await expect(notice).toContainText('「欠席を連絡」をやることに追加しました');
    await expect.poll(() => tasksList.calls).toBeGreaterThan(1);
    const tasksLink = notice.getByTestId('routine-absence-task-link');
    await expect(tasksLink).toHaveAttribute('href', '/tasks');
    for (const width of [390, 445]) {
      await page.setViewportSize({ width, height: 844 });
      const linkBox = await tasksLink.boundingBox();
      expect(linkBox?.width).toBeGreaterThanOrEqual(44);
      expect(linkBox?.height).toBeGreaterThanOrEqual(44);
      expect(
        await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await tasksLink.click();
    await expect(page).toHaveURL('/tasks');
    await expect(page.getByTestId('tasks-screen')).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL('/routines');
    await expect(page.getByTestId('routine-absence-task-notice')).toHaveCount(0);
    await instanceChip.click();
    await card
      .getByTestId('routine-instance-actions-instance-routine-lesson-absence-1')
      .getByTestId('routine-instance-restore')
      .click();
    await expect(page.getByTestId('routine-absence-task-notice')).toHaveCount(0);
    await expect(instanceChip).not.toContainText('お休み');

    await instanceChip.click();
    await card
      .getByTestId('routine-instance-actions-instance-routine-lesson-absence-1')
      .getByTestId('routine-instance-skip')
      .click();
    await expect(page.getByTestId('routine-absence-task-notice')).toBeVisible();
    await instanceChip.click();
    const actions = card.getByTestId('routine-instance-actions-instance-routine-lesson-absence-1');
    await actions.getByTestId('routine-instance-set-move').click();
    await actions.getByTestId('routine-instance-move-date').fill('2026-10-15');
    await actions.getByTestId('routine-instance-move-start').fill('17:30');
    await actions.getByTestId('routine-instance-move-end').fill('18:30');
    await actions.getByTestId('routine-instance-move-save').click();
    await expect(instanceChip).toContainText('10/15');
    await expect(page.getByTestId('routine-absence-task-notice')).toHaveCount(0);
  });

  test('shows the right notice for housework and other skips and clears both after restore', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [
        routine({ id: 'routine-failed-lesson', title: '英会話' }),
        routine({ id: 'routine-housework', title: '掃除', category: 'housework' }),
        routine({ id: 'routine-other', title: 'その他', category: 'other' }),
      ],
    });
    await openRoutinePage(page);

    const lesson = page.getByTestId('routine-card').filter({ hasText: '英会話' });
    const lessonInstance = lesson.getByTestId(
      'routine-instance-chip-instance-routine-failed-lesson-1',
    );
    await lessonInstance.click();
    api.setFailNextInstanceMutation();
    await lesson
      .getByTestId('routine-instance-actions-instance-routine-failed-lesson-1')
      .getByTestId('routine-instance-skip')
      .click();
    await expect(
      page.getByRole('alert').filter({ hasText: '変更を保存できませんでした' }),
    ).toBeVisible();
    await expect(page.getByTestId('routine-absence-task-notice')).toHaveCount(0);
    await expect(lessonInstance).not.toContainText('お休み');

    const housework = page.getByTestId('routine-card').filter({ hasText: '掃除' });
    const houseworkInstance = housework.getByTestId(
      'routine-instance-chip-instance-routine-housework-1',
    );
    await houseworkInstance.click();
    await housework
      .getByTestId('routine-instance-actions-instance-routine-housework-1')
      .getByTestId('routine-instance-skip')
      .click();
    await expect(houseworkInstance).toContainText('お休み');
    await expect(page.getByTestId('routine-absence-task-notice')).toContainText(
      '「お休みを連絡」をやることに追加しました',
    );
    await houseworkInstance.click();
    await housework
      .getByTestId('routine-instance-actions-instance-routine-housework-1')
      .getByTestId('routine-instance-restore')
      .click();
    await expect(houseworkInstance).not.toContainText('お休み');
    await expect(page.getByTestId('routine-absence-task-notice')).toHaveCount(0);

    const other = page.getByTestId('routine-card').filter({ hasText: 'その他' });
    const otherInstance = other.getByTestId('routine-instance-chip-instance-routine-other-1');
    await otherInstance.click();
    await other
      .getByTestId('routine-instance-actions-instance-routine-other-1')
      .getByTestId('routine-instance-skip')
      .click();
    await expect(otherInstance).toContainText('お休み');
    await expect(page.getByTestId('routine-absence-task-notice')).toContainText(
      '「お休みを連絡」をやることに追加しました',
    );
    await otherInstance.click();
    await other
      .getByTestId('routine-instance-actions-instance-routine-other-1')
      .getByTestId('routine-instance-restore')
      .click();
    await expect(otherInstance).not.toContainText('お休み');
    await expect(page.getByTestId('routine-absence-task-notice')).toHaveCount(0);
  });

  test('shows an optimistic skip while saving, locks its series, and keeps another series usable', async ({
    page,
  }) => {
    const conflictEvent = {
      id: 'event-instant-skip',
      title: '運動会',
      time: {
        kind: 'timed' as const,
        start: '2026-10-13T17:00:00+09:00',
        endExclusive: '2026-10-13T18:00:00+09:00',
      },
    };
    const api = await mockRoutineApis(page, {
      routines: [
        routine({
          id: 'routine-instant-skip',
          title: 'ピアノ',
          upcoming: {
            status: 'ready',
            conflictsStatus: 'ready',
            instances: [
              { ...instance('instant-skip', '2026-10-13'), conflicts: [conflictEvent] },
              instance('instant-skip-next', '2026-10-20'),
            ],
          },
        }),
        routine({ id: 'routine-other-series', title: '水泳' }),
      ],
    });
    await openRoutinePage(page);
    const piano = page.getByTestId('routine-card').filter({ hasText: 'ピアノ' });
    const swim = page.getByTestId('routine-card').filter({ hasText: '水泳' });
    const chip = piano.getByTestId('routine-instance-chip-instant-skip');
    await expect(piano.getByTestId('routine-conflicts-instant-skip')).toBeVisible();
    await chip.click();
    const actions = piano.getByTestId('routine-instance-actions-instant-skip');
    const mutation = api.holdNextInstanceMutation();
    await actions.getByTestId('routine-instance-skip').evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await mutation.started;

    await expect(chip).toContainText('お休み');
    await expect(chip).toContainText('保存中');
    await expect(chip).toHaveAccessibleName(/保存中/);
    await expect(piano.getByTestId('routine-conflicts-instant-skip')).toHaveCount(0);
    await expect(piano.getByTestId('routine-skip-holidays-routine-instant-skip')).toBeDisabled();
    await expect(piano.getByTestId('routine-instance-chip-instant-skip-next')).toBeDisabled();
    await expect(swim.getByTestId('routine-skip-holidays-routine-other-series')).toBeEnabled();
    const otherChip = swim.getByTestId('routine-instance-chip-instance-routine-other-series-1');
    await expect(otherChip).toBeEnabled();
    expect(api.instanceMutations).toHaveLength(1);

    await otherChip.click();
    await swim
      .getByTestId('routine-instance-actions-instance-routine-other-series-1')
      .getByTestId('routine-instance-skip')
      .click();
    await expect(otherChip).toContainText('お休み');
    await expect.poll(() => api.instanceMutations).toHaveLength(2);
    await expect(chip).toContainText('お休み');
    await expect(chip).toContainText('保存中');
    await expect(piano.getByTestId('routine-conflicts-instant-skip')).toHaveCount(0);

    for (const width of [390, 445]) {
      await page.setViewportSize({ width, height: 844 });
      await expectNoHorizontalOverflow(page);
      await expect(chip).toContainText('保存中');
    }
    mutation.release();
    await expect(chip).not.toContainText('保存中');
    await expect(chip).toContainText('お休み');
  });

  test('restores an automatic skip immediately and keeps its conflict until the refreshed list arrives', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [
        routine({
          id: 'routine-instant-restore',
          title: 'ピアノ',
          upcoming: {
            status: 'ready',
            conflictsStatus: 'ready',
            instances: [
              {
                ...instance(
                  'instant-restore',
                  '2026-10-13',
                  'skipped',
                  null,
                  '17:00',
                  '18:00',
                  'holiday',
                ),
                conflicts: [
                  {
                    id: 'restore-conflict',
                    title: '運動会',
                    time: {
                      kind: 'timed',
                      start: '2026-10-13T17:00:00+09:00',
                      endExclusive: '2026-10-13T18:00:00+09:00',
                    },
                  },
                ],
              },
            ],
          },
        }),
      ],
    });
    await openRoutinePage(page);
    const card = page.getByTestId('routine-card').filter({ hasText: 'ピアノ' });
    const chip = card.getByTestId('routine-instance-chip-instant-restore');
    await chip.click();
    const actions = card.getByTestId('routine-instance-actions-instant-restore');
    const mutation = api.holdNextInstanceMutation();
    await actions.getByTestId('routine-instance-restore').click();
    await mutation.started;

    await expect(chip).toContainText('10/13');
    await expect(chip).not.toContainText('お休み');
    await expect(chip).not.toContainText('祝日');
    await expect(chip).toContainText('保存中');
    await expect(card.getByTestId('routine-conflicts-instant-restore')).toBeVisible();
    await expect(card.getByTestId('routine-instance-actions-instant-restore')).toHaveCount(0);
    mutation.release();
    await expect(chip).not.toContainText('保存中');
    expect(api.instanceMutations).toMatchObject([
      { routineId: 'routine-instant-restore', instanceId: 'instant-restore', action: 'restore' },
    ]);
  });

  test('closes the move form immediately and shows the requested time before the API response', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [
        routine({
          id: 'routine-instant-move',
          title: 'ピアノ',
          upcoming: {
            status: 'ready',
            conflictsStatus: 'ready',
            instances: [
              {
                ...instance('instant-move', '2026-10-13'),
                conflicts: [
                  {
                    id: 'move-conflict',
                    title: '運動会',
                    time: {
                      kind: 'timed',
                      start: '2026-10-13T17:00:00+09:00',
                      endExclusive: '2026-10-13T18:00:00+09:00',
                    },
                  },
                ],
              },
            ],
          },
        }),
      ],
    });
    await openRoutinePage(page);
    const card = page.getByTestId('routine-card').filter({ hasText: 'ピアノ' });
    const chip = card.getByTestId('routine-instance-chip-instant-move');
    const conflictPanel = card.getByTestId('routine-conflicts-instant-move');
    await conflictPanel.getByTestId('routine-conflict-move-instant-move').click();
    const actions = card.getByTestId('routine-instance-actions-instant-move');
    await actions.getByTestId('routine-instance-move-date').fill('2026-10-24');
    await actions.getByTestId('routine-instance-move-start').fill('19:15');
    await actions.getByTestId('routine-instance-move-end').fill('20:15');
    const mutation = api.holdNextInstanceMutation();
    await actions.getByTestId('routine-instance-move-save').click();
    await mutation.started;

    await expect(card.getByTestId('routine-instance-actions-instant-move')).toHaveCount(0);
    await expect(chip).toContainText('10/24');
    await expect(chip).toContainText('保存中');
    await expect(conflictPanel).toBeVisible();
    expect(api.instanceMutations).toMatchObject([
      {
        routineId: 'routine-instant-move',
        instanceId: 'instant-move',
        action: 'move',
        body: { date: '2026-10-24', startTime: '19:15', endTime: '20:15' },
      },
    ]);
    mutation.release();
    await expect(chip).not.toContainText('保存中');
    await expect(conflictPanel).toHaveCount(0);

    await chip.click();
    const movedActions = card.getByTestId('routine-instance-actions-instant-move');
    await movedActions.getByTestId('routine-instance-change-move').click();
    await expect(movedActions.getByTestId('routine-instance-move-date')).toHaveValue('2026-10-13');
    await expect(movedActions.getByTestId('routine-instance-move-start')).toHaveValue('17:00');
    await expect(movedActions.getByTestId('routine-instance-move-end')).toHaveValue('18:00');
    const restoreDateMutation = api.holdNextInstanceMutation();
    await movedActions.getByTestId('routine-instance-move-save').click();
    await restoreDateMutation.started;
    await expect(chip).toContainText('10/13');
    await expect(chip).not.toContainText('振替');
    await expect(chip).toContainText('保存中');
    restoreDateMutation.release();
    await expect(chip).not.toContainText('保存中');
    await expect(chip).not.toContainText('振替');
  });

  test('keeps the updated chip and exact list DOM while the post-mutation list refetch is pending', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-stable', title: 'ピアノ' })],
    });
    await openRoutinePage(page);
    const card = page.getByTestId('routine-card').filter({ hasText: 'ピアノ' });
    const chip = card.getByTestId('routine-instance-chip-instance-routine-stable-1');
    const cardElement = await card.elementHandle();
    const chipElement = await chip.elementHandle();
    expect(cardElement).not.toBeNull();
    expect(chipElement).not.toBeNull();
    await chip.click();
    const actions = card.getByTestId('routine-instance-actions-instance-routine-stable-1');
    const delayedList = api.holdNextListResponse();
    await actions.getByTestId('routine-instance-skip').click();
    await expect(chip).toContainText('お休み');
    await delayedList.started;

    const list = page.getByTestId('routine-list');
    await expect(page.getByTestId('routine-list-placeholder')).toHaveCount(0);
    await expect(list).toHaveCount(1);
    await expect(chip).toBeVisible();
    await expect(chip).toBeEnabled();
    await expect(chip).toContainText('お休み');
    expect(await cardElement?.evaluate((node) => node.isConnected)).toBe(true);
    expect(await chipElement?.evaluate((node) => node.isConnected)).toBe(true);
    expect(await card.evaluate((node, original) => node === original, cardElement)).toBe(true);
    expect(await chip.evaluate((node, original) => node === original, chipElement)).toBe(true);

    delayedList.release();
    await expect(page.getByTestId('routine-list-placeholder')).toHaveCount(0);
    await expect(chip).toContainText('お休み');
  });

  test('shows cached routines immediately on tab return while refreshing in the background', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-tab-return', title: '水泳' })],
    });
    await page.route('**/api/families/*/tasks', async (route) => {
      await route.fulfill(jsonResponse(200, { tasks: [] }));
    });
    await openRoutinePage(page);
    const navigation = page.getByRole('navigation', { name: 'メインナビゲーション' });
    await navigation.getByRole('link', { name: /やること/ }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole('heading', { name: 'やること', exact: true })).toBeVisible();

    const delayedList = api.holdNextListResponse();
    await navigation.getByRole('link', { name: /繰り返し/ }).click();
    await delayedList.started;
    await expect(page.getByTestId('routine-card')).toContainText('水泳');
    await expect(page.getByTestId('routine-list-placeholder')).toHaveCount(0);
    delayedList.release();
    await expect(page.getByTestId('routine-card')).toContainText('水泳');
  });

  test('hides cached routine cards when a background refetch reports lost family access', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-no-access', title: '家族だけの予定' })],
    });
    await page.route('**/api/families/*/tasks', async (route) => {
      await route.fulfill(jsonResponse(200, { tasks: [] }));
    });
    await openRoutinePage(page);
    await expect(page.getByTestId('routine-card')).toContainText('家族だけの予定');
    api.failNextRoutineList(404);
    const navigation = page.getByRole('navigation', { name: 'メインナビゲーション' });
    await navigation.getByRole('link', { name: /やること/ }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await navigation.getByRole('link', { name: /繰り返し/ }).click();
    await expect(page.getByText('家族だけの予定')).toHaveCount(0);
    await expect(page.getByText('繰り返し予定を読み込めませんでした。')).toBeVisible();
  });

  test('shows two static card placeholders during the initial routine list request', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-initial', title: '水泳' })],
    });
    const delayedList = api.holdNextListResponse();
    await openRoutinePage(page);
    await delayedList.started;
    await expect(page.getByTestId('routine-list-placeholder').locator('li')).toHaveCount(2);
    await expect(page.getByRole('status', { name: '繰り返し予定を読み込み中' })).toBeVisible();
    await expect(page.getByTestId('routine-list')).toHaveCount(0);
    delayedList.release();
    await expect(page.getByTestId('routine-card')).toContainText('水泳');
  });

  test('shows a retryable information error for an unsupported routine with unavailable details', async ({
    page,
  }) => {
    await mockRoutineApis(page, {
      routines: [
        routine({
          id: 'routine-budget-limit',
          title: null,
          status: 'unsupported',
          weekdays: [],
          interval: null,
          startDate: null,
          endDate: null,
          startTime: null,
          endTime: null,
          memberIds: [],
          assigneeMemberId: null,
          upcoming: { status: 'unavailable', conflictsStatus: 'unavailable', instances: [] },
        }),
      ],
    });
    await openRoutinePage(page);
    const card = page.getByTestId('routine-card');
    await expect(card).toContainText('繰り返し予定の情報を取得できませんでした');
    await expect(card).not.toContainText('Google カレンダーで繰り返し設定を確認してください');
    await expect(card.getByRole('button', { name: '再試行' })).toBeVisible();
  });

  test('does not show the previous account list while the new account list is loading', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-account-a', title: 'アカウントAの予定' })],
    });
    await openRoutinePage(page);
    await expect(page.getByTestId('routine-card')).toContainText('アカウントAの予定');
    api.setRoutines([routine({ id: 'routine-account-b', title: 'アカウントBの予定' })]);
    api.setAccountUserId('usr_routine_partner');
    const delayedList = api.holdAllListResponses();
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes('/api/auth/me') && response.status() === 200,
      ),
      triggerVisibilityCycle(page),
    ]);
    await delayedList.started;
    await expect(page.getByText('アカウントAの予定')).toHaveCount(0);
    await expect(page.getByTestId('routine-list-placeholder').locator('li')).toHaveCount(2);
    delayedList.release();
    await expect(page.getByTestId('routine-card')).toContainText('アカウントBの予定');
    await expect(page.getByText('アカウントAの予定')).toHaveCount(0);
  });

  test('resolves conflict panels through existing skip and move actions and refetches conflicts', async ({
    page,
  }) => {
    const conflictEvent = (id: string, date: string) => ({
      id,
      title: '運動会',
      time: {
        kind: 'timed' as const,
        start: `${date}T17:00:00+09:00`,
        endExclusive: `${date}T18:00:00+09:00`,
      },
    });
    const api = await mockRoutineApis(page, {
      routines: [
        routine({
          id: 'routine-conflict-resolution',
          title: 'ピアノ',
          weekdays: ['SA'],
          upcoming: {
            status: 'ready',
            conflictsStatus: 'ready',
            instances: [
              {
                ...instance('conflict-skip', '2026-10-17'),
                conflicts: [conflictEvent('sports-skip', '2026-10-17')],
              },
              {
                ...instance('conflict-move', '2026-10-24'),
                conflicts: [conflictEvent('sports-move', '2026-10-24')],
              },
              {
                ...instance('conflict-moved-skip', '2026-10-31'),
                conflicts: [conflictEvent('sports-moved-skip', '2026-10-31')],
              },
            ],
          },
        }),
      ],
    });
    await openRoutinePage(page);
    const card = page.getByTestId('routine-card').filter({ hasText: 'ピアノ' });
    const firstPanel = card.getByTestId('routine-conflicts-conflict-skip');
    const secondPanel = card.getByTestId('routine-conflicts-conflict-move');
    await expect(firstPanel).toContainText('10/17（土）は『運動会』 17:00–18:00と重なっています');
    await expect(secondPanel).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectVisibleTargetsAtLeast44px(page);
    await page.setViewportSize({ width: 445, height: 844 });
    await expectNoHorizontalOverflow(page);
    await expectVisibleTargetsAtLeast44px(page);
    await page.setViewportSize({ width: 390, height: 844 });

    const beforeSkipRefetch = api.listCalls;
    await firstPanel.getByTestId('routine-conflict-skip-conflict-skip').click();
    await expect(firstPanel).toHaveCount(0);
    await expect.poll(() => api.listCalls).toBeGreaterThan(beforeSkipRefetch);
    expect(api.instanceMutations[0]).toMatchObject({ action: 'skip', instanceId: 'conflict-skip' });

    const moveButton = secondPanel.getByTestId('routine-conflict-move-conflict-move');
    await moveButton.click();
    const actions = card.getByTestId('routine-instance-actions-conflict-move');
    await actions.getByTestId('routine-instance-move-date').fill('2026-10-24');
    await actions.getByTestId('routine-instance-move-start').fill('17:15');
    await actions.getByTestId('routine-instance-move-end').fill('18:15');
    const beforeOverlapRefetch = api.listCalls;
    await actions.getByTestId('routine-instance-move-save').click();
    await expect(secondPanel).toBeVisible();
    await expect.poll(() => api.listCalls).toBeGreaterThan(beforeOverlapRefetch);

    await secondPanel.getByTestId('routine-conflict-move-conflict-move').click();
    const moveActions = card.getByTestId('routine-instance-actions-conflict-move');
    await moveActions.getByTestId('routine-instance-move-date').fill('2026-10-24');
    await moveActions.getByTestId('routine-instance-move-start').fill('19:00');
    await moveActions.getByTestId('routine-instance-move-end').fill('20:00');
    const beforeResolvedRefetch = api.listCalls;
    await moveActions.getByTestId('routine-instance-move-save').click();
    await expect(secondPanel).toHaveCount(0);
    await expect.poll(() => api.listCalls).toBeGreaterThan(beforeResolvedRefetch);
    expect(api.instanceMutations.at(-1)).toMatchObject({
      action: 'move',
      instanceId: 'conflict-move',
    });

    const movedSkipPanel = card.getByTestId('routine-conflicts-conflict-moved-skip');
    await movedSkipPanel.getByTestId('routine-conflict-move-conflict-moved-skip').click();
    const movedActions = card.getByTestId('routine-instance-actions-conflict-moved-skip');
    await movedActions.getByTestId('routine-instance-move-date').fill('2026-10-31');
    await movedActions.getByTestId('routine-instance-move-start').fill('17:15');
    await movedActions.getByTestId('routine-instance-move-end').fill('18:15');
    await movedActions.getByTestId('routine-instance-move-save').click();
    await expect(movedSkipPanel).toBeVisible();
    const movedSkipButton = movedSkipPanel.getByTestId('routine-conflict-skip-conflict-moved-skip');
    await expect(movedSkipButton).toBeVisible();
    await movedSkipButton.click();
    await expect(movedSkipPanel).toHaveCount(0);
    expect(api.instanceMutations.at(-1)).toMatchObject({
      action: 'skip',
      instanceId: 'conflict-moved-skip',
    });
  });

  test('keeps move controls readable before saving and exposes pending state on the chip', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      holdInstanceMutation: true,
      routines: [
        routine({
          id: 'routine-move-colors',
          title: 'ピアノ',
          upcoming: {
            status: 'ready',
            conflictsStatus: 'ready',
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
    await expect(actions).toHaveCount(0);
    const chip = card.getByTestId('routine-instance-chip-instance-move-colors');
    await expect(chip).toContainText('保存中');
    await expect(chip).toHaveAccessibleName(/保存中/);
    await expect(chip).toBeDisabled();
    api.releaseInstanceMutation();
    await saveRequest;
    await expect(chip).not.toContainText('保存中');
    expect(api.instanceMutations).toHaveLength(1);
  });

  test('keeps the prior chip state after a failed operation and offers retry after unavailable upcoming data', async ({
    page,
  }) => {
    const unavailable = routine({
      id: 'routine-unavailable',
      title: '水泳',
      upcoming: { status: 'unavailable', conflictsStatus: 'unavailable', instances: [] },
    });
    const api = await mockRoutineApis(page, {
      routines: [
        routine({
          id: 'routine-error',
          title: 'ピアノ',
          upcoming: {
            status: 'ready',
            conflictsStatus: 'ready',
            instances: [
              {
                ...instance('instance-error', '2026-10-13'),
                conflicts: [
                  {
                    id: 'event-error-conflict',
                    title: '運動会',
                    time: {
                      kind: 'timed',
                      start: '2026-10-13T17:00:00+09:00',
                      endExclusive: '2026-10-13T18:00:00+09:00',
                    },
                  },
                ],
              },
            ],
          },
        }),
        unavailable,
        routine({
          id: 'routine-conflicts-unavailable',
          title: '合唱',
          upcoming: {
            status: 'ready',
            conflictsStatus: 'unavailable',
            instances: [
              {
                ...instance('unknown-conflict-instance', '2026-10-13'),
                conflicts: [
                  {
                    id: 'unknown-conflict-event',
                    title: '見えない予定',
                    time: {
                      kind: 'timed',
                      start: '2026-10-13T17:00:00+09:00',
                      endExclusive: '2026-10-13T18:00:00+09:00',
                    },
                  },
                ],
              },
            ],
          },
        }),
      ],
      failNextInstanceMutation: true,
    });
    await openRoutinePage(page);
    const errorCard = page.getByTestId('routine-card').filter({ hasText: 'ピアノ' });
    const chip = errorCard.getByTestId('routine-instance-chip-instance-error');
    await expect(chip).toContainText('10/13');
    await expect(errorCard.getByTestId('routine-conflicts-instance-error')).toBeVisible();
    const mutation = api.holdNextInstanceMutation();
    await errorCard.getByTestId('routine-conflict-skip-instance-error').click();
    await mutation.started;
    await expect(chip).toContainText('お休み');
    await expect(chip).toContainText('保存中');
    await expect(errorCard.getByTestId('routine-conflicts-instance-error')).toHaveCount(0);
    mutation.release();
    await expect(errorCard.getByRole('alert')).toHaveText(
      '変更を保存できませんでした。時間をおいて再度お試しください。',
    );
    await expect(chip).toContainText('10/13');
    await expect(chip).not.toContainText('お休み');
    await expect(errorCard.getByTestId('routine-conflicts-instance-error')).toBeVisible();
    expect(api.instanceMutations).toHaveLength(1);

    const unavailableCard = page.getByTestId('routine-card').filter({ hasText: '水泳' });
    await expect(unavailableCard).toContainText('直近の回を取得できませんでした。');
    const retry = unavailableCard.getByRole('button', { name: '再試行' });
    const callsBeforeRetry = api.listCalls;
    await retry.click();
    await expect(retry).toBeVisible();
    await expect.poll(() => api.listCalls).toBeGreaterThan(callsBeforeRetry);
    const unknownCard = page.getByTestId('routine-card').filter({ hasText: '合唱' });
    await expect(unknownCard).toContainText('重複を確認できませんでした。');
    await expect(
      unknownCard.getByTestId('routine-instance-chip-unknown-conflict-instance'),
    ).not.toContainText('重複');
    await expect(
      unknownCard.getByTestId('routine-conflicts-unknown-conflict-instance'),
    ).toHaveCount(0);
  });

  test('rolls back a failed move and reopens the form with its draft intact', async ({ page }) => {
    const api = await mockRoutineApis(page, {
      routines: [
        routine({
          id: 'routine-failed-move',
          title: 'ピアノ',
          upcoming: {
            status: 'ready',
            conflictsStatus: 'ready',
            instances: [instance('failed-move', '2026-10-13')],
          },
        }),
      ],
      failNextInstanceMutation: true,
    });
    await openRoutinePage(page);
    const card = page.getByTestId('routine-card').filter({ hasText: 'ピアノ' });
    const chip = card.getByTestId('routine-instance-chip-failed-move');
    await chip.click();
    const actions = card.getByTestId('routine-instance-actions-failed-move');
    await actions.getByTestId('routine-instance-set-move').click();
    await actions.getByTestId('routine-instance-move-date').fill('2026-10-30');
    await actions.getByTestId('routine-instance-move-start').fill('19:00');
    await actions.getByTestId('routine-instance-move-end').fill('20:15');
    const mutation = api.holdNextInstanceMutation();
    await actions.getByTestId('routine-instance-move-save').click();
    await mutation.started;
    await expect(card.getByTestId('routine-instance-actions-failed-move')).toHaveCount(0);
    await expect(chip).toContainText('10/30');
    await expect(chip).toContainText('保存中');
    mutation.release();

    await expect(chip).toContainText('10/13');
    await expect(chip).not.toContainText('10/30');
    await expect(card.getByRole('alert')).toHaveText(
      '変更を保存できませんでした。時間をおいて再度お試しください。',
    );
    const reopenedActions = card.getByTestId('routine-instance-actions-failed-move');
    await expect(reopenedActions.getByTestId('routine-instance-move-date')).toHaveValue(
      '2026-10-30',
    );
    await expect(reopenedActions.getByTestId('routine-instance-move-start')).toHaveValue('19:00');
    await expect(reopenedActions.getByTestId('routine-instance-move-end')).toHaveValue('20:15');
  });

  test('ignores a held instance result after the signed-in account changes', async ({ page }) => {
    const api = await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-account-pending', title: 'アカウントAの予定' })],
    });
    await openRoutinePage(page);
    const accountACard = page.getByTestId('routine-card').filter({ hasText: 'アカウントAの予定' });
    const chip = accountACard.getByTestId(
      'routine-instance-chip-instance-routine-account-pending-1',
    );
    await chip.click();
    const mutation = api.holdNextInstanceMutation();
    await accountACard
      .getByTestId('routine-instance-actions-instance-routine-account-pending-1')
      .getByTestId('routine-instance-skip')
      .click();
    await mutation.started;
    await expect(chip).toContainText('お休み');

    api.setRoutines([routine({ id: 'routine-account-b-pending', title: 'アカウントBの予定' })]);
    api.setAccountUserId('usr_routine_partner');
    const delayedList = api.holdNextListResponse();
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes('/api/auth/me') && response.status() === 200,
      ),
      triggerVisibilityCycle(page),
    ]);
    await delayedList.started;
    await expect(page.getByText('アカウントAの予定')).toHaveCount(0);
    delayedList.release();
    await expect(page.getByTestId('routine-card')).toContainText('アカウントBの予定');

    mutation.release();
    await expect(page.getByTestId('routine-card')).toContainText('アカウントBの予定');
    await expect(page.getByText('アカウントAの予定')).toHaveCount(0);
  });

  test('saves holiday settings and continues 20-item batches while locking the routine card', async ({
    page,
  }) => {
    const api = await mockRoutineApis(page, {
      routines: [
        routine({
          id: 'routine-holidays',
          title: 'ピアノ',
          upcoming: {
            status: 'ready',
            conflictsStatus: 'ready',
            instances: [instance('holiday-instance', '2026-10-13')],
          },
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
            upcoming: {
              status: 'ready',
              conflictsStatus: 'ready',
              instances: [instance('holiday-instance', '2026-10-13')],
            },
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
            conflictsStatus: 'ready',
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

  test('fits 390px and 445px, keeps controls at least 44px, and keeps the routine tab ready', async ({
    page,
  }) => {
    await mockRoutineApis(page, {
      routines: [routine({ id: 'routine-long', title: '家族みんなで参加する長めの習い事' })],
    });
    await page.route('**/api/families/*/tasks', async (route) => {
      await route.fulfill(jsonResponse(200, { tasks: [] }));
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
    await expect(navigation.getByRole('link', { name: /やること/ })).not.toContainText('準備中');
    await expect(navigation.getByText('準備中', { exact: true })).toHaveCount(0);
  });
});
