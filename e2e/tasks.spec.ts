import { type Page, type Route, expect, test } from '@playwright/test';
import type { Task } from '../src/shared/schemas/tasks';

test.use({
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  timezoneId: 'UTC',
  locale: 'ja-JP',
});

const USER_A = 'usr_tasks_a';
const USER_B = 'usr_tasks_b';
const FAMILY_A = 'fam_tasks_a';
const FAMILY_B = 'fam_tasks_b';
const MEMBERS = [
  {
    id: 'mem_adult_a',
    userId: USER_A,
    kind: 'adult' as const,
    name: 'あおい',
    color: 'indigo' as const,
    sortOrder: 0,
  },
  {
    id: 'mem_adult_b',
    userId: 'usr_other',
    kind: 'adult' as const,
    name: 'はる',
    color: 'green' as const,
    sortOrder: 1,
  },
  {
    id: 'mem_child',
    userId: null,
    kind: 'child' as const,
    name: 'ゆう',
    color: 'ochre' as const,
    sortOrder: 2,
  },
];

const ready = {
  state: 'ready' as const,
  eventId: 'evt_picnic',
  title: '公園ピクニック',
  time: {
    kind: 'timed' as const,
    start: '2026-10-10T10:00:00+09:00',
    endExclusive: '2026-10-10T12:00:00+09:00',
  },
  memberIds: ['mem_adult_a', 'mem_child'],
  items: ['水筒', '敷物'],
};

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    due: { kind: 'date', dueAt: '2026-10-10' },
    doneAt: null,
    assigneeMemberId: null,
    source: 'manual',
    linkedEvent: { state: 'none' },
    ...overrides,
  };
}

function responseTask(source: Task, familyId: string): Task {
  if (familyId === FAMILY_B) return task('task-private-b', { title: 'Bのやること' });
  return source;
}

