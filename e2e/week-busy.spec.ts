import { type Page, expect, test } from '@playwright/test';
import type { DateKey } from '../src/shared/schemas/date';
import type { FamilyPublic } from '../src/shared/schemas/family';
import type { PersonalWeekResponse } from '../src/shared/schemas/personal';
import type { WeekEvent, WeekResponse } from '../src/shared/schemas/week';
import type { BusyWeekResponse } from '../src/shared/schemas/week-busy';
import { addCalendarDays, getWeekday } from '../src/shared/time/date';
import { getWeekRange } from '../src/shared/time/week';

test.use({
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  timezoneId: 'UTC',
  locale: 'ja-JP',
});

const BASE_WEEK = '2026-10-05' as DateKey;
const SATURDAY = '2026-10-10' as DateKey;
const FAMILY_A = 'fam_busy_a';
const FAMILY_B = 'fam_busy_b';
const ADULT_A = 'mem_busy_a';
const ADULT_B = 'mem_busy_b';
const CHILD = 'mem_busy_child';
const A_USER = 'usr_busy_a';
const B_USER = 'usr_busy_b';

type Account = 'A' | 'B';
type BusyFactory = (familyId: string, start: DateKey) => unknown;

interface MockOptions {
  activeAccount?: () => Account;
  busyFactory?: BusyFactory;
  busyFailureStatus?: number;
  delayBusyStart?: DateKey;
  malformedBusy?: boolean;
  longNames?: boolean;
  conflictFixture?: boolean;
  unusualDay?: 'one-event' | 'two-events' | 'dense-event';
}

function familyId(account: Account): string {
  return account === 'A' ? FAMILY_A : FAMILY_B;
}

function adultId(account: Account): string {
  return account === 'A' ? ADULT_A : ADULT_B;
}

function familyFixture(account: Account, longNames = false): FamilyPublic {
  const selfId = adultId(account);
  const otherAccount: Account = account === 'A' ? 'B' : 'A';
  const selfName = account === 'A' ? '大人甲' : '大人乙';
  const otherName = account === 'A' ? '大人乙' : '大人甲';
  return {
    id: familyId(account),
    name: account === 'A' ? '空き時間サンプル家 A' : '空き時間サンプル家 B',
    familyCalendarId: `cal_family_${account}`,
    ownerUserId: account === 'A' ? A_USER : B_USER,
    creationStatus: 'ready',
    members: [
      {
        id: selfId,
        userId: account === 'A' ? A_USER : B_USER,
        kind: 'adult',
        name: longNames ? `${selfName}${'長'.repeat(45)}` : selfName,
        color: 'indigo',
        sortOrder: 0,
      },
      {
        id: adultId(otherAccount),
        userId: otherAccount === 'A' ? A_USER : B_USER,
        kind: 'adult',
        name: longNames ? `${otherName}${'長'.repeat(45)}` : otherName,
        color: 'green',
        sortOrder: 1,
      },
      {
        id: CHILD,
        userId: null,
        kind: 'child',
        name: longNames ? `子ども${'長'.repeat(45)}` : '子ども',
        color: 'ochre',
        sortOrder: 2,
      },
    ],
  };
}

