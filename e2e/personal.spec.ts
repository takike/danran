import { expect, test } from '@playwright/test';
import type { DateKey } from '../src/shared/schemas/date';
import type { FamilyPublic } from '../src/shared/schemas/family';
import type {
  PersonalCalendarListResponse,
  PersonalWeekResponse,
} from '../src/shared/schemas/personal';
import { type WeekEvent, type WeekResponse, weekResponseSchema } from '../src/shared/schemas/week';
import { addCalendarDays, getWeekday } from '../src/shared/time/date';
import { getWeekRange } from '../src/shared/time/week';

test.use({
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  timezoneId: 'UTC',
  locale: 'ja-JP',
});

const FAMILY_ID = 'fam_personal_a';
const USER_A = 'usr_personal_a';
const USER_B = 'usr_personal_b';
const MEMBER_A = 'mem_personal_a';
const BASE_WEEK = '2026-10-05' as DateKey;
const PRIMARY_ID = 'primary';
const WORK_ID = 'work-calendar@example.test';

const familyA: FamilyPublic = {
  id: FAMILY_ID,
  name: '個人予定サンプル家',
  familyCalendarId: 'family-calendar-synthetic',
  ownerUserId: USER_A,
  creationStatus: 'ready',
  members: [
    {
      id: MEMBER_A,
      userId: USER_A,
      kind: 'adult',
      name: 'テスト利用者',
      color: 'coral',
      sortOrder: 0,
    },
    {
      id: 'mem_child',
      userId: null,
      kind: 'child',
      name: '子ども',
      color: 'ochre',
      sortOrder: 1,
    },
  ],
};

const familyEvent: WeekEvent = {
  id: 'family-wednesday',
  title: '家族の予定',
  time: {
    kind: 'timed',
    start: '2026-10-07T12:00:00+09:00',
    endExclusive: '2026-10-07T13:00:00+09:00',
  },
  memberIds: ['mem_child'],
  assigneeMemberId: null,
  status: 'confirmed',
  isRoutine: false,
  source: 'manual',
  items: [],
};

const saturdayFamilyEvent: WeekEvent = {
  id: 'family-saturday',
  title: '家族の土曜予定',
  time: {
    kind: 'timed',
    start: '2026-10-10T10:00:00+09:00',
    endExclusive: '2026-10-10T11:00:00+09:00',
  },
  memberIds: [],
  assigneeMemberId: null,
  status: 'confirmed',
  isRoutine: false,
  source: 'manual',
  items: [],
};

const syntheticPersonalEvents: PersonalWeekResponse['events'] = [
  ...(
    [
      ['personal-mon-1', '歯科の予約', '2026-10-05T08:00:00+09:00', '2026-10-05T09:00:00+09:00'],
      ['personal-mon-2', '仕事の打合せ', '2026-10-05T10:00:00+09:00', '2026-10-05T11:00:00+09:00'],
      ['personal-mon-3', '手続きの予定', '2026-10-05T13:00:00+09:00', '2026-10-05T14:00:00+09:00'],
      [
        'personal-wed-1',
        '個人予定・午前',
        '2026-10-07T09:00:00+09:00',
        '2026-10-07T10:00:00+09:00',
      ],
      [
        'personal-wed-routine',
        '個人の繰り返し',
        '2026-10-07T15:00:00+09:00',
        '2026-10-07T16:00:00+09:00',
      ],
      ['personal-sat-1', '個人予定・朝', '2026-10-10T08:00:00+09:00', '2026-10-10T09:00:00+09:00'],
    ] as const
  ).map(([id, title, start, endExclusive], index) => ({
    id: `${PRIMARY_ID}::${id}`,
    calendarId: PRIMARY_ID,
    title,
    time: {
      kind: 'timed' as const,
      start,
      endExclusive,
    },
    isRoutine: index === 4,
  })),
];