function deferred() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function installTaskHarness(page: Page, initialTasks: Task[], members = MEMBERS) {
  let userId = USER_A;
  let familyId = FAMILY_A;
  let tasks = [...initialTasks];
  let failNextPatch = false;
  let failNextGet = false;
  let failNextDelete = false;
  let failCreateAfterCommit = false;
  const createRequests: Array<{ clientRequestId: string; title: string }> = [];
  const patchRequests: Array<Record<string, unknown>> = [];
  const createdByRequestId = new Map<string, Task>();
  let createdSequence = 0;
  let patchGate: ReturnType<typeof deferred> | undefined;
  let getGate: ReturnType<typeof deferred> | undefined;
  let createGate: ReturnType<typeof deferred> | undefined;
  let patchStarted: (() => void) | undefined;
  let getStarted: (() => void) | undefined;
  const patchStartedPromise = new Promise<void>((resolve) => {
    patchStarted = resolve;
  });
  const getStartedPromise = new Promise<void>((resolve) => {
    getStarted = resolve;
  });
  let getCalls = 0;

  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: userId, email: 'tasks@example.test', displayName: 'テスト利用者' },
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
            id: familyId,
            name: 'サンプル家',
            familyCalendarId: 'cal_tasks',
            ownerUserId: userId,
            creationStatus: 'ready',
            members: members.map((member) => ({
              ...member,
              userId: member.userId === USER_A ? userId : member.userId,
            })),
          },
        ],
      }),
    });
  });
  await page.route('**/api/families/*/tasks**', async (route: Route) => {
    const pathParts = new URL(route.request().url()).pathname.split('/');
    const requestFamilyId = pathParts[3] ?? familyId;
    const method = route.request().method();
    if (method === 'GET') {
      getCalls += 1;
      getStarted?.();
      if (getGate) {
        const gate = getGate;
        getGate = undefined;
        await gate.promise;
      }
      if (failNextGet) {
        failNextGet = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'failed', code: 'INTERNAL_ERROR' }),
        });
        return;
      }
      const visible = tasks.map((item) => responseTask(item, requestFamilyId));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: visible }),
      });
      return;
    }
    if (method === 'PATCH') {
      patchStarted?.();
      if (patchGate) await patchGate.promise;
      if (failNextPatch) {
        failNextPatch = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'failed', code: 'INTERNAL_ERROR' }),
        });
        return;
      }
      const taskId = pathParts.at(-1);
      const patch = route.request().postDataJSON() as {
        title?: string;
        due?: Task['due'];
        done?: boolean;
        assigneeMemberId?: string | null;
      };
      patchRequests.push(patch);
      const index = tasks.findIndex((item) => item.id === taskId);
      if (index >= 0) {
        const current = tasks[index];
        if (!current) {
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'missing', code: 'NOT_FOUND' }),
          });
          return;
        }
        tasks[index] = {
          ...current,
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.due === undefined ? {} : { due: patch.due }),
          ...(patch.done === undefined ? {} : { doneAt: patch.done ? 1_797_000_000 : null }),
          ...(patch.assigneeMemberId === undefined
            ? {}
            : { assigneeMemberId: patch.assigneeMemberId }),
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ task: tasks[index] }),
        });
      } else {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'missing', code: 'NOT_FOUND' }),
        });
      }
      return;
    }
    if (method === 'DELETE') {
      const taskId = pathParts.at(-1);
      if (failNextDelete) {
        failNextDelete = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'failed', code: 'INTERNAL_ERROR' }),
        });
        return;
      }
      tasks = tasks.filter((item) => item.id !== taskId);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    if (method === 'POST') {
      const body = route.request().postDataJSON() as {
        clientRequestId: string;
        title: string;
        due: Task['due'];
        assigneeMemberId: string | null;
        eventId?: string | null;
      };
      createRequests.push({ clientRequestId: body.clientRequestId, title: body.title });
      if (createGate) {
        const gate = createGate;
        createGate = undefined;
        await gate.promise;
      }
      let created = createdByRequestId.get(body.clientRequestId);
      if (!created) {
        createdSequence += 1;
        created = task(`task-created-${createdSequence}`, {
          title: body.title,
          due: body.due,
          assigneeMemberId: body.assigneeMemberId,
          linkedEvent: body.eventId ? ready : { state: 'none' },
        });
        createdByRequestId.set(body.clientRequestId, created);
        tasks = [...tasks, created];
      }
      if (failCreateAfterCommit) {
        failCreateAfterCommit = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'failed', code: 'INTERNAL_ERROR' }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ task: created }),
        });
      }
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  return {
    getCalls: () => getCalls,
    taskCount: () => tasks.length,
    patchStartedPromise,
    getStartedPromise,
    setFailNextPatch: () => {
      failNextPatch = true;
    },
    setFailNextGet: () => {
      failNextGet = true;
    },
    setFailNextDelete: () => {
      failNextDelete = true;
    },
    setFailCreateAfterCommit: () => {
      failCreateAfterCommit = true;
    },
    createRequests,
    patchRequests,
    setPatchGate: (gate: ReturnType<typeof deferred>) => {
      patchGate = gate;
    },
    setGetGate: (gate: ReturnType<typeof deferred>) => {
      getGate = gate;
    },
    setCreateGate: (gate: ReturnType<typeof deferred>) => {
      createGate = gate;
    },
    switchAccount: () => {
      userId = USER_B;
      familyId = FAMILY_B;
    },
    patchGate: () => patchGate,
  };
}

async function selectView(page: Page, label: string) {
  await page.getByLabel('やることの表示').getByText(label, { exact: true }).click();
}

async function freezeClock(page: Page) {
  await page.addInitScript((timestamp) => {
    Date.now = () => timestamp;
  }, Date.parse('2026-10-08T03:00:00Z'));
}