function makeFamilyEvents(
  anchor: DateKey,
  unusualDay: MockOptions['unusualDay'] = 'two-events',
  conflictFixture = false,
): WeekEvent[] {
  const saturday = addCalendarDays(anchor, 5);
  const wednesday = addCalendarDays(anchor, 2);
  const tuesday = addCalendarDays(anchor, 1);
  const events: WeekEvent[] = [
    {
      id: 'evt-family-everyone',
      title: '家族の合成予定',
      time: {
        kind: 'timed',
        start: `${saturday}T12:00:00+09:00`,
        endExclusive: `${saturday}T13:00:00+09:00`,
      },
      memberIds: [],
      assigneeMemberId: null,
      status: 'confirmed',
      isRoutine: false,
      isRecurring: false,
      movedFrom: null,
      affectsAvailability: true,
      source: 'manual',
      items: [],
    },
    {
      id: 'evt-child-routine',
      title: '朝のルーティン',
      time: {
        kind: 'timed',
        start: `${saturday}T16:00:00+09:00`,
        endExclusive: `${saturday}T17:00:00+09:00`,
      },
      memberIds: [CHILD],
      assigneeMemberId: null,
      status: 'confirmed',
      isRoutine: true,
      isRecurring: true,
      movedFrom: null,
      affectsAvailability: true,
      source: 'manual',
      items: [],
    },
    {
      id: 'evt-routine-not-in-free-time',
      title: '空き判定しない家事代行',
      time: {
        kind: 'timed',
        start: `${saturday}T18:00:00+09:00`,
        endExclusive: `${saturday}T19:00:00+09:00`,
      },
      memberIds: [ADULT_B],
      assigneeMemberId: null,
      status: 'confirmed',
      isRoutine: true,
      isRecurring: true,
      movedFrom: null,
      affectsAvailability: false,
      source: 'manual',
      items: [],
    },
    {
      id: 'evt-weekday-routine',
      title: '火曜のルーティン',
      time: {
        kind: 'timed',
        start: `${tuesday}T09:00:00+09:00`,
        endExclusive: `${tuesday}T10:00:00+09:00`,
      },
      memberIds: [CHILD],
      assigneeMemberId: null,
      status: 'confirmed',
      isRoutine: true,
      isRecurring: true,
      movedFrom: null,
      affectsAvailability: true,
      source: 'manual',
      items: [],
    },
    {
      id: 'evt-weekday-exception',
      title:
        unusualDay === 'dense-event'
          ? `振替後のとても長い予定タイトル${'長い文字'.repeat(8)}`
          : '水曜へ振替した習い事',
      time: {
        kind: 'timed',
        start: `${wednesday}T17:00:00+09:00`,
        endExclusive: `${wednesday}T18:00:00+09:00`,
      },
      memberIds: [CHILD],
      assigneeMemberId: unusualDay === 'dense-event' ? ADULT_A : null,
      status: 'confirmed',
      isRoutine: false,
      isRecurring: true,
      movedFrom:
        unusualDay === 'one-event' ? `${wednesday}T16:00:00+09:00` : `${tuesday}T17:00:00+09:00`,
      affectsAvailability: true,
      source: 'manual',
      items: [],
    },
  ];
  if (unusualDay !== 'one-event') {
    events.push({
      id: 'evt-weekday-oneoff',
      title: unusualDay === 'dense-event' ? '単発予定' : '保護者会',
      time: {
        kind: 'timed',
        start: `${wednesday}T${unusualDay === 'dense-event' || !conflictFixture ? '18:30' : '17:30'}:00+09:00`,
        endExclusive: `${wednesday}T${unusualDay === 'dense-event' || !conflictFixture ? '19:00' : '18:00'}:00+09:00`,
      },
      memberIds: [CHILD],
      assigneeMemberId: null,
      status: unusualDay === 'dense-event' ? 'tentative' : 'confirmed',
      isRoutine: false,
      isRecurring: false,
      movedFrom: null,
      affectsAvailability: true,
      source: 'manual',
      items: [],
    });
  }
  return events;
}

function makeWeek(
  anchor: DateKey,
  family: FamilyPublic,
  unusualDay?: MockOptions['unusualDay'],
  conflictFixture = false,
): WeekResponse {
  const range = getWeekRange(anchor);
  const events = makeFamilyEvents(range.start, unusualDay, conflictFixture);
  const days = range.days.map((date) => {
    const weekday = getWeekday(date);
    const isHoliday = date === '2026-10-12';
    const isWeekend = weekday === 0 || weekday === 6 || isHoliday;
    const eventIds = events
      .filter((event) => {
        if (event.time.kind === 'all-day')
          return event.time.start <= date && date < event.time.endExclusive;
        const start = event.time.start.slice(0, 10);
        const end = event.time.endExclusive.slice(0, 10);
        return (
          start <= date &&
          date <= end &&
          !(end === date && event.time.endExclusive.endsWith('T00:00:00+09:00'))
        );
      })
      .map((event) => event.id);
    const hasNonRoutineEvent = events.some(
      (event) => eventIds.includes(event.id) && !event.isRoutine,
    );
    return {
      date,
      weekday,
      holidayName: isHoliday ? 'スポーツの日' : null,
      closures: [],
      layout: isWeekend
        ? ('weekend-card' as const)
        : hasNonRoutineEvent
          ? ('expanded' as const)
          : ('compact' as const),
      eventIds,
    };
  });
  return {
    family: { id: family.id, name: family.name },
    members: family.members.map(({ id, name, color, kind, sortOrder }) => ({
      id,
      name,
      color,
      kind,
      sortOrder,
    })),
    week: {
      start: range.start,
      endInclusive: range.endInclusive,
      prevWeekStart: range.prevWeekStart,
      nextWeekStart: range.nextWeekStart,
      today: '2026-10-06',
    },
    days: [...days].reverse(),
    events,
  };
}

function makeBusyWeek(family: FamilyPublic, anchor: DateKey): BusyWeekResponse {
  const range = getWeekRange(anchor);
  const sat = addCalendarDays(range.start, 5);
  return {
    family: { id: family.id },
    week: {
      start: range.start,
      endInclusive: range.endInclusive,
      prevWeekStart: range.prevWeekStart,
      nextWeekStart: range.nextWeekStart,
      today: '2026-10-06',
    },
    members: [
      {
        memberId: family.members[0]?.id ?? ADULT_A,
        status: 'ready',
        busy: [{ start: `${sat}T10:00:00+09:00`, end: `${sat}T11:00:00+09:00` }],
      },
      {
        memberId: family.members[1]?.id ?? ADULT_B,
        status: 'ready',
        busy: [{ start: `${sat}T14:00:00+09:00`, end: `${sat}T15:00:00+09:00` }],
      },
    ],
  };
}

