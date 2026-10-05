import { expect, test } from '@playwright/test';
import type { FamilyPublic } from '../src/shared/schemas/family';

test.use({
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  timezoneId: 'UTC',
  locale: 'ja-JP',
});

const FAMILY_ID = 'fam_busy_a';
const USER_A = 'usr_busy_a';
const MEMBER_A = 'mem_busy_a';
const PRIMARY_ID = 'primary';
const WORK_ID = 'work-calendar@example.test';

const familyA: FamilyPublic = {
  id: FAMILY_ID,
  name: '空き状況サンプル家',
  familyCalendarId: 'family-calendar-busy-synthetic',
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
      id: 'mem_busy_child',
      userId: null,
      kind: 'child',
      name: '子ども',
      color: 'ochre',
      sortOrder: 1,
    },
  ],
};

function calendars(memberId: string, selected: string[], hasSavedSelection = selected.length > 0) {
  return {
    status: 'ready',
    memberId,
    hasSavedSelection,
    calendars: [
      {
        id: PRIMARY_ID,
        name: '自分のカレンダー',
        isPrimary: true,
        selected: selected.includes(PRIMARY_ID),
      },
      {
        id: WORK_ID,
        name: '仕事の予定',
        isPrimary: false,
        selected: selected.includes(WORK_ID),
      },
    ],
  };
}