async function simulateTabReturn(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    window.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    window.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

test('task list, datetime form, and inline assignee picker at 390px', async ({ page }) => {
  await freezeClock(page);
  await installTaskHarness(page, [
    task('task-auto', {
      title: '持ち物を準備',
      source: 'items',
      due: { kind: 'datetime', dueAt: '2026-10-09T20:00:00+09:00' },
      linkedEvent: { ...ready, items: ['水筒', '敷物'] },
    }),
    task('task-manual', {
      title: '参加票を出す',
      due: { kind: 'datetime', dueAt: '2026-10-09T20:00:00+09:00' },
    }),
    task('task-mine', {
      title: '自分が担当',
      assigneeMemberId: 'mem_adult_a',
      linkedEvent: ready,
    }),
    task('task-done-screenshot', {
      title: '前日に確認',
      doneAt: 1_797_000_000,
      linkedEvent: ready,
    }),
    task('task-unlinked-screenshot', { title: '振込を確認' }),
  ]);
  await page.goto('/tasks');
  await expect(page.getByText('10/8（木）時点')).toBeVisible();
  await expect(page.getByTestId('tasks-event-view')).toBeVisible();
  await expect(page.getByTestId('task-assignee-task-auto')).toBeVisible();
  await expect(page.getByText('10/10 公園ピクニック', { exact: true })).toBeVisible();
  await expect(page.getByText('持ち物を準備', { exact: true })).toBeVisible();
  await expect(page.getByText('持ち物から自動')).toBeVisible();
  await expect(page.getByText('水筒、敷物', { exact: true })).toBeVisible();
  await expect(page.getByTestId('task-edit-task-auto')).toHaveCount(0);
  await page.getByText(/予定に紐づかないやること/).click();
  await page.setViewportSize({ width: 390, height: 1100 });
  await page.screenshot({ path: 'docs/screenshots/s5-tasks.png' });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByTestId('task-add-button').click();
  await expect(page.getByTestId('task-dialog')).toBeVisible();
  await page.getByTestId('task-due-kind').selectOption('datetime');
  await page.getByTestId('task-form-title').fill('図書館へ返却');
  await expect(page.getByTestId('task-due-time')).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/task-form.png' });
  await page.getByRole('button', { name: '閉じる' }).click();

  await page.getByTestId('task-assignee-task-auto').click();
  await expect(page.getByRole('group', { name: '担当を選択' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 1100 });
  await page.screenshot({ path: 'docs/screenshots/s5-tasks-assignee.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  const buttons = await page.getByRole('group', { name: '担当を選択' }).getByRole('button').all();
  for (const button of buttons) {
    const box = await button.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  }
  expect(await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await selectView(page, '期限順');
  await expect(page.getByTestId('tasks-due-view')).toBeVisible();
  await selectView(page, '自分の担当');
  await expect(page.getByTestId('tasks-mine-view').getByText('自分が担当')).toBeVisible();
});

test('manual and automatic task titles update strikethrough with completion state', async ({
  page,
}) => {
  await freezeClock(page);
  await installTaskHarness(page, [
    task('task-manual-style', { title: '手動の確認', linkedEvent: ready }),
    task('task-done-auto', {
      title: '自動の確認',
      source: 'items',
      linkedEvent: ready,
    }),
  ]);

  await page.goto('/tasks');
  const manualTitle = page.getByTestId('task-edit-task-manual-style');
  const automaticTitle = page.getByText('自動の確認', { exact: true });
  await expect(manualTitle).toBeVisible();
  await expect(automaticTitle).toBeVisible();

  const assertStrikethrough = async () => {
    for (const title of [manualTitle, automaticTitle]) {
      const style = await title.evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          decorationLine: computed.textDecorationLine,
          decorationColor: computed.textDecorationColor,
        };
      });
      expect(style.decorationLine).toContain('line-through');
      expect(style.decorationColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(style.decorationColor).not.toBe('transparent');
    }
  };
  const assertNoStrikethrough = async () => {
    for (const title of [manualTitle, automaticTitle]) {
      const decorationLine = await title.evaluate(
        (element) => getComputedStyle(element).textDecorationLine,
      );
      expect(decorationLine).not.toContain('line-through');
    }
  };

  await assertNoStrikethrough();
  await page.getByRole('checkbox', { name: '手動の確認を完了にする' }).click();
  await expect(page.getByRole('checkbox', { name: '手動の確認を未完了に戻す' })).toBeChecked();
  await page.getByRole('checkbox', { name: '自動の確認を完了にする' }).click();
  await expect(page.getByRole('checkbox', { name: '自動の確認を未完了に戻す' })).toBeChecked();
  await assertStrikethrough();
  await manualTitle.hover();
  await assertStrikethrough();
  await page.getByRole('checkbox', { name: '手動の確認を未完了に戻す' }).click();
  await expect(page.getByRole('checkbox', { name: '手動の確認を完了にする' })).not.toBeChecked();
  await page.getByRole('checkbox', { name: '自動の確認を未完了に戻す' }).click();
  await expect(page.getByRole('checkbox', { name: '自動の確認を完了にする' })).not.toBeChecked();
  await assertNoStrikethrough();
});

test('shows summaries and sorts each view in event, due, and assigned order', async ({ page }) => {
  await freezeClock(page);
  const earlierEvent = {
    ...ready,
    eventId: 'evt_earlier',
    title: '先の予定',
    time: {
      kind: 'timed' as const,
      start: '2026-10-09T10:00:00+09:00',
      endExclusive: '2026-10-09T11:00:00+09:00',
    },
  };
  await installTaskHarness(page, [
    task('task-week', {
      title: '週内',
      due: { kind: 'date', dueAt: '2026-10-11' },
      assigneeMemberId: 'mem_adult_a',
      linkedEvent: ready,
    }),
    task('task-today', { title: '今日', due: { kind: 'date', dueAt: '2026-10-08' } }),
    task('task-overdue', { title: '過ぎた', due: { kind: 'date', dueAt: '2026-10-07' } }),
    task('task-no-due', { title: '期限なし', due: { kind: 'none' }, linkedEvent: earlierEvent }),
    task('task-unknown-due', {
      title: '期限不明',
      due: { kind: 'unknown' },
      assigneeMemberId: 'mem_adult_a',
      linkedEvent: earlierEvent,
    }),
    task('task-done', {
      title: '完了済み',
      due: { kind: 'date', dueAt: '2026-10-08' },
      doneAt: 1_797_000_000,
      linkedEvent: ready,
    }),
  ]);
  await page.goto('/tasks');
  await expect(page.getByLabel('やることのサマリー')).toContainText('今日まで 2');
  await expect(page.getByLabel('やることのサマリー')).toContainText('今週 3');
  await expect(page.getByLabel('やることのサマリー')).toContainText('担当未定 3');
  const eventGroups = page.getByTestId('task-event-group');
  await expect(eventGroups.nth(0)).toContainText('先の予定');
  await expect(eventGroups.nth(1)).toContainText('公園ピクニック');
  await selectView(page, '期限順');
  const dueView = page.getByTestId('tasks-due-view');
  await expect(dueView.getByRole('button', { name: '過ぎた' })).toBeVisible();
  const openTitles = await dueView
    .locator('ul')
    .first()
    .locator('button[data-testid^="task-edit-"]')
    .allTextContents();
  expect(openTitles).toEqual(['過ぎた', '今日', '週内', '期限なし', '期限不明']);
  await expect(dueView.getByRole('heading', { name: '完了', exact: true })).toBeVisible();
  await selectView(page, '自分の担当');
  const mineView = page.getByTestId('tasks-mine-view');
  const mineTitles = await mineView.locator('button[data-testid^="task-edit-"]').allTextContents();
  expect(mineTitles).toEqual(['週内', '期限不明']);
});

test('optimistic completion and assignee removal roll back and keep errors on the row', async ({
  page,
}) => {
  await freezeClock(page);
  const harness = await installTaskHarness(page, [
    task('task-done', { title: '期限順で完了', due: { kind: 'date', dueAt: '2026-10-08' } }),
    task('task-assigned', { title: '担当解除', assigneeMemberId: 'mem_adult_a' }),
  ]);
  await page.goto('/tasks');
  await expect(page.getByTestId('tasks-event-view')).toBeVisible();
  await selectView(page, '期限順');
  await expect(page.getByRole('button', { name: '期限順で完了' })).toBeVisible();

  harness.setFailNextPatch();
  const completionGate = deferred();
  harness.setPatchGate(completionGate);
  const completionStarted = harness.patchStartedPromise;
  await page.getByRole('checkbox', { name: '期限順で完了を完了にする' }).click();
  await completionStarted;
  await expect(page.getByRole('checkbox', { name: '期限順で完了を未完了に戻す' })).toBeChecked();
  completionGate.resolve();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: '完了状態を保存できませんでした。もう一度お試しください。' }),
  ).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '期限順で完了を完了にする' })).not.toBeChecked();

  await selectView(page, '自分の担当');
  const assigneeGate = deferred();
  harness.setPatchGate(assigneeGate);
  harness.setFailNextPatch();
  const assigneeStarted = harness.patchStartedPromise;
  await page.getByTestId('task-assignee-task-assigned').click();
  await page
    .getByRole('group', { name: '担当を選択' })
    .getByRole('button', { name: '担当なし' })
    .click();
  await assigneeStarted;
  await expect(page.getByTestId('tasks-mine-view').getByText('担当解除')).toHaveCount(0);
  assigneeGate.resolve();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: '担当を保存できませんでした。もう一度お試しください。' }),
  ).toBeVisible();
  await expect(page.getByTestId('task-assignee-task-assigned')).toHaveAttribute(
    'aria-label',
    '担当を変更: あおい',
  );
});