function makePersonalWeek(family: FamilyPublic, anchor: DateKey): PersonalWeekResponse {
  const week = makeWeek(anchor, family);
  const saturday = addCalendarDays(week.week.start, 5);
  return {
    family: { id: family.id },
    memberId: family.members[0]?.id ?? ADULT_A,
    week: week.week,
    status: 'ready',
    events: [
      {
        id: 'primary::self-synthetic-event',
        calendarId: 'primary',
        title: '本人だけの合成予定',
        time: {
          kind: 'timed',
          start: `${saturday}T18:00:00+09:00`,
          endExclusive: `${saturday}T19:00:00+09:00`,
        },
        isRoutine: false,
      },
    ],
  };
}

interface MockApiControl {
  delayEntered: Promise<void>;
  releaseDelay: () => void;
  setActiveAccount: (account: Account) => void;
  setAuthenticated: (value: boolean) => void;
  readonly createdEventCount: number;
  readonly busyFamilyRequests: string[];
}

async function mockWeekApis(page: Page, options: MockOptions = {}): Promise<MockApiControl> {
  let account: Account = 'A';
  let authenticated = true;
  let createdEventCount = 0;
  const busyFamilyRequests: string[] = [];
  let markDelayEntered!: () => void;
  let releaseDelay!: () => void;
  const delayEntered = new Promise<void>((resolve) => {
    markDelayEntered = resolve;
  });
  const delayGate = new Promise<void>((resolve) => {
    releaseDelay = resolve;
  });
  const getAccount = options.activeAccount ?? (() => account);

  await page.route('**/api/auth/me', async (route) => {
    if (!authenticated) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
      return;
    }
    const active = getAccount();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: active === 'A' ? A_USER : B_USER,
          email: active === 'A' ? 'a@example.test' : 'b@example.test',
          displayName: active === 'A' ? 'テスト利用者 A' : 'テスト利用者 B',
        },
      }),
    });
  });
  await page.route('**/api/families', async (route) => {
    const active = getAccount();
    const family = familyFixture(active, options.longNames);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ families: [family] }),
    });
  });
  await page.route('**/api/families/*/week**', async (route) => {
    const url = new URL(route.request().url());
    const requestFamilyId = url.pathname.split('/')[3] ?? FAMILY_A;
    const active = requestFamilyId === FAMILY_B ? 'B' : getAccount();
    const family = familyFixture(active, options.longNames);
    const anchor = (url.searchParams.get('start') ?? BASE_WEEK) as DateKey;
    if (url.pathname.endsWith('/week/busy')) {
      busyFamilyRequests.push(requestFamilyId);
      if (options.delayBusyStart === anchor) {
        markDelayEntered();
        await delayGate;
      }
      if (options.busyFailureStatus) {
        await route.fulfill({
          status: options.busyFailureStatus,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'INTERNAL_ERROR', error: 'synthetic busy error detail' }),
        });
        return;
      }
      const body = options.busyFactory
        ? options.busyFactory(family.id, anchor)
        : makeBusyWeek(family, anchor);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
      return;
    }
    if (url.pathname.endsWith('/week/personal')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makePersonalWeek(family, anchor)),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeWeek(anchor, family, options.unusualDay, options.conflictFixture)),
    });
  });
  await page.route('**/api/families/*/events', async (route) => {
    if (route.request().method() === 'POST') {
      createdEventCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ eventId: 'evt_created_synthetic' }),
      });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/auth/logout', async (route) => {
    authenticated = false;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  return {
    delayEntered,
    releaseDelay: () => releaseDelay(),
    setActiveAccount: (nextAccount) => {
      account = nextAccount;
    },
    setAuthenticated: (value) => {
      authenticated = value;
    },
    get createdEventCount() {
      return createdEventCount;
    },
    busyFamilyRequests,
  };
}

async function expectNoHorizontalOverflow(page: Page) {
  const width = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(width.document, JSON.stringify(width)).toBeLessThanOrEqual(width.viewport);
}

async function expectVisibleControlsAtLeast44px(page: Page) {
  const controls = page.locator('button:visible, a:visible, input:visible');
  for (const control of await controls.all()) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    if (bounds) {
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
  }
}

async function triggerVisibilityCycle(page: Page) {
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
}

