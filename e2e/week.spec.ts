import { expect, test } from '@playwright/test';
import type { DateKey } from '../src/shared/schemas/date';
import { type WeekResponse, weekResponseSchema } from '../src/shared/schemas/week';
import { addCalendarDays, getWeekday } from '../src/shared/time/date';
import { getWeekRange } from '../src/shared/time/week';

test.use({
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  timezoneId: 'UTC',
});

const FAMILY_ID = 'fam_synthetic';
const BASE_WEEK = '2026-10-05' as DateKey;
const LONG_FAMILY_NAME = 'F'.repeat(80);
const members = [
  {
    id: 'mem_adult_a',
    name: 'メンバー甲',
    color: 'indigo' as const,
    kind: 'adult' as const,
    sortOrder: 0,
  },
  {
    id: 'mem_adult_b',
    name: 'メンバー乙',
    color: 'green' as const,
    kind: 'adult' as const,
    sortOrder: 1,
  },
  {
    id: 'mem_child',
    name: 'メンバー丙',
    color: 'ochre' as const,
    kind: 'child' as const,
    sortOrder: 2,
  },
];

function buildWeek(anchor: DateKey): WeekResponse {
  const range = getWeekRange(anchor);
  const baseEvents: WeekResponse['events'] =
    anchor === BASE_WEEK
      ? [
          {
            id: 'evt_routine',
            title: '朝の支度',
            time: {
              kind: 'timed',
              start: `${addCalendarDays(anchor, 0)}T07:30:00+09:00`,
              endExclusive: `${addCalendarDays(anchor, 0)}T08:00:00+09:00`,
            },
            memberIds: ['mem_child'],
            assigneeMemberId: 'mem_adult_a',
            status: 'confirmed',
            isRoutine: true,
            isRecurring: true,
            movedFrom: null,
            affectsAvailability: true,
            source: 'manual',
            items: [],
          },
          {
            id: 'evt_outing',
            title: '公園ピクニック',
            time: {
              kind: 'timed',
              start: `${addCalendarDays(anchor, 2)}T10:00:00+09:00`,
              endExclusive: `${addCalendarDays(anchor, 2)}T12:00:00+09:00`,
            },
            memberIds: ['mem_adult_a', 'mem_child'],
            assigneeMemberId: 'mem_adult_b',
            status: 'tentative',
            isRoutine: false,
            isRecurring: false,
            movedFrom: null,
            affectsAvailability: true,
            source: 'manual',
            items: ['水筒', '敷物'],
          },
          {
            id: 'evt_published_personal',
            title: '公開済みの予定サンプル',
            time: {
              kind: 'timed',
              start: `${addCalendarDays(anchor, 3)}T13:00:00+09:00`,
              endExclusive: `${addCalendarDays(anchor, 3)}T14:00:00+09:00`,
            },
            memberIds: ['mem_adult_a'],
            assigneeMemberId: null,
            status: 'confirmed',
            isRoutine: false,
            isRecurring: false,
            movedFrom: null,
            affectsAvailability: true,
            source: 'publish',
            items: [],
          },
          {
            id: 'evt_import',
            title: '取り込み予定',
            time: {
              kind: 'timed',
              start: `${addCalendarDays(anchor, 4)}T15:00:00+09:00`,
              endExclusive: `${addCalendarDays(anchor, 4)}T16:00:00+09:00`,
            },
            memberIds: ['mem_child'],
            assigneeMemberId: null,
            status: 'confirmed',
            isRoutine: false,
            isRecurring: false,
            movedFrom: null,
            affectsAvailability: true,
            source: 'import',
            items: ['申込書'],
          },
          {
            id: 'evt_club',
            title: '工作クラブ',
            time: {
              kind: 'timed',
              start: `${addCalendarDays(anchor, 5)}T09:00:00+09:00`,
              endExclusive: `${addCalendarDays(anchor, 5)}T10:00:00+09:00`,
            },
            memberIds: ['mem_child'],
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
            id: 'evt_all_day',
            title: '秋の行事',
            time: {
              kind: 'all-day',
              start: addCalendarDays(anchor, 5),
              endExclusive: addCalendarDays(anchor, 6),
            },
            memberIds: [],
            assigneeMemberId: null,
            status: 'confirmed',
            isRoutine: false,
            isRecurring: false,
            movedFrom: null,
            affectsAvailability: true,
            source: 'external',
            items: [],
          },
          {
            id: 'evt_overnight',
            title: '家族で宿泊',
            time: {
              kind: 'all-day',
              start: addCalendarDays(anchor, 5),
              endExclusive: addCalendarDays(anchor, 7),
            },
            memberIds: ['mem_adult_a', 'mem_adult_b', 'mem_child'],
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
            id: 'evt_midnight_end',
            title: '夜の予定',
            time: {
              kind: 'timed',
              start: `${addCalendarDays(anchor, 5)}T22:00:00+09:00`,
              endExclusive: `${addCalendarDays(anchor, 6)}T00:00:00+09:00`,
            },
            memberIds: ['mem_adult_b'],
            assigneeMemberId: null,
            status: 'confirmed',
            isRoutine: false,
            isRecurring: false,
            movedFrom: null,
            affectsAvailability: true,
            source: 'manual',
            items: [],
          },
        ]
      : [];
  const events = weekResponseSchema.shape.events.parse(baseEvents);
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
    const isHoliday = date === '2026-10-12';
    const weekend = weekday === 0 || weekday === 6 || isHoliday;
    return {
      date,
      weekday,
      holidayName: isHoliday ? 'スポーツの日' : null,
      closures: date === '2026-10-12' ? [{ label: '施設休み', memberIds: ['mem_child'] }] : [],
      layout: weekend
        ? ('weekend-card' as const)
        : dayEvents.some((event) => !event.isRoutine)
          ? ('expanded' as const)
          : ('compact' as const),
      eventIds: dayEvents.map((event) => event.id),
    };
  });
  return weekResponseSchema.parse({
    family: { id: FAMILY_ID, name: 'サンプル家' },
    members,
    week: {
      start: range.start,
      endInclusive: range.endInclusive,
      prevWeekStart: range.prevWeekStart,
      nextWeekStart: range.nextWeekStart,
      today: '2026-10-07',
    },
    days: [...days].reverse(),
    events,
  });
}