test('saves completion and assignee changes immediately while refreshing cached rows in the background', async ({
  page,
}) => {
  await freezeClock(page);
  const harness = await installTaskHarness(page, [
    task('task-toggle', { title: '水やり', linkedEvent: ready }),
    task('task-assign', { title: '連絡帳', linkedEvent: ready }),
  ]);
  await page.goto('/tasks');
  const placeholder = page.getByTestId('task-list-placeholder');
  await expect(page.getByText('水やり')).toBeVisible();
  await expect(placeholder).toHaveCount(0);
  const before = harness.getCalls();
  const refresh = deferred();
  harness.setGetGate(refresh);
  await page.getByRole('checkbox', { name: '水やりを完了にする' }).click();
  await expect(page.getByRole('checkbox', { name: '水やりを未完了に戻す' })).toBeChecked();
  await expect.poll(() => harness.getCalls()).toBeGreaterThan(before);
  await expect(placeholder).toHaveCount(0);
  refresh.resolve();
  await expect(page.getByRole('checkbox', { name: '水やりを未完了に戻す' })).toBeEnabled();
  await page.getByRole('checkbox', { name: '水やりを未完了に戻す' }).click();
  await expect(page.getByRole('checkbox', { name: '水やりを完了にする' })).toBeVisible();

  await page.getByTestId('task-assignee-task-assign').click();
  await page
    .getByRole('group', { name: '担当を選択' })
    .getByRole('button', { name: 'はる' })
    .click();
  await expect(page.getByTestId('task-assignee-task-assign')).toHaveAttribute(
    'aria-label',
    '担当を変更: はる',
  );
  await page.getByTestId('task-assignee-task-assign').click();
  await page
    .getByRole('group', { name: '担当を選択' })
    .getByRole('button', { name: '担当なし' })
    .click();
  await expect(page.getByTestId('task-assignee-task-assign')).toHaveAttribute(
    'aria-label',
    '担当を決める',
  );
});