test.describe('Task 2-5: weekend busy timeline', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Date.now = () => Date.parse('2026-10-06T12:00:00+09:00');
    });
  });

  test('keeps unusual-day cards compact, aligns add buttons, and wraps dense event content', async ({
    page,
  }) => {
    await mockWeekApis(page, { unusualDay: 'one-event' });
    await page.goto(`/?week=${BASE_WEEK}`);

    const expandedDay = page
      .getByTestId('week-day')
      .filter({ has: page.getByTestId('expanded-day-card') });
    const compactDay = page.getByTestId('week-day').filter({ hasText: '火曜のルーティン' });
    const card = expandedDay.getByTestId('expanded-day-card');
    const expandedAdd = expandedDay.getByTestId('add-event-2026-10-07');
    const compactAdd = compactDay.getByTestId('add-event-2026-10-06');
    await expect(card).toBeVisible();

    for (const width of [390, 445]) {
      await page.setViewportSize({ width, height: 844 });
      const cardBounds = await card.boundingBox();
      const expandedAddBounds = await expandedAdd.boundingBox();
      const compactAddBounds = await compactAdd.boundingBox();
      const eventButtonBounds = await page
        .getByTestId('edit-event-evt-weekday-exception')
        .boundingBox();
      expect(cardBounds).not.toBeNull();
      expect(expandedAddBounds).not.toBeNull();
      expect(compactAddBounds).not.toBeNull();
      expect(eventButtonBounds).not.toBeNull();
      expect(cardBounds?.height).toBeLessThanOrEqual(88);
      expect(
        Math.abs((expandedAddBounds?.x ?? 0) - (compactAddBounds?.x ?? 0)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          (expandedAddBounds?.x ?? 0) +
            (expandedAddBounds?.width ?? 0) -
            ((compactAddBounds?.x ?? 0) + (compactAddBounds?.width ?? 0)),
        ),
      ).toBeLessThanOrEqual(1);
      expect((cardBounds?.x ?? 0) + (cardBounds?.width ?? 0)).toBeLessThanOrEqual(
        expandedAddBounds?.x ?? 0,
      );
      expect(Math.abs((expandedAddBounds?.y ?? 0) - (cardBounds?.y ?? 0))).toBeLessThanOrEqual(1);
      expect(eventButtonBounds?.width).toBeGreaterThanOrEqual(44);
      expect(eventButtonBounds?.height).toBeGreaterThanOrEqual(44);
    }

    await expect(page.getByTestId('edit-event-evt-weekday-exception')).toHaveAccessibleDescription(
      /17:00.*18:00.*繰り返し.*時間変更/,
    );
    await page.getByTestId('edit-event-evt-weekday-exception').click();
    await expect(page.getByTestId('routine-event-notice')).toBeVisible();
    await expect(page.getByTestId('event-dialog')).toHaveCount(0);

    await mockWeekApis(page, { unusualDay: 'two-events' });
    await page.goto(`/?week=${BASE_WEEK}`);
    const twoEventDay = page
      .getByTestId('week-day')
      .filter({ has: page.getByTestId('expanded-day-card') });
    const twoEventCard = twoEventDay.getByTestId('expanded-day-card');
    await expect(twoEventCard).toBeVisible();
    for (const width of [390, 445]) {
      await page.setViewportSize({ width, height: 844 });
      const bounds = await twoEventCard.boundingBox();
      expect(bounds?.height).toBeLessThanOrEqual(150);
      const addBounds = await twoEventDay.getByTestId('add-event-2026-10-07').boundingBox();
      const compactBounds = await page
        .getByTestId('week-day')
        .filter({ hasText: '火曜のルーティン' })
        .getByTestId('add-event-2026-10-06')
        .boundingBox();
      expect(Math.abs((addBounds?.x ?? 0) - (compactBounds?.x ?? 0))).toBeLessThanOrEqual(1);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(addBounds?.x ?? 0);
    }
    await twoEventDay.getByTestId('edit-event-evt-weekday-oneoff').click();
    await expect(page.getByTestId('event-dialog')).toBeVisible();
    await expect(page.getByTestId('event-dialog').getByLabel('タイトル')).toHaveValue('保護者会');
    await page.getByRole('button', { name: '閉じる' }).click();

    await mockWeekApis(page, { unusualDay: 'dense-event' });
    await page.goto(`/?week=${BASE_WEEK}`);
    const denseDay = page
      .getByTestId('week-day')
      .filter({ has: page.getByTestId('expanded-day-card') });
    const denseCard = denseDay.getByTestId('expanded-day-card');
    await expect(denseCard.getByText('振替（10/6 から）')).toBeVisible();
    await expect(denseCard.getByText('担当 大人甲')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    for (const width of [390, 445]) {
      await page.setViewportSize({ width, height: 844 });
      await expectNoHorizontalOverflow(page);
      const longTitle = denseCard.getByText(
        `振替後のとても長い予定タイトル${'長い文字'.repeat(8)}`,
      );
      const titleBounds = await longTitle.boundingBox();
      const cardBounds = await denseCard.boundingBox();
      const metaBounds = await denseDay
        .getByTestId('expanded-event-meta-evt-weekday-exception')
        .boundingBox();
      const titleRowBounds = await denseDay
        .getByTestId('expanded-event-title-row-evt-weekday-exception')
        .boundingBox();
      expect(titleBounds?.x).toBeGreaterThanOrEqual(cardBounds?.x ?? 0);
      expect((titleBounds?.x ?? 0) + (titleBounds?.width ?? 0)).toBeLessThanOrEqual(
        (cardBounds?.x ?? 0) + (cardBounds?.width ?? 0),
      );
      expect(metaBounds).not.toBeNull();
      expect(titleRowBounds).not.toBeNull();
      expect(metaBounds?.x).toBeGreaterThanOrEqual(cardBounds?.x ?? 0);
      expect((metaBounds?.x ?? 0) + (metaBounds?.width ?? 0)).toBeLessThanOrEqual(
        (cardBounds?.x ?? 0) + (cardBounds?.width ?? 0),
      );
      expect(titleRowBounds?.x).toBeGreaterThanOrEqual(cardBounds?.x ?? 0);
      expect((titleRowBounds?.x ?? 0) + (titleRowBounds?.width ?? 0)).toBeLessThanOrEqual(
        (cardBounds?.x ?? 0) + (cardBounds?.width ?? 0),
      );
      expect((metaBounds?.y ?? 0) + (metaBounds?.height ?? 0)).toBeLessThanOrEqual(
        titleRowBounds?.y ?? 0,
      );
    }
  });

  test('renders ready member and child busy bars, common windows, routine calculation and screenshot', async ({
    page,
  }) => {
    const writeScreenshot = process.env.DANRAN_SCREENSHOTS === '1';
    await mockWeekApis(page, { conflictFixture: writeScreenshot });
    await page.goto(`/?week=${BASE_WEEK}`);

    await expect(page.getByTestId(`busy-timeline-${SATURDAY}`)).toBeVisible();
    const adultA = page.getByTestId(`busy-row-${SATURDAY}-${ADULT_A}`);
    const adultB = page.getByTestId(`busy-row-${SATURDAY}-${ADULT_B}`);
    const child = page.getByTestId(`busy-row-${SATURDAY}-${CHILD}`);
    await expect(adultA).toBeVisible();
    await expect(adultB).toBeVisible();
    await expect(child).toBeVisible();
    await expect(page.getByTestId(`busy-row-label-${SATURDAY}-${ADULT_A}`)).toHaveText(
      '大人甲：10:00–11:00、12:00–13:00 は予定あり',
    );
    await expect(page.getByTestId(`busy-row-label-${SATURDAY}-${ADULT_B}`)).toHaveText(
      '大人乙：12:00–13:00、14:00–15:00 は予定あり',
    );
    await expect(page.getByTestId(`busy-row-label-${SATURDAY}-${CHILD}`)).toHaveText(
      '子ども：12:00–13:00、16:00–17:00 は予定あり',
    );
    await expect(page.getByTestId(`busy-common-readout-${SATURDAY}`)).toHaveText(
      '共通の空き：08:00–10:00、11:00–12:00、13:00–14:00、15:00–16:00、17:00–20:00',
    );
    await expect(page.getByText('みんな空き 8時間', { exact: true })).toBeVisible();
    await expect(page.getByText('みんな空きなし', { exact: true })).toHaveCount(0);
    await expect(page.getByText('朝のルーティン', { exact: true })).toBeVisible();
    await expect(page.getByText('空き判定しない家事代行', { exact: true })).toBeVisible();
    await expect(page.getByText('家族の合成予定', { exact: true })).toBeVisible();
    await expect(page.getByText('本人だけの合成予定', { exact: true })).toBeVisible();
    if (writeScreenshot) {
      await expect(page.getByTestId('week-event-conflict-evt-weekday-exception')).toBeVisible();
      await expect(page.getByTestId('week-event-conflict-evt-weekday-oneoff')).toBeVisible();
      await expect(
        page.getByRole('button', { name: '予定を編集: 水曜へ振替した習い事、重複' }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: '予定を編集: 保護者会、重複' })).toBeVisible();
    }

    const commonReadout = page.getByTestId(`busy-common-readout-${SATURDAY}`);
    const commonBefore = await commonReadout.textContent();
    await page.getByRole('button', { name: 'ルーティンを隠す' }).click();
    await expect(page.getByText('朝のルーティン', { exact: true })).toHaveCount(0);
    await expect(commonReadout).toHaveText(commonBefore ?? '');
    await expect(adultA).toBeVisible();
    await expect(child).toBeVisible();
    await page.getByRole('button', { name: 'ルーティンを表示' }).click();
    await expect(page.getByText('朝のルーティン', { exact: true })).toBeVisible();

    await expect(page.getByTestId('busy-timeline-2026-10-07')).toHaveCount(0);
    await expect(page.getByTestId('busy-timeline-2026-10-11')).toBeVisible();
    await expect(page.getByTestId('busy-timeline-2026-10-12')).toBeVisible();
    await expect(
      page.getByTestId('week-day').filter({ hasText: '水曜へ振替した習い事' }),
    ).toHaveAttribute('data-layout', 'expanded');
    await expect(
      page.getByTestId('week-day').filter({ hasText: '火曜のルーティン' }),
    ).toHaveAttribute('data-layout', 'compact');
    await expect(page.getByText('振替（10/6 から）', { exact: true })).toBeVisible();
    await page.getByText('火曜のルーティン', { exact: true }).click();
    await expect(page.getByTestId('routine-event-notice')).toBeVisible();
    await expect(page.getByTestId('event-dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'ルーティンを隠す' }).click();
    await expect(page.getByText('火曜のルーティン', { exact: true })).toHaveCount(0);
    await expect(page.getByText('水曜へ振替した習い事', { exact: true })).toBeVisible();
    await page.getByText('水曜へ振替した習い事', { exact: true }).click();
    await expect(page.getByTestId('routine-event-notice')).toContainText(
      'この予定は繰り返し予定です。休み・振替は『繰り返し』タブで設定できます。',
    );
    await expect(page.getByTestId('event-dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'ルーティンを表示' }).click();
    await page.reload();
    await expect(page.getByText('水曜へ振替した習い事', { exact: true })).toBeVisible();
    await expect(page.getByText('火曜のルーティン', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 445, height: 844 });
    await expect(page.getByText('振替（10/6 から）', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page);
    await expectVisibleControlsAtLeast44px(page);
    if (process.env.DANRAN_SCREENSHOTS === '1') {
      const fullHeight = await page.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      );
      await page.setViewportSize({ width: 390, height: fullHeight + 100 });
      await page.screenshot({ path: 'docs/screenshots/s1-week-view.png', fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
    }
  });

  test('uses only family events for not-shared members and links only for the current member', async ({
    page,
  }) => {
    await mockWeekApis(page, {
      busyFactory: (id, anchor) => {
        const response = makeBusyWeek(familyFixture('A'), anchor);
        return {
          ...response,
          family: { id },
          members: [
            { memberId: ADULT_A, status: 'not_shared', busy: [] },
            {
              memberId: ADULT_B,
              status: 'ready',
              busy: response.members[1]?.busy ?? [],
            },
          ],
        };
      },
    });
    await page.goto(`/?week=${BASE_WEEK}`);

    const unsharedRow = page.getByTestId(`busy-row-${SATURDAY}-${ADULT_A}`);
    await expect(unsharedRow).toBeVisible();
    await expect(page.getByTestId(`busy-not-shared-${SATURDAY}-${ADULT_A}`)).toContainText(
      '個人の予定は未共有',
    );
    await expect(
      page.getByTestId(`busy-not-shared-${SATURDAY}-${ADULT_A}`).getByRole('link', {
        name: '家族タブで空き状況の共有を設定',
      }),
    ).toHaveAttribute('href', '/family');
    await expect(page.getByTestId(`busy-row-label-${SATURDAY}-${ADULT_A}`)).toContainText(
      '大人甲：12:00–13:00 は予定あり',
    );
    await expect(page.getByTestId(`busy-common-row-${SATURDAY}`)).toBeVisible();
    await expect(page.getByTestId(`busy-not-shared-summary-${SATURDAY}`)).toBeVisible();

    const otherMemberRow = page.getByTestId(`busy-row-${SATURDAY}-${ADULT_B}`);
    await expect(
      otherMemberRow.getByRole('link', { name: '家族タブで空き状況の共有を設定' }),
    ).toHaveCount(0);
  });

  test('does not show a family-page link on a different member row when account B is current', async ({
    page,
  }) => {
    await mockWeekApis(page, {
      activeAccount: () => 'B',
      busyFactory: (id, anchor) => {
        const response = makeBusyWeek(familyFixture('B'), anchor);
        return {
          ...response,
          family: { id },
          members: [
            { memberId: ADULT_B, status: 'not_shared', busy: [] },
            { memberId: ADULT_A, status: 'not_shared', busy: [] },
          ],
        };
      },
    });
    await page.goto(`/?week=${BASE_WEEK}`);

    const selfLink = page.getByTestId(`busy-not-shared-${SATURDAY}-${ADULT_B}`).getByRole('link', {
      name: '家族タブで空き状況の共有を設定',
    });
    await expect(selfLink).toHaveAttribute('href', '/family');
    await expect(
      page.getByTestId(`busy-not-shared-${SATURDAY}-${ADULT_A}`).getByRole('link', {
        name: '家族タブで空き状況の共有を設定',
      }),
    ).toHaveCount(0);
  });

  test('does not treat unavailable busy as free or show a common window', async ({ page }) => {
    await mockWeekApis(page, {
      busyFactory: (id, anchor) => {
        const response = makeBusyWeek(familyFixture('A'), anchor);
        return {
          ...response,
          family: { id },
          members: [response.members[0], { memberId: ADULT_B, status: 'unavailable', busy: [] }],
        };
      },
    });
    await page.goto(`/?week=${BASE_WEEK}`);

    await expect(page.getByTestId(`busy-unavailable-${SATURDAY}-${ADULT_B}`)).toHaveText(
      '取得できませんでした',
    );
    await expect(page.getByTestId(`busy-segment-${SATURDAY}-${ADULT_B}-0`)).toHaveCount(0);
    await expect(page.getByTestId(`busy-common-row-${SATURDAY}`)).toHaveCount(0);
    await expect(page.getByText('みんな空き 8時間', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId(`busy-unavailable-summary-${SATURDAY}`)).toContainText(
      '共通の空きは表示していません',
    );
    await expect(page.getByText('家族の合成予定', { exact: true })).toBeVisible();
    await expect(page.getByText('本人だけの合成予定', { exact: true })).toBeVisible();
  });

  test('busy failure or delay stays local while family/personal events and event creation work', async ({
    page,
  }) => {
    const api = await mockWeekApis(page, {
      busyFailureStatus: 500,
      delayBusyStart: BASE_WEEK,
    });
    await page.goto(`/?week=${BASE_WEEK}`);
    await api.delayEntered;
    await expect(page.getByTestId(`busy-loading-${SATURDAY}`)).toBeVisible();
    await expect(page.getByText('家族の合成予定', { exact: true })).toBeVisible();
    await expect(page.getByText('本人だけの合成予定', { exact: true })).toBeVisible();
    await page.getByTestId(`add-event-${SATURDAY}`).click();
    const dialog = page.getByTestId('event-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('タイトル').fill('busy失敗中の追加予定');
    await dialog.getByLabel('開始時刻').fill('09:00');
    await dialog.getByLabel('終了時刻').fill('10:00');
    await dialog.getByTestId('save-event').click();
    await expect(dialog).toHaveCount(0);
    expect(api.createdEventCount).toBe(1);

    api.releaseDelay();
    await expect(page.getByTestId(`busy-error-${SATURDAY}`)).toHaveText(
      '空き状況を読み込めませんでした。',
    );
    await expect(page.getByText('家族の合成予定', { exact: true })).toBeVisible();
    await expect(page.getByText('本人だけの合成予定', { exact: true })).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('synthetic busy error detail');
  });

  test('rejects busy metadata without rendering private calendar and event details', async ({
    page,
  }) => {
    await mockWeekApis(page, {
      longNames: true,
      busyFactory: (id, anchor) => ({
        ...makeBusyWeek(familyFixture('A', true), anchor),
        family: { id },
        privateCalendarName: 'leaked-calendar-name@example.test',
        members: makeBusyWeek(familyFixture('A', true), anchor).members.map((member) => ({
          ...member,
          privateCalendarId: 'secret-calendar-id@example.test',
          privateTitle: 'secret-personal-title',
        })),
      }),
    });
    await page.goto(`/?week=${BASE_WEEK}`);
    await expect(page.getByTestId(`busy-error-${SATURDAY}`)).toBeVisible();
    const text = await page.locator('body').innerText();
    expect(text).not.toContain('leaked-calendar-name@example.test');
    expect(text).not.toContain('secret-calendar-id@example.test');
    expect(text).not.toContain('secret-personal-title');
    await expectNoHorizontalOverflow(page);
  });

  test('keeps timeline bars wide with long member names at 390px and 445px', async ({ page }) => {
    await mockWeekApis(page, { longNames: true });
    await page.goto(`/?week=${BASE_WEEK}`);
    const row = page.getByTestId(`busy-row-${SATURDAY}-${ADULT_A}`);
    await expect(row).toBeVisible();
    const track = row.locator('div[aria-hidden="true"]');
    const segment = page.getByTestId(`busy-segment-${SATURDAY}-${ADULT_A}-0`);
    await expect(segment).toBeAttached();
    let [trackBounds, segmentBounds] = await Promise.all([
      track.boundingBox(),
      segment.boundingBox(),
    ]);
    expect(trackBounds?.width).toBeGreaterThanOrEqual(140);
    expect(segmentBounds?.width).toBeGreaterThan(0);
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 445, height: 844 });
    await expectNoHorizontalOverflow(page);
    [trackBounds, segmentBounds] = await Promise.all([track.boundingBox(), segment.boundingBox()]);
    expect(trackBounds?.width).toBeGreaterThanOrEqual(140);
    expect(segmentBounds?.width).toBeGreaterThan(0);
  });

  test('does not show a prior week busy response after navigation and clears it on account switch', async ({
    page,
  }) => {
    const api = await mockWeekApis(page, {
      delayBusyStart: '2026-10-12' as DateKey,
      busyFactory: (id, anchor) => {
        const response = makeBusyWeek(familyFixture(id === FAMILY_B ? 'B' : 'A'), anchor);
        const sat = addCalendarDays(getWeekRange(anchor).start, 5);
        const startTime =
          anchor === '2026-10-12' ? '08:00' : anchor === '2026-10-19' ? '19:00' : '10:00';
        const endTime =
          anchor === '2026-10-12' ? '09:00' : anchor === '2026-10-19' ? '20:00' : '11:00';
        if (id === FAMILY_B) {
          return {
            ...response,
            family: { id },
            members: [
              {
                memberId: ADULT_B,
                status: 'ready',
                busy: [{ start: `${sat}T17:00:00+09:00`, end: `${sat}T18:00:00+09:00` }],
              },
              { memberId: ADULT_A, status: 'ready', busy: [] },
            ],
          };
        }
        return {
          ...response,
          family: { id },
          members: [
            {
              memberId: ADULT_A,
              status: 'ready',
              busy: [{ start: `${sat}T${startTime}:00+09:00`, end: `${sat}T${endTime}:00+09:00` }],
            },
            { memberId: ADULT_B, status: 'ready', busy: [] },
          ],
        };
      },
    });
    await page.goto(`/?week=${BASE_WEEK}`);
    await expect(page.getByTestId(`busy-row-label-${SATURDAY}-${ADULT_A}`)).toContainText(
      '10:00–11:00',
    );

    await page.getByRole('button', { name: '次の週' }).click();
    await expect(page).toHaveURL(/week=2026-10-12/);
    await api.delayEntered;
    await page.getByRole('button', { name: '次の週' }).click();
    await expect(page).toHaveURL(/week=2026-10-19/);
    const currentSaturday = '2026-10-24';
    await expect(page.getByTestId(`busy-row-label-${currentSaturday}-${ADULT_A}`)).toContainText(
      '19:00–20:00',
    );
    api.releaseDelay();
    await expect(page.getByTestId(`busy-row-label-${currentSaturday}-${ADULT_A}`)).toContainText(
      '19:00–20:00',
    );
    await expect(page.getByTestId('busy-timeline-2026-10-17')).toHaveCount(0);

    api.setActiveAccount('B');
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes('/api/auth/me') && response.status() === 200,
      ),
      triggerVisibilityCycle(page),
    ]);
    await expect(page.getByText('空き時間サンプル家 B', { exact: true })).toBeVisible();
    await expect(page.getByText('空き時間サンプル家 A', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('busy-timeline-2026-10-10')).toHaveCount(0);
    await expect(page.getByTestId('busy-row-label-2026-10-24-mem_busy_b')).toContainText(
      '17:00–18:00',
    );
    await expect(page.getByTestId('busy-row-label-2026-10-24-mem_busy_a')).toContainText(
      '12:00–13:00',
    );
    await expect(page.getByTestId('busy-row-label-2026-10-24-mem_busy_a')).not.toContainText(
      '10:00–11:00',
    );
    expect(api.busyFamilyRequests).toContain(FAMILY_B);
  });

  test('logout clears busy before a new account fetches its own week', async ({ page }) => {
    const api = await mockWeekApis(page, {
      busyFactory: (id, anchor) => {
        const response = makeBusyWeek(familyFixture(id === FAMILY_B ? 'B' : 'A'), anchor);
        if (id !== FAMILY_B) return response;
        const sat = addCalendarDays(getWeekRange(anchor).start, 5);
        return {
          ...response,
          family: { id },
          members: [
            {
              memberId: ADULT_B,
              status: 'ready',
              busy: [{ start: `${sat}T17:00:00+09:00`, end: `${sat}T18:00:00+09:00` }],
            },
            { memberId: ADULT_A, status: 'ready', busy: [] },
          ],
        };
      },
    });
    await page.goto(`/?week=${BASE_WEEK}`);
    await expect(page.getByTestId(`busy-timeline-${SATURDAY}`)).toBeVisible();
    await page.getByRole('link', { name: '家族', exact: true }).click();
    await expect(page.locator('[data-testid="logout-button"]')).toBeVisible();
    await page.locator('[data-testid="logout-button"]').click();
    await expect(page.getByTestId('login-button')).toBeVisible();
    await expect(page.locator('[data-testid="logout-button"]')).toHaveCount(0);

    api.setActiveAccount('B');
    api.setAuthenticated(true);
    const priorBRequests = api.busyFamilyRequests.filter(
      (requestedFamily) => requestedFamily === FAMILY_B,
    ).length;
    await triggerVisibilityCycle(page);
    await expect(page.getByTestId('user-display-name')).toHaveText('テスト利用者 B');
    await page.getByRole('link', { name: '週', exact: true }).click();
    await expect(page.getByTestId(`busy-timeline-${SATURDAY}`)).toBeVisible();
    await expect(page.getByTestId(`busy-row-label-${SATURDAY}-${ADULT_B}`)).toContainText(
      '17:00–18:00',
    );
    await expect(page.getByText('空き時間サンプル家 B', { exact: true })).toBeVisible();
    expect(
      api.busyFamilyRequests.filter((requestedFamily) => requestedFamily === FAMILY_B).length,
    ).toBeGreaterThan(priorBRequests);
    await expect(page.getByTestId(`busy-row-label-${SATURDAY}-${ADULT_A}`)).toContainText(
      '12:00–13:00',
    );
    await expect(page.getByTestId(`busy-row-label-${SATURDAY}-${ADULT_A}`)).not.toContainText(
      '14:00–15:00',
    );
  });
});