function buildLongContentWeek(anchor: DateKey): WeekResponse {
  const week = buildWeek(anchor);
  return weekResponseSchema.parse({
    ...week,
    family: { ...week.family, name: LONG_FAMILY_NAME },
    members: week.members.map((member, index) => ({
      ...member,
      name: `Member${index}${'M'.repeat(60)}`,
    })),
    events: week.events.map((event) => ({
      ...event,
      title: event.id === 'evt_outing' ? `LongEvent${'T'.repeat(100)}` : event.title,
      items: event.id === 'evt_outing' ? [`LongItem${'I'.repeat(80)}`] : event.items,
    })),
    days: week.days.map((day) => ({
      ...day,
      closures: day.closures.map((closure) => ({
        ...closure,
        label: `LongClosure${'C'.repeat(80)}`,
      })),
    })),
  });
}

async function mockWeekApis(
  page: import('@playwright/test').Page,
  options: {
    mode?: 'ready' | 'empty' | 'unauth';
    apiError?: { status: number; code: string; error?: string };
    malformed?: boolean;
    longContent?: boolean;
  } = {},
) {
  const mode = options.mode ?? 'ready';
  let familyCalls = 0;
  const weekRequests: string[] = [];
  await page.route('**/api/auth/me', async (route) => {
    if (mode === 'unauth') {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'usr_synthetic', email: 'private@example.test', displayName: 'テスト利用者' },
      }),
    });
  });
  await page.route('**/api/families', async (route) => {
    familyCalls++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        families:
          mode === 'ready'
            ? [
                {
                  id: FAMILY_ID,
                  name: options.longContent ? LONG_FAMILY_NAME : 'サンプル家',
                  familyCalendarId: 'cal_synthetic',
                  ownerUserId: 'usr_synthetic',
                  creationStatus: 'ready',
                  members: [],
                },
              ]
            : [],
      }),
    });
  });
  await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) => {
    const url = new URL(route.request().url());
    weekRequests.push(url.searchParams.get('start') ?? 'missing');
    if (url.pathname.endsWith('/week/personal')) {
      const anchor = (url.searchParams.get('start') ?? BASE_WEEK) as DateKey;
      const familyWeek = buildWeek(anchor);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          family: { id: FAMILY_ID },
          memberId: 'mem_synthetic_self',
          week: familyWeek.week,
          status: 'authorization_required',
          events: [],
        }),
      });
      return;
    }
    if (options.apiError) {
      await route.fulfill({
        status: options.apiError.status,
        contentType: 'application/json',
        body: JSON.stringify({
          code: options.apiError.code,
          error: options.apiError.error ?? 'private Google response must never be rendered',
        }),
      });
      return;
    }
    if (options.malformed) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ family: { id: FAMILY_ID }, events: 'not-an-array' }),
      });
      return;
    }
    const requested = url.searchParams.get('start') as DateKey | null;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        options.longContent
          ? buildLongContentWeek(requested ?? BASE_WEEK)
          : buildWeek(requested ?? BASE_WEEK),
      ),
    });
  });
  await page.route(`**/api/families/${FAMILY_ID}/personal-calendars`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'authorization_required',
        memberId: 'mem_synthetic_self',
        calendars: [],
      }),
    }),
  );
  await page.route(`**/api/families/${FAMILY_ID}/busy-calendars`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'authorization_required',
        memberId: 'mem_synthetic_self',
        calendars: [],
      }),
    }),
  );
  return {
    get familyCalls() {
      return familyCalls;
    },
    weekRequests,
  };
}

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const metrics = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const offenders = [...document.querySelectorAll('body *')]
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === 'string' ? element.className : '',
          text: element.textContent?.trim().slice(0, 100) ?? '',
          left: Math.round(bounds.left),
          right: Math.round(bounds.right),
          width: Math.round(bounds.width),
        };
      })
      .filter((item) => item.width > 0 && (item.left < -1 || item.right > viewportWidth + 1))
      .sort((left, right) => right.right - left.right)
      .slice(0, 10);
    return {
      viewportWidth,
      documentWidth: document.documentElement.scrollWidth,
      offenders,
    };
  });
  expect(
    metrics.documentWidth,
    `Horizontal overflow: ${JSON.stringify(metrics)}`,
  ).toBeLessThanOrEqual(metrics.viewportWidth);
}

async function expectControlsAtLeast44px(page: import('@playwright/test').Page) {
  const controls = page.locator('button:visible, a:visible, input:visible');
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    expect(
      box,
      `visible control ${(await control.getAttribute('aria-label')) ?? (await control.textContent())}`,
    ).not.toBeNull();
    if (box) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
  }
}