test('creates linked and unlinked manual tasks, edits a task, and confirms deletion inline', async ({
  page,
}) => {
  await freezeClock(page);
  const harness = await installTaskHarness(page, [
    task('task-manual-existing', { title: '買い物メモ', linkedEvent: ready }),
  ]);
  await page.goto('/tasks');

  await page.getByTestId('task-add-button').click();
  await page.getByTestId('task-form-title').fill('電池を買う');
  await page.getByTestId('task-due-kind').selectOption('date');
  await page.getByTestId('task-due-date').fill('2026-10-09');
  await page.getByTestId('task-form-assignee').selectOption('mem_adult_b');
  await page.getByTestId('task-save').click();
  await page.getByText(/予定に紐づかないやること/).click();
  await expect(page.getByRole('button', { name: '電池を買う' })).toBeVisible();
  expect(harness.createRequests[0]?.title).toBe('電池を買う');

  await page.getByTestId('task-add-to-event-evt_picnic').click();
  await expect(page.getByTestId('task-dialog')).toContainText('公園ピクニック');
  await page.getByTestId('task-form-title').fill('帽子を用意');
  await page.getByTestId('task-save').click();
  await expect(page.getByRole('button', { name: '帽子を用意' })).toBeVisible();
  expect(harness.createRequests[1]?.title).toBe('帽子を用意');

  await page.getByTestId('task-edit-task-manual-existing').click();
  await page.getByTestId('task-form-title').fill('新しい買い物メモ');
  await page.getByTestId('task-save').click();
  await expect(page.getByRole('button', { name: '新しい買い物メモ' })).toBeVisible();

  await page.getByTestId('task-edit-task-manual-existing').click();
  await page.getByRole('button', { name: '削除', exact: true }).click();
  await expect(page.getByText('このやることを削除しますか？')).toBeVisible();
  await page.getByRole('button', { name: '削除する' }).click();
  await expect(page.getByRole('button', { name: '新しい買い物メモ' })).toHaveCount(0);
  expect(harness.taskCount()).toBe(2);
});

