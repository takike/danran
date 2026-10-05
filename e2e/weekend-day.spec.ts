import { type Locator, type Page, expect, test } from '@playwright/test';
import type { DateKey } from '../src/shared/schemas/date';
import { createEventInputSchema, eventInputSchema } from '../src/shared/schemas/events';
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
const EXTENDED_HOLIDAY = '2026-10-12' as DateKey;
const FAMILY_A = 'fam_day_a';
const FAMILY_B = 'fam_day_b';
const ADULT_A = 'mem_day_a';
const ADULT_B = 'mem_day_b';
const ADULT_C = 'mem_day_c';
const CHILD = 'mem_day_child';
const A_USER = 'usr_day_a';
const B_USER = 'usr_day_b';
const SECRET_B_PERSONAL_TITLE = 'B_PRIVATE_TITLE_MUST_NOT_LEAK';
const A_PERSONAL_TITLE = '本人だけの合成予定';
const B_PERSONAL_TITLE = SECRET_B_PERSONAL_TITLE;

type Account = 'A' | 'B';
type PersonalMode = 'ready' | 'authorization_required' | 'unselected' | 'error';
type BusyMode = 'ready' | 'not_shared' | 'unavailable' | 'error';

interface MockOptions {
  initialAccount?: Account;
  authenticated?: boolean;
  familyReady?: boolean;
  personalMode?: PersonalMode;
  busyModeA?: BusyMode;
  busyModeB?: BusyMode;
  weekFailure?: boolean;
  personalFailure?: boolean;
  delayPersonal?: boolean;
  busyFailure?: boolean;
  delayBusy?: boolean;
  manyMembers?: boolean;
}

interface DayApiControl {
  readonly busyEntered: Promise<void>;
  readonly personalEntered: Promise<void>;
  releaseBusy: () => void;
  releasePersonal: () => void;
  setAccount: (account: Account) => void;
  setAuthenticated: (value: boolean) => void;
  readonly requests: string[];
  readonly createdEvents: WeekEvent[];
}

function familyId(account: Account): string {
  return account === 'A' ? FAMILY_A : FAMILY_B;
}

function adultId(account: Account): string {
  return account === 'A' ? ADULT_A : ADULT_B;
}

function familyFixture(account: Account, manyMembers = false): FamilyPublic {
  const ordered: Array<
    Pick<FamilyPublic['members'][number], 'id' | 'userId' | 'kind' | 'name' | 'color'>
  > = [
    {
      id: ADULT_A,
      userId: A_USER,
      kind: 'adult' as const,
      name: '大人甲',
      color: 'indigo' as const,
    },
    {
      id: ADULT_B,
      userId: B_USER,
      kind: 'adult' as const,
      name: '大人乙',
      color: 'green' as const,
    },
    {
      id: ADULT_C,
      userId: 'usr_day_c',
      kind: 'adult' as const,
      name: '大人丙',
      color: 'purple' as const,
    },
    { id: CHILD, userId: null, kind: 'child' as const, name: '子ども', color: 'ochre' as const },
  ];
  if (manyMembers) {
    for (let index = 0; index < 4; index++) {
      ordered.splice(3 + index, 0, {
        id: `mem_day_extra_${index}`,
        userId: `usr_day_extra_${index}`,
        kind: 'adult',
        name: `長い名前の大人${index + 1}長い名前`,
        color: ['teal', 'coral', 'rose', 'slate'][
          index
        ] as FamilyPublic['members'][number]['color'],
      });
    }
  }
  const selfId = adultId(account);
  const members: FamilyPublic['members'] = ordered.map((member, sortOrder) => ({
    ...member,
    name: manyMembers ? `${member.name}${'長'.repeat(16)}` : member.name,
    sortOrder,
  }));
  return {
    id: familyId(account),
    name: account === 'A' ? '週末テスト家 A' : '週末テスト家 B',
    familyCalendarId: `family_calendar_${account}`,
    ownerUserId: account === 'A' ? A_USER : B_USER,
    creationStatus: 'ready',
    members: members.map((member) =>
      member.id === selfId ? { ...member, userId: account === 'A' ? A_USER : B_USER } : member,
    ),
  };
}

function event(
  id: string,
  title: string,
  start: string,
  endExclusive: string,
  memberIds: string[],
  options: Partial<Pick<WeekEvent, 'assigneeMemberId' | 'status' | 'isRoutine' | 'items'>> = {},
): WeekEvent {
  return {
    id,
    title,
    time: { kind: 'timed', start, endExclusive },
    memberIds,
    assigneeMemberId: options.assigneeMemberId ?? null,
    status: options.status ?? 'confirmed',
    isRoutine: options.isRoutine ?? false,
    source: 'manual',
    items: options.items ?? [],
  };
}