async function triggerVisibilityCycle(page: import('@playwright/test').Page) {
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

test.describe('Task 1-7: S1 week view', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // Keep the native Date constructor intact for timezone-aware subclasses such as TZDate.
      const fixedNow = Date.parse('2026-10-07T12:00:00+09:00');
      Date.now = () => fixedNow;
    });
  });

  test('renders synthetic family week, compact routines, expanded events, long weekend, holiday and qualifiers', async ({
    page,
  }) => {
    await mockWeekApis(page);
    await page.goto('/');
    await expect(page.locator('[data-testid="home-screen"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: '10/5 – 10/12' })).toBeVisible();
    await expect(page.getByText('2026年10月')).toBeVisible();
    const legend = page.getByRole('list', { name: 'メンバー' });
    const legendColors = await Promise.all(
      ['メンバー甲', 'メンバー乙', 'メンバー丙'].map(async (name) => {
        const entry = legend.getByText(name, { exact: true });
        await expect(entry).toBeVisible();
        return entry
          .locator('..')
          .locator('[aria-hidden="true"]')
          .evaluate((element) => getComputedStyle(element).backgroundColor);
      }),
    );
    expect(new Set(legendColors).size).toBe(3);
    const compactDates = await page
      .locator('[data-testid="week-day"][data-layout="compact"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-date')));
    expect(compactDates).toEqual([...compactDates].sort());
    const emptyTuesday = page.locator('[data-testid="week-day"][data-date="2026-10-06"]');
    await expect(emptyTuesday).toHaveAttribute('data-layout', 'compact');
    await expect(emptyTuesday.locator('h3').getByText('6', { exact: true })).toBeVisible();
    const emptyDescription = emptyTuesday.getByText('予定なし', { exact: true });
    await expect(emptyDescription).toHaveClass(/sr-only/);
    const emptyDescriptionBox = await emptyDescription.boundingBox();
    expect(emptyDescriptionBox?.width).toBeLessThanOrEqual(1);
    expect(emptyDescriptionBox?.height).toBeLessThanOrEqual(1);
    const mondayRowHeight = (
      await page.locator('[data-testid="week-day"][data-date="2026-10-05"]').boundingBox()
    )?.height;
    const emptyRowHeight = (await emptyTuesday.boundingBox())?.height;
    expect(mondayRowHeight).toBeDefined();
    expect(emptyRowHeight).toBeDefined();
    if (mondayRowHeight !== undefined && emptyRowHeight !== undefined)
      expect(emptyRowHeight).toBeLessThan(mondayRowHeight);
    const emptyDayAddButton = emptyTuesday.locator('button[data-testid="add-event-2026-10-06"]');
    await expect(emptyDayAddButton).toHaveAttribute('aria-label', '10月6日に予定を追加');
    await expect(emptyDayAddButton).toHaveText('');
    await expect(emptyDayAddButton.locator('svg')).toHaveCount(1);
    const emptyDayAddBounds = await emptyDayAddButton.boundingBox();
    expect(emptyDayAddBounds?.width).toBeGreaterThanOrEqual(44);
    expect(emptyDayAddBounds?.height).toBeGreaterThanOrEqual(44);
    const emptyDayAddStyle = await emptyDayAddButton.evaluate((button) => ({
      borderWidth: getComputedStyle(button).borderTopWidth,
      backgroundColor: getComputedStyle(button).backgroundColor,
    }));
    expect(emptyDayAddStyle).toEqual({ borderWidth: '0px', backgroundColor: 'rgba(0, 0, 0, 0)' });
    const weekendDates = await page
      .locator('[data-testid="week-day"][data-layout="weekend-card"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-date')));
    expect(weekendDates).toEqual([...weekendDates].sort());
    await expect(page.getByText('朝の支度')).toBeVisible();
    await expect(page.getByText('朝の支度').locator('..')).toHaveClass(/bg-chip/);
    await expect(page.getByText('公園ピクニック')).toBeVisible();
    await expect(page.getByText('公開済みの予定サンプル')).toBeVisible();
    await expect(page.getByText('取り込み予定')).toBeVisible();
    await expect(page.getByText('水筒')).toBeVisible();
    await expect(page.getByText('敷物')).toBeVisible();
    await expect(page.getByText('施設休み')).toBeVisible();
    await expect(page.getByText('スポーツの日')).toBeVisible();
    await expect(page.getByText('3連休')).toBeVisible();
    await expect(page.getByText('候補')).toBeVisible();
    const navigation = page.getByRole('navigation', { name: 'メインナビゲーション' });
    await expect(navigation.getByRole('link', { name: /繰り返し/ })).toBeVisible();
    await expect(page.getByText('担当 メンバー乙').first()).toBeVisible();
    await expect(page.getByText('秋の行事')).toBeVisible();
    const saturdayCard = page.locator('[data-testid="week-day"][data-date="2026-10-10"]');
    const sundayCard = page.locator('[data-testid="week-day"][data-date="2026-10-11"]');
    await expect(saturdayCard.getByTestId('week-event-conflict-evt_club')).toBeVisible();
    await expect(saturdayCard.getByTestId('week-event-conflict-evt_all_day')).toBeVisible();
    await expect(
      saturdayCard.getByRole('button', { name: '予定を編集: 工作クラブ、重複' }),
    ).toBeVisible();
    await expect(
      saturdayCard.getByRole('button', { name: '予定を編集: 秋の行事、重複' }),
    ).toBeVisible();
    await expect(page.getByTestId('week-event-conflict-evt_outing')).toHaveCount(0);
    await expect(page.getByTestId('week-event-conflict-evt_import')).toHaveCount(0);
    const saturdayAddButton = saturdayCard.locator('button[data-testid="add-event-2026-10-10"]');
    await expect(saturdayAddButton).toHaveAttribute('aria-label', '10月10日に予定を追加');
    await expect(saturdayAddButton).toHaveText('');
    await expect(saturdayAddButton.locator('svg')).toHaveCount(1);
    const longWeekendBadge = saturdayCard.getByText('3連休', { exact: true });
    const [longWeekendBounds, saturdayAddBounds, saturdayCardBounds] = await Promise.all([
      longWeekendBadge.boundingBox(),
      saturdayAddButton.boundingBox(),
      saturdayCard.boundingBox(),
    ]);
    expect(longWeekendBounds?.x).toBeDefined();
    expect(saturdayAddBounds?.x).toBeDefined();
    if (longWeekendBounds && saturdayAddBounds && saturdayCardBounds) {
      expect(longWeekendBounds.x).toBeLessThan(saturdayAddBounds.x);
      expect(saturdayAddBounds.x + saturdayAddBounds.width).toBeLessThanOrEqual(
        saturdayCardBounds.x + saturdayCardBounds.width,
      );
    }
    await expect(saturdayCard.getByText('家族で宿泊', { exact: true })).toBeVisible();
    await expect(sundayCard.getByText('家族で宿泊', { exact: true })).toBeVisible();
    await expect(saturdayCard.getByText('繰り返し', { exact: true })).toBeVisible();
    const externalEventContent = saturdayCard
      .getByText('秋の行事', { exact: true })
      .locator('..')
      .locator('..');
    await expect(externalEventContent.locator('[aria-hidden="true"]')).toHaveCount(1);
    await expect(page.getByText('夜の予定')).toBeVisible();
    await expect(page.getByText('夜の予定')).toHaveCount(1);
    await expect(page.getByText('終日（10/10〜10/11）')).toHaveCount(2);
    await expect(page.getByText('22:00–10/11 00:00')).toBeVisible();
    await expect(navigation.getByRole('link', { name: /やること/ })).toBeVisible();
    const preparingCaptions = navigation.getByText('準備中', { exact: true });
    await expect(preparingCaptions).toHaveCount(1);
    for (const caption of await preparingCaptions.all()) {
      const box = await caption.boundingBox();
      expect(box).not.toBeNull();
      if (box) expect(box.y + box.height).toBeLessThanOrEqual(844);
    }
    await expect(page.getByRole('button', { name: '予定を追加', exact: true })).toBeVisible();
    await expect(page.locator('button[data-testid^="add-event-"]')).toHaveCount(8);
    await expect(page.getByText(/予定を立てる/)).toHaveCount(0);
    await expect(
      page.getByText(/みんな空き|予定あり|自分だけ|空き時間から探す|添付写真/),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectControlsAtLeast44px(page);
  });

  test('long synthetic names and event details wrap without horizontal overflow at 390px', async ({
    page,
  }) => {
    await mockWeekApis(page, { longContent: true });
    await page.goto('/?week=2026-10-05');

    await expect(page.getByText(`LongEvent${'T'.repeat(100)}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`LongItem${'I'.repeat(80)}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`LongClosure${'C'.repeat(80)}`, { exact: true })).toBeVisible();
    const legend = page.getByRole('list', { name: 'メンバー' });
    await expect(legend.getByText(`Member1${'M'.repeat(60)}`, { exact: true })).toBeVisible();
    await expect(page.getByText(LONG_FAMILY_NAME, { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectControlsAtLeast44px(page);
  });

  test('keeps adjacent empty compact rows at 44px with separate add-button hit areas', async ({
    page,
  }) => {
    await mockWeekApis(page);
    await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) => {
      const requested = new URL(route.request().url()).searchParams.get('start') as DateKey | null;
      const week = buildWeek(requested ?? BASE_WEEK);
      const emptyDates = new Set<DateKey>(['2026-10-08', '2026-10-09']);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...week,
          days: week.days.map((day) =>
            emptyDates.has(day.date) ? { ...day, layout: 'compact', eventIds: [] } : day,
          ),
        }),
      });
    });
    await page.goto('/?week=2026-10-05');

    const thursday = page.locator('[data-testid="week-day"][data-date="2026-10-08"]');
    const friday = page.locator('[data-testid="week-day"][data-date="2026-10-09"]');
    await expect(thursday).toHaveAttribute('data-layout', 'compact');
    await expect(friday).toHaveAttribute('data-layout', 'compact');
    const [thursdayRow, fridayRow, thursdayAdd, fridayAdd] = await Promise.all([
      thursday.boundingBox(),
      friday.boundingBox(),
      page.getByTestId('add-event-2026-10-08').boundingBox(),
      page.getByTestId('add-event-2026-10-09').boundingBox(),
    ]);
    expect(thursdayRow).not.toBeNull();
    expect(fridayRow).not.toBeNull();
    expect(thursdayAdd).not.toBeNull();
    expect(fridayAdd).not.toBeNull();
    if (thursdayRow && fridayRow && thursdayAdd && fridayAdd) {
      expect(Math.abs(thursdayRow.height - 44)).toBeLessThanOrEqual(1);
      expect(Math.abs(fridayRow.height - 44)).toBeLessThanOrEqual(1);
      for (const target of [thursdayAdd, fridayAdd]) {
        expect(target.width).toBeGreaterThanOrEqual(44);
        expect(target.height).toBeGreaterThanOrEqual(44);
      }
      expect(thursdayAdd.y + thursdayAdd.height).toBeLessThanOrEqual(fridayAdd.y + 0.5);
    }
  });

  test('uses viewport width at 445px and centers the shared max width on a wide viewport', async ({
    page,
  }) => {
    await mockWeekApis(page);
    await page.setViewportSize({ width: 445, height: 844 });
    await page.goto('/?week=2026-10-05');

    const main = page.getByRole('main');
    await expect(page.getByRole('heading', { name: '10/5 – 10/12' })).toBeVisible();
    await expect(main).toBeVisible();
    const main445 = await main.boundingBox();
    expect(main445).not.toBeNull();
    if (main445) {
      expect(main445.x).toBe(0);
      expect(main445.width).toBe(445);
    }
    const navigation = page.getByRole('navigation', { name: 'メインナビゲーション' });
    const nav445 = await navigation.boundingBox();
    expect(nav445).not.toBeNull();
    if (nav445) {
      expect(nav445.x).toBe(0);
      expect(nav445.width).toBe(445);
    }
    const navInner = navigation.locator('div.mx-auto');
    const navInner445 = await navInner.boundingBox();
    expect(navInner445?.width).toBe(445);
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 1024, height: 844 });
    const mainWide = await main.boundingBox();
    expect(mainWide).not.toBeNull();
    if (mainWide) {
      expect(mainWide.width).toBe(480);
      expect(mainWide.x).toBe(272);
    }
    const navWide = await navigation.boundingBox();
    expect(navWide).not.toBeNull();
    if (navWide) {
      expect(navWide.x).toBe(0);
      expect(navWide.width).toBe(1024);
    }
    const navInnerWide = await navInner.boundingBox();
    expect(navInnerWide?.width).toBe(480);
    await expectNoHorizontalOverflow(page);
  });

  test('formats month headings across months and years', async ({ page }) => {
    await mockWeekApis(page);
    await page.goto('/?week=2026-09-28');
    await expect(page.getByText('2026年9月〜10月', { exact: true })).toBeVisible();
    await page.goto('/?week=2026-12-28');
    await expect(page.getByText('2026年12月〜2027年1月', { exact: true })).toBeVisible();
  });

  test('falls back to a compact row when an expanded day has no visible events', async ({
    page,
  }) => {
    await mockWeekApis(page);
    await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) => {
      const requested = new URL(route.request().url()).searchParams.get('start') as DateKey | null;
      const week = buildWeek(requested ?? BASE_WEEK);
      const date = addCalendarDays(week.week.start, 1);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...week,
          days: week.days.map((day) => (day.date === date ? { ...day, layout: 'expanded' } : day)),
        }),
      });
    });
    await page.goto('/?week=2026-10-05');
    const expandedEmpty = page.locator('[data-testid="week-day"][data-date="2026-10-06"]');
    await expect(expandedEmpty).toHaveAttribute('data-layout', 'compact');
    await expect(expandedEmpty.getByText('予定なし', { exact: true })).toHaveClass(/sr-only/);
    await expect(expandedEmpty.getByText('いつもと違う日')).toHaveCount(0);
  });

  test('hide-routine toggle filters events without changing day layout, and navigation is history-aware', async ({
    page,
  }) => {
    await mockWeekApis(page);
    await page.goto('/?week=2026-10-05');
    await expect(page.getByText('朝の支度')).toBeVisible();
    const monday = page.locator('[data-testid="week-day"][data-date="2026-10-05"]');
    await expect(monday).toHaveAttribute('data-layout', 'compact');
    const wednesday = page.locator('[data-testid="week-day"][data-date="2026-10-07"]');
    await expect(wednesday).toHaveAttribute('data-layout', 'expanded');
    const saturday = page.locator('[data-testid="week-day"][data-date="2026-10-10"]');
    await expect(saturday).toHaveAttribute('data-layout', 'weekend-card');
    const routineToggle = page.getByRole('button', { name: /ルーティンを隠す|ルーティンを表示/ });
    await routineToggle.click();
    await expect(page.getByText('朝の支度')).toHaveCount(0);
    await expect(monday).toHaveAttribute('data-layout', 'compact');
    await expect(wednesday).toHaveAttribute('data-layout', 'expanded');
    await expect(routineToggle).toHaveAttribute('aria-pressed', 'true');
    await routineToggle.click();
    await expect(page.getByText('朝の支度')).toBeVisible();

    await page.getByRole('button', { name: /次の週/ }).click();
    await expect(page).toHaveURL(/week=2026-10-12/);
    await expect(page.getByRole('button', { name: /今週へ/ })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/week=2026-10-05/);
    await expect(page.getByRole('button', { name: /今週へ/ })).toHaveCount(0);
    await page.getByRole('button', { name: /前の週/ }).click();
    await expect(page).toHaveURL(/week=2026-09-28/);
  });

  test('keeps the prior week while loading and advances repeated navigation from the URL target', async ({
    page,
  }) => {
    await mockWeekApis(page);
    await page.goto('/?week=2026-10-05');
    await expect(page.getByText('公園ピクニック')).toBeVisible();

    await page.unroute(`**/api/families/${FAMILY_ID}/week**`);
    const pending: Array<{ start: DateKey; release: () => void; fulfilled: Promise<void> }> = [];
    await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) => {
      const url = new URL(route.request().url());
      const start = (url.searchParams.get('start') ?? BASE_WEEK) as DateKey;
      let release!: () => void;
      let markFulfilled!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fulfilled = new Promise<void>((resolve) => {
        markFulfilled = resolve;
      });
      pending.push({ start, release, fulfilled });
      await gate;
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(buildWeek(start)),
        });
      } finally {
        markFulfilled();
      }
    });

    try {
      const nextButton = page.getByRole('button', { name: /次の週/ });
      await nextButton.click();
      await expect(page).toHaveURL(/week=2026-10-12/);
      await expect(page.getByTestId('week-updating')).toHaveText('更新中...');
      await expect(page.getByText('公園ピクニック')).toBeVisible();
      await expect(nextButton).toBeEnabled();
      await expect(page.getByRole('button', { name: /前の週/ })).toBeEnabled();

      await nextButton.click();
      await expect(page).toHaveURL(/week=2026-10-19/);
      await expect.poll(() => pending.some((request) => request.start === '2026-10-19')).toBe(true);
      expect(pending.map((request) => request.start)).toContain('2026-10-12');
      const latest = pending.find((request) => request.start === '2026-10-19');
      const earlier = pending.find((request) => request.start === '2026-10-12');
      latest?.release();
      if (latest) await latest.fulfilled;
      await expect(page.getByTestId('week-updating')).toHaveCount(0);
      await expect(page.locator('[data-testid="week-day"][data-date="2026-10-19"]')).toBeVisible();
      earlier?.release();
      if (earlier) await earlier.fulfilled;
      await expect(page.locator('[data-testid="week-day"][data-date="2026-10-19"]')).toBeVisible();
      await expect(page.getByText('公園ピクニック')).toHaveCount(0);
    } finally {
      for (const request of pending) request.release();
    }
  });

  test('clears the prior week after a week navigation error', async ({ page }) => {
    await mockWeekApis(page);
    await page.goto('/?week=2026-10-05');
    await expect(page.getByText('公園ピクニック')).toBeVisible();
    await page.unroute(`**/api/families/${FAMILY_ID}/week**`);
    await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'GOOGLE_ERROR', error: 'synthetic private response' }),
      }),
    );

    await page.getByRole('button', { name: /次の週/ }).click();
    await expect(
      page.getByRole('heading', { name: '週の予定を取得できませんでした' }),
    ).toBeVisible();
    await expect(page.getByText('公園ピクニック')).toHaveCount(0);
    await expect(page.locator('[data-testid="week-day"]')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain('synthetic private response');
  });

  test('canonicalizes missing and non-Monday anchors with replace while preserving fixed OAuth notices', async ({
    page,
  }) => {
    await mockWeekApis(page);
    await page.goto('/?error=access_denied');
    await expect(page.locator('[data-testid="access-denied-message"]')).toBeVisible();
    await expect(page).toHaveURL(/week=2026-10-05/);
    await page.goto('/?week=2026-10-07&error=access_denied');
    await expect(page).toHaveURL(/week=2026-10-05/);
    await expect(page.locator('[data-testid="access-denied-message"]')).toBeVisible();
    await expect(page).toHaveURL(/error=access_denied/);
    await page.goBack();
    await expect(page).not.toHaveURL(/week=2026-10-07/);
  });

  test('invalid and out-of-range dates fail closed without week API calls and recover safely', async ({
    page,
  }) => {
    const api = await mockWeekApis(page);
    await page.goto('/?week=not-a-date');
    await expect(page.getByText(/日付を確認してください/)).toBeVisible();
    expect(api.weekRequests).toHaveLength(0);
    await expect(page.getByRole('button', { name: /今週へ/ })).toBeVisible();
    await page.goto('/?week=1900-01-01');
    await expect(page.getByText(/日付を確認してください/)).toBeVisible();
    expect(api.weekRequests).toHaveLength(0);
    await page.getByRole('button', { name: /今週へ/ }).click();
    await expect(page).toHaveURL(/week=2026-10-05/);
    await expect(page.getByText('朝の支度')).toBeVisible();
  });

  test('loading and safe fixed API error guidance cover every week error class', async ({
    page,
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mockWeekApis(page);
    await page.unroute(`**/api/families/${FAMILY_ID}/week**`);
    await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) => {
      await gate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildWeek(BASE_WEEK)),
      });
    });
    await page.goto('/?week=2026-10-05');
    try {
      await expect(page.getByText(/読み込み中/)).toBeVisible();
    } finally {
      release();
    }
    await expect(page.getByText('朝の支度')).toBeVisible();

    const cases = [
      { status: 401, code: 'REAUTH_REQUIRED', text: /Google カレンダーの再認証/ },
      { status: 403, code: 'CALENDAR_ACCESS_DENIED', text: /家族カレンダーにアクセス/ },
      { status: 503, code: 'GOOGLE_TEMPORARY_ERROR', text: /時間をおいて/ },
      { status: 502, code: 'GOOGLE_ERROR', text: /通信に失敗/ },
      {
        status: 500,
        code: 'UNEXPECTED_PRIVATE_CODE',
        text: '予定を読み込めませんでした。通信状態を確認して、もう一度お試しください。',
      },
      { status: 401, code: 'UNAUTHORIZED', text: /ログイン/ },
    ];
    for (const item of cases) {
      await page.unroute(`**/api/families/${FAMILY_ID}/week**`);
      let failRequest = true;
      await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) => {
        if (!failRequest) {
          const url = new URL(route.request().url());
          const start = (url.searchParams.get('start') ?? BASE_WEEK) as DateKey;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(buildWeek(start)),
          });
          return;
        }
        await route.fulfill({
          status: item.status,
          contentType: 'application/json',
          body: JSON.stringify({ code: item.code, error: 'raw synthetic server detail' }),
        });
      });
      let loginCalls = 0;
      await page.route('**/api/auth/login', async (route) => {
        loginCalls++;
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<html><body>Mocked login</body></html>',
        });
      });
      await page.reload();
      if (item.code === 'UNAUTHORIZED') {
        await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();
        expect(loginCalls).toBe(0);
        await page.getByRole('button', { name: 'Google でログイン' }).click();
        await expect(page).toHaveURL(/\/api\/auth\/login/);
        await page.goto('/?week=2026-10-05');
        continue;
      }
      await expect(page.getByText(item.text)).toBeVisible();
      if (item.code === 'REAUTH_REQUIRED') {
        await expect(page.getByRole('button', { name: /Google で再ログイン/ })).toBeVisible();
      } else {
        await expect(page.getByRole('button', { name: /再試行/ })).toBeVisible();
      }
      expect(await page.locator('body').innerText()).not.toContain('raw synthetic server detail');
      if (item.code === 'CALENDAR_ACCESS_DENIED')
        await expect(page.getByText(/オーナー/)).toBeVisible();
      if (item.code === 'REAUTH_REQUIRED') {
        const reauthButton = page.getByRole('button', { name: /Google で再ログイン/ });
        await expect(reauthButton).toBeVisible();
        expect(loginCalls).toBe(0);
        await reauthButton.click();
        await expect(page).toHaveURL(/\/api\/auth\/login/);
        await page.goto('/?week=2026-10-05');
      } else {
        const retryButton = page.getByRole('button', { name: /再試行/ });
        await expect(retryButton).toBeVisible();
        failRequest = false;
        await retryButton.click();
        await expect(page.getByText('公園ピクニック')).toBeVisible();
      }
    }
  });

  test('unauthenticated and no-ready-family states are safe; family settings stays available', async ({
    page,
  }) => {
    await mockWeekApis(page, { mode: 'unauth' });
    await page.goto('/');
    await expect(page.locator('[data-testid="login-button"]')).toBeVisible();
    await expect(page.getByText('朝の支度')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /プライバシー/ })).toBeVisible();
    await page.goto('/family');
    await expect(page.getByRole('heading', { name: '家族' })).toBeVisible();
    await expect(page.getByText('続けるには Google でログインしてください。')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();

    await page.unroute('**/api/auth/me');
    await page.route('**/api/auth/me', async (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_synthetic', email: 'private@example.test', displayName: 'テスト利用者' },
        }),
      }),
    );
    await page.goto('/');
    await expect(page.locator('[data-testid="onboarding-link"]')).toBeVisible();
    await expect(page.getByText('朝の支度')).toHaveCount(0);
    await page.goto('/family');
    await expect(page.getByText('テスト利用者')).toBeVisible();
    await expect(page.locator('[data-testid="onboarding-link"]')).toBeVisible();
    await expect(page.locator('[data-testid="logout-button"]')).toBeVisible();
    await expect(page.getByText('朝の支度')).toHaveCount(0);
  });

  test('routine tab opens its feature and other unfinished tabs still show preparation screens', async ({
    page,
  }) => {
    await mockWeekApis(page);
    await page.route('**/api/families/*/tasks', async (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: [] }),
      }),
    );
    await page.route('**/api/families/fam_synthetic/routines', async (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ routines: [] }),
      }),
    );
    await page.goto('/?week=2026-10-05');
    await page.setViewportSize({ width: 445, height: 844 });
    await expectNoHorizontalOverflow(page);

    await page.getByRole('link', { name: /繰り返し/ }).click();
    await expect(page).toHaveURL(/\/routines$/);
    await expect(page.locator('[data-testid="routines-screen"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: '繰り返し予定' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '準備中', exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    const navigation = page.getByRole('navigation', { name: 'メインナビゲーション' });
    await navigation.getByRole('link', { name: '週', exact: true }).click();
    await expect(page.getByText('朝の支度')).toBeVisible();
    await navigation.getByRole('link', { name: /やること/ }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole('heading', { name: 'やること', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '準備中', exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'プリントを撮影' }).click();
    await expect(page).toHaveURL(/\/import$/);
    await expect(page.getByRole('heading', { name: 'プリント取り込み' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '準備中', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('session expiry removes the previously loaded private family week', async ({ page }) => {
    let authenticated = true;
    await page.route('**/api/auth/me', async (route) => {
      if (!authenticated) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Unauthorized' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_synthetic', email: 'private@example.test', displayName: 'テスト利用者' },
        }),
      });
    });
    await page.route('**/api/families', async (route) =>
      route.fulfill({
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
      }),
    );
    await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildWeek(BASE_WEEK)),
      }),
    );

    await page.goto('/?week=2026-10-05');
    await expect(page.getByText('公園ピクニック')).toBeVisible();
    authenticated = false;
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes('/api/auth/me') && response.status() === 401,
      ),
      triggerVisibilityCycle(page),
    ]);
    await expect(page.locator('[data-testid="login-button"]')).toBeVisible();
    await expect(page.getByText('公園ピクニック')).toHaveCount(0);
    await expect(page.getByText('テスト利用者')).toHaveCount(0);
  });

  test('background week revalidation failure removes stale week events and legend while keeping the session', async ({
    page,
  }) => {
    await mockWeekApis(page);
    await page.goto('/?week=2026-10-05');
    await expect(page.getByText('公園ピクニック')).toBeVisible();
    await expect(page.getByRole('list', { name: 'メンバー' })).toBeVisible();

    await page.unroute(`**/api/families/${FAMILY_ID}/week**`);
    await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'REAUTH_REQUIRED',
          error: 'private calendar access detail must stay hidden',
        }),
      }),
    );
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes(`/api/families/${FAMILY_ID}/week`) && response.status() === 401,
      ),
      triggerVisibilityCycle(page),
    ]);

    await expect(page.getByText('公園ピクニック')).toHaveCount(0);
    await expect(page.getByText('メンバー甲')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'メンバー' })).toHaveCount(0);
    await expect(page.getByText(/Google カレンダーの再認証が必要です/)).toBeVisible();
    await expect(page.locator('body')).not.toContainText('private calendar access detail');

    await page.goto('/family');
    await expect(page.locator('[data-testid="user-display-name"]')).toHaveText('テスト利用者');
  });

  test('a delayed logout for account A cannot clear account B or B family week', async ({
    page,
  }) => {
    let activeUser: 'A' | 'B' = 'A';
    const weekRequestUsers: string[] = [];
    let signalLogoutEntered!: () => void;
    const logoutEntered = new Promise<void>((resolve) => {
      signalLogoutEntered = resolve;
    });
    let releaseLogout!: () => void;
    const logoutGate = new Promise<void>((resolve) => {
      releaseLogout = resolve;
    });

    await page.route('**/api/auth/me', async (route) => {
      const isAccountA = activeUser === 'A';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: isAccountA ? 'usr_account_a' : 'usr_account_b',
            email: isAccountA ? 'a@example.test' : 'b@example.test',
            displayName: isAccountA ? 'アカウントA' : 'アカウントB',
          },
        }),
      });
    });
    await page.route('**/api/families', async (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          families: [
            {
              id: FAMILY_ID,
              name: 'サンプル家',
              familyCalendarId: 'cal_synthetic',
              ownerUserId: activeUser === 'A' ? 'usr_account_a' : 'usr_account_b',
              creationStatus: 'ready',
              members: [],
            },
          ],
        }),
      }),
    );
    await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) => {
      const url = new URL(route.request().url());
      const start = (url.searchParams.get('start') ?? BASE_WEEK) as DateKey;
      const syntheticWeek = buildWeek(start);
      if (url.pathname.endsWith('/week/personal')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            family: { id: FAMILY_ID },
            memberId: 'mem_synthetic_self',
            week: syntheticWeek.week,
            status: 'authorization_required',
            events: [],
          }),
        });
        return;
      }
      weekRequestUsers.push(activeUser);
      const week =
        activeUser === 'A'
          ? syntheticWeek
          : {
              ...syntheticWeek,
              family: { ...syntheticWeek.family, name: 'Bサンプル家' },
              events: syntheticWeek.events.map((event) => ({
                ...event,
                title: `B ${event.title}`,
              })),
            };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(week),
      });
    });
    await page.route('**/api/auth/logout', async (route) => {
      signalLogoutEntered();
      await logoutGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto('/?week=2026-10-05');
    await expect(page.getByText('公園ピクニック')).toBeVisible();
    await page.getByRole('link', { name: '家族', exact: true }).click();
    await expect(page.locator('[data-testid="user-display-name"]')).toHaveText('アカウントA');
    await page.getByRole('button', { name: 'ログアウト' }).click();
    await logoutEntered;
    const logoutResponse = page.waitForResponse(
      (response) => response.url().includes('/api/auth/logout') && response.status() === 200,
    );

    try {
      activeUser = 'B';
      await Promise.all([
        page.waitForResponse(
          (response) => response.url().includes('/api/auth/me') && response.status() === 200,
        ),
        triggerVisibilityCycle(page),
      ]);
      await expect(page.locator('[data-testid="user-display-name"]')).toHaveText('アカウントB');
    } finally {
      releaseLogout();
    }

    // Observe logout completion before asserting that the adopted identity remains active.
    await logoutResponse;
    await expect(page.locator('[data-testid="logout-button"]')).toBeEnabled();
    await expect(page.locator('[data-testid="user-display-name"]')).toHaveText('アカウントB');
    await expect(page.getByRole('button', { name: 'Google でログイン' })).toHaveCount(0);

    await page
      .getByRole('navigation', { name: 'メインナビゲーション' })
      .getByRole('link', { name: '週', exact: true })
      .click();
    await expect(page.getByText('B 公園ピクニック')).toBeVisible();
    await expect(page.getByText('公園ピクニック', { exact: true })).toHaveCount(0);
    expect(weekRequestUsers).toContain('B');
    expect(weekRequestUsers.at(-1)).toBe('B');
    await page.getByRole('link', { name: '家族', exact: true }).click();
    await expect(page.locator('[data-testid="user-display-name"]')).toHaveText('アカウントB');
    await expect(page.getByRole('button', { name: 'ログアウト' })).toBeVisible();
  });

  test('malformed response and arbitrary server text never reach the page', async ({ page }) => {
    await mockWeekApis(page, { malformed: true });
    await page.goto('/?week=2026-10-05');
    await expect(page.getByText(/週の予定を取得できません/)).toBeVisible();
    await expect(page.locator('body')).not.toContainText('not-an-array');
    await page.unroute(`**/api/families/${FAMILY_ID}/week**`);
    await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'GOOGLE_ERROR',
          error: '<img src=x onerror=alert(1)>raw-secret',
        }),
      }),
    );
    await page.reload();
    const html = await page.innerHTML('body');
    expect(html).not.toContain('raw-secret');
    expect(html).not.toContain('onerror=');
  });
});