function buildWeek(anchor: DateKey, family: FamilyPublic, events: WeekEvent[] = []): WeekResponse {
  const range = getWeekRange(anchor);
  const days = range.days.map((date) => {
    const weekday = getWeekday(date);
    const isHoliday = date === '2026-10-12';
    const isWeekend = weekday === 0 || weekday === 6 || isHoliday;
    const dayEvents = events.filter((event) => {
      if (event.time.kind === 'all-day') {
        return event.time.start <= date && date < event.time.endExclusive;
      }
      const start = event.time.start.slice(0, 10);
      const end = event.time.endExclusive.slice(0, 10);
      return (
        start <= date &&
        date <= end &&
        !(end === date && event.time.endExclusive.endsWith('T00:00:00+09:00'))
      );
    });
    return {
      date,
      weekday,
      holidayName: isHoliday ? 'スポーツの日' : null,
      closures: [],
      layout: isWeekend
        ? ('weekend-card' as const)
        : dayEvents.some((event) => !event.isRoutine)
          ? ('expanded' as const)
          : ('compact' as const),
      eventIds: dayEvents.map((event) => event.id),
    };
  });
  return weekResponseSchema.parse({
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
  });
}

function buildPersonalWeek(
  anchor: DateKey,
  familyId: string,
  memberId: string,
  events: PersonalWeekResponse['events'],
  status: PersonalWeekResponse['status'],
): PersonalWeekResponse {
  const range = getWeekRange(anchor);
  return {
    family: { id: familyId },
    memberId,
    week: {
      start: range.start,
      endInclusive: range.endInclusive,
      prevWeekStart: range.prevWeekStart,
      nextWeekStart: range.nextWeekStart,
      today: '2026-10-06',
    },
    status,
    events: status === 'ready' ? events : [],
  };
}

function calendarList(
  memberId: string,
  status: PersonalCalendarListResponse['status'],
  selected: string[],
): PersonalCalendarListResponse {
  if (status === 'authorization_required') {
    return { status, memberId, calendars: [] };
  }
  return {
    status: 'ready',
    memberId,
    calendars: [
      {
        id: PRIMARY_ID,
        name: '自分のカレンダー',
        isPrimary: true,
        selected: selected.includes(PRIMARY_ID),
      },
      {
        id: WORK_ID,
        name: 'テスト用カレンダー',
        isPrimary: false,
        selected: selected.includes(WORK_ID),
      },
    ],
  };
}