function fixtureEvents(date: DateKey): WeekEvent[] {
  const nextDate = addCalendarDays(date, 1);
  return [
    event(
      'evt-assigned-piano',
      'ピアノ教室',
      `${date}T09:00:00+09:00`,
      `${date}T10:00:00+09:00`,
      [CHILD],
      { assigneeMemberId: ADULT_A },
    ),
    event(
      'evt-overlap-piano',
      '重なる送迎予定',
      `${date}T09:30:00+09:00`,
      `${date}T10:30:00+09:00`,
      [ADULT_A],
    ),
    event(
      'evt-candidate-overlap',
      '重なる候補予定',
      `${date}T09:30:00+09:00`,
      `${date}T10:00:00+09:00`,
      [ADULT_A],
      { status: 'tentative' },
    ),
    event(
      'evt-all-members',
      '家族全員の昼予定',
      `${date}T14:00:00+09:00`,
      `${date}T15:00:00+09:00`,
      [],
    ),
    event(
      'evt-routine',
      '繰り返しの合成予定',
      `${date}T16:00:00+09:00`,
      `${date}T17:00:00+09:00`,
      [ADULT_B],
      { isRoutine: true },
    ),
    event(
      'evt-all-span-only',
      '家族全員で見る予定',
      `${date}T18:00:00+09:00`,
      `${date}T18:30:00+09:00`,
      [],
    ),
    event(
      'evt-candidate-picnic',
      '公園ピクニック',
      `${date}T13:30:00+09:00`,
      `${date}T17:00:00+09:00`,
      [],
      { status: 'tentative', items: ['レジャーシート', '着替え'] },
    ),
    event('evt-before-hours', '朝の家族予定', `${date}T06:00:00+09:00`, `${date}T06:30:00+09:00`, [
      ADULT_B,
    ]),
    event(
      'evt-cross-opening',
      '朝にまたがる予定',
      `${date}T06:30:00+09:00`,
      `${date}T08:30:00+09:00`,
      [CHILD],
    ),
    event('evt-after-hours', '夜の家族予定', `${date}T21:30:00+09:00`, `${date}T22:30:00+09:00`, [
      ADULT_C,
    ]),
    {
      id: 'evt-all-day',
      title: '終日の家族予定',
      time: { kind: 'all-day', start: date, endExclusive: nextDate },
      memberIds: [ADULT_A],
      assigneeMemberId: null,
      status: 'confirmed',
      isRoutine: false,
      source: 'manual',
      items: [],
    },
  ];
}

