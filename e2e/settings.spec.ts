import { expect, test } from '@playwright/test';
import type { ClosureDay } from '../src/shared/schemas/closure';
import type { DateKey } from '../src/shared/schemas/date';
import type { FamilyPublic } from '../src/shared/schemas/family';
import {
  type CreateClosureRangeInput,
  createClosureRangeInputSchema,
} from '../src/shared/schemas/settings';
import { type WeekEvent, type WeekResponse, weekResponseSchema } from '../src/shared/schemas/week';
import { addCalendarDays, getWeekday } from '../src/shared/time/date';
import { getWeekRange } from '../src/shared/time/week';

test.use({
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  timezoneId: 'UTC',
  locale: 'ja-JP',
});

const FAMILY_ID = 'fam_settings';
const BASE_WEEK = '2026-10-05' as DateKey;
const OWNER_ID = 'usr_owner';
const CURRENT_USER_ID = 'usr_adult_b';
const MEMBER_B_ID = 'mem_adult_b';
const MEMBER_CHILD_ID = 'mem_child';

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

const initialFamily: FamilyPublic = {
  id: FAMILY_ID,
  name: '設定サンプル家',
  familyCalendarId: 'cal_settings',
  ownerUserId: OWNER_ID,
  creationStatus: 'ready',
  members: [
    {
      id: 'mem_owner',
      userId: OWNER_ID,
      kind: 'adult',
      name: 'メンバー甲',
      color: 'indigo',
      sortOrder: 0,
    },
    {
      id: MEMBER_B_ID,
      userId: CURRENT_USER_ID,
      kind: 'adult',
      name: 'メンバー乙',
      color: 'green',
      sortOrder: 1,
    },
    {
      id: MEMBER_CHILD_ID,
      userId: null,
      kind: 'child',
      name: 'メンバー丙',
      color: 'ochre',
      sortOrder: 2,
    },
  ],
};

const targetEvent: WeekEvent = {
  id: 'evt_target',
  title: '対象予定',
  time: {
    kind: 'timed',
    start: '2026-10-07T10:00:00+09:00',
    endExclusive: '2026-10-07T11:00:00+09:00',
  },
  memberIds: [MEMBER_B_ID],
  assigneeMemberId: null,
  status: 'confirmed',
  isRoutine: false,
  source: 'manual',
  items: [],
};

function buildWeek(family: FamilyPublic, closures: ClosureDay[]): WeekResponse {
  const range = getWeekRange(BASE_WEEK);
  const weekClosures = closures.filter(
    (closure) => closure.date >= range.start && closure.date <= range.endInclusive,
  );
  const days = range.days.map((date) => {
    const dateClosures = weekClosures.filter((closure) => closure.date === date);
    const weekday = getWeekday(date);
    const isHoliday = date === '2026-10-12';
    const isWeekend = weekday === 0 || weekday === 6 || isHoliday;
    const hasEvent = date === '2026-10-07';
    return {
      date,
      weekday,
      holidayName: isHoliday ? 'スポーツの日' : null,
      closures: dateClosures.map(({ label, memberIds }) => ({ label, memberIds })),
      layout:
        isWeekend || dateClosures.length > 0
          ? ('weekend-card' as const)
          : hasEvent
            ? ('expanded' as const)
            : ('compact' as const),
      eventIds: hasEvent ? [targetEvent.id] : [],
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
      today: '2026-10-07',
    },
    days: [...days].reverse(),
    events: [targetEvent],
  });
}

function makeClosure(date: DateKey, label: string, memberIds: string[]): ClosureDay {
  return {
    id: `closure_${date}`,
    familyId: FAMILY_ID,
    date,
    label,
    memberIds,
  };
}