async function mockPersonalApis(
  page: import('@playwright/test').Page,
  options: { preauthorized?: boolean; selected?: string[]; failPersonalWeek?: boolean } = {},
) {
  let currentUserId = USER_A;
  let currentFamily = structuredClone(familyA);
  let authorized = options.preauthorized ?? false;
  let savedCalendarIds = options.selected ?? [];
  let hasSavedSelection = options.selected !== undefined;
  let personalWeekFailureStatus = options.failPersonalWeek ? 503 : null;
  const personalPutBodies: Array<{ calendarIds: string[] }> = [];
  let personalPutCount = 0;
  let signalPersonalPut!: () => void;
  let resolvePersonalPut!: () => void;
  let personalPutGate: Promise<void> | undefined;
  let holdNextPersonalPut = false;
  const setHoldPersonalPut = (value: boolean) => {
    holdNextPersonalPut = value;
    if (value) {
      personalPutGate = new Promise<void>((resolve) => {
        resolvePersonalPut = resolve;
      });
    }
  };

  await page.route('**/api/auth/me', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: currentUserId,
          email: 'private@example.test',
          displayName: currentUserId === USER_A ? 'テスト利用者' : '別の利用者',
        },
      }),
    }),
  );
  await page.route('**/api/families', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ families: [currentFamily] }),
    }),
  );
  await page.route(`**/api/families/${FAMILY_ID}`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ family: currentFamily }),
    }),
  );
  await page.route('**/api/families/*/closures', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ closures: [], hasMore: false }),
    }),
  );
  await page.route('**/api/families/*/personal-calendars', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          calendarList(
            currentFamily.members.find((member) => member.userId === currentUserId)?.id ?? MEMBER_A,
            authorized ? 'ready' : 'authorization_required',
            hasSavedSelection ? savedCalendarIds : [PRIMARY_ID],
          ),
        ),
      });
      return;
    }
    if (route.request().method() !== 'PUT') {
      await route.fallback();
      return;
    }
    personalPutCount++;
    const body = route.request().postDataJSON() as { calendarIds: string[] };
    personalPutBodies.push(body);
    if (holdNextPersonalPut) {
      holdNextPersonalPut = false;
      signalPersonalPut();
      await personalPutGate;
    }
    if (!authorized) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authorizationRequired: true,
          authorizationUrl:
            'https://accounts.google.com/o/oauth2/v2/auth?scope=openid%20email%20profile%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events.readonly&include_granted_scopes=true&state=synthetic',
        }),
      });
      return;
    }
    savedCalendarIds = body.calendarIds;
    hasSavedSelection = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authorizationRequired: false,
        ...calendarList(
          currentFamily.members.find((member) => member.userId === currentUserId)?.id ?? MEMBER_A,
          'ready',
          savedCalendarIds,
        ),
      }),
    });
  });
  await page.route('**/api/families/*/week**', async (route) => {
    const url = new URL(route.request().url());
    const anchor = (url.searchParams.get('start') ?? BASE_WEEK) as DateKey;
    if (url.pathname.endsWith('/week/personal')) {
      if (personalWeekFailureStatus !== null) {
        await route.fulfill({
          status: personalWeekFailureStatus,
          contentType: 'application/json',
          body: JSON.stringify({
            code:
              personalWeekFailureStatus === 403
                ? 'CALENDAR_ACCESS_DENIED'
                : 'GOOGLE_TEMPORARY_ERROR',
            error: 'private Google payload',
          }),
        });
        return;
      }
      const memberId =
        currentFamily.members.find((member) => member.userId === currentUserId)?.id ?? MEMBER_A;
      const status =
        authorized && savedCalendarIds.length > 0
          ? 'ready'
          : authorized
            ? 'unselected'
            : 'authorization_required';
      const personalEvents =
        currentUserId === USER_A && anchor === BASE_WEEK ? syntheticPersonalEvents : [];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          buildPersonalWeek(anchor, currentFamily.id, memberId, personalEvents, status),
        ),
      });
      return;
    }
    const familyEvents =
      currentUserId === USER_A && anchor === BASE_WEEK ? [familyEvent, saturdayFamilyEvent] : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildWeek(anchor, currentFamily, familyEvents)),
    });
  });
  return {
    get personalPutBodies() {
      return personalPutBodies;
    },
    get personalPutCount() {
      return personalPutCount;
    },
    setHoldPersonalPut,
    waitForPersonalPut: () =>
      new Promise<void>((resolve) => {
        signalPersonalPut = resolve;
      }),
    releasePersonalPut: () => resolvePersonalPut(),
    authorize: () => {
      authorized = true;
    },
    setSelection: (calendarIds: string[]) => {
      savedCalendarIds = calendarIds;
      hasSavedSelection = true;
    },
    setPersonalWeekFailureStatus: (status: number | null) => {
      personalWeekFailureStatus = status;
    },
    setIdentity: (userId: string, family: FamilyPublic) => {
      currentUserId = userId;
      currentFamily = structuredClone(family);
      authorized = true;
      savedCalendarIds = [PRIMARY_ID];
      hasSavedSelection = true;
    },
  };
}

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const result = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(result.scroll).toBeLessThanOrEqual(result.viewport);
}

async function expectVisibleHitTargetsAtLeast44px(page: import('@playwright/test').Page) {
  const hitTargets = await page
    .locator('button:visible, a:visible, input[type="checkbox"]:visible')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const target = element.matches('input[type="checkbox"]')
          ? (element.closest('label') ?? element)
          : element;
        const box = target.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }),
    );
  for (const box of hitTargets) {
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
}