test('keeps form input after save failure, validates locally, and ignores a rapid duplicate submit', async ({
  page,
}) => {
  await freezeClock(page);
  const harness = await installTaskHarness(page, []);
  harness.setFailCreateAfterCommit();
  await page.goto('/tasks');
  await page.getByTestId('task-add-button').click();
  await page.getByTestId('task-form-title').fill('保存失敗の入力');
  await page.getByTestId('task-save').click();
  await expect(page.getByRole('alert')).toContainText('やることを保存できませんでした');
  await expect(page.getByTestId('task-form-title')).toHaveValue('保存失敗の入力');
  await page.getByRole('button', { name: '閉じる' }).click();

  await page.getByTestId('task-add-button').click();
  await page.getByTestId('task-form-title').fill('   ');
  await page.getByTestId('task-save').click();
  await expect(page.getByRole('alert')).toContainText('入力内容を確認してください');
  expect(harness.createRequests).toHaveLength(1);
  await page.getByTestId('task-form-title').fill('二重作成しない');
  const gate = deferred();
  harness.setCreateGate(gate);
  await page.getByTestId('task-save').click();
  await expect.poll(() => harness.createRequests.length).toBe(2);
  await page.getByTestId('task-save').click({ force: true });
  expect(harness.createRequests).toHaveLength(2);
  gate.resolve();
  await selectView(page, '期限順');
  await expect(page.getByRole('button', { name: '二重作成しない' })).toBeVisible();
  expect(harness.taskCount()).toBe(2);
});

test('retries an ambiguous create with the original idempotency key and applies the latest valid title', async ({
  page,
}) => {
  await freezeClock(page);
  const harness = await installTaskHarness(page, []);
  harness.setFailCreateAfterCommit();
  await page.goto('/tasks');
  await page.getByTestId('task-add-button').click();
  await page.getByTestId('task-form-title').fill('最初のタイトル');
  await page.getByTestId('task-save').click();
  await expect(page.getByRole('alert')).toContainText('やることを保存できませんでした');
  const idempotencyId = harness.createRequests[0]?.clientRequestId;
  expect(idempotencyId).toBeTruthy();

  await page.getByTestId('task-form-title').fill('   ');
  await page.getByTestId('task-save').click();
  await expect(page.getByRole('alert')).toContainText('入力内容を確認してください');
  await page.getByTestId('task-form-title').fill('修正したタイトル');
  await page.getByTestId('task-save').click();

  await selectView(page, '期限順');
  await expect(page.getByText('修正したタイトル')).toBeVisible();
  expect(harness.createRequests).toHaveLength(2);
  expect(harness.createRequests.map(({ clientRequestId }) => clientRequestId)).toEqual([
    idempotencyId,
    idempotencyId,
  ]);
  expect(harness.createRequests[1]?.title).toBe('最初のタイトル');
  expect(harness.taskCount()).toBe(1);
  expect(harness.patchRequests).toContainEqual({
    title: '修正したタイトル',
    due: { kind: 'none' },
    assigneeMemberId: null,
  });
});