async function mockBusyApis(
  page: import('@playwright/test').Page,
  options: {
    authorized?: boolean;
    selected?: string[];
    personalSelected?: string[];
  } = {},
) {
  let authorized = options.authorized ?? false;
  let savedBusyCalendarIds = options.selected ?? [];
  let personalCalendarIds = options.personalSelected ?? [PRIMARY_ID];
  let nextBusyPutStatus: number | null = null;
  const busyPutBodies: Array<{ calendarIds: string[] }> = [];
  const personalPutBodies: Array<{ calendarIds: string[] }> = [];
  let busyPutCount = 0;
  let signalBusyPut!: () => void;
  let releaseBusyPut!: () => void;
  let busyPutGate: Promise<void> | undefined;
  let holdNextBusyPut = false;

  await page.route('**/api/auth/me', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: USER_A, email: 'synthetic@example.test', displayName: 'テスト利用者' },
      }),
    }),
  );
  await page.route('**/api/families', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ families: [familyA] }),
    }),
  );
  await page.route(`**/api/families/${FAMILY_ID}`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ family: familyA }),
    }),
  );
  await page.route(`**/api/families/${FAMILY_ID}/closures`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ closures: [], hasMore: false }),
    }),
  );
  await page.route(`**/api/families/${FAMILY_ID}/personal-calendars`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(calendars(MEMBER_A, personalCalendarIds)),
      });
      return;
    }
    if (route.request().method() !== 'PUT') {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as { calendarIds: string[] };
    personalPutBodies.push(body);
    personalCalendarIds = body.calendarIds;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authorizationRequired: false,
        ...calendars(MEMBER_A, personalCalendarIds),
      }),
    });
  });
  await page.route(`**/api/families/${FAMILY_ID}/busy-calendars`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          authorized
            ? calendars(MEMBER_A, savedBusyCalendarIds)
            : { status: 'authorization_required', memberId: MEMBER_A, calendars: [] },
        ),
      });
      return;
    }
    if (route.request().method() !== 'PUT') {
      await route.fallback();
      return;
    }
    busyPutCount++;
    const body = route.request().postDataJSON() as { calendarIds: string[] };
    busyPutBodies.push(body);
    if (holdNextBusyPut) {
      holdNextBusyPut = false;
      signalBusyPut();
      await busyPutGate;
    }
    if (!authorized) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authorizationRequired: true,
          authorizationUrl:
            'https://accounts.google.com/o/oauth2/v2/auth?scope=openid%20email%20profile%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.freebusy&include_granted_scopes=true&login_hint=synthetic-user&state=busy-test',
        }),
      });
      return;
    }
    if (nextBusyPutStatus !== null) {
      const status = nextBusyPutStatus;
      nextBusyPutStatus = null;
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'GOOGLE_ERROR', error: 'private Google failure' }),
      });
      return;
    }
    savedBusyCalendarIds = body.calendarIds;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authorizationRequired: false,
        ...calendars(MEMBER_A, savedBusyCalendarIds),
      }),
    });
  });

  return {
    get busyPutBodies() {
      return busyPutBodies;
    },
    get busyPutCount() {
      return busyPutCount;
    },
    get personalPutBodies() {
      return personalPutBodies;
    },
    holdNextPut() {
      holdNextBusyPut = true;
      busyPutGate = new Promise<void>((resolve) => {
        releaseBusyPut = resolve;
      });
    },
    waitForPut: () =>
      new Promise<void>((resolve) => {
        signalBusyPut = resolve;
      }),
    releasePut: () => releaseBusyPut(),
    authorize: () => {
      authorized = true;
    },
    failNextPut: (status: number) => {
      nextBusyPutStatus = status;
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

test.describe('Task 2-2: busy calendar sharing settings', () => {
  test('requests free/busy consent once, saves calendars, and keeps personal display independent', async ({
    page,
  }) => {
    const api = await mockBusyApis(page);
    await page.route('https://accounts.google.com/**', async (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<title>Google consent mock</title>',
      }),
    );
    await page.goto('/family');
    const enable = page.getByTestId('enable-busy-sharing');
    await expect(enable).toBeVisible();
    await expect(page.getByText('予定のタイトルや内容は共有されません。')).toBeVisible();
    api.holdNextPut();
    const putEntered = api.waitForPut();
    await enable.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await putEntered;
    await expect(enable).toBeDisabled();
    expect(api.busyPutCount).toBe(1);
    expect(api.busyPutBodies).toEqual([{ calendarIds: [] }]);
    api.releasePut();
    await page.waitForURL(/accounts\.google\.com\/o\/oauth2/);
    const consentUrl = new URL(page.url());
    expect(consentUrl.searchParams.get('include_granted_scopes')).toBe('true');
    expect(consentUrl.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/calendar.freebusy',
    );
    expect(consentUrl.searchParams.get('login_hint')).toBe('synthetic-user');

    await page.goBack();
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await expect(enable).toBeEnabled();
    api.authorize();
    await page.goto('/family?busy=granted');

    const primary = page.getByTestId(`busy-calendar-${PRIMARY_ID}`);
    const work = page.getByTestId(`busy-calendar-${WORK_ID}`);
    const save = page.getByTestId('save-busy-calendars');
    const notice = page.getByTestId('busy-calendar-not-sharing');
    await expect(page.getByTestId('busy-consent-success')).toBeVisible();
    await expect(notice).toHaveText(
      '現在、空き状況は共有していません。共有するカレンダーを選んで保存してください。',
    );
    await expect(primary).not.toBeChecked();
    await expect(work).not.toBeChecked();
    await expect(save).toBeDisabled();
    await expect(page.getByTestId(`personal-calendar-${PRIMARY_ID}`)).toBeChecked();

    if (process.env.DANRAN_SCREENSHOTS === '1') {
      await page.goto('/family');
      await expect(page.getByTestId('busy-calendar-not-sharing')).toBeVisible();
      await expect(page.getByTestId(`busy-calendar-${PRIMARY_ID}`)).not.toBeChecked();
      await expect(page.getByTestId('save-busy-calendars')).toBeDisabled();
      const original = page.viewportSize();
      const fullHeight = await page.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      );
      await page.setViewportSize({ width: 390, height: fullHeight + 100 });
      await page.screenshot({ path: 'docs/screenshots/family.png', fullPage: true });
      if (original) await page.setViewportSize(original);
    }

    await primary.check();
    await expect(save).toBeEnabled();
    await save.click();
    expect(api.busyPutBodies.at(-1)).toEqual({ calendarIds: [PRIMARY_ID] });
    await expect(notice).toHaveCount(0);
    await expect(page.getByTestId(`personal-calendar-${PRIMARY_ID}`)).toBeChecked();
    expect(api.personalPutBodies).toEqual([]);

    await work.check();
    await save.click();
    expect(api.busyPutBodies.at(-1)).toEqual({ calendarIds: [PRIMARY_ID, WORK_ID] });
    await expect(page.getByTestId(`personal-calendar-${PRIMARY_ID}`)).toBeChecked();
    expect(api.personalPutBodies).toEqual([]);

    await primary.uncheck();
    await work.uncheck();
    await expect(save).toBeEnabled();
    await save.click();
    expect(api.busyPutBodies.at(-1)).toEqual({ calendarIds: [] });
    await expect(notice).toHaveText(
      '現在、空き状況は共有していません。共有するカレンダーを選んで保存してください。',
    );
    await expect(primary).not.toBeChecked();
    await expect(work).not.toBeChecked();
    await expect(save).toBeDisabled();
    await expect(page.getByTestId(`personal-calendar-${PRIMARY_ID}`)).toBeChecked();
    expect(api.personalPutBodies).toEqual([]);
    await page.reload();
    await expect(page.getByTestId('busy-calendar-not-sharing')).toHaveText(
      '現在、空き状況は共有していません。共有するカレンダーを選んで保存してください。',
    );
    await expect(page.getByTestId(`busy-calendar-${PRIMARY_ID}`)).not.toBeChecked();
    await expect(page.getByTestId(`busy-calendar-${WORK_ID}`)).not.toBeChecked();
    await expect(page.getByTestId('save-busy-calendars')).toBeDisabled();
    await expect(page.getByTestId(`personal-calendar-${PRIMARY_ID}`)).toBeChecked();

    for (const width of [390, 445]) {
      await page.setViewportSize({ width, height: 844 });
      await expectNoHorizontalOverflow(page);
      await expectVisibleHitTargetsAtLeast44px(page);
    }
  });

  test('keeps an unsaved choice after a failed save and shows fixed guidance', async ({ page }) => {
    const api = await mockBusyApis(page, { authorized: true });
    await page.goto('/family');
    const primary = page.getByTestId(`busy-calendar-${PRIMARY_ID}`);
    await expect(primary).not.toBeChecked();
    await primary.check();
    api.failNextPut(502);
    await page.getByTestId('save-busy-calendars').click();
    await expect(page.getByTestId('busy-calendar-save-error')).toHaveText(
      'Google カレンダーとの通信に失敗しました。',
    );
    await expect(primary).toBeChecked();
    await expect(page.locator('body')).not.toContainText('private Google failure');

    await page.getByTestId('save-busy-calendars').click();
    await expect(page.getByTestId('busy-calendar-not-sharing')).toHaveCount(0);
    expect(api.busyPutBodies.at(-1)).toEqual({ calendarIds: [PRIMARY_ID] });
  });

  test('shows only fixed OAuth failure guidance', async ({ page }) => {
    await mockBusyApis(page);
    for (const error of ['busy_denied', 'busy_failed', 'busy_account_mismatch']) {
      await page.goto(`/family?error=${error}&detail=private-google-error`);
      await expect(page.getByTestId('busy-consent-error')).toBeVisible();
      await expect(page.locator('body')).not.toContainText('private-google-error');
    }
  });
});
