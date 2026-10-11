import { type Page, type Route, expect, test } from '@playwright/test';
import type { DateKey } from '../src/shared/schemas/date';
import type { FamilyPublic } from '../src/shared/schemas/family';
import type { Task } from '../src/shared/schemas/tasks';
import type { WeekEvent, WeekResponse } from '../src/shared/schemas/week';
import { addCalendarDays, getWeekday } from '../src/shared/time/date';
import { getWeekRange } from '../src/shared/time/week';

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, timezoneId: 'UTC' });

const BASE_WEEK = '2026-10-05' as DateKey;
const USER_A = 'usr_week_tasks_a';
const USER_B = 'usr_week_tasks_b';
const FAMILY_A = 'fam_week_tasks_a';
const FAMILY_B = 'fam_week_tasks_b';
const MEMBER_A = 'mem_week_tasks_adult';
const CHILD = 'mem_week_tasks_child';

type Identity = { userId: string; familyId: string; familyName: string };
type TaskBehavior = 'ready' | 'failure' | 'delayed';

function familyFixture(identity: Identity): FamilyPublic {
  return {
    id: identity.familyId,
    name: identity.familyName,
    familyCalendarId: `cal_${identity.familyId}`,
    ownerUserId: identity.userId,
    creationStatus: 'ready',
    members: [
      {
        id: MEMBER_A,
        userId: identity.userId,
        kind: 'adult',
        name: 'テスト利用者',
        color: 'indigo',
        sortOrder: 0,
      },
      {
        id: CHILD,
        userId: null,
        kind: 'child',
        name: '子ども',
        color: 'ochre',
        sortOrder: 1,
      },
    ],
  };
}

function makeEvents(start: DateKey): WeekEvent[] {
  const tuesday = addCalendarDays(start, 1);
  const wednesday = addCalendarDays(start, 2);
  const saturday = addCalendarDays(start, 5);
  return [
    {
      id: 'evt_routine',
      title: '火曜のルーティン',
      time: {
        kind: 'timed',
        start: `${tuesday}T08:00:00+09:00`,
        endExclusive: `${tuesday}T08:30:00+09:00`,
      },
      memberIds: [CHILD],
      assigneeMemberId: null,
      status: 'confirmed',
      isRecurring: true,
      isRoutine: true,
      movedFrom: null,
      affectsAvailability: true,
      source: 'manual',
      items: [],
    },
    {
      id: 'evt_weekday',
      title: '水曜の家族予定',
      time: {
        kind: 'timed',
        start: `${wednesday}T10:00:00+09:00`,
        endExclusive: `${wednesday}T11:00:00+09:00`,
      },
      memberIds: [CHILD],
      assigneeMemberId: null,
      status: 'confirmed',
      isRecurring: false,
      isRoutine: false,
      movedFrom: null,
      affectsAvailability: true,
      source: 'manual',
      items: ['持ち物'],
    },
    {
      id: 'evt_recurring',
      title: '木曜の繰り返し予定',
      time: {
        kind: 'timed',
        start: `${addCalendarDays(start, 3)}T10:00:00+09:00`,
        endExclusive: `${addCalendarDays(start, 3)}T11:00:00+09:00`,
      },
      memberIds: [CHILD],
      assigneeMemberId: null,
      status: 'confirmed',
      isRecurring: true,
      isRoutine: false,
      movedFrom: `${addCalendarDays(start, 3)}T09:00:00+09:00`,
      affectsAvailability: true,
      source: 'manual',
      items: [],
    },
    {
      id: 'evt_weekend',
      title: '土曜の家族予定',
      time: {
        kind: 'timed',
        start: `${saturday}T12:00:00+09:00`,
        endExclusive: `${saturday}T13:00:00+09:00`,
      },
      memberIds: [CHILD],
      assigneeMemberId: null,
      status: 'confirmed',
      isRecurring: false,
      isRoutine: false,
      movedFrom: null,
      affectsAvailability: true,
      source: 'manual',
      items: [],
    },
    {
      id: 'evt_zero',
      title: '件数なし予定',
      time: {
        kind: 'timed',
        start: `${addCalendarDays(start, 6)}T14:00:00+09:00`,
        endExclusive: `${addCalendarDays(start, 6)}T15:00:00+09:00`,
      },
      memberIds: [CHILD],
      assigneeMemberId: null,
      status: 'confirmed',
      isRecurring: false,
      isRoutine: false,
      movedFrom: null,
      affectsAvailability: true,
      source: 'manual',
      items: [],
    },
  ];
}