test('keeps cached rows visible during refetch and prevents an old account response from appearing after a switch', async ({
  page,
}) => {
  await freezeClock(page);
  const harness = await installTaskHarness(page, [
    task('task-private-a', { title: 'Aだけのやること' }),
  ]);
  await page.goto('/tasks');
  await selectView(page, '期限順');
  await expect(page.getByText('Aだけのやること')).toBeVisible();

  const refetchGate = deferred();
  harness.setGetGate(refetchGate);
  await simulateTabReturn(page);
  await expect.poll(() => harness.getCalls()).toBeGreaterThan(1);
  await expect(page.getByText('Aだけのやること')).toBeVisible();
  refetchGate.resolve();

  const mutationGate = deferred();
  harness.setPatchGate(mutationGate);
  const mutationStarted = harness.patchStartedPromise;
  await expect(page.getByRole('checkbox', { name: 'Aだけのやることを完了にする' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Aだけのやることを完了にする' }).click();
  await mutationStarted;
  harness.switchAccount();
  await simulateTabReturn(page);
  await expect.poll(() => harness.getCalls()).toBeGreaterThan(2);
  await expect(page.getByTestId('tasks-event-view')).toBeVisible();
  await selectView(page, '期限順');
  await expect(page.getByText('Bのやること')).toBeVisible();
  mutationGate.resolve();
  await expect(page.getByText('Aだけのやること')).toHaveCount(0);
  await expect(page.getByText('Bのやること')).toBeVisible();
});

test('shows missing and unavailable event cards and the empty-state action', async ({ page }) => {
  await freezeClock(page);
  await installTaskHarness(page, [
    task('task-missing', {
      title: '消えた予定の準備',
      linkedEvent: { state: 'missing', eventId: 'evt_deleted' },
    }),
    task('task-unavailable', {
      title: '取得失敗の準備',
      linkedEvent: { state: 'unavailable', eventId: 'evt_private' },
    }),
  ]);
  await page.goto('/tasks');
  await expect(page.getByTestId('task-missing-group')).toContainText('予定が見つかりません');
  await expect(page.getByTestId('task-unavailable-group')).toContainText(
    '予定の情報を取得できませんでした',
  );
  await expect(
    page.getByTestId('task-unavailable-group').getByRole('button', { name: '再試行' }),
  ).toBeVisible();
});

test('explains the empty state and offers a manual task action', async ({ page }) => {
  await freezeClock(page);
  const harness = await installTaskHarness(page, []);
  await page.goto('/tasks');
  await expect(page.getByText('家族のやることをまとめて管理')).toBeVisible();
  await page.getByRole('button', { name: 'やることを追加', exact: true }).last().click();
  await expect(page.getByTestId('task-dialog')).toBeVisible();
  expect(harness.taskCount()).toBe(0);
});

test('shows initial loading and retry after a failed list request', async ({ page }) => {
  await freezeClock(page);
  const harness = await installTaskHarness(page, [
    task('task-retry', { title: '再試行で取得', linkedEvent: ready }),
  ]);
  const initialLoad = deferred();
  harness.setGetGate(initialLoad);
  await page.goto('/tasks');
  await expect(page.getByTestId('task-list-placeholder')).toBeVisible();
  await expect.poll(() => harness.getCalls()).toBeGreaterThan(0);
  initialLoad.resolve();
  await expect(page.getByText('再試行で取得')).toBeVisible();
  harness.setFailNextGet();
  await simulateTabReturn(page);
  await expect(
    page.getByText('最新の一覧を取得できませんでした。前回の表示を続けています。'),
  ).toBeVisible();
  await page.getByRole('button', { name: '再試行', exact: true }).click();
  await expect(page.getByText('再試行で取得')).toBeVisible();
});

test('refreshes cached tasks when returning from another tab and fits at 390px and 445px', async ({
  page,
}) => {
  await freezeClock(page);
  const harness = await installTaskHarness(page, [
    task('task-tab-return', { title: 'タブに戻る' }),
  ]);
  await page.goto('/tasks');
  const navigation = page.getByRole('navigation', { name: 'メインナビゲーション' });
  await navigation.getByRole('link', { name: '週', exact: true }).click();
  await expect(page).toHaveURL(/\/\?week=/);
  const gate = deferred();
  harness.setGetGate(gate);
  await navigation.getByRole('link', { name: /やること/ }).click();
  await selectView(page, '期限順');
  await expect(page.getByText('タブに戻る')).toBeVisible();
  await expect.poll(() => harness.getCalls()).toBeGreaterThan(1);
  await expect(page.getByTestId('task-list-placeholder')).toHaveCount(0);
  gate.resolve();

  for (const width of [390, 445]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const targets = page.locator(
      'button:visible, a:visible, select:visible, summary:visible, label:has(input[type="checkbox"]):visible, input[type="text"]:visible, input[type="date"]:visible, input[type="time"]:visible',
    );
    for (const target of await targets.all()) {
      const box = await target.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  }
});

test('wraps long task, event, and member names at 390px and 445px', async ({ page }) => {
  await freezeClock(page);
  const longEvent = {
    ...ready,
    title: `Event${'E'.repeat(100)}`,
    memberIds: ['mem_adult_a'],
  };
  const longMembers = MEMBERS.map((member, index) => ({
    ...member,
    name: index === 0 ? `Member${'M'.repeat(70)}` : member.name,
  }));
  await installTaskHarness(
    page,
    [
      task('task-long-title', {
        title: 'Task'.padEnd(200, 'T'),
        assigneeMemberId: 'mem_adult_a',
        linkedEvent: longEvent,
      }),
    ],
    longMembers,
  );
  await page.goto('/tasks');

  for (const width of [390, 445]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByTestId('task-add-to-event-evt_picnic').click();
    await expect(page.getByTestId('task-dialog')).toContainText(longEvent.title);
    expect(
      await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('button', { name: '閉じる' }).click();
    await page.getByTestId('task-assignee-task-long-title').click();
    await expect(page.getByRole('group', { name: '担当を選択' })).toBeVisible();
    expect(
      await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByTestId('task-assignee-task-long-title').click();
  }
});