async function mockSettingsApis(page: import('@playwright/test').Page) {
  let family = structuredClone(initialFamily);
  let currentUserId = CURRENT_USER_ID;
  let familyReads = 0;
  let closures: ClosureDay[] = [makeClosure('2026-10-12' as DateKey, '行事振替休み', [])];
  const memberPatches: Array<{ memberId: string; body: { name: string; color: string } }> = [];
  const closurePosts: CreateClosureRangeInput[] = [];
  const closureDeletes: string[] = [];

  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: currentUserId,
          email: 'adult-b@example.test',
          displayName: currentUserId === CURRENT_USER_ID ? '設定担当' : '別利用者',
        },
      }),
    });
  });
  await page.route('**/api/families', async (route) => {
    familyReads++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ families: [family] }),
    });
  });
  await page.route(`**/api/families/${FAMILY_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ family }),
    });
  });
  await page.route(`**/api/families/${FAMILY_ID}/week**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildWeek(family, closures)),
    });
  });
  await page.route(`**/api/families/${FAMILY_ID}/personal-calendars`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'authorization_required',
        memberId: MEMBER_B_ID,
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
        memberId: MEMBER_B_ID,
        calendars: [],
      }),
    }),
  );
  await page.route(`**/api/families/${FAMILY_ID}/members/*`, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback();
      return;
    }
    const memberId = new URL(route.request().url()).pathname.split('/').at(-1);
    const body = route.request().postDataJSON() as { name: string; color: string };
    if (!memberId) throw new Error('Expected member ID in PATCH path');
    memberPatches.push({ memberId, body });
    family = {
      ...family,
      members: family.members.map((member) =>
        member.id === memberId
          ? { ...member, name: body.name, color: body.color as typeof member.color }
          : member,
      ),
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ family }),
    });
  });
  await page.route('**/api/families/*/closures', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ closures, hasMore: false }),
      });
      return;
    }
    if (route.request().method() === 'POST') {
      const body = createClosureRangeInputSchema.parse(route.request().postDataJSON());
      closurePosts.push(body);
      const endDate = body.endDate ?? body.startDate;
      const createdDates: DateKey[] = [];
      let date = body.startDate;
      while (date <= endDate) {
        createdDates.push(date);
        date = addCalendarDays(date, 1);
      }
      const canonicalMemberIds = [...new Set(body.memberIds)].sort();
      const created = createdDates.map((dateKey) => {
        const existing = closures.find(
          (closure) =>
            closure.date === dateKey &&
            closure.label === body.label.trim() &&
            JSON.stringify([...closure.memberIds].sort()) === JSON.stringify(canonicalMemberIds),
        );
        return existing ?? makeClosure(dateKey, body.label.trim(), canonicalMemberIds);
      });
      closures = [
        ...closures,
        ...created.filter((closure) => !closures.some((old) => old.id === closure.id)),
      ];
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ closures: created }),
      });
      return;
    }
    await route.fallback();
  });
  await page.route(`**/api/families/${FAMILY_ID}/closures/*`, async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback();
      return;
    }
    const closureId = new URL(route.request().url()).pathname.split('/').at(-1);
    if (!closureId) throw new Error('Expected closure ID in DELETE path');
    closureDeletes.push(closureId);
    closures = closures.filter((closure) => closure.id !== closureId);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
  return {
    memberPatches,
    closurePosts,
    closureDeletes,
    get family() {
      return family;
    },
    get familyReads() {
      return familyReads;
    },
    setFamily: (nextFamily: FamilyPublic) => {
      family = nextFamily;
    },
    setCurrentUserId: (userId: string) => {
      currentUserId = userId;
    },
    get closures() {
      return closures;
    },
  };
}

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const sizes = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(sizes.document, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.viewport);
}

async function expectVisibleTargetsAtLeast44px(page: import('@playwright/test').Page) {
  const controls = page.locator(
    'main button:visible, main input:visible:not([type="checkbox"]):not([type="radio"]), main select:visible',
  );
  for (const control of await controls.all()) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    if (bounds) {
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
  }
  for (const input of await page.locator('main input[type="checkbox"]:visible').all()) {
    const bounds = await input.locator('xpath=ancestor::label[1]').boundingBox();
    expect(bounds?.width).toBeGreaterThanOrEqual(44);
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }
}