function makeWeek(identity: Identity, start: DateKey): WeekResponse {
  const range = getWeekRange(start);
  const events = makeEvents(range.start);
  const days = range.days.map((date) => {
    const weekday = getWeekday(date);
    const isWeekend = weekday === 0 || weekday === 6;
    const eventIds = events
      .filter((event) =>
        event.time.kind === 'all-day'
          ? event.time.start === date
          : event.time.start.slice(0, 10) === date,
      )
      .map((event) => event.id);
    return {
      date,
      weekday,
      holidayName: null,
      closures: [],
      layout: isWeekend
        ? ('weekend-card' as const)
        : eventIds.some((id) => id === 'evt_weekday' || id === 'evt_recurring')
          ? ('expanded' as const)
          : ('compact' as const),
      eventIds,
    };
  });
  return {
    family: { id: identity.familyId, name: identity.familyName },
    members: familyFixture(identity).members.map(({ id, name, kind, color, sortOrder }) => ({
      id,
      name,
      kind,
      color,
      sortOrder,
    })),
    week: {
      start: range.start,
      endInclusive: range.endInclusive,
      prevWeekStart: range.prevWeekStart,
      nextWeekStart: range.nextWeekStart,
      today: '2026-10-06' as DateKey,
    },
    days,
    events,
  };
}

function makeTask(
  id: string,
  title: string,
  due: Task['due'],
  options: {
    done?: boolean;
    eventId?: string;
    eventTitle?: string;
    eventRecurring?: boolean;
    source?: Task['source'];
  } = {},
): Task {
  const eventId = options.eventId;
  return {
    id,
    title,
    due,
    doneAt: options.done ? 1_791_290_000 : null,
    assigneeMemberId: null,
    source: options.source ?? 'manual',
    linkedEvent: eventId
      ? {
          state: 'ready',
          eventId,
          title: options.eventTitle ?? '水曜の家族予定',
          time: {
            kind: 'timed',
            start: '2026-10-07T10:00:00+09:00',
            endExclusive: '2026-10-07T11:00:00+09:00',
          },
          memberIds: [CHILD],
          items: [],
        }
      : { state: 'none' },
  };
}