function makeWeek(anchor: DateKey, family: FamilyPublic, events: WeekEvent[]): WeekResponse {
  const range = getWeekRange(anchor);
  const days = range.days.map((date) => {
    const dayEvents = events.filter((entry) => {
      if (entry.time.kind === 'all-day') {
        return entry.time.start <= date && date < entry.time.endExclusive;
      }
      const startDate = entry.time.start.slice(0, 10);
      const endDate = entry.time.endExclusive.slice(0, 10);
      return (
        startDate <= date &&
        date <= endDate &&
        !(endDate === date && entry.time.endExclusive.endsWith('T00:00:00+09:00'))
      );
    });
    const weekday = getWeekday(date);
    const holidayName = date === EXTENDED_HOLIDAY ? 'スポーツの日' : null;
    const weekend = weekday === 0 || weekday === 6 || holidayName !== null;
    return {
      date,
      weekday,
      holidayName,
      closures: [],
      layout: weekend
        ? ('weekend-card' as const)
        : dayEvents.length > 0
          ? ('expanded' as const)
          : ('compact' as const),
      eventIds: dayEvents.map((entry) => entry.id),
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

function makeBusyWeek(family: FamilyPublic, anchor: DateKey, mode: MockOptions): BusyWeekResponse {
  const base = makeWeek(anchor, family, fixtureEvents(SATURDAY));
  const range = getWeekRange(anchor);
  const day = addCalendarDays(range.start, 5);
  const busyFor = (memberId: string, account: Account): BusyWeekResponse['members'][number] => {
    const memberMode = account === 'A' ? (mode.busyModeA ?? 'ready') : (mode.busyModeB ?? 'ready');
    if (memberMode !== 'ready') {
      return { memberId, status: memberMode === 'error' ? 'unavailable' : memberMode, busy: [] };
    }
    const intervals =
      account === 'A'
        ? [
            { start: `${day}T08:00:00+09:00`, end: `${day}T09:00:00+09:00` },
            { start: `${day}T10:00:00+09:00`, end: `${day}T11:00:00+09:00` },
            { start: `${day}T13:30:00+09:00`, end: `${day}T14:30:00+09:00` },
          ]
        : [{ start: `${day}T11:00:00+09:00`, end: `${day}T12:00:00+09:00` }];
    if (memberId === ADULT_C) {
      return {
        memberId,
        status: 'ready',
        busy: [{ start: `${day}T08:00:00+09:00`, end: `${day}T08:45:00+09:00` }],
      };
    }
    return { memberId, status: 'ready', busy: intervals };
  };
  const members = family.members
    .filter((member) => member.kind === 'adult')
    .map((member) => busyFor(member.id, member.id === ADULT_B ? 'B' : 'A'));
  return {
    family: { id: family.id },
    week: base.week,
    members,
  };
}

function makePersonalWeek(
  family: FamilyPublic,
  anchor: DateKey,
  mode: MockOptions,
): PersonalWeekResponse {
  const base = makeWeek(anchor, family, fixtureEvents(SATURDAY));
  const activeAccount: Account = family.id === FAMILY_B ? 'B' : 'A';
  const memberId = adultId(activeAccount);
  const status = mode.personalMode ?? 'ready';
  const date = addCalendarDays(getWeekRange(anchor).start, 5);
  const events: PersonalWeekResponse['events'] =
    status === 'ready'
      ? [
          {
            id: `${memberId}::personal-timed`,
            calendarId: `private_calendar_${activeAccount}`,
            title: activeAccount === 'A' ? A_PERSONAL_TITLE : B_PERSONAL_TITLE,
            time: {
              kind: 'timed',
              start: `${date}T15:15:00+09:00`,
              endExclusive: `${date}T16:15:00+09:00`,
            },
            isRoutine: false,
          },
          {
            id: `${memberId}::personal-all-day`,
            calendarId: `private_calendar_${activeAccount}`,
            title: `${activeAccount}本人だけの終日予定`,
            time: { kind: 'all-day', start: date, endExclusive: addCalendarDays(date, 1) },
            isRoutine: false,
          },
          {
            id: `${memberId}::personal-outside`,
            calendarId: `private_calendar_${activeAccount}`,
            title: `${activeAccount}本人だけの夜予定`,
            time: {
              kind: 'timed',
              start: `${date}T21:30:00+09:00`,
              endExclusive: `${date}T22:00:00+09:00`,
            },
            isRoutine: false,
          },
        ]
      : [];
  return {
    family: { id: family.id },
    memberId,
    week: base.week,
    status: status === 'error' ? 'authorization_required' : status,
    events,
  };
}

async function mockDayApis(page: Page, options: MockOptions = {}): Promise<DayApiControl> {
  let account = options.initialAccount ?? 'A';
  let authenticated = options.authenticated ?? true;
  let createdSequence = 0;
  const requests: string[] = [];
  const createdEvents: WeekEvent[] = [];
  const eventsByFamily = new Map<string, WeekEvent[]>([
    [FAMILY_A, fixtureEvents(SATURDAY)],
    [FAMILY_B, fixtureEvents(SATURDAY)],
  ]);
  let releaseBusy!: () => void;
  let enterBusy!: () => void;
  let releasePersonal!: () => void;
  let enterPersonal!: () => void;
  const busyGate = new Promise<void>((resolve) => {
    releaseBusy = resolve;
  });
  const busyEntered = new Promise<void>((resolve) => {
    enterBusy = resolve;
  });
  const personalGate = new Promise<void>((resolve) => {
    releasePersonal = resolve;
  });
  const personalEntered = new Promise<void>((resolve) => {
    enterPersonal = resolve;
  });

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
        user: {
          id: account === 'A' ? A_USER : B_USER,
          email: `${account.toLowerCase()}@example.test`,
          displayName: `テスト利用者 ${account}`,
        },
      }),
    });
  });

  await page.route('**/api/families', async (route) => {
    if (options.familyReady === false) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ families: [] }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ families: [familyFixture(account, options.manyMembers)] }),
    });
  });

  await page.route('**/api/families/*/week**', async (route) => {
    const url = new URL(route.request().url());
    const requestedFamilyId = url.pathname.split('/')[3] ?? familyId(account);
    const requestedAccount: Account = requestedFamilyId === FAMILY_B ? 'B' : 'A';
    const family = familyFixture(requestedAccount, options.manyMembers);
    const events = eventsByFamily.get(requestedFamilyId) ?? fixtureEvents(SATURDAY);
    const anchor = (url.searchParams.get('start') ?? BASE_WEEK) as DateKey;
    requests.push(`${url.pathname}?start=${anchor}`);

    if (url.pathname.endsWith('/week/personal')) {
      if (options.delayPersonal) {
        enterPersonal();
        await personalGate;
      }
      if (options.personalFailure) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'INTERNAL_ERROR',
            error: 'private personal failure detail',
          }),
        });
        return;
      }
      const personal = makePersonalWeek(family, anchor, options);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(personal),
      });
      return;
    }

    if (url.pathname.endsWith('/week/busy')) {
      if (options.delayBusy) {
        enterBusy();
        await busyGate;
      }
      if (options.busyFailure) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'INTERNAL_ERROR', error: 'private busy failure detail' }),
        });
        return;
      }
      const busy = makeBusyWeek(family, anchor, options);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(busy),
      });
      return;
    }

    if (options.weekFailure) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'GOOGLE_TEMPORARY_ERROR',
          error: 'private week failure detail',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeWeek(anchor, family, events)),
    });
  });

  await page.route('**/api/families/*/events', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const input = createEventInputSchema.parse(route.request().postDataJSON());
    createdSequence++;
    const created: WeekEvent = {
      id: `evt_day_created_${createdSequence}`,
      title: input.title,
      time: input.time,
      memberIds: input.memberIds,
      assigneeMemberId: input.assigneeMemberId,
      status: input.status,
      isRoutine: false,
      source: 'manual',
      items: input.items,
    };
    const requestedFamilyId = new URL(route.request().url()).pathname.split('/')[3] ?? FAMILY_A;
    eventsByFamily.set(requestedFamilyId, [
      ...(eventsByFamily.get(requestedFamilyId) ?? []),
      created,
    ]);
    createdEvents.push(created);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ eventId: created.id }),
    });
  });

  await page.route('**/api/families/*/events/*', async (route) => {
    const requestedFamilyId = new URL(route.request().url()).pathname.split('/')[3] ?? FAMILY_A;
    const eventId = new URL(route.request().url()).pathname.split('/').at(-1);
    if (route.request().method() === 'PATCH') {
      const input = eventInputSchema.parse(route.request().postDataJSON());
      const current = eventsByFamily.get(requestedFamilyId) ?? [];
      eventsByFamily.set(
        requestedFamilyId,
        current.map((entry) =>
          entry.id === eventId
            ? {
                ...entry,
                title: input.title,
                time: input.time,
                memberIds: input.memberIds,
                assigneeMemberId: input.assigneeMemberId,
                status: input.status,
                items: input.items,
              }
            : entry,
        ),
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ eventId }),
      });
      return;
    }
    if (route.request().method() === 'DELETE') {
      eventsByFamily.set(
        requestedFamilyId,
        (eventsByFamily.get(requestedFamilyId) ?? []).filter((entry) => entry.id !== eventId),
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    await route.fallback();
  });

  return {
    busyEntered,
    personalEntered,
    releaseBusy: () => releaseBusy(),
    releasePersonal: () => releasePersonal(),
    setAccount: (next) => {
      account = next;
    },
    setAuthenticated: (next) => {
      authenticated = next;
    },
    requests,
    createdEvents,
  };
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport);
}