test.describe('Task 1-9: family settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Date.now = () => Date.parse('2026-10-07T12:00:00+09:00');
    });
  });

  test('an active non-owner adult updates a member and creates/deletes a closure reflected in the week view', async ({
    page,
  }) => {
    const api = await mockSettingsApis(page);
    let releasePatch: (() => void) | undefined;
    let patchStarted: (() => void) | undefined;
    let patchRequests = 0;
    const patchStartedPromise = new Promise<void>((resolve) => {
      patchStarted = resolve;
    });
    const patchGate = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    await page.route(`**/api/families/${FAMILY_ID}/members/${MEMBER_B_ID}`, async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.fallback();
        return;
      }
      patchRequests++;
      patchStarted?.();
      await patchGate;
      await route.fallback();
    });

    await page.goto('/family');
    await expect(page.getByRole('heading', { name: 'メンバー' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '休園日', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectVisibleTargetsAtLeast44px(page);
    await page.setViewportSize({ width: 445, height: 844 });
    await expectNoHorizontalOverflow(page);
    await expectVisibleTargetsAtLeast44px(page);
    await page.setViewportSize({ width: 390, height: 844 });

    const nameInput = page.getByTestId(`member-name-${MEMBER_B_ID}`);
    const colorSelect = page.getByTestId(`member-color-${MEMBER_B_ID}`);
    await nameInput.fill('家族メンバー改');
    await colorSelect.selectOption('coral');
    const saveMember = page.getByTestId(`save-member-${MEMBER_B_ID}`);
    await saveMember.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await patchStartedPromise;
    await expect(saveMember).toBeDisabled();
    await page.waitForTimeout(100);
    expect(patchRequests).toBe(1);
    releasePatch?.();
    await expect(page.getByText('家族メンバー改', { exact: true })).toBeVisible();
    expect(api.memberPatches).toHaveLength(1);
    expect(api.memberPatches[0]).toEqual({
      memberId: MEMBER_B_ID,
      body: { name: '家族メンバー改', color: 'coral' },
    });

    await page
      .getByRole('navigation', { name: 'メインナビゲーション' })
      .getByRole('link', { name: '週' })
      .click();
    const legend = page.getByRole('list', { name: 'メンバー' });
    const legendName = legend.getByText('家族メンバー改', { exact: true });
    await expect(legendName).toBeVisible();
    const expectedColor = await legendName
      .locator('..')
      .locator('[aria-hidden="true"]')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(expectedColor).toBe('rgb(192, 86, 70)');
    await expect(page.getByText('対象予定', { exact: true })).toBeVisible();
    const eventMember = page
      .locator('[data-testid="week-day"][data-date="2026-10-07"]')
      .getByText('家族メンバー改', { exact: true });
    await expect(eventMember).toBeVisible();
    const eventColor = await eventMember
      .locator('..')
      .locator('[aria-hidden="true"]')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(eventColor).toBe(expectedColor);

    await page
      .getByRole('navigation', { name: 'メインナビゲーション' })
      .getByRole('link', { name: '家族' })
      .click();
    await expect(page.getByRole('heading', { name: '休園日', exact: true })).toBeVisible();
    await page.getByTestId('closure-start-date').fill('2026-10-08');
    await page.getByTestId('closure-end-date').fill('2026-10-08');
    await page.getByTestId('closure-label').fill('園の行事');
    await page.getByTestId(`closure-member-${MEMBER_CHILD_ID}`).check();

    let releaseCreate: (() => void) | undefined;
    let createStarted: (() => void) | undefined;
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let createRequests = 0;
    await page.route(`**/api/families/${FAMILY_ID}/closures`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      createRequests++;
      createStarted?.();
      await createGate;
      await route.fallback();
    });
    const addClosure = page.getByTestId('add-closure');
    await addClosure.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await createStartedPromise;
    await expect(addClosure).toBeDisabled();
    await page.waitForTimeout(100);
    expect(createRequests).toBe(1);
    releaseCreate?.();
    await expect(page.getByTestId('closure-row-closure_2026-10-08')).toBeVisible();
    expect(api.closurePosts).toHaveLength(1);
    expect(api.closurePosts[0]).toMatchObject({
      startDate: '2026-10-08',
      endDate: '2026-10-08',
      label: '園の行事',
      memberIds: [MEMBER_CHILD_ID],
    });

    await page
      .getByRole('navigation', { name: 'メインナビゲーション' })
      .getByRole('link', { name: '週' })
      .click();
    const closureDay = page.locator('[data-testid="week-day"][data-date="2026-10-08"]');
    await expect(closureDay).toHaveAttribute('data-layout', 'weekend-card');
    await expect(closureDay.getByText('園の行事', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.setViewportSize({ width: 445, height: 844 });
    await expectNoHorizontalOverflow(page);
    await page
      .getByRole('navigation', { name: 'メインナビゲーション' })
      .getByRole('link', { name: '家族' })
      .click();

    const closureDelete = page.getByTestId('delete-closure-closure_2026-10-08');
    await closureDelete.click();
    await expect(page.getByText('この休園日を削除しますか？')).toBeVisible();
    await page.getByTestId('cancel-delete-closure-closure_2026-10-08').click();
    await expect(page.getByText('この休園日を削除しますか？')).toHaveCount(0);
    await expect(page.getByTestId('closure-row-closure_2026-10-08')).toBeVisible();

    let releaseDelete: (() => void) | undefined;
    let deleteStarted: (() => void) | undefined;
    const deleteStartedPromise = new Promise<void>((resolve) => {
      deleteStarted = resolve;
    });
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let deleteRequests = 0;
    await page.route(`**/api/families/${FAMILY_ID}/closures/closure_2026-10-08`, async (route) => {
      if (route.request().method() !== 'DELETE') {
        await route.fallback();
        return;
      }
      deleteRequests++;
      deleteStarted?.();
      await deleteGate;
      await route.fallback();
    });
    await closureDelete.click();
    const confirmDelete = page.getByTestId('confirm-delete-closure-closure_2026-10-08');
    await confirmDelete.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await deleteStartedPromise;
    await expect(confirmDelete).toBeDisabled();
    await page.waitForTimeout(100);
    expect(deleteRequests).toBe(1);
    releaseDelete?.();
    await expect(page.getByTestId('closure-row-closure_2026-10-08')).toHaveCount(0);
    expect(api.closureDeletes).toEqual(['closure_2026-10-08']);
    await page
      .getByRole('navigation', { name: 'メインナビゲーション' })
      .getByRole('link', { name: '週' })
      .click();
    await expect(closureDay).toHaveAttribute('data-layout', 'compact');
    await expect(closureDay.getByText('園の行事', { exact: true })).toHaveCount(0);
  });

  test('retains form values after API errors and rejects a 32-day closure before sending', async ({
    page,
  }) => {
    const api = await mockSettingsApis(page);
    let patchAttempts = 0;
    await page.route(`**/api/families/${FAMILY_ID}/members/${MEMBER_B_ID}`, async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.fallback();
        return;
      }
      patchAttempts++;
      if (patchAttempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'INTERNAL_ERROR', error: 'private backend details' }),
        });
        return;
      }
      await route.fallback();
    });
    await page.goto('/family');
    const nameInput = page.getByTestId(`member-name-${MEMBER_B_ID}`);
    const colorSelect = page.getByTestId(`member-color-${MEMBER_B_ID}`);
    await nameInput.fill('保存失敗後の名前');
    await colorSelect.selectOption('purple');
    await page.getByTestId(`save-member-${MEMBER_B_ID}`).click();
    await expect(page.getByRole('alert')).toHaveText(
      'サーバーで問題が発生しました。しばらく経ってから再度お試しください。',
    );
    await expect(page.getByRole('alert')).not.toContainText('private backend details');
    await expect(nameInput).toHaveValue('保存失敗後の名前');
    await expect(colorSelect).toHaveValue('purple');
    await page.getByTestId(`save-member-${MEMBER_B_ID}`).click();
    await expect(page.getByText('保存失敗後の名前', { exact: true })).toBeVisible();
    expect(patchAttempts).toBe(2);

    let closureAttempts = 0;
    await page.route(`**/api/families/${FAMILY_ID}/closures`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      closureAttempts++;
      if (closureAttempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'INTERNAL_ERROR', error: 'private closure details' }),
        });
        return;
      }
      await route.fallback();
    });
    await page.getByTestId('closure-start-date').fill('2026-10-10');
    await page.getByTestId('closure-end-date').fill('2026-10-10');
    await page.getByTestId('closure-label').fill('保存に失敗した休園日');
    await page.getByTestId('closure-member-mem_child').check();
    await page.getByTestId('add-closure').click();
    await expect(page.getByTestId('settings-error')).toHaveText(
      'サーバーで問題が発生しました。しばらく経ってから再度お試しください。',
    );
    await expect(page.getByTestId('closure-start-date')).toHaveValue('2026-10-10');
    await expect(page.getByTestId('closure-end-date')).toHaveValue('2026-10-10');
    await expect(page.getByTestId('closure-label')).toHaveValue('保存に失敗した休園日');
    await expect(page.getByTestId('closure-member-mem_child')).toBeChecked();
    await expect(page.getByTestId('settings-error')).not.toContainText('private closure details');
    await page.getByTestId('add-closure').click();
    await expect(page.getByTestId('closure-row-closure_2026-10-10')).toBeVisible();
    expect(closureAttempts).toBe(2);

    const closurePostsBeforeInvalidRange = api.closurePosts.length;
    await page.getByTestId('closure-start-date').fill('2026-10-01');
    await page.getByTestId('closure-end-date').fill('2026-11-01');
    await page.getByTestId('closure-label').fill('31日を超える行事');
    await page.getByTestId('add-closure').click();
    await expect(page.getByRole('alert')).toContainText('期間は31日以内で入力してください。');
    await expect(page.getByTestId('closure-start-date')).toHaveValue('2026-10-01');
    await expect(page.getByTestId('closure-end-date')).toHaveValue('2026-11-01');
    expect(api.closurePosts).toHaveLength(closurePostsBeforeInvalidRange);
  });

  test('background refresh updates clean member rows, preserves dirty drafts, and isolates a new family and user', async ({
    page,
  }) => {
    const api = await mockSettingsApis(page);
    await page.goto('/family');
    const dirtyInput = page.getByTestId(`member-name-${MEMBER_B_ID}`);
    const cleanInput = page.getByTestId('member-name-mem_owner');
    await expect(dirtyInput).toHaveValue('メンバー乙');
    await dirtyInput.fill('この画面の未保存値');

    const refreshedFamily: FamilyPublic = {
      ...api.family,
      members: api.family.members.map((member) =>
        member.id === 'mem_owner'
          ? { ...member, name: '取得後の表示名' }
          : member.id === MEMBER_B_ID
            ? { ...member, name: 'APIから届いた名前' }
            : member,
      ),
    };
    api.setFamily(refreshedFamily);
    const readsBeforeRefresh = api.familyReads;
    await triggerVisibilityCycle(page);
    await expect.poll(() => api.familyReads).toBeGreaterThan(readsBeforeRefresh);
    await expect(cleanInput).toHaveValue('取得後の表示名');
    await expect(dirtyInput).toHaveValue('この画面の未保存値');

    api.setFamily({
      ...refreshedFamily,
      id: 'fam_other_settings',
      name: '別の家族',
      ownerUserId: 'usr_other',
      members: refreshedFamily.members.map((member) =>
        member.id === MEMBER_B_ID ? { ...member, name: '別アカウントのメンバー' } : member,
      ),
    });
    api.setCurrentUserId('usr_other');
    const readsBeforeIdentitySwitch = api.familyReads;
    await triggerVisibilityCycle(page);
    await expect.poll(() => api.familyReads).toBeGreaterThan(readsBeforeIdentitySwitch);
    await expect(page.getByTestId('user-display-name')).toHaveText('別利用者');
    await expect(page.getByTestId(`member-name-${MEMBER_B_ID}`)).toHaveValue(
      '別アカウントのメンバー',
    );
  });
});
