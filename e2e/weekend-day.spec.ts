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
  memberCount?: 2 | 4;
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

function familyFixture(
  account: Account,
  manyMembers = false,
  memberCount: 2 | 4 = 4,
): FamilyPublic {
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
  const visibleMembers = manyMembers ? ordered : ordered.slice(0, memberCount);
  const members: FamilyPublic['members'] = visibleMembers.map((member, sortOrder) => ({
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
  options: Partial<
    Pick<WeekEvent, 'assigneeMemberId' | 'status' | 'isRoutine' | 'items' | 'affectsAvailability'>
  > = {},
): WeekEvent {
  return {
    id,
    title,
    time: { kind: 'timed', start, endExclusive },
    memberIds,
    assigneeMemberId: options.assigneeMemberId ?? null,
    status: options.status ?? 'confirmed',
    isRoutine: options.isRoutine ?? false,
    affectsAvailability: options.affectsAvailability ?? true,
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
      'evt-width-control',
      '買い物の予定',
      `${date}T11:00:00+09:00`,
      `${date}T12:00:00+09:00`,
      [ADULT_B],
      { isRoutine: true },
    ),
    event(
      'evt-short-overlap-long',
      '1時間の比較予定',
      `${date}T09:00:00+09:00`,
      `${date}T10:00:00+09:00`,
      [],
    ),
    event(
      'evt-short-thirty',
      '30分の短い予定',
      `${date}T09:15:00+09:00`,
      `${date}T09:45:00+09:00`,
      [ADULT_C],
    ),
    event(
      'evt-short-fifteen',
      '15分の短い予定',
      `${date}T13:00:00+09:00`,
      `${date}T13:15:00+09:00`,
      [CHILD],
    ),
    event(
      'evt-candidate-items-hour',
      '持ち物あり候補',
      `${date}T13:00:00+09:00`,
      `${date}T14:00:00+09:00`,
      [],
      { status: 'tentative', items: ['水筒'] },
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
      'evt-nonblocking-routine',
      '空き判定しない家事代行',
      `${date}T19:00:00+09:00`,
      `${date}T20:00:00+09:00`,
      [ADULT_B],
      { isRoutine: true, affectsAvailability: false },
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
      `${date}T15:00:00+09:00`,
      `${date}T17:00:00+09:00`,
      [],
      {
        status: 'tentative',
        items: ['レジャーシート', '着替え'],
        assigneeMemberId: ADULT_A,
      },
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
      affectsAvailability: true,
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
        busy: [
          { start: `${day}T08:00:00+09:00`, end: `${day}T08:45:00+09:00` },
          { start: `${day}T09:00:00+09:00`, end: `${day}T09:15:00+09:00` },
        ],
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
              start: `${date}T15:00:00+09:00`,
              endExclusive: `${date}T16:00:00+09:00`,
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
          {
            id: `${memberId}::personal-short`,
            calendarId: `private_calendar_${activeAccount}`,
            title: '15分の自分だけ予定',
            time: {
              kind: 'timed',
              start: `${date}T13:00:00+09:00`,
              endExclusive: `${date}T13:15:00+09:00`,
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
      body: JSON.stringify({
        families: [familyFixture(account, options.manyMembers, options.memberCount)],
      }),
    });
  });

  await page.route('**/api/families/*/week**', async (route) => {
    const url = new URL(route.request().url());
    const requestedFamilyId = url.pathname.split('/')[3] ?? familyId(account);
    const requestedAccount: Account = requestedFamilyId === FAMILY_B ? 'B' : 'A';
    const family = familyFixture(requestedAccount, options.manyMembers, options.memberCount);
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
      affectsAvailability: true,
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

async function expectCardTitleAboveOverlappingFreeLabel(
  card: Locator,
  title: Locator,
  freeLabels: Locator,
  expectedOverlap: boolean,
) {
  await title.scrollIntoViewIfNeeded();
  const result = await card.evaluate(
    (cardElement, titleTestId) => {
      const titleElement =
        cardElement.querySelector(`[data-testid="${titleTestId}"]`) ??
        cardElement.querySelector('span');
      if (!titleElement) return { foundTitle: false, overlaps: [], titleInsideCard: false };
      const titleRect = titleElement.getBoundingClientRect();
      const faceElement =
        cardElement.querySelector<HTMLElement>('[data-testid^="weekend-day-event-face-"]') ??
        cardElement;
      const cardRect = faceElement.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(titleElement);
      const visibleTextRects = Array.from(range.getClientRects())
        .map((rect) => ({
          left: Math.max(rect.left, titleRect.left),
          right: Math.min(rect.right, titleRect.right),
          top: Math.max(rect.top, titleRect.top),
          bottom: Math.min(rect.bottom, titleRect.bottom),
        }))
        .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
      const visibleTextRect = visibleTextRects[0];
      const titleInsideCard =
        titleRect.width > 0 &&
        titleRect.height > 0 &&
        titleRect.left >= cardRect.left &&
        titleRect.right <= cardRect.right &&
        titleRect.top >= cardRect.top &&
        titleRect.bottom <= cardRect.bottom;
      const overlaps: Array<{
        label: string;
        topmost: string | null;
        cardZ: string;
        labelZ: string;
        labelParentZ: string | null;
        visible: boolean;
      }> = [];
      for (const label of document.querySelectorAll<HTMLElement>(
        '[data-testid^="weekend-day-free-band-"]',
      )) {
        const labelRect = label.getBoundingClientRect();
        if (!visibleTextRect) continue;
        const left = Math.max(visibleTextRect.left, labelRect.left);
        const right = Math.min(visibleTextRect.right, labelRect.right);
        const top = Math.max(visibleTextRect.top, labelRect.top);
        const bottom = Math.min(visibleTextRect.bottom, labelRect.bottom);
        if (right <= left || bottom <= top) continue;
        const point = { x: left + Math.min(2, (right - left) / 2), y: (top + bottom) / 2 };
        const topmost = document.elementFromPoint(point.x, point.y);
        const overlap = {
          label: label.textContent ?? '',
          topmost: topmost?.getAttribute('data-testid') ?? topmost?.tagName ?? null,
          cardZ: getComputedStyle(cardElement).zIndex,
          labelZ: getComputedStyle(label).zIndex,
          labelParentZ: label.parentElement ? getComputedStyle(label.parentElement).zIndex : null,
          visible: Boolean(topmost && titleElement.contains(topmost)),
        };
        if (!topmost || !titleElement.contains(topmost)) {
          overlap.topmost = topmost
            ? `${topmost.tagName}.${topmost instanceof HTMLElement ? topmost.className : ''}`
            : 'no-element-at-overlap';
        }
        overlaps.push(overlap);
      }
      return {
        foundTitle: true,
        titleInsideCard,
        overlaps,
      };
    },
    await title.getAttribute('data-testid'),
  );
  await expect(title).toBeVisible();
  expect(await card.getAttribute('aria-label')).toContain((await title.textContent()) ?? '');
  expect(result.foundTitle).toBe(true);
  expect(result.titleInsideCard, JSON.stringify(result.overlaps)).toBe(true);
  expect(result.overlaps.length > 0, JSON.stringify(result)).toBe(expectedOverlap);
  for (const overlap of result.overlaps) {
    expect(overlap.visible, JSON.stringify(overlap)).toBe(true);
    expect(Number(overlap.cardZ)).toBeGreaterThan(Number(overlap.labelParentZ));
    expect(Number(overlap.cardZ)).toBeGreaterThan(Number(overlap.labelZ));
  }
  await expect(freeLabels).not.toHaveCount(0);
}

async function expectTextFirstGlyphHitWithinCard(text: Locator, card: Locator) {
  await text.scrollIntoViewIfNeeded();
  const expectedCard = await card.getAttribute('data-testid');
  const result = await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const bounds = range.getClientRects()[0];
    if (!bounds) return { foundText: false, hitCard: null };
    const hit = document.elementFromPoint(
      bounds.left + Math.min(2, bounds.width / 2),
      bounds.top + bounds.height / 2,
    );
    return {
      foundText: true,
      hitCard:
        hit?.closest('button[data-testid^="weekend-day-event-"]')?.getAttribute('data-testid') ??
        null,
    };
  });
  expect(result.foundText).toBe(true);
  expect(result.hitCard, `first glyph of ${await text.textContent()} was occluded`).toBe(
    expectedCard,
  );
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
      const isDenseTimelineEvent = await control.evaluate((element) =>
        element.matches('.day-timeline-event, .day-timeline-event__hit'),
      );
      // Narrow event lanes divide their column width; keep their tap height while allowing that specified width.
      if (!isDenseTimelineEvent) expect(bounds.width).toBeGreaterThanOrEqual(44);
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
    const scroller = page.getByTestId('weekend-day-scroll');
    const timeline = page.getByTestId('weekend-day-timeline');
    const memberIds = [ADULT_A, ADULT_B, ADULT_C, CHILD];
    const memberNames = ['大人甲', '大人乙', '大人丙', '子ども'];
    const [scrollportBounds, scrollMetrics] = await Promise.all([
      scroller.boundingBox(),
      scroller.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      })),
    ]);
    expect(scrollportBounds).not.toBeNull();
    expect(scrollMetrics.scroll).toBeLessThanOrEqual(scrollMetrics.client);
    const columnBounds = await Promise.all(
      memberIds.map((memberId) => page.getByTestId(`weekend-day-column-${memberId}`).boundingBox()),
    );
    expect(columnBounds.every((bounds) => bounds !== null)).toBe(true);
    const widths = columnBounds.map((bounds) => bounds?.width ?? 0);
    for (const width of widths.slice(1)) expect(width).toBeCloseTo(widths[0] ?? 0, 0);
    for (const width of widths) expect(width).toBeLessThan(90);
    if (scrollportBounds) {
      for (const name of memberNames) {
        const heading = scroller.getByText(name, { exact: true }).first();
        await expect(heading).toBeVisible();
        const headingBounds = await heading.boundingBox();
        expect(headingBounds).not.toBeNull();
        if (headingBounds) {
          expect(headingBounds.x).toBeGreaterThanOrEqual(scrollportBounds.x);
          expect(headingBounds.x + headingBounds.width).toBeLessThanOrEqual(
            scrollportBounds.x + scrollportBounds.width,
          );
        }
      }
    }
    const finalTick = timeline.getByText('21', { exact: true });
    await expect(finalTick).toBeVisible();
    const [finalTickBounds, timelineBounds] = await Promise.all([
      finalTick.boundingBox(),
      timeline.boundingBox(),
    ]);
    expect(finalTickBounds).not.toBeNull();
    expect(timelineBounds).not.toBeNull();
    if (finalTickBounds && timelineBounds) {
      expect(finalTickBounds.height).toBeGreaterThan(0);
      expect(finalTickBounds.y).toBeGreaterThanOrEqual(timelineBounds.y);
      expect(finalTickBounds.y + finalTickBounds.height).toBeLessThanOrEqual(
        timelineBounds.y + timelineBounds.height,
      );
    }
    const adultColumn = page.getByTestId(`weekend-day-column-${ADULT_A}`);
    const childColumn = page.getByTestId(`weekend-day-column-${CHILD}`);
    const narrowRoutine = page.getByTestId(`weekend-day-event-evt-routine-${ADULT_B}`);
    await expect(narrowRoutine.getByText('16:00–17:00 · 大人乙', { exact: true })).toBeHidden();
    const narrowWidthControl = page.getByTestId(`weekend-day-event-evt-width-control-${ADULT_B}`);
    await expect(
      narrowWidthControl.getByText('11:00–12:00 · 大人乙', { exact: true }),
    ).toBeHidden();
    const assignedAdult = page.getByTestId(`weekend-day-event-evt-assigned-piano-${ADULT_A}`);
    await expect(assignedAdult).toHaveAttribute('aria-label', /担当 大人甲/);
    await expect(page.getByTestId(`weekend-day-event-evt-assigned-piano-${CHILD}`)).toContainText(
      'ピアノ教室',
    );
    await expect(adultColumn.getByText('重なる送迎予定')).toBeVisible();
    await expect(page.getByTestId(`weekend-day-event-evt-routine-${ADULT_B}`)).toHaveAttribute(
      'aria-label',
      /繰り返し予定/,
    );
    await expect(
      page.getByTestId(`weekend-day-event-evt-nonblocking-routine-${ADULT_B}`),
    ).toHaveAttribute('aria-label', /繰り返し予定/);
    await expect(page.getByText('みんな空き 18:30–20:00', { exact: true })).toBeVisible();
    const overlapPiano = page.getByTestId(`weekend-day-event-evt-overlap-piano-${ADULT_A}`);
    const overlapTitle = overlapPiano.getByTestId('weekend-day-event-title-evt-overlap-piano');
    await expect(overlapPiano).toHaveAttribute('aria-label', /重なる送迎予定.*09:30–10:30/);
    await expect(overlapTitle).toBeVisible();
    const titleStyle = await overlapTitle.evaluate((element) => ({
      textOverflow: getComputedStyle(element).textOverflow,
      bounds: element.getBoundingClientRect().toJSON(),
      card: element.closest('button')?.getBoundingClientRect().toJSON(),
    }));
    expect(titleStyle.textOverflow).toBe('ellipsis');
    expect(titleStyle.card).not.toBeUndefined();
    if (titleStyle.card) {
      expect(titleStyle.bounds.left).toBeGreaterThanOrEqual(titleStyle.card.left);
      expect(titleStyle.bounds.right).toBeLessThanOrEqual(titleStyle.card.right);
    }
    await expect(page.getByTestId('weekend-day-event-evt-candidate-picnic-all')).toContainText(
      '公園ピクニック',
    );
    await expect(page.getByTestId('weekend-day-event-evt-candidate-picnic-all')).toHaveAttribute(
      'aria-label',
      /候補.*持ち物 レジャーシート、着替え/,
    );
    const picnic = page.getByTestId('weekend-day-event-evt-candidate-picnic-all');
    await expect(picnic.getByText('候補', { exact: true })).toBeVisible();
    await expect(picnic.getByText('15:00–17:00 · 家族全員', { exact: true })).toBeVisible();
    await expect(picnic.getByText('担当：大人甲', { exact: true })).toBeVisible();
    await expect(picnic.getByText('レジャーシート', { exact: true })).toBeVisible();
    await expect(picnic.getByText('着替え', { exact: true })).toBeVisible();
    for (const label of [
      picnic.getByText('候補', { exact: true }),
      picnic.getByText('15:00–17:00 · 家族全員', { exact: true }),
      picnic.getByText('担当：大人甲', { exact: true }),
      picnic.getByText('レジャーシート', { exact: true }),
      picnic.getByText('着替え', { exact: true }),
    ]) {
      await expectTextFirstGlyphHitWithinCard(label, picnic);
    }
    const assignedBounds = await page
      .getByTestId(`weekend-day-event-face-evt-assigned-piano-${ADULT_A}`)
      .boundingBox();
    const overlapBounds = await page
      .getByTestId(`weekend-day-event-face-evt-overlap-piano-${ADULT_A}`)
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
      .getByTestId(`weekend-day-event-face-evt-candidate-overlap-${ADULT_A}`)
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
    const narrowCandidate = page.getByTestId(`weekend-day-event-evt-candidate-overlap-${ADULT_A}`);
    const narrowCandidateFace = page.getByTestId(
      `weekend-day-event-face-evt-candidate-overlap-${ADULT_A}`,
    );
    const narrowCandidateBounds = await narrowCandidateFace.boundingBox();
    expect(narrowCandidateBounds).not.toBeNull();
    if (narrowCandidateBounds) expect(narrowCandidateBounds.width).toBeLessThan(90);
    const narrowCandidateBorder = await narrowCandidateFace.evaluate(
      (element) => getComputedStyle(element).borderTopStyle,
    );
    const narrowCandidateMark = narrowCandidate.getByText('候', { exact: true });
    expect(narrowCandidateBorder === 'dashed' || (await narrowCandidateMark.count()) > 0).toBe(
      true,
    );
    if ((await narrowCandidateMark.count()) > 0) {
      await expect(narrowCandidateMark).toBeVisible();
      const [markBounds, cardBounds] = await Promise.all([
        narrowCandidateMark.boundingBox(),
        narrowCandidateFace.boundingBox(),
      ]);
      expect(markBounds).not.toBeNull();
      expect(cardBounds).not.toBeNull();
      if (markBounds && cardBounds) {
        expect(markBounds.x).toBeGreaterThanOrEqual(cardBounds.x);
        expect(markBounds.x + markBounds.width).toBeLessThanOrEqual(
          cardBounds.x + cardBounds.width,
        );
      }
    }
    const shortBusy = page.getByTestId(`weekend-day-personal-busy-${SATURDAY}-${ADULT_C}-0`);
    const [shortBusyBounds, busyTimelineBounds] = await Promise.all([
      shortBusy.boundingBox(),
      page.getByTestId('weekend-day-timeline').boundingBox(),
    ]);
    expect(shortBusyBounds).not.toBeNull();
    expect(busyTimelineBounds).not.toBeNull();
    if (shortBusyBounds && busyTimelineBounds) {
      expect(shortBusyBounds.y).toBeCloseTo(busyTimelineBounds.y + 48, 0);
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
    const candidateFace = page.getByTestId('weekend-day-event-face-evt-candidate-picnic-all');
    const lunchFace = page.getByTestId('weekend-day-event-face-evt-all-members-all');
    const [candidateBounds, lunchBounds] = await Promise.all([
      candidateFace.boundingBox(),
      lunchFace.boundingBox(),
    ]);
    expect(candidateBounds).not.toBeNull();
    expect(lunchBounds).not.toBeNull();
    if (candidateBounds && lunchBounds) {
      expect(candidateBounds.y).toBeGreaterThanOrEqual(lunchBounds.y + lunchBounds.height - 1);
      expect(candidateBounds.x).toBeCloseTo(lunchBounds.x, 0);
      expect(candidateBounds.width).toBeCloseTo(lunchBounds.width, 0);
    }
    const allMemberSpan = page.getByTestId('weekend-day-event-evt-all-span-only-all');
    const allMemberSpanFace = page.getByTestId('weekend-day-event-face-evt-all-span-only-all');
    await expect(allMemberSpan).toHaveCount(1);
    const [spanBounds, firstColumnBounds, lastColumnBounds] = await Promise.all([
      allMemberSpanFace.boundingBox(),
      page.getByTestId(`weekend-day-column-${ADULT_A}`).boundingBox(),
      page.getByTestId(`weekend-day-column-${CHILD}`).boundingBox(),
    ]);
    expect(spanBounds).not.toBeNull();
    expect(firstColumnBounds).not.toBeNull();
    expect(lastColumnBounds).not.toBeNull();
    if (spanBounds && firstColumnBounds && lastColumnBounds) {
      expect(spanBounds.x).toBeCloseTo(firstColumnBounds.x, 0);
      expect(spanBounds.x + spanBounds.width).toBeCloseTo(
        lastColumnBounds.x + lastColumnBounds.width,
        0,
      );
      expect(spanBounds.width).toBeCloseTo(
        widths.reduce((sum, width) => sum + width, 0),
        0,
      );
    }
    await expect(allMemberSpan).toContainText('家族全員で見る予定');
    const spanningBackground = await allMemberSpanFace.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    const freeBandBackground = await page
      .getByTestId('weekend-day-free-band-0')
      .evaluate(
        (element) =>
          getComputedStyle(
            element.parentElement?.querySelector('span[aria-hidden="true"]') ?? element,
          ).backgroundColor,
      );
    expect(spanningBackground).not.toBe(freeBandBackground);
    const chipColor = await allMemberSpanFace.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--chip)';
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    expect(spanningBackground).toBe(chipColor);
    await expect(
      page.getByTestId(`weekend-day-personal-busy-${SATURDAY}-${ADULT_B}-0`),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: '読み上げ用の予定と空きの一覧' })).toContainText(
      '予定あり',
    );
    await expect(
      page.getByTestId(`weekend-day-personal-event-${ADULT_A}::personal-timed`),
    ).toContainText(A_PERSONAL_TITLE);
    const selfTitle = page.getByTestId(`weekend-day-personal-title-${ADULT_A}::personal-timed`);
    const selfCard = page.getByTestId(`weekend-day-personal-event-${ADULT_A}::personal-timed`);
    const selfFace = page.getByTestId(`weekend-day-personal-event-face-${ADULT_A}::personal-timed`);
    const freeLabels = page.locator('[data-testid^="weekend-day-free-band-"]');
    await expect(freeLabels).not.toHaveCount(0);
    const [selfTitleBounds, selfCardBounds] = await Promise.all([
      selfTitle.boundingBox(),
      selfFace.boundingBox(),
    ]);
    expect(selfTitleBounds).not.toBeNull();
    expect(selfCardBounds).not.toBeNull();
    if (selfTitleBounds && selfCardBounds) {
      expect(selfTitleBounds.y).toBeGreaterThanOrEqual(selfCardBounds.y);
      expect(selfTitleBounds.y + selfTitleBounds.height).toBeLessThanOrEqual(
        selfCardBounds.y + selfCardBounds.height,
      );
    }
    const candidateTitle = page.getByTestId('weekend-day-event-title-evt-candidate-picnic');
    const [candidateCardBounds, candidateTitleBounds, privateTitleCardBounds] = await Promise.all([
      candidateFace.boundingBox(),
      candidateTitle.boundingBox(),
      selfFace.boundingBox(),
    ]);
    expect(candidateCardBounds).not.toBeNull();
    expect(candidateTitleBounds).not.toBeNull();
    expect(privateTitleCardBounds).not.toBeNull();
    if (candidateCardBounds && candidateTitleBounds && privateTitleCardBounds) {
      expect(candidateTitleBounds.x).toBeGreaterThanOrEqual(
        privateTitleCardBounds.x + privateTitleCardBounds.width,
      );
      expect(candidateTitleBounds.x + candidateTitleBounds.width).toBeLessThanOrEqual(
        candidateCardBounds.x + candidateCardBounds.width,
      );
    }
    await expect(candidateTitle).toHaveCSS('text-overflow', 'ellipsis');
    await expectCardTitleAboveOverlappingFreeLabel(candidate, candidateTitle, freeLabels, true);
    await expectCardTitleAboveOverlappingFreeLabel(selfCard, selfTitle, freeLabels, true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.getByTestId('weekend-day-all-day')).toContainText('終日の家族予定');
    await expect(page.getByTestId('weekend-day-all-day')).toContainText('A本人だけの終日予定');
    await expect(page.getByTestId('weekend-day-outside-hours')).toContainText('朝の家族予定');
    await expect(page.getByTestId('weekend-day-outside-hours')).toContainText('夜の家族予定');
    await expect(page.getByTestId('weekend-day-outside-hours')).toContainText('A本人だけの夜予定');

    const crossingEvent = page.getByTestId(`weekend-day-event-evt-cross-opening-${CHILD}`);
    const dayTimelineBounds = await page.getByTestId('weekend-day-timeline').boundingBox();
    const clipped = await crossingEvent.boundingBox();
    expect(dayTimelineBounds).not.toBeNull();
    expect(clipped).not.toBeNull();
    if (dayTimelineBounds && clipped) {
      expect(clipped.y).toBeCloseTo(dayTimelineBounds.y, 0);
      expect(clipped.y + clipped.height).toBeLessThanOrEqual(
        dayTimelineBounds.y + dayTimelineBounds.height,
      );
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

  test('shows event details when the rendered card has enough width', async ({ page }) => {
    await mockDayApis(page, { memberCount: 2 });
    await page.goto(`/day/${SATURDAY}`);
    await expect(page.getByTestId('weekend-day-timeline')).toBeVisible();
    const scroller = page.getByTestId('weekend-day-scroll');
    const columnBounds = await Promise.all(
      [ADULT_A, ADULT_B].map((memberId) =>
        page.getByTestId(`weekend-day-column-${memberId}`).boundingBox(),
      ),
    );
    expect(columnBounds.every((bounds) => bounds !== null)).toBe(true);
    const widths = columnBounds.map((bounds) => bounds?.width ?? 0);
    for (const width of widths) {
      expect(width).toBeGreaterThanOrEqual(140);
      expect(width).toBeLessThan(180);
    }
    expect(widths[0]).toBeCloseTo(widths[1] ?? 0, 0);
    const widthControl = page.getByTestId(`weekend-day-event-evt-width-control-${ADULT_B}`);
    await expect(widthControl.getByText('11:00–12:00 · 大人乙', { exact: true })).toBeVisible();
    const scrollMetrics = await scroller.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    expect(scrollMetrics.scroll).toBeLessThanOrEqual(scrollMetrics.client);
  });

  test('keeps visual event faces true to duration and routes expanded transparent hits to the shorter event', async ({
    page,
  }) => {
    await mockDayApis(page);
    await page.goto(`/day/${SATURDAY}`);
    await expect(page.getByTestId('weekend-day-timeline')).toBeVisible();

    const face = (id: string, suffix: string) =>
      page.getByTestId(`weekend-day-event-face-${id}-${suffix}`);
    const hit = (id: string, suffix: string) =>
      page.getByTestId(`weekend-day-event-${id}-${suffix}`);
    const oneHour = face('evt-width-control', ADULT_B);
    const oneHourCandidate = face('evt-candidate-items-hour', 'all');
    const thirtyMinutes = face('evt-short-thirty', ADULT_C);
    const fifteenMinutes = face('evt-short-fifteen', CHILD);
    for (const [eventFace, expectedHeight] of [
      [oneHour, 48],
      [oneHourCandidate, 48],
      [thirtyMinutes, 24],
      [fifteenMinutes, 24],
    ] as const) {
      const bounds = await eventFace.boundingBox();
      expect(bounds).not.toBeNull();
      if (bounds) expect(bounds.height).toBeCloseTo(expectedHeight, 0);
    }
    await expect(oneHourCandidate).toContainText('持ち物あり候補');
    await expect(oneHourCandidate).toContainText('候補');
    await expect(oneHourCandidate.getByText('水筒', { exact: true })).toBeHidden();

    const longFace = face('evt-short-overlap-long', 'all');
    const shortFace = thirtyMinutes;
    const shortHit = hit('evt-short-thirty', ADULT_C);
    const [longBounds, shortBounds, shortHitBounds] = await Promise.all([
      longFace.boundingBox(),
      shortFace.boundingBox(),
      shortHit.boundingBox(),
    ]);
    expect(longBounds).not.toBeNull();
    expect(shortBounds).not.toBeNull();
    expect(shortHitBounds).not.toBeNull();
    if (longBounds && shortBounds && shortHitBounds) {
      expect(shortHitBounds.height).toBeGreaterThanOrEqual(44);
      const left = Math.max(longBounds.x, shortHitBounds.x);
      const right = Math.min(
        longBounds.x + longBounds.width,
        shortHitBounds.x + shortHitBounds.width,
      );
      const top = Math.max(longBounds.y, shortHitBounds.y);
      const bottom = Math.min(
        longBounds.y + longBounds.height,
        shortHitBounds.y + shortHitBounds.height,
      );
      let transparentPoint: { x: number; y: number } | null = null;
      for (let y = top; y < bottom && !transparentPoint; y += 1) {
        for (let x = left; x < right; x += 1) {
          const inShortFace =
            x >= shortBounds.x &&
            x <= shortBounds.x + shortBounds.width &&
            y >= shortBounds.y &&
            y <= shortBounds.y + shortBounds.height;
          if (!inShortFace) {
            transparentPoint = { x: x + 0.5, y: y + 0.5 };
            break;
          }
        }
      }
      expect(
        transparentPoint,
        'the short event should expose a transparent hit area over the long face',
      ).not.toBeNull();
      if (transparentPoint) {
        const [shortZ, longZ] = await Promise.all([
          shortHit.evaluate((element) => Number(getComputedStyle(element).zIndex)),
          hit('evt-short-overlap-long', 'all').evaluate((element) =>
            Number(getComputedStyle(element).zIndex),
          ),
        ]);
        expect(shortZ).toBeGreaterThan(longZ);
        const topHit = await page.evaluate(({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          return element
            ?.closest('button[data-testid^="weekend-day-event-"]')
            ?.getAttribute('data-testid');
        }, transparentPoint);
        expect(topHit).toBe(`weekend-day-event-evt-short-thirty-${ADULT_C}`);
        await page.mouse.click(transparentPoint.x, transparentPoint.y);
        await expect(page.getByTestId('event-dialog').getByLabel('タイトル')).toHaveValue(
          '30分の短い予定',
        );
        await page.getByTestId('event-dialog').getByRole('button', { name: 'キャンセル' }).click();
      }
    }

    const twelveTick = page.getByTestId('weekend-day-timeline').getByText('12', { exact: true });
    const controlBounds = await oneHour.boundingBox();
    const tickBounds = await twelveTick.boundingBox();
    expect(controlBounds).not.toBeNull();
    expect(tickBounds).not.toBeNull();
    if (controlBounds && tickBounds) {
      expect(controlBounds.y + controlBounds.height).toBeLessThanOrEqual(
        tickBounds.y + tickBounds.height / 2 + 1,
      );
    }
    const noonBandLabel = page
      .locator('[data-testid^="weekend-day-free-band-"]')
      .filter({ hasText: '12:00' })
      .first();
    await expect(noonBandLabel).toBeVisible();
    const noonLabelHit = await noonBandLabel.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const bounds = range.getClientRects()[0];
      if (!bounds) return false;
      const hitElement = document.elementFromPoint(
        bounds.left + Math.min(2, bounds.width / 2),
        bounds.top + bounds.height / 2,
      );
      return (
        hitElement?.closest('[data-testid^="weekend-day-free-add-"]') === element.parentElement &&
        !hitElement.closest('button[data-testid^="weekend-day-event-"]')
      );
    });
    expect(noonLabelHit).toBe(true);

    const thirtyHitBounds = await hit('evt-short-thirty', ADULT_C).boundingBox();
    expect(thirtyHitBounds).not.toBeNull();
    if (thirtyHitBounds) expect(thirtyHitBounds.height).toBeGreaterThanOrEqual(44);
    await expect(
      thirtyMinutes.getByTestId('weekend-day-event-title-evt-short-thirty'),
    ).toBeVisible();
    const thirtyTitle = thirtyMinutes.getByTestId('weekend-day-event-title-evt-short-thirty');
    const [thirtyTitleBounds, thirtyFaceBounds] = await Promise.all([
      thirtyTitle.boundingBox(),
      thirtyMinutes.boundingBox(),
    ]);
    expect(thirtyTitleBounds).not.toBeNull();
    expect(thirtyFaceBounds).not.toBeNull();
    if (thirtyTitleBounds && thirtyFaceBounds) {
      expect(thirtyTitleBounds.y).toBeGreaterThanOrEqual(thirtyFaceBounds.y);
      expect(thirtyTitleBounds.y + thirtyTitleBounds.height).toBeLessThanOrEqual(
        thirtyFaceBounds.y + thirtyFaceBounds.height,
      );
    }
    const shortBusyFace = page.getByTestId(`weekend-day-personal-busy-${SATURDAY}-${ADULT_C}-1`);
    const shortBusyBounds = await shortBusyFace.boundingBox();
    expect(shortBusyBounds).not.toBeNull();
    if (shortBusyBounds) expect(shortBusyBounds.height).toBeCloseTo(24, 0);

    const shortPrivate = page.getByTestId(
      `weekend-day-personal-event-face-${ADULT_A}::personal-short`,
    );
    await expect(shortPrivate).toBeVisible();
    const privateBounds = await shortPrivate.boundingBox();
    expect(privateBounds).not.toBeNull();
    if (privateBounds) expect(privateBounds.height).toBeCloseTo(24, 0);
    await expect(shortPrivate).toContainText('15分の自分だけ予定');
    await expect(shortPrivate.locator('svg')).toBeVisible();
    await expect(
      page.getByTestId(`weekend-day-personal-event-${ADULT_A}::personal-short`),
    ).toHaveAttribute('aria-label', /自分だけに見える予定/);
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