async function expectTextInsideViewport(locator: Locator) {
  const bounds = await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
    };
  });
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
}

async function expectLabelUnobscured(locator: Locator) {
  await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      window.scrollBy(0, rect.top + rect.height / 2 - window.innerHeight / 2);
    }
  });
  const unobscured = await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getClientRects()[0];
    if (!rect) return { visible: false, text: element.textContent, topmost: 'no-text-range' };
    const previousPointerEvents = (element as HTMLElement).style.pointerEvents;
    (element as HTMLElement).style.pointerEvents = 'auto';
    const topmost = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    (element as HTMLElement).style.pointerEvents = previousPointerEvents;
    return {
      visible: Boolean(topmost && (topmost === element || element.contains(topmost))),
      text: element.textContent,
      topmost: topmost?.getAttribute('data-testid') ?? topmost?.tagName,
    };
  });
  expect(unobscured.visible, JSON.stringify(unobscured)).toBe(true);
}

async function expectBaseWeekScreen(page: Page) {
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByRole('heading', { name: '10/5 – 10/12', exact: true })).toBeVisible();
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
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    window.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    window.dispatchEvent(new Event('visibilitychange'));
  });
}

test.describe('Task 2-6: weekend day detail', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Date.now = () => Date.parse('2026-10-06T12:00:00+09:00');
    });
  });

  test('opens S2 from the holiday-extended week link and returns to the same week', async ({
    page,
  }) => {
    const api = await mockDayApis(page);
    await page.goto(`/?week=${BASE_WEEK}`);
    const link = page.getByTestId(`weekend-day-link-${EXTENDED_HOLIDAY}`);
    await expect(link).toBeVisible();
    await expect(page.getByTestId('weekend-day-link-2026-10-08')).toHaveCount(0);
    if (process.env.DANRAN_SCREENSHOTS === '1') {
      const fullHeight = await page.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      );
      await page.setViewportSize({ width: 390, height: fullHeight + 100 });
      await page.screenshot({ path: 'docs/screenshots/s1-week-view.png', fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await link.click();
    await expect(page).toHaveURL(`/day/${EXTENDED_HOLIDAY}`);
    await expect(page.getByTestId('weekend-day-timeline')).toBeVisible();
    expect(api.requests).toContain(`/api/families/${FAMILY_A}/week?start=${BASE_WEEK}`);
    await page.getByTestId('weekend-day-back').click();
    await expect(page).toHaveURL(new RegExp(`week=${BASE_WEEK}`));
    await expectBaseWeekScreen(page);
    await page.getByTestId(`weekend-day-link-${EXTENDED_HOLIDAY}`).click();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`week=${BASE_WEEK}`));
    await expectBaseWeekScreen(page);
  });

  test('direct URL uses canonical week; invalid dates return to S1; unauthenticated and family-gated users see no day data', async ({
    page,
  }) => {
    const direct = await mockDayApis(page);
    await page.goto(`/day/${SATURDAY}`);
    await expect(page.getByTestId('weekend-day-timeline')).toBeVisible();
    expect(direct.requests).toContain(`/api/families/${FAMILY_A}/week?start=${BASE_WEEK}`);
    await page.goto(`/day/${EXTENDED_HOLIDAY}`);
    await expect(page.getByTestId('weekend-day-timeline')).toBeVisible();
    expect(direct.requests).toContain(`/api/families/${FAMILY_A}/week?start=${EXTENDED_HOLIDAY}`);

    await page.goto('/day/2026-02-30');
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await page.goto('/day/1969-12-31');
    await expect(page.getByTestId('home-screen')).toBeVisible();

    await mockDayApis(page, { authenticated: false });
    await page.goto(`/day/${SATURDAY}`);
    await expect(page.getByTestId('login-button')).toBeVisible();
    await expect(page.getByTestId('weekend-day-timeline')).toHaveCount(0);

    await mockDayApis(page, { familyReady: false });
    await page.goto(`/day/${SATURDAY}`);
    await expect(page.getByTestId('onboarding-link')).toBeVisible();
    await expect(page.getByTestId('weekend-day-timeline')).toHaveCount(0);
  });

  test('renders member columns, assigned events, private self events, candidate, all-day and outside-hours content', async ({
    page,
  }) => {
    await mockDayApis(page);
    await page.goto(`/day/${SATURDAY}`);
    await expect(page.getByTestId('weekend-day-timeline')).toBeVisible();
    const adultColumn = page.getByTestId(`weekend-day-column-${ADULT_A}`);
    const childColumn = page.getByTestId(`weekend-day-column-${CHILD}`);
    await expect(page.getByTestId(`weekend-day-event-evt-assigned-piano-${ADULT_A}`)).toContainText(
      '担当',
    );
    await expect(page.getByTestId(`weekend-day-event-evt-assigned-piano-${CHILD}`)).toContainText(
      'ピアノ教室',
    );
    await expect(adultColumn.getByText('重なる送迎予定')).toBeVisible();
    await expect(page.getByTestId(`weekend-day-event-evt-routine-${ADULT_B}`)).toContainText(
      '繰り返し',
    );
    await expect(page.getByTestId('weekend-day-event-evt-candidate-picnic-all')).toContainText(
      '公園ピクニック',
    );
    await expect(page.getByTestId('weekend-day-event-evt-candidate-picnic-all')).toContainText(
      '候補',
    );
    await expect(page.getByTestId('weekend-day-event-evt-candidate-picnic-all')).toContainText(
      'レジャーシート',
    );
    const assignedBounds = await page
      .getByTestId(`weekend-day-event-evt-assigned-piano-${ADULT_A}`)
      .boundingBox();
    const overlapBounds = await page
      .getByTestId(`weekend-day-event-evt-overlap-piano-${ADULT_A}`)
      .boundingBox();
    expect(assignedBounds).not.toBeNull();
    expect(overlapBounds).not.toBeNull();
    if (assignedBounds && overlapBounds) {
      expect(assignedBounds.y).toBeLessThan(overlapBounds.y + overlapBounds.height);
      expect(overlapBounds.y).toBeLessThan(assignedBounds.y + assignedBounds.height);
      expect(assignedBounds.x).not.toBe(overlapBounds.x);
      expect(assignedBounds.width).toBeLessThan(overlapBounds.width * 2);
    }
    const singleCandidate = await page
      .getByTestId(`weekend-day-event-evt-candidate-overlap-${ADULT_A}`)
      .boundingBox();
    expect(singleCandidate).not.toBeNull();
    if (singleCandidate && assignedBounds && overlapBounds) {
      expect(singleCandidate.y).toBeLessThan(assignedBounds.y + assignedBounds.height);
      expect(assignedBounds.y).toBeLessThan(singleCandidate.y + singleCandidate.height);
      expect(singleCandidate.x).not.toBe(assignedBounds.x);
      expect(singleCandidate.y).toBeLessThan(overlapBounds.y + overlapBounds.height);
      expect(overlapBounds.y).toBeLessThan(singleCandidate.y + singleCandidate.height);
      expect(singleCandidate.x).not.toBe(overlapBounds.x);
    }
    const shortBusy = page.getByTestId(`weekend-day-personal-busy-${SATURDAY}-${ADULT_C}-0`);
    const [shortBusyBounds, timelineBounds] = await Promise.all([
      shortBusy.boundingBox(),
      page.getByTestId('weekend-day-timeline').boundingBox(),
    ]);
    expect(shortBusyBounds).not.toBeNull();
    expect(timelineBounds).not.toBeNull();
    if (shortBusyBounds && timelineBounds) {
      expect(shortBusyBounds.y).toBeCloseTo(timelineBounds.y + 48, 0);
      expect(shortBusyBounds.height).toBeCloseTo(36, 0);
    }
    await expect(shortBusy.getByText('予定あり')).toBeVisible();
    const visibleBusy = page.getByTestId(`weekend-day-personal-busy-${SATURDAY}-${ADULT_A}-0`);
    const busyPattern = await visibleBusy.evaluate(
      (element) => getComputedStyle(element).backgroundImage,
    );
    expect(busyPattern).not.toBe('none');
    expect(busyPattern).not.toContain('var(');
    const candidate = page.getByTestId('weekend-day-event-evt-candidate-picnic-all');
    const lunch = page.getByTestId('weekend-day-event-evt-all-members-all');
    const [candidateBounds, lunchBounds] = await Promise.all([
      page.getByTestId(`weekend-day-event-segment-evt-candidate-picnic-${ADULT_A}`).boundingBox(),
      page.getByTestId(`weekend-day-event-segment-evt-all-members-${ADULT_A}`).boundingBox(),
    ]);
    expect(candidateBounds).not.toBeNull();
    expect(lunchBounds).not.toBeNull();
    if (candidateBounds && lunchBounds) {
      expect(candidateBounds.y).toBeLessThan(lunchBounds.y + lunchBounds.height);
      expect(lunchBounds.y).toBeLessThan(candidateBounds.y + candidateBounds.height);
      expect(candidateBounds.x).not.toBe(lunchBounds.x);
    }
    const allMemberSpan = page.getByTestId('weekend-day-event-evt-all-span-only-all');
    await expect(allMemberSpan).toHaveCount(1);
    const [spanBounds, columnBounds] = await Promise.all([
      allMemberSpan.boundingBox(),
      page.getByTestId(`weekend-day-column-${ADULT_A}`).boundingBox(),
    ]);
    expect(spanBounds).not.toBeNull();
    expect(columnBounds).not.toBeNull();
    if (spanBounds && columnBounds) expect(spanBounds.width).toBeGreaterThan(columnBounds.width);
    await expect(
      page.getByTestId(`weekend-day-personal-busy-${SATURDAY}-${ADULT_B}-0`),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: '読み上げ用の予定と空きの一覧' })).toContainText(
      '予定あり',
    );
    await expect(
      page.getByTestId(`weekend-day-personal-event-${ADULT_A}::personal-timed`),
    ).toContainText(A_PERSONAL_TITLE);
    const selfTitle = page
      .getByTestId(`weekend-day-personal-event-${ADULT_A}::personal-timed`)
      .locator('span')
      .first();
    const selfCard = page.getByTestId(`weekend-day-personal-event-${ADULT_A}::personal-timed`);
    const freeLabels = page.locator('[data-testid^="weekend-day-free-band-"]');
    await expect(freeLabels).not.toHaveCount(0);
    await expectTextInsideViewport(selfTitle);
    const [selfTitleBounds, selfCardBounds] = await Promise.all([
      selfTitle.boundingBox(),
      selfCard.boundingBox(),
    ]);
    expect(selfTitleBounds).not.toBeNull();
    expect(selfCardBounds).not.toBeNull();
    if (selfTitleBounds && selfCardBounds) {
      expect(selfTitleBounds.y).toBeGreaterThanOrEqual(selfCardBounds.y);
      expect(selfTitleBounds.y + selfTitleBounds.height).toBeLessThanOrEqual(
        selfCardBounds.y + selfCardBounds.height,
      );
    }
    for (const freeLabel of await freeLabels.all()) {
      await expectTextInsideViewport(freeLabel);
      await expectLabelUnobscured(freeLabel);
    }
    const scroller = page.getByTestId('weekend-day-scroll');
    await scroller.evaluate((element) => {
      element.scrollLeft = element.scrollWidth - element.clientWidth;
    });
    const childColumnAfterScroll = await page
      .getByTestId(`weekend-day-column-${CHILD}`)
      .boundingBox();
    expect(childColumnAfterScroll).not.toBeNull();
    if (childColumnAfterScroll) {
      expect(childColumnAfterScroll.x).toBeLessThan(390);
      expect(childColumnAfterScroll.x + childColumnAfterScroll.width).toBeGreaterThan(0);
    }
    for (const freeLabel of await freeLabels.all()) {
      await expectTextInsideViewport(freeLabel);
      await expectLabelUnobscured(freeLabel);
    }
    await scroller.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.getByTestId('weekend-day-all-day')).toContainText('終日の家族予定');
    await expect(page.getByTestId('weekend-day-all-day')).toContainText('A本人だけの終日予定');
    await expect(page.getByTestId('weekend-day-outside-hours')).toContainText('朝の家族予定');
    await expect(page.getByTestId('weekend-day-outside-hours')).toContainText('夜の家族予定');
    await expect(page.getByTestId('weekend-day-outside-hours')).toContainText('A本人だけの夜予定');

    const crossingEvent = page.getByTestId(`weekend-day-event-evt-cross-opening-${CHILD}`);
    const timeline = await page.getByTestId('weekend-day-timeline').boundingBox();
    const clipped = await crossingEvent.boundingBox();
    expect(timeline).not.toBeNull();
    expect(clipped).not.toBeNull();
    if (timeline && clipped) {
      expect(clipped.y).toBeCloseTo(timeline.y, 0);
      expect(clipped.y + clipped.height).toBeLessThanOrEqual(timeline.y + timeline.height);
    }

    const body = await page.locator('body').innerText();
    expect(body).not.toContain(SECRET_B_PERSONAL_TITLE);
    expect(body).not.toContain(B_PERSONAL_TITLE);
    expect(body).not.toContain('private_calendar_B');
    await expectVisibleControlsAtLeast44px(page);
    await expectNoHorizontalOverflow(page);
    if (process.env.DANRAN_SCREENSHOTS === '1') {
      const fullHeight = await page.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      );
      await page.setViewportSize({ width: 390, height: fullHeight + 100 });
      await page.screenshot({ path: 'docs/screenshots/s2-weekend-day.png', fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
    }
  });

  test('keeps common free time for not-shared members and disables it when a member is unavailable', async ({
    page,
  }) => {
    await mockDayApis(page, { busyModeB: 'not_shared' });
    await page.goto(`/day/${SATURDAY}`);
    await expect(page.getByTestId('weekend-day-not-shared')).toContainText(
      '個人の予定を共有していない人がいます',
    );
    await expect(
      page.getByTestId('weekend-day-scroll').getByText('個人の予定は未共有', { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('weekend-day-free-band-0')).toBeVisible();
    await expect(page.getByTestId('weekend-day-search')).toBeEnabled();

    await mockDayApis(page, { busyModeB: 'unavailable' });
    await page.goto(`/day/${SATURDAY}`);
    await expect(page.getByTestId('weekend-day-unavailable')).toContainText(
      '共通の空きは表示していません',
    );
    await expect(
      page.getByTestId('weekend-day-scroll').getByText('取得できませんでした', { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('weekend-day-no-common')).toHaveCount(0);
    await expect(page.getByTestId('weekend-day-free-band-0')).toHaveCount(0);
    await expect(page.getByTestId('weekend-day-search')).toBeDisabled();
  });

  test('opens a free band at its start for one hour, caps a short band, then reflects a saved event in S2 and S1', async ({
    page,
  }) => {
    const api = await mockDayApis(page);
    await page.goto(`/day/${SATURDAY}`);
    const add = page.getByTestId('weekend-day-free-add-0');
    await expect(add).toHaveAttribute('aria-label', /空き時間に予定を追加/);
    await add.click();
    const dialog = page.getByTestId('event-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('開始日')).toHaveValue(SATURDAY);
    await expect(dialog.getByLabel('開始時刻')).toHaveValue('12:00');
    await expect(dialog.getByLabel('終了時刻')).toHaveValue('13:00');
    await dialog.getByLabel('タイトル').fill('共通空きから作った予定');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.createdEvents[0]?.time).toEqual({
      kind: 'timed',
      start: `${SATURDAY}T12:00:00+09:00`,
      endExclusive: `${SATURDAY}T13:00:00+09:00`,
    });
    await expect(page.getByTestId('weekend-day-event-evt_day_created_1-all')).toContainText(
      '共通空きから作った予定',
    );
    await page.getByRole('link', { name: '週', exact: true }).click();
    await expect(page.getByTestId('edit-event-evt_day_created_1')).toContainText(
      '共通空きから作った予定',
    );

    const shortApi = await mockDayApis(page, { busyModeA: 'ready' });
    // Replace the route with a 45-minute first shared-free interval.
    await page.route(`**/api/families/${FAMILY_A}/week/busy**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== `/api/families/${FAMILY_A}/week/busy`) {
        await route.fallback();
        return;
      }
      const anchor = (url.searchParams.get('start') ?? BASE_WEEK) as DateKey;
      const family = familyFixture('A');
      const response = makeBusyWeek(family, anchor, {});
      const date = addCalendarDays(getWeekRange(anchor).start, 5);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...response,
          members: [
            {
              memberId: ADULT_A,
              status: 'ready',
              busy: [{ start: `${date}T08:00:00+09:00`, end: `${date}T09:00:00+09:00` }],
            },
            {
              memberId: ADULT_B,
              status: 'ready',
              busy: [
                { start: `${date}T09:00:00+09:00`, end: `${date}T12:00:00+09:00` },
                { start: `${date}T12:45:00+09:00`, end: `${date}T13:00:00+09:00` },
              ],
            },
            { memberId: ADULT_C, status: 'ready', busy: [] },
          ],
        }),
      });
    });
    await page.goto(`/day/${SATURDAY}`);
    await page.getByTestId('weekend-day-free-add-0').click();
    const shortDialog = page.getByTestId('event-dialog');
    await expect(shortDialog.getByLabel('開始時刻')).toHaveValue('12:00');
    await expect(shortDialog.getByLabel('終了時刻')).toHaveValue('12:45');
    expect(shortApi.createdEvents).toHaveLength(0);
  });

  test('family week failures never infer common free time; personal/busy failures do not block event creation', async ({
    page,
  }) => {
    await mockDayApis(page, { weekFailure: true });
    await page.goto(`/day/${SATURDAY}`);
    await expect(page.getByTestId('weekend-day-week-error')).toBeVisible();
    await expect(page.getByTestId('weekend-day-free-band-0')).toHaveCount(0);
    await expect(page.getByTestId('weekend-day-search')).toBeDisabled();
    await expect(
      page.getByTestId(`weekend-day-personal-busy-${SATURDAY}-${ADULT_A}-0`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`weekend-day-personal-event-${ADULT_A}::personal-timed`),
    ).toContainText(A_PERSONAL_TITLE);

    const api = await mockDayApis(page, { personalFailure: true, busyFailure: true });
    await page.goto(`/day/${SATURDAY}`);
    await expect(page.getByTestId('weekend-day-timeline')).toBeVisible();
    await expect(page.getByTestId(`weekend-day-event-evt-assigned-piano-${CHILD}`)).toContainText(
      'ピアノ教室',
    );
    await expect(page.getByTestId('weekend-day-personal-error')).toBeVisible();
    await expect(page.getByTestId('weekend-day-busy-error')).toBeVisible();
    await expect(page.getByTestId('weekend-day-add')).toBeEnabled();
    await page.getByTestId('weekend-day-add').click();
    const dialog = page.getByTestId('event-dialog');
    await expect(dialog.getByLabel('開始日')).toHaveValue(SATURDAY);
    await expect(dialog.getByLabel('開始時刻')).toHaveValue('13:00');
    await dialog.getByLabel('タイトル').fill('API失敗中の予定');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.createdEvents).toHaveLength(1);
    expect(await page.locator('body').innerText()).not.toContain('private busy failure detail');
    expect(await page.locator('body').innerText()).not.toContain('private personal failure detail');
  });

  test('keeps family and private content interactive while the busy request is delayed', async ({
    page,
  }) => {
    const api = await mockDayApis(page, { delayBusy: true, delayPersonal: true });
    await page.goto(`/day/${SATURDAY}`);
    await Promise.all([api.busyEntered, api.personalEntered]);
    await expect(page.getByTestId(`weekend-day-event-evt-assigned-piano-${CHILD}`)).toBeVisible();
    await expect(page.getByTestId('weekend-day-personal-loading')).toBeVisible();
    await page.getByTestId('weekend-day-add').click();
    const dialog = page.getByTestId('event-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('開始日').fill(SATURDAY);
    await dialog.getByLabel('開始時刻').fill('09:00');
    await dialog.getByLabel('終了時刻').fill('10:00');
    await dialog.getByLabel('タイトル').fill('busy待機中に保存した予定');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.createdEvents).toHaveLength(1);
    await expect(
      page.getByTestId(`weekend-day-event-${api.createdEvents[0]?.id}-all`),
    ).toContainText('busy待機中に保存した予定');
    api.releaseBusy();
    api.releasePersonal();
    await expect(page.getByTestId('weekend-day-free-add-0')).toBeVisible();
  });

  test('edits and deletes family events while recurring event edits stay deferred', async ({
    page,
  }) => {
    await mockDayApis(page);
    await page.goto(`/day/${SATURDAY}`);
    await page.getByTestId('weekend-day-event-evt-candidate-picnic-all').click();
    const dialog = page.getByTestId('event-dialog');
    await expect(dialog.getByLabel('タイトル')).toHaveValue('公園ピクニック');
    await dialog.getByLabel('タイトル').fill('更新したピクニック');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByTestId('weekend-day-event-evt-candidate-picnic-all')).toContainText(
      '更新したピクニック',
    );

    await page.getByTestId(`weekend-day-event-evt-routine-${ADULT_B}`).click();
    await expect(page.getByTestId('weekend-day-routine-notice')).toContainText(
      '繰り返し予定の変更は準備中',
    );

    await page.getByTestId('weekend-day-event-evt-all-members-all').click();
    const deleteDialog = page.getByTestId('event-dialog');
    await deleteDialog.getByRole('button', { name: '削除', exact: true }).click();
    await expect(deleteDialog.getByText('「家族全員の昼予定」を削除しますか？')).toBeVisible();
    await deleteDialog.getByTestId('confirm-delete-event').click();
    await expect(deleteDialog).toHaveCount(0);
    await expect(page.getByTestId('weekend-day-event-evt-all-members-all')).toHaveCount(0);
  });

  test('switching accounts removes the previous self-only event title', async ({ page }) => {
    const api = await mockDayApis(page);
    await page.goto(`/day/${SATURDAY}`);
    await expect(
      page.getByTestId(`weekend-day-personal-event-${ADULT_A}::personal-timed`),
    ).toContainText(A_PERSONAL_TITLE);
    api.setAccount('B');
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes('/api/auth/me') && response.status() === 200,
      ),
      triggerVisibilityCycle(page),
    ]);
    await expect(
      page.getByTestId(`weekend-day-personal-event-${ADULT_B}::personal-timed`),
    ).toContainText(B_PERSONAL_TITLE);
    await expect(
      page.getByTestId(`weekend-day-personal-event-${ADULT_A}::personal-timed`),
    ).toHaveCount(0);
  });

  test('contains horizontal scrolling inside a many-member timeline at 390px and 445px', async ({
    page,
  }) => {
    await mockDayApis(page, { manyMembers: true });
    await page.goto(`/day/${SATURDAY}`);
    const scroller = page.getByTestId('weekend-day-scroll');
    await expect(scroller).toBeVisible();
    const dimensions = await scroller.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    expect(dimensions.scroll).toBeGreaterThan(dimensions.client);
    await expectNoHorizontalOverflow(page);
    await page.setViewportSize({ width: 445, height: 844 });
    await expectNoHorizontalOverflow(page);
    await expectVisibleControlsAtLeast44px(page);
  });
});