function taskFixture(): Task[] {
  return [
    makeTask('task_monday', '月曜の期限だけ', { kind: 'date', dueAt: '2026-10-05' }),
    makeTask(
      'task_tue_date',
      '日付だけの期限',
      { kind: 'date', dueAt: '2026-10-06' },
      { eventId: 'evt_weekday' },
    ),
    makeTask(
      'task_tue_early',
      '朝の締切',
      { kind: 'datetime', dueAt: '2026-10-06T09:00:00+09:00' },
      { eventId: 'evt_weekday' },
    ),
    makeTask(
      'task_tue_late',
      '夜の締切',
      { kind: 'datetime', dueAt: '2026-10-06T18:00:00+09:00' },
      { eventId: 'evt_weekday' },
    ),
    makeTask(
      'task_wed',
      '水曜の締切',
      { kind: 'date', dueAt: '2026-10-07' },
      { eventId: 'evt_weekday' },
    ),
    makeTask(
      'task_sat',
      '週末の締切',
      { kind: 'datetime', dueAt: '2026-10-10T09:00:00+09:00' },
      { eventId: 'evt_weekend' },
    ),
    makeTask('task_overdue', '過去日の締切', { kind: 'date', dueAt: '2026-10-04' }),
    makeTask('task_done', '完了した締切', { kind: 'date', dueAt: '2026-10-06' }, { done: true }),
    makeTask('task_no_due', '期限なし', { kind: 'none' }),
    makeTask('task_unknown', '不明な期限', { kind: 'unknown' }),
    makeTask(
      'task_routine',
      'ルーティンのやること',
      { kind: 'none' },
      { eventId: 'evt_routine', eventTitle: '火曜のルーティン' },
    ),
    makeTask(
      'task_recurring',
      '繰り返し予定のやること',
      { kind: 'date', dueAt: '2026-10-08' },
      { eventId: 'evt_recurring', eventTitle: '木曜の繰り返し予定', eventRecurring: true },
    ),
    makeTask(
      'task_personal',
      '自分だけの予定のやること',
      { kind: 'date', dueAt: '2026-10-10' },
      { eventId: 'evt_personal', eventTitle: '自分だけの予定' },
    ),
  ];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Harness {
  setIdentity(identity: Identity): void;
  setTaskBehavior(behavior: TaskBehavior): void;
  setTasks(tasks: Task[]): void;
  holdNextTaskRequest(): { started: Promise<void>; release(): void };
  waitForTaskResponse(index: number): Promise<void>;
  releaseTasks(): void;
  tasksStarted: Promise<void>;
  taskRequests: string[];
  taskResponses: Promise<void>[];
  weekRequests: string[];
}

async function installHarness(
  page: Page,
  options: { taskBehavior?: TaskBehavior; tasks?: Task[] } = {},
): Promise<Harness> {
  let identity: Identity = { userId: USER_A, familyId: FAMILY_A, familyName: '合成家 A' };
  let tasks = options.tasks ?? taskFixture();
  const taskRequests: string[] = [];
  const taskResponses: Promise<void>[] = [];
  const weekRequests: string[] = [];
  const tasksGate = deferred();
  const tasksStarted = deferred();
  const queuedTaskGates: Array<{
    gate: ReturnType<typeof deferred>;
    started: ReturnType<typeof deferred>;
  }> = [];
  let taskBehavior = options.taskBehavior ?? 'ready';
  await page.route('**/api/auth/me', async (route) =>
    fulfill(route, {
      user: { id: identity.userId, email: 'week@example.test', displayName: 'テスト利用者' },
    }),
  );
  await page.route('**/api/families', async (route) =>
    fulfill(route, { families: [familyFixture(identity)] }),
  );
  await page.route('**/api/families/*/week**', async (route) => {
    const url = new URL(route.request().url());
    weekRequests.push(
      url.pathname.endsWith('/week/personal')
        ? 'personal'
        : url.pathname.endsWith('/week/busy')
          ? 'busy'
          : 'week',
    );
    const start = (url.searchParams.get('start') ?? BASE_WEEK) as DateKey;
    if (url.pathname.endsWith('/week/personal')) {
      const week = makeWeek(identity, start);
      await fulfill(route, {
        family: { id: identity.familyId },
        memberId: MEMBER_A,
        week: week.week,
        status: 'ready',
        events: [
          {
            id: 'evt_personal',
            calendarId: 'cal_private',
            title: '自分だけの予定',
            time: {
              kind: 'timed',
              start: '2026-10-10T14:00:00+09:00',
              endExclusive: '2026-10-10T15:00:00+09:00',
            },
            isRoutine: false,
          },
        ],
      });
      return;
    }
    if (url.pathname.endsWith('/week/busy')) {
      const week = makeWeek(identity, start);
      await fulfill(route, {
        family: { id: identity.familyId },
        week: week.week,
        members: [],
      });
      return;
    }
    await fulfill(route, makeWeek(identity, start));
  });
  await page.route('**/api/families/*/tasks**', async (route: Route) => {
    const url = new URL(route.request().url());
    const familyId = url.pathname.split('/')[3] ?? identity.familyId;
    const requestIdentity = { ...identity };
    const requestBehavior = taskBehavior;
    const requestTasks = structuredClone(tasks);
    taskRequests.push(`${requestIdentity.userId}:${familyId}`);
    if (route.request().method() === 'GET' && url.pathname.endsWith('/tasks')) {
      const responseSignal = deferred();
      taskResponses.push(responseSignal.promise);
      const queuedGate = queuedTaskGates.shift();
      if (queuedGate) {
        queuedGate.started.resolve();
        await queuedGate.gate.promise;
      }
      if (
        requestBehavior === 'delayed' &&
        requestIdentity.userId === USER_A &&
        familyId === FAMILY_A
      ) {
        tasksStarted.resolve();
        await tasksGate.promise;
      }
      if (requestBehavior === 'failure') {
        await fulfill(route, { error: 'synthetic tasks failure', code: 'INTERNAL_ERROR' }, 500);
      } else {
        const accountTasks =
          requestIdentity.userId === USER_B
            ? [
                makeTask(
                  familyId === FAMILY_B ? 'task_family_b' : 'task_b_private',
                  familyId === FAMILY_B ? 'B家族のやること' : 'B利用者のやること',
                  { kind: 'date', dueAt: '2026-10-06' },
                ),
              ]
            : requestTasks;
        await fulfill(route, { tasks: accountTasks });
      }
      responseSignal.resolve();
      return;
    }
    if (route.request().method() === 'PATCH') {
      const taskId = url.pathname.split('/').at(-1);
      const body = route.request().postDataJSON() as { done?: boolean };
      const task = tasks.find((item) => item.id === taskId);
      if (task) {
        task.doneAt = body.done ? 1_791_290_000 : null;
        await fulfill(route, { task });
        return;
      }
    }
    await fulfill(route, { error: 'unexpected task request', code: 'NOT_FOUND' }, 404);
  });
  await page.route('**/api/families/*/events**', async (route) => {
    if (route.request().method() === 'PATCH' || route.request().method() === 'POST') {
      await fulfill(route, { eventId: 'evt_saved_synthetic' });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/families/*/routines', async (route) => fulfill(route, { routines: [] }));
  return {
    setIdentity(next) {
      identity = next;
    },
    setTaskBehavior(next) {
      taskBehavior = next;
    },
    setTasks(next) {
      tasks = next;
    },
    holdNextTaskRequest() {
      const gate = deferred();
      const started = deferred();
      queuedTaskGates.push({ gate, started });
      return { started: started.promise, release: gate.resolve };
    },
    waitForTaskResponse(index) {
      const response = taskResponses[index];
      if (!response) throw new Error(`Task response ${index} has not started`);
      return response;
    },
    releaseTasks() {
      tasksGate.resolve();
    },
    tasksStarted: tasksStarted.promise,
    taskRequests,
    taskResponses,
    weekRequests,
  };
}

async function fulfill(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport);
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

test('shows deadline links without changing day layout and counts only eligible family events', async ({
  page,
}) => {
  await installHarness(page);
  await page.goto(`/?week=${BASE_WEEK}`);

  const monday = page.locator('[data-testid="week-day"][data-date="2026-10-05"]');
  await expect(monday).toHaveAttribute('data-layout', 'compact');
  await expect(page.getByTestId('week-deadline-2026-10-05-task_monday')).toBeVisible();
  await expect(monday.getByTestId('week-deadlines-2026-10-05')).toBeVisible();
  expect((await monday.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const tuesday = page.locator('[data-testid="week-day"][data-date="2026-10-06"]');
  await expect(tuesday).toHaveAttribute('data-layout', 'compact');
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_early')).toBeVisible();
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_late')).toBeVisible();
  await expect(page.getByTestId('week-deadlines-more-2026-10-06')).toHaveText('ほか 1 件');
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_date')).toHaveCount(0);
  await expect(page.getByTestId('week-deadline-2026-10-04-task_overdue')).toHaveCount(0);
  await expect(page.getByTestId('week-deadline-2026-10-06-task_done')).toHaveCount(0);
  await expect(page.getByTestId('week-deadline-2026-10-06-task_no_due')).toHaveCount(0);
  await expect(page.getByTestId('week-deadline-2026-10-06-task_unknown')).toHaveCount(0);

  const weekdayCard = page.locator('[data-testid="week-day"][data-date="2026-10-07"]');
  await expect(weekdayCard).toHaveAttribute('data-layout', 'expanded');
  await expect(page.getByTestId('week-deadline-2026-10-07-task_wed')).toBeVisible();
  await expect(page.getByTestId('week-event-task-count-evt_weekday')).toHaveText(
    'やること 残り 4 件',
  );
  await expect(page.getByTestId('week-event-task-count-evt_routine')).toHaveCount(0);
  await expect(page.getByTestId('week-event-task-count-evt_recurring')).toHaveCount(0);
  await expect(page.getByTestId('week-event-task-count-evt_weekend')).toHaveText(
    'やること 残り 1 件',
  );
  await expect(page.getByTestId('week-event-task-count-evt_zero')).toHaveCount(0);
  await expect(page.getByTestId('week-event-task-count-evt_personal')).toHaveCount(0);

  const deadline = page.getByTestId('week-deadline-2026-10-06-task_tue_early');
  await expect(deadline).toHaveAttribute('href', /\/tasks$/);
  await expect(deadline).toHaveAttribute(
    'aria-label',
    /2026年10月6日 火曜日が期限.*朝の締切.*水曜の家族予定/,
  );
  await expect(page.getByTestId('week-deadlines-more-2026-10-06')).toHaveAttribute(
    'aria-label',
    '2026年10月6日 火曜日が期限のやることをすべて表示（ほか1件）',
  );
  await expect(
    page.getByRole('button', { name: /水曜の家族予定.*やること 残り 4 件/ }),
  ).toBeVisible();
  const countBadge = page.getByTestId('week-event-task-count-evt_weekday');
  expect(await countBadge.evaluate((element) => element.tagName)).toBe('SPAN');
  expect(await countBadge.locator('a, button').count()).toBe(0);
  await page.getByRole('button', { name: 'ルーティンを隠す' }).click();
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_early')).toBeVisible();
  await expect(page.locator('[data-testid="week-day"][data-date="2026-10-06"]')).toHaveAttribute(
    'data-layout',
    'compact',
  );

  await page.getByRole('button', { name: /予定を編集: 水曜の家族予定/ }).click();
  await expect(page.getByTestId('event-dialog')).toBeVisible();
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.getByTestId('event-dialog')).toHaveCount(0);

  await deadline.click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('heading', { name: 'やること', exact: true })).toBeVisible();
});

test('shows an absence task deadline on its stored due date', async ({ page }) => {
  const tasks = taskFixture();
  tasks.push(
    makeTask(
      'task_absence_notice',
      '「ピアノ」（10/17（土））に欠席を連絡',
      { kind: 'date', dueAt: '2026-10-16' },
      { source: 'conflict' },
    ),
  );
  await installHarness(page, { tasks });
  await page.goto('/?week=2026-10-12');

  const deadline = page.getByTestId('week-deadline-2026-10-16-task_absence_notice');
  await expect(deadline).toBeVisible();
  await expect(deadline).toContainText('「ピアノ」（10/17（土））に欠席を連絡');
  await expect(deadline).toHaveAttribute('href', '/tasks');
  for (const width of [390, 445]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect((await deadline.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
});

test('keeps the week visible when tasks load slowly or a refresh fails', async ({ page }) => {
  const harness = await installHarness(page, { taskBehavior: 'delayed' });
  await page.goto(`/?week=${BASE_WEEK}`);
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByText('水曜の家族予定', { exact: true })).toBeVisible();
  await harness.tasksStarted;
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_early')).toHaveCount(0);
  harness.releaseTasks();
  await harness.waitForTaskResponse(0);
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_early')).toBeVisible();

  harness.setTaskBehavior('failure');
  await simulateTabReturn(page);
  await expect.poll(() => harness.taskResponses.length).toBeGreaterThan(1);
  await harness.waitForTaskResponse(1);
  await expect(page.getByText('水曜の家族予定', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_early')).toBeVisible();
  await expect(page.getByTestId('week-event-task-count-evt_weekday')).toHaveText(
    'やること 残り 4 件',
  );
});

test('keeps the week visible without task markers when the initial task request fails', async ({
  page,
}) => {
  const harness = await installHarness(page, { taskBehavior: 'failure' });
  await page.goto(`/?week=${BASE_WEEK}`);
  await expect.poll(() => harness.taskResponses.length).toBeGreaterThan(0);
  await harness.waitForTaskResponse(0);

  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByText('水曜の家族予定', { exact: true })).toBeVisible();
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_early')).toHaveCount(0);
  await expect(page.getByTestId('week-event-task-count-evt_weekday')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('keeps cached task markers and day heights while a focus refresh is pending', async ({
  page,
}) => {
  const harness = await installHarness(page);
  await page.goto(`/?week=${BASE_WEEK}`);
  const earlyDeadline = page.getByTestId('week-deadline-2026-10-06-task_tue_early');
  const personalEvent = page.getByTestId('personal-event-evt_personal');
  await expect(earlyDeadline).toBeVisible();
  await expect(page.getByTestId('week-event-task-count-evt_weekday')).toHaveText(
    'やること 残り 4 件',
  );
  await expect(personalEvent).toBeVisible();

  const compactDay = page.locator('[data-testid="week-day"][data-date="2026-10-06"]');
  const expandedCard = page
    .locator('[data-testid="week-day"][data-date="2026-10-07"]')
    .getByTestId('expanded-day-card');
  const compactHeight = (await compactDay.boundingBox())?.height;
  const expandedHeight = (await expandedCard.boundingBox())?.height;
  expect(compactHeight).toBeDefined();
  expect(expandedHeight).toBeDefined();

  const refreshedTasks = taskFixture();
  const refreshedEarlyTask = refreshedTasks.find((task) => task.id === 'task_tue_early');
  const refreshedWednesdayTask = refreshedTasks.find((task) => task.id === 'task_wed');
  expect(refreshedEarlyTask).toBeDefined();
  expect(refreshedWednesdayTask).toBeDefined();
  if (refreshedEarlyTask) refreshedEarlyTask.title = '更新後の朝の締切';
  if (refreshedWednesdayTask) refreshedWednesdayTask.doneAt = 1_791_290_000;
  harness.setTasks(refreshedTasks);
  const weekRequestCounts = Object.fromEntries(
    ['week', 'personal', 'busy'].map((kind) => [
      kind,
      harness.weekRequests.filter((request) => request === kind).length,
    ]),
  );
  const heldRefresh = harness.holdNextTaskRequest();
  await simulateTabReturn(page);
  await heldRefresh.started;
  await expect
    .poll(() =>
      ['week', 'personal', 'busy'].every(
        (kind) =>
          harness.weekRequests.filter((request) => request === kind).length >
          (weekRequestCounts[kind] ?? 0),
      ),
    )
    .toBe(true);
  await expect(personalEvent).toBeVisible();
  await expect(earlyDeadline).toBeVisible();
  await expect(page.getByTestId('week-event-task-count-evt_weekday')).toHaveText(
    'やること 残り 4 件',
  );
  expect((await compactDay.boundingBox())?.height).toBe(compactHeight);
  expect((await expandedCard.boundingBox())?.height).toBe(expandedHeight);

  heldRefresh.release();
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_early')).toContainText(
    '更新後の朝の締切',
  );
  await harness.waitForTaskResponse(1);
  await expect(page.getByTestId('week-event-task-count-evt_weekday')).toHaveText(
    'やること 残り 3 件',
  );
});

test('shows cached task markers immediately when returning from tasks during a refresh', async ({
  page,
}) => {
  const harness = await installHarness(page);
  await page.goto(`/?week=${BASE_WEEK}`);
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_early')).toBeVisible();
  await expect(page.getByTestId('week-event-task-count-evt_weekday')).toHaveText(
    'やること 残り 4 件',
  );
  await harness.waitForTaskResponse(0);

  await page
    .getByRole('navigation', { name: 'メインナビゲーション' })
    .getByRole('link', { name: 'やること', exact: true })
    .click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect.poll(() => harness.taskResponses.length).toBeGreaterThan(1);
  await harness.waitForTaskResponse(1);

  const refreshedTasks = taskFixture();
  const refreshedEarlyTask = refreshedTasks.find((task) => task.id === 'task_tue_early');
  const refreshedWednesdayTask = refreshedTasks.find((task) => task.id === 'task_wed');
  expect(refreshedEarlyTask).toBeDefined();
  expect(refreshedWednesdayTask).toBeDefined();
  if (refreshedEarlyTask) refreshedEarlyTask.title = '更新後の朝の締切';
  if (refreshedWednesdayTask) refreshedWednesdayTask.doneAt = 1_791_290_000;
  harness.setTasks(refreshedTasks);
  const heldRefresh = harness.holdNextTaskRequest();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`\\?week=${BASE_WEEK}$`));
  await heldRefresh.started;
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_early')).toBeVisible();
  await expect(page.getByTestId('week-event-task-count-evt_weekday')).toHaveText(
    'やること 残り 4 件',
  );
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_early')).not.toContainText(
    '更新後の朝の締切',
  );

  heldRefresh.release();
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_early')).toContainText(
    '更新後の朝の締切',
  );
  await harness.waitForTaskResponse(2);
  await expect(page.getByTestId('week-event-task-count-evt_weekday')).toHaveText(
    'やること 残り 3 件',
  );
});

test('reflects task completion from the tasks page and keeps long labels inside the viewport', async ({
  page,
}) => {
  const tasks = taskFixture();
  tasks.push(
    makeTask('task_long_title', `とても長い締切タイトル${'長い予定'.repeat(18)}`, {
      kind: 'date',
      dueAt: '2026-10-10',
    }),
  );
  await installHarness(page, { tasks });
  await page.goto(`/?week=${BASE_WEEK}`);
  await page
    .getByRole('navigation', { name: 'メインナビゲーション' })
    .getByRole('link', { name: 'やること', exact: true })
    .click();
  await expect(page).toHaveURL(/\/tasks$/);
  await page.getByRole('checkbox', { name: '朝の締切を完了にする' }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/\?week=2026-10-05$/);
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_early')).toHaveCount(0);
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_date')).toBeVisible();
  await expect(page.getByTestId('week-deadlines-more-2026-10-06')).toHaveCount(0);
  await expect(page.getByTestId('week-event-task-count-evt_weekday')).toHaveText(
    'やること 残り 3 件',
  );

  const longDeadline = page.getByTestId('week-deadline-2026-10-10-task_long_title');
  await expect(longDeadline).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 445, height: 844 });
  await expectNoHorizontalOverflow(page);
  for (const link of await page
    .locator('[data-testid^="week-deadline-"], [data-testid^="week-deadlines-more-"]')
    .all()) {
    expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
});

test('does not show the previous family task response after identity changes while it is pending', async ({
  page,
}) => {
  const harness = await installHarness(page, { taskBehavior: 'delayed' });
  await page.goto(`/?week=${BASE_WEEK}`);
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await harness.tasksStarted;
  harness.setIdentity({ userId: USER_B, familyId: FAMILY_A, familyName: '合成家 A' });
  await simulateTabReturn(page);
  await expect(page.getByText('合成家 A', { exact: true })).toBeVisible();
  await expect(page.getByTestId('week-deadline-2026-10-06-task_b_private')).toBeVisible();
  harness.releaseTasks();
  await expect(page.getByTestId('week-deadline-2026-10-06-task_tue_early')).toHaveCount(0);
  await expect(page.getByTestId('week-deadline-2026-10-06-task_b_private')).toBeVisible();
  harness.setIdentity({ userId: USER_B, familyId: FAMILY_B, familyName: '合成家 B' });
  await simulateTabReturn(page);
  await expect(page.getByText('合成家 B', { exact: true })).toBeVisible();
  await expect(page.getByTestId('week-deadline-2026-10-06-task_family_b')).toBeVisible();
  await expect(page.getByTestId('week-deadline-2026-10-06-task_b_private')).toHaveCount(0);
});