test.describe('Task 2-1: personal calendar events', () => {
  test('requests incremental consent once, saves selection including all-off, and retains it on reload', async ({
    page,
  }) => {
    const api = await mockPersonalApis(page);
    await page.route('https://accounts.google.com/**', async (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<title>Google consent mock</title>',
      }),
    );
    await page.goto('/family');
    const enable = page.getByTestId('enable-personal-events');
    await expect(enable).toBeVisible();
    api.setHoldPersonalPut(true);
    const putEntered = api.waitForPersonalPut();
    await enable.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await putEntered;
    await expect(enable).toBeDisabled();
    expect(api.personalPutCount).toBe(1);
    expect(api.personalPutBodies).toEqual([{ calendarIds: [] }]);
    api.releasePersonalPut();
    await page.waitForURL(/accounts\.google\.com\/o\/oauth2/);
    const consentUrl = new URL(page.url());
    expect(consentUrl.searchParams.get('include_granted_scopes')).toBe('true');
    expect(consentUrl.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/calendar.events.readonly',
    );
    expect(consentUrl.searchParams.get('scope')).not.toContain('calendar.events ');

    await page.goBack();
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await expect(enable).toBeEnabled();
    api.authorize();
    await page.goto('/family?personal=granted');
    await expect(page.getByTestId('personal-consent-success')).toBeVisible();
    const primary = page.getByTestId(`personal-calendar-${PRIMARY_ID}`);
    const work = page.getByTestId(`personal-calendar-${WORK_ID}`);
    await expect(primary).toBeChecked();
    await expect(work).not.toBeChecked();
    const save = page.getByTestId('save-personal-calendars');
    await expect(save).toBeEnabled();
    await save.click();
    expect(api.personalPutBodies.at(-1)).toEqual({ calendarIds: [PRIMARY_ID] });
    await work.check();
    await save.click();
    await expect(primary).toBeChecked();
    await expect(work).toBeChecked();
    expect(api.personalPutBodies.at(-1)).toEqual({ calendarIds: [PRIMARY_ID, WORK_ID] });

    if (process.env.DANRAN_SCREENSHOTS === '1') {
      await page.goto('/family');
      await expect(page.getByTestId(`personal-calendar-${PRIMARY_ID}`)).toBeChecked();
      const original = page.viewportSize();
      const fullHeight = await page.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      );
      await page.setViewportSize({ width: 390, height: fullHeight + 100 });
      await page.screenshot({ path: 'docs/screenshots/family.png', fullPage: true });
      if (original) await page.setViewportSize(original);
    }

    await primary.uncheck();
    await work.uncheck();
    await page.getByTestId('save-personal-calendars').click();
    expect(api.personalPutBodies.at(-1)).toEqual({ calendarIds: [] });
    await page.reload();
    await expect(page.getByTestId(`personal-calendar-${PRIMARY_ID}`)).not.toBeChecked();
    await expect(page.getByTestId(`personal-calendar-${WORK_ID}`)).not.toBeChecked();
  });

  test('shows read-only self-only personal events in compact, expanded and weekend layouts', async ({
    page,
  }) => {
    const api = await mockPersonalApis(page, { preauthorized: true, selected: [PRIMARY_ID] });
    await page.goto(`/?week=${BASE_WEEK}`);
    const firstPersonal = page.getByTestId('personal-event-primary::personal-mon-1');
    await expect(firstPersonal).toBeVisible();
    await expect(firstPersonal).toContainText('自分だけ');
    expect(await firstPersonal.evaluate((element) => element.closest('button, a') === null)).toBe(
      true,
    );
    await firstPersonal.click();
    await expect(page.getByTestId('personal-events-dialog')).toHaveCount(0);
    await expect(page.getByTestId('personal-event-primary::personal-mon-2')).toBeVisible();
    await expect(page.getByTestId('personal-event-primary::personal-mon-3')).toHaveCount(0);
    await page.getByTestId('personal-events-more-2026-10-05').click();
    const dayDialog = page.getByTestId('personal-events-dialog');
    await expect(dayDialog).toBeVisible();
    await expect(dayDialog.getByText('歯科の予約')).toBeVisible();
    await expect(dayDialog.getByText('仕事の打合せ')).toBeVisible();
    await expect(dayDialog.getByText('手続きの予定')).toBeVisible();
    await page.getByTestId('personal-events-dialog-close').click();

    const wednesday = page
      .getByTestId('week-day')
      .filter({ has: page.getByText('7', { exact: true }) });
    const wednesdayPersonal = page.getByTestId('personal-event-primary::personal-wed-1');
    await expect(wednesdayPersonal).toBeVisible();
    await expect(page.getByTestId('personal-event-primary::personal-wed-routine')).toBeVisible();
    await page.getByRole('button', { name: 'ルーティンを隠す' }).click();
    await expect(page.getByTestId('personal-event-primary::personal-wed-routine')).toHaveCount(0);
    await page.getByRole('button', { name: 'ルーティンを表示' }).click();
    await expect(page.getByTestId('personal-event-primary::personal-wed-routine')).toBeVisible();
    const wednesdayText = await wednesday.innerText();
    expect(wednesdayText.indexOf('個人予定・午前')).toBeLessThan(
      wednesdayText.indexOf('家族の予定'),
    );

    const saturday = page
      .getByTestId('week-day')
      .filter({ has: page.getByText('10', { exact: true }) });
    const saturdayText = await saturday.innerText();
    expect(saturdayText.indexOf('個人予定・朝')).toBeLessThan(
      saturdayText.indexOf('家族の土曜予定'),
    );

    if (process.env.DANRAN_SCREENSHOTS === '1') {
      const original = page.viewportSize();
      const fullHeight = await page.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      );
      await page.setViewportSize({ width: 390, height: fullHeight + 100 });
      await page.screenshot({ path: 'docs/screenshots/s1-week-view.png', fullPage: true });
      if (original) await page.setViewportSize(original);
    }

    await page.getByTestId('personal-events-more-2026-10-05').click();
    api.setPersonalWeekFailureStatus(403);
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
    await expect(page.getByText('手続きの予定')).toHaveCount(0);
    await expect(page.getByTestId('edit-event-family-wednesday')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('private Google payload');
    if (await page.getByTestId('personal-events-dialog').count()) {
      await expect(page.getByTestId('personal-events-dialog').getByText('歯科の予約')).toHaveCount(
        0,
      );
    }
    api.setPersonalWeekFailureStatus(null);

    await page.setViewportSize({ width: 445, height: 844 });
    await expectNoHorizontalOverflow(page);
    await expectVisibleHitTargetsAtLeast44px(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page);
    await expectVisibleHitTargetsAtLeast44px(page);
    await page.getByRole('button', { name: '次の週' }).click();
    await expect(page).toHaveURL(/week=2026-10-12/);
    await expect(page.getByTestId('personal-event-primary::personal-mon-1')).toHaveCount(0);
    await expect(page.getByText('家族の予定')).toHaveCount(0);
    await page.getByRole('button', { name: '前の週' }).click();
    await expect(page).toHaveURL(/week=2026-10-05/);
    await expect(page.getByTestId('personal-event-primary::personal-mon-1')).toBeVisible();
  });

  test('keeps family events after personal-fetch failure and isolates the next account/family', async ({
    page,
  }) => {
    const api = await mockPersonalApis(page, {
      preauthorized: true,
      selected: [PRIMARY_ID],
      failPersonalWeek: true,
    });
    await page.goto(`/?week=${BASE_WEEK}`);
    await expect(page.getByTestId('edit-event-family-wednesday')).toBeVisible();
    await expect(page.getByTestId('personal-events-status')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('private Google payload');
    await expect(page.getByText('歯科の予約')).toHaveCount(0);

    const familyB: FamilyPublic = {
      ...familyA,
      id: 'fam_personal_b',
      name: '別の家族',
      members: familyA.members.map((member) =>
        member.userId === USER_A ? { ...member, id: 'mem_personal_b', userId: USER_B } : member,
      ),
    };
    api.setIdentity(USER_B, familyB);
    await page.goto(`/?week=${BASE_WEEK}`);
    await expect(page.getByText('家族の予定')).toHaveCount(0);
    await expect(page.getByText('別の家族')).toBeVisible();
    await expect(page.getByText('歯科の予約')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('手続きの予定');
  });

  test('keeps selection drafts after a fixed API failure and shows only fixed consent guidance', async ({
    page,
  }) => {
    const api = await mockPersonalApis(page, { preauthorized: true, selected: [PRIMARY_ID] });
    let saveAttempts = 0;
    await page.route(`**/api/families/${FAMILY_ID}/personal-calendars`, async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.fallback();
        return;
      }
      saveAttempts++;
      if (saveAttempts === 1) {
        await route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'GOOGLE_ERROR', error: 'private Google details' }),
        });
        return;
      }
      await route.fallback();
    });
    await page.goto('/family');
    const primary = page.getByTestId(`personal-calendar-${PRIMARY_ID}`);
    await expect(primary).toBeChecked();
    await primary.uncheck();
    await page.getByTestId('save-personal-calendars').click();
    await expect(page.getByTestId('personal-calendar-error')).toHaveText(
      'Google カレンダーとの通信に失敗しました。',
    );
    await expect(primary).not.toBeChecked();
    await expect(page.locator('body')).not.toContainText('private Google details');
    await page.getByTestId('save-personal-calendars').click();
    await expect(page.getByTestId('personal-calendar-error')).toHaveCount(0);
    await expect(primary).not.toBeChecked();
    expect(saveAttempts).toBe(2);
    expect(api.personalPutBodies.at(-1)).toEqual({ calendarIds: [] });

    for (const error of ['personal_denied', 'personal_failed', 'personal_account_mismatch']) {
      await page.goto(`/family?error=${error}&detail=private-google-error`);
      await expect(page.getByTestId('personal-consent-error')).toBeVisible();
      await expect(page.locator('body')).not.toContainText('private-google-error');
    }
  });
});
