import { readFile } from 'node:fs/promises';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { DateKey } from '../src/shared/schemas/date';
import type { FamilyPublic } from '../src/shared/schemas/family';
import type { WeekResponse } from '../src/shared/schemas/week';
import { getWeekday } from '../src/shared/time/date';
import { getWeekRange } from '../src/shared/time/week';

test.use({
  serviceWorkers: 'allow',
  viewport: { width: 390, height: 844 },
});

type FixtureVersion = 'A' | 'B';

interface PwaFixtureServer {
  origin: string;
  setVersion: (version: FixtureVersion) => void;
  close: () => Promise<void>;
}

const CLIENT_OUTPUT_DIRECTORY = fileURLToPath(new URL('../dist/client/', import.meta.url));
const FIXTURE_CACHE_PREFIX = 'danran-pwa-update-fixture-';
const NAVIGATION_CACHE_KEY = '/__pwa_fixture_navigation__';
const NAVIGATION_COUNTER_KEY = '__pwa_fixture_navigation_count__';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

async function createPwaFixtureServer(): Promise<PwaFixtureServer> {
  const clientIndex = await readFile(resolve(CLIENT_OUTPUT_DIRECTORY, 'index.html'), 'utf8');
  const registerScript = await readFile(resolve(CLIENT_OUTPUT_DIRECTORY, 'registerSW.js'), 'utf8');
  let currentVersion: FixtureVersion = 'A';

  const htmlForVersion = (version: FixtureVersion): string => {
    const withMarker = clientIndex.replace(
      '</head>',
      `<meta name="pwa-fixture-build" content="${version}"></head>`,
    );
    const withCounter = withMarker.replace(
      '<body>',
      `<body><script>const key=${JSON.stringify(NAVIGATION_COUNTER_KEY)};sessionStorage.setItem(key,String(Number(sessionStorage.getItem(key)||'0')+1));</script>`,
    );
    if (withMarker === clientIndex || withCounter === withMarker) {
      throw new Error('Built app HTML did not contain the expected head and body tags');
    }
    return withCounter;
  };

  const serviceWorkerForVersion = (version: FixtureVersion): string => {
    const cacheName = `${FIXTURE_CACHE_PREFIX}${version}`;
    return `
      const VERSION = ${JSON.stringify(version)};
      const CACHE_NAME = ${JSON.stringify(cacheName)};
      const CACHE_KEY = ${JSON.stringify(NAVIGATION_CACHE_KEY)};
      self.addEventListener('install', (event) => {
        event.waitUntil((async () => {
          const response = await fetch('/__pwa_fixture_shell__?version=' + VERSION, { cache: 'no-store' });
          if (!response.ok) throw new Error('Unable to precache fixture app shell');
          const cache = await caches.open(CACHE_NAME);
          await cache.put(CACHE_KEY, response);
          await self.skipWaiting();
        })());
      });
      self.addEventListener('activate', (event) => {
        event.waitUntil((async () => {
          const names = await caches.keys();
          await Promise.all(names
            .filter((name) => name.startsWith(${JSON.stringify(FIXTURE_CACHE_PREFIX)}) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)));
          await self.clients.claim();
        })());
      });
      self.addEventListener('fetch', (event) => {
        const request = event.request;
        if (request.method !== 'GET' || request.mode !== 'navigate') return;
        if (new URL(request.url).pathname.startsWith('/api/')) return;
        event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match(CACHE_KEY)));
      });
    `;
  };

  const sendText = (response: ServerResponse, status: number, type: string, body: string) => {
    response.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Type': type,
      'Service-Worker-Allowed': '/',
    });
    response.end(body);
  };

  const serveAsset = async (pathname: string, response: ServerResponse) => {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      sendText(response, 400, 'text/plain; charset=utf-8', 'Bad path');
      return;
    }
    const assetPath = resolve(CLIENT_OUTPUT_DIRECTORY, `.${decodedPath}`);
    const relativePath = relative(CLIENT_OUTPUT_DIRECTORY, assetPath);
    if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
      sendText(response, 404, 'text/plain; charset=utf-8', 'Not found');
      return;
    }
    try {
      const content = await readFile(assetPath);
      response.writeHead(200, {
        'Cache-Control': 'public, max-age=3600',
        'Content-Type': CONTENT_TYPES[extname(assetPath)] ?? 'application/octet-stream',
      });
      response.end(content);
    } catch {
      sendText(response, 404, 'text/plain; charset=utf-8', 'Not found');
    }
  };

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/sw.js') {
      sendText(
        response,
        200,
        'text/javascript; charset=utf-8',
        serviceWorkerForVersion(currentVersion),
      );
      return;
    }
    if (requestUrl.pathname === '/registerSW.js') {
      sendText(response, 200, 'text/javascript; charset=utf-8', registerScript);
      return;
    }
    if (requestUrl.pathname === '/__pwa_fixture_shell__') {
      const version = requestUrl.searchParams.get('version') === 'B' ? 'B' : 'A';
      sendText(response, 200, 'text/html; charset=utf-8', htmlForVersion(version));
      return;
    }
    if (requestUrl.pathname.startsWith('/api/')) {
      sendText(
        response,
        404,
        'application/json; charset=utf-8',
        JSON.stringify({ error: 'Synthetic API route not mocked' }),
      );
      return;
    }
    if (requestUrl.pathname.startsWith('/assets/')) {
      await serveAsset(requestUrl.pathname, response);
      return;
    }
    if (
      requestUrl.pathname === '/manifest.webmanifest' ||
      requestUrl.pathname.startsWith('/icons/')
    ) {
      await serveAsset(requestUrl.pathname, response);
      return;
    }
    if (requestUrl.pathname === '/favicon.svg') {
      await serveAsset(requestUrl.pathname, response);
      return;
    }
    sendText(response, 200, 'text/html; charset=utf-8', htmlForVersion('A'));
  };

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent)
        sendText(response, 500, 'text/plain; charset=utf-8', 'Fixture error');
      else response.destroy();
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.closeAllConnections();
    throw new Error('PWA fixture server did not bind to an IP address');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    setVersion: (version) => {
      currentVersion = version;
    },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
        server.closeAllConnections();
      }),
  };
}

const TEST_USER_ID = 'usr_pwa_update_fixture';
const TEST_FAMILY_ID = 'fam_pwa_update_fixture';

function makeFamily(
  child: { id: string; name: string; color: string } | null = null,
): FamilyPublic {
  return {
    id: TEST_FAMILY_ID,
    name: '更新テスト家族',
    familyCalendarId: 'cal_pwa_update_fixture',
    ownerUserId: TEST_USER_ID,
    creationStatus: 'ready',
    members: [
      {
        id: 'mem_pwa_owner',
        userId: TEST_USER_ID,
        kind: 'adult',
        name: 'テスト利用者',
        color: 'indigo',
        sortOrder: 0,
      },
      ...(child
        ? [
            {
              id: child.id,
              userId: null,
              kind: 'child' as const,
              name: child.name,
              color: child.color as FamilyPublic['members'][number]['color'],
              sortOrder: 1,
            },
          ]
        : []),
    ],
  };
}

async function mockOnboardingApis(
  page: import('@playwright/test').Page,
  initialFamily: FamilyPublic | null,
) {
  let family = initialFamily;
  let familyReadCount = 0;
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: TEST_USER_ID,
          email: 'pwa-update@example.test',
          displayName: 'テスト利用者',
        },
      }),
    });
  });
  await page.route('**/api/families', async (route) => {
    if (route.request().method() === 'GET') {
      familyReadCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ families: family ? [family] : [] }),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ family: family ?? makeFamily() }),
    });
  });
  return {
    get familyReads() {
      return familyReadCount;
    },
    setFamily: (nextFamily: FamilyPublic | null) => {
      family = nextFamily;
    },
  };
}

async function waitForActiveController(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return (
        registration?.active?.state === 'activated' && navigator.serviceWorker.controller !== null
      );
    },
    undefined,
    { timeout: 20_000 },
  );
}

async function navigationCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate((key) => Number(sessionStorage.getItem(key) ?? '0'), NAVIGATION_COUNTER_KEY);
}

async function requestWorkerUpdate(
  page: import('@playwright/test').Page,
  fixture: PwaFixtureServer,
): Promise<void> {
  fixture.setVersion('B');
  await page.evaluate(() => {
    void navigator.serviceWorker.getRegistration().then((registration) => registration?.update());
  });
}

async function expectVersionAndReloadCount(
  page: import('@playwright/test').Page,
  expectedVersion: FixtureVersion,
  expectedCount: number,
) {
  await expect(page.locator('meta[name="pwa-fixture-build"]')).toHaveAttribute(
    'content',
    expectedVersion,
  );
  await expect.poll(() => navigationCount(page)).toBe(expectedCount);
}

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(metrics.document).toBeLessThanOrEqual(metrics.viewport);
}

async function expectVisibleButtonAtLeast44px(page: import('@playwright/test').Page, name: string) {
  const box = await page.getByRole('button', { name }).boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
}

async function triggerReplacementAndExpectBanner(
  page: import('@playwright/test').Page,
  fixture: PwaFixtureServer,
) {
  await requestWorkerUpdate(page, fixture);
  await expect(page.getByTestId('pwa-update-banner')).toBeVisible();
  await expect(page.locator('meta[name="pwa-fixture-build"]')).toHaveAttribute('content', 'A');
  expect(await navigationCount(page)).toBe(1);
}

test.describe('PWA update handover with a real Service Worker', () => {
  test('first claim does not reload; a new worker reloads once to its precached HTML and leaves APIs network-only', async ({
    page,
  }) => {
    const fixture = await createPwaFixtureServer();
    try {
      await page.route('**/api/auth/me', async (route) => {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Unauthorized' }),
        });
      });
      await page.goto(`${fixture.origin}/`);
      await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();
      await waitForActiveController(page);
      await expect.poll(() => navigationCount(page)).toBe(1);

      let apiCalls = 0;
      await page.route('**/api/pwa-update-probe', async (route) => {
        apiCalls++;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      });
      const apiResponses = await page.evaluate(async () => {
        const first = await fetch('/api/pwa-update-probe').then((response) => response.json());
        const second = await fetch('/api/pwa-update-probe').then((response) => response.json());
        return [first, second];
      });
      expect(apiResponses).toEqual([{ ok: true }, { ok: true }]);
      expect(apiCalls).toBe(2);
      const apiCacheEntries = await page.evaluate(async () => {
        const urls: string[] = [];
        for (const name of await caches.keys()) {
          const cache = await caches.open(name);
          for (const request of await cache.keys()) urls.push(new URL(request.url).pathname);
        }
        return urls.filter((pathname) => pathname.startsWith('/api/'));
      });
      expect(apiCacheEntries).toEqual([]);

      await requestWorkerUpdate(page, fixture);
      await expectVersionAndReloadCount(page, 'B', 2);
      expect(await navigationCount(page)).toBe(2);
    } finally {
      await fixture.close();
    }
  });

  test('an open event form protects its draft and a pending save blocks manual reload', async ({
    page,
  }) => {
    const fixture = await createPwaFixtureServer();
    let releaseSave: (() => void) | undefined;
    let saveStarted: (() => void) | undefined;
    const saveStartedPromise = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    try {
      const family = makeFamily({ id: 'mem_pwa_child', name: 'ひな', color: 'ochre' });
      await mockOnboardingApis(page, family);
      const weekStart = '2026-10-05' as DateKey;
      const range = getWeekRange(weekStart);
      const week: WeekResponse = {
        family: { id: TEST_FAMILY_ID, name: family.name },
        members: family.members.map((member) => ({
          id: member.id,
          name: member.name,
          color: member.color,
          kind: member.kind,
          sortOrder: member.sortOrder,
        })),
        week: {
          start: range.start,
          endInclusive: range.endInclusive,
          prevWeekStart: range.prevWeekStart,
          nextWeekStart: range.nextWeekStart,
          today: '2026-10-07' as DateKey,
        },
        days: [...range.days].reverse().map((date) => ({
          date,
          weekday: getWeekday(date),
          holidayName: null,
          closures: [],
          layout:
            getWeekday(date) === 0 || getWeekday(date) === 6
              ? ('weekend-card' as const)
              : ('compact' as const),
          eventIds: [],
        })),
        events: [],
      };
      await page.route(`**/api/families/${TEST_FAMILY_ID}/week**`, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/week/personal')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              family: { id: TEST_FAMILY_ID },
              memberId: 'mem_pwa_owner',
              week: week.week,
              status: 'authorization_required',
              events: [],
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(week),
        });
      });
      await page.route(`**/api/families/${TEST_FAMILY_ID}/events`, async (route) => {
        saveStarted?.();
        await saveGate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ eventId: 'evt_pwa_created' }),
        });
      });

      await page.goto(`${fixture.origin}/?week=${weekStart}`);
      await expect(page.getByRole('button', { name: '予定を追加', exact: true })).toBeVisible();
      await waitForActiveController(page);
      await page.getByRole('button', { name: '予定を追加', exact: true }).click();
      const dialog = page.getByTestId('event-dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('タイトル').fill('更新中に守る予定');

      await requestWorkerUpdate(page, fixture);
      await expect(page.getByTestId('pwa-update-banner')).toBeVisible();
      await expect(dialog.getByLabel('タイトル')).toHaveValue('更新中に守る予定');
      expect(await navigationCount(page)).toBe(1);

      const updateButton = page.getByRole('button', { name: '更新', exact: true });
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      await saveStartedPromise;
      await expect(updateButton).toBeDisabled();
      expect(await navigationCount(page)).toBe(1);

      releaseSave?.();
      await expect(dialog).toBeHidden();
      await expect(updateButton).toBeEnabled();
      await expectVersionAndReloadCount(page, 'A', 1);
      await updateButton.click();
      await expectVersionAndReloadCount(page, 'B', 2);
    } finally {
      releaseSave?.();
      await fixture.close();
    }
  });

  test('an open routine form protects its draft and a pending save blocks manual reload', async ({
    page,
  }) => {
    const fixture = await createPwaFixtureServer();
    let releaseSave: (() => void) | undefined;
    let saveStarted: (() => void) | undefined;
    const saveStartedPromise = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    try {
      const family = makeFamily({ id: 'mem_pwa_routine_child', name: 'ひな', color: 'ochre' });
      await mockOnboardingApis(page, family);
      await page.route(`**/api/families/${TEST_FAMILY_ID}/routines`, async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ routines: [] }),
          });
          return;
        }
        saveStarted?.();
        await saveGate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            routineId: 'routine_pwa_saved',
            eventId: 'evt_pwa_routine_saved',
          }),
        });
      });

      await page.goto(`${fixture.origin}/routines`);
      await expect(page.getByTestId('routines-screen')).toBeVisible();
      await page.getByTestId('routine-add-button').click();
      const dialog = page.getByTestId('routine-dialog');
      await dialog.getByTestId('routine-form-title').fill('更新中に守る繰り返し');
      await waitForActiveController(page);

      await requestWorkerUpdate(page, fixture);
      await expect(page.getByTestId('pwa-update-banner')).toBeVisible();
      await expect(dialog.getByTestId('routine-form-title')).toHaveValue('更新中に守る繰り返し');
      expect(await navigationCount(page)).toBe(1);

      const updateButton = page.getByRole('button', { name: '更新', exact: true });
      await dialog.getByTestId('routine-save').click();
      await saveStartedPromise;
      await expect(updateButton).toBeDisabled();
      expect(await navigationCount(page)).toBe(1);

      releaseSave?.();
      await expect(dialog).toHaveCount(0);
      await expect(updateButton).toBeEnabled();
      await expectVersionAndReloadCount(page, 'A', 1);
      await updateButton.click();
      await expectVersionAndReloadCount(page, 'B', 2);
    } finally {
      releaseSave?.();
      await fixture.close();
    }
  });

  test('an edited instance move protects its draft from a PWA update', async ({ page }) => {
    const fixture = await createPwaFixtureServer();
    try {
      await mockOnboardingApis(page, makeFamily());
      await page.route(`**/api/families/${TEST_FAMILY_ID}/routines`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            routines: [
              {
                id: 'routine_pwa_move',
                title: '更新中に守る繰り返し',
                weekdays: ['TU'],
                interval: 1,
                startDate: '2026-10-13',
                endDate: null,
                startTime: '17:00',
                endTime: '18:00',
                memberIds: [],
                assigneeMemberId: null,
                category: 'lesson',
                affectsAvailability: true,
                skipHolidays: false,
                skipNewYear: false,
                autoSkipDue: false,
                status: 'ready',
                upcoming: {
                  status: 'ready',
                  conflictsStatus: 'ready',
                  instances: [
                    {
                      id: 'instance_pwa_move',
                      originalStart: '2026-10-13T17:00:00+09:00',
                      originalEnd: '2026-10-13T18:00:00+09:00',
                      start: '2026-10-13T17:00:00+09:00',
                      end: '2026-10-13T18:00:00+09:00',
                      status: 'normal',
                      autoSkipReason: null,
                      conflicts: [],
                    },
                  ],
                },
              },
            ],
          }),
        });
      });
      await page.goto(`${fixture.origin}/routines`);
      await expect(page.getByTestId('routines-screen')).toBeVisible();
      await page.getByTestId('routine-instance-chip-instance_pwa_move').click();
      const actions = page.getByTestId('routine-instance-actions-instance_pwa_move');
      await actions.getByTestId('routine-instance-set-move').click();
      await actions.getByTestId('routine-instance-move-date').fill('2026-10-14');
      await waitForActiveController(page);

      await requestWorkerUpdate(page, fixture);
      await expect(page.getByTestId('pwa-update-banner')).toBeVisible();
      await expect(actions.getByTestId('routine-instance-move-date')).toHaveValue('2026-10-14');
      expect(await navigationCount(page)).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  test('a pending instance mutation blocks reload until the response settles', async ({ page }) => {
    const fixture = await createPwaFixtureServer();
    let skipMutationApplied = false;
    let releaseMutation: (() => void) | undefined;
    let mutationStarted: (() => void) | undefined;
    const mutationStartedPromise = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    try {
      await mockOnboardingApis(page, makeFamily());
      await page.route(`**/api/families/${TEST_FAMILY_ID}/routines`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            routines: [
              {
                id: 'routine_pwa_pending',
                title: '更新中に守る繰り返し',
                weekdays: ['TU'],
                interval: 1,
                startDate: '2026-10-13',
                endDate: null,
                startTime: '17:00',
                endTime: '18:00',
                memberIds: [],
                assigneeMemberId: null,
                category: 'lesson',
                affectsAvailability: true,
                skipHolidays: false,
                skipNewYear: false,
                autoSkipDue: false,
                status: 'ready',
                upcoming: {
                  status: 'ready',
                  conflictsStatus: 'ready',
                  instances: [
                    {
                      id: 'instance_pwa_pending',
                      originalStart: '2026-10-13T17:00:00+09:00',
                      originalEnd: '2026-10-13T18:00:00+09:00',
                      start: skipMutationApplied ? null : '2026-10-13T17:00:00+09:00',
                      end: skipMutationApplied ? null : '2026-10-13T18:00:00+09:00',
                      status: skipMutationApplied ? 'skipped' : 'normal',
                      autoSkipReason: null,
                      conflicts: [],
                    },
                  ],
                },
              },
            ],
          }),
        });
      });
      await page.route(
        `**/api/families/${TEST_FAMILY_ID}/routines/routine_pwa_pending/instances/instance_pwa_pending/skip`,
        async (route) => {
          mutationStarted?.();
          await mutationGate;
          skipMutationApplied = true;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              instance: {
                id: 'instance_pwa_pending',
                originalStart: '2026-10-13T17:00:00+09:00',
                originalEnd: '2026-10-13T18:00:00+09:00',
                start: null,
                end: null,
                status: 'skipped',
                autoSkipReason: null,
              },
            }),
          });
        },
      );
      await page.goto(`${fixture.origin}/routines`);
      await expect(page.getByTestId('routines-screen')).toBeVisible();
      await page.getByTestId('routine-instance-chip-instance_pwa_pending').click();
      await waitForActiveController(page);
      const updateButton = page.getByRole('button', { name: '更新', exact: true });
      await page
        .getByTestId('routine-instance-actions-instance_pwa_pending')
        .getByTestId('routine-instance-skip')
        .click();
      await mutationStartedPromise;
      await requestWorkerUpdate(page, fixture);
      await expect(page.getByTestId('pwa-update-banner')).toBeVisible();
      await expect(updateButton).toBeDisabled();
      expect(await navigationCount(page)).toBe(1);
      releaseMutation?.();
      await expect(page.getByTestId('routine-instance-chip-instance_pwa_pending')).toContainText(
        'お休み',
      );
      await expect(updateButton).toBeEnabled();
      expect(await navigationCount(page)).toBe(1);
    } finally {
      releaseMutation?.();
      await fixture.close();
    }
  });

  test('an automatic routine continuation blocks PWA reload until every batch settles', async ({
    page,
  }) => {
    const fixture = await createPwaFixtureServer();
    let releaseApply: (() => void) | undefined;
    let applyStarted: (() => void) | undefined;
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const applyStartedPromise = new Promise<void>((resolve) => {
      applyStarted = resolve;
    });
    try {
      await mockOnboardingApis(page, makeFamily());
      await page.route(`**/api/families/${TEST_FAMILY_ID}/routines`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            routines: [
              {
                id: 'routine_pwa_auto_pending',
                title: '更新中に守る繰り返し',
                weekdays: ['TU'],
                interval: 1,
                startDate: '2026-10-13',
                endDate: null,
                startTime: '17:00',
                endTime: '18:00',
                memberIds: [],
                assigneeMemberId: null,
                category: 'lesson',
                affectsAvailability: true,
                skipHolidays: true,
                skipNewYear: false,
                autoSkipDue: true,
                status: 'ready',
                upcoming: { status: 'ready', conflictsStatus: 'ready', instances: [] },
              },
            ],
          }),
        });
      });
      await page.route(
        `**/api/families/${TEST_FAMILY_ID}/routines/routine_pwa_auto_pending/auto-skips/apply`,
        async (route) => {
          applyStarted?.();
          await applyGate;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ skipHolidays: true, skipNewYear: false, hasMore: false }),
          });
        },
      );
      await page.goto(`${fixture.origin}/routines`);
      await expect(page.getByTestId('routines-screen')).toBeVisible();
      await applyStartedPromise;
      await waitForActiveController(page);
      const updateButton = page.getByRole('button', { name: '更新', exact: true });
      await requestWorkerUpdate(page, fixture);
      await expect(page.getByTestId('pwa-update-banner')).toBeVisible();
      await expect(updateButton).toBeDisabled();
      expect(await navigationCount(page)).toBe(1);
      releaseApply?.();
      await expect(
        page.getByTestId('routine-auto-skips-pending-routine_pwa_auto_pending'),
      ).toHaveCount(0);
      await expect(updateButton).toBeEnabled();
      expect(await navigationCount(page)).toBe(1);
    } finally {
      releaseApply?.();
      await fixture.close();
    }
  });

  test('a typed family name is retained while the update banner waits for explicit apply', async ({
    page,
  }) => {
    const fixture = await createPwaFixtureServer();
    try {
      await mockOnboardingApis(page, null);
      await page.goto(`${fixture.origin}/onboarding`);
      const familyName = page.getByTestId('family-name-input');
      await expect(familyName).toBeVisible();
      await waitForActiveController(page);
      await familyName.fill('合成の家族');

      await triggerReplacementAndExpectBanner(page, fixture);
      await expect(familyName).toHaveValue('合成の家族');
      await expect(page.getByRole('button', { name: '更新', exact: true })).toBeEnabled();
      await expectNoHorizontalOverflow(page);
      await expectVisibleButtonAtLeast44px(page, '更新');
      await page.setViewportSize({ width: 445, height: 844 });
      const banner445 = await page.getByTestId('pwa-update-banner').boundingBox();
      expect(banner445?.width).toBe(445);
      expect(banner445?.x).toBe(0);
      await page.setViewportSize({ width: 1024, height: 844 });
      const bannerWide = await page.getByTestId('pwa-update-banner').boundingBox();
      expect(bannerWide?.width).toBe(480);
      expect(bannerWide?.x).toBe(272);
      await page.setViewportSize({ width: 390, height: 844 });
      if (process.env.DANRAN_SCREENSHOTS === '1') {
        await page.screenshot({ path: 'docs/screenshots/pwa-update.png' });
      }

      await page.getByRole('button', { name: '更新', exact: true }).click();
      await expectVersionAndReloadCount(page, 'B', 2);
    } finally {
      await fixture.close();
    }
  });

  test('an edited family member setting protects its unsaved name during a PWA update', async ({
    page,
  }) => {
    const fixture = await createPwaFixtureServer();
    try {
      const family = makeFamily();
      await mockOnboardingApis(page, family);
      await page.route(`**/api/families/${TEST_FAMILY_ID}/closures`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ closures: [], hasMore: false }),
        });
      });
      await page.route(`**/api/families/${TEST_FAMILY_ID}/personal-calendars`, async (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'authorization_required',
            memberId: 'mem_pwa_owner',
            calendars: [],
          }),
        }),
      );
      await page.route(`**/api/families/${TEST_FAMILY_ID}/busy-calendars`, async (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'authorization_required',
            memberId: 'mem_pwa_owner',
            calendars: [],
          }),
        }),
      );
      await page.goto(`${fixture.origin}/family`);
      const memberName = page.getByTestId('member-name-mem_pwa_owner');
      await expect(memberName).toHaveValue('テスト利用者');
      await waitForActiveController(page);
      await memberName.fill('更新前に守る名前');

      await triggerReplacementAndExpectBanner(page, fixture);
      await expect(memberName).toHaveValue('更新前に守る名前');
      await expect(page.getByRole('button', { name: '更新', exact: true })).toBeEnabled();
      expect(await navigationCount(page)).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  test('an unsaved personal calendar selection protects the screen during a PWA update', async ({
    page,
  }) => {
    const fixture = await createPwaFixtureServer();
    try {
      await mockOnboardingApis(page, makeFamily());
      await page.route(`**/api/families/${TEST_FAMILY_ID}/closures`, async (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ closures: [], hasMore: false }),
        }),
      );
      await page.route(`**/api/families/${TEST_FAMILY_ID}/personal-calendars`, async (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'ready',
            memberId: 'mem_pwa_owner',
            hasSavedSelection: true,
            calendars: [
              { id: 'primary', name: '自分のカレンダー', isPrimary: true, selected: true },
              { id: 'calendar-secondary', name: '仕事', isPrimary: false, selected: false },
            ],
          }),
        }),
      );
      await page.route(`**/api/families/${TEST_FAMILY_ID}/busy-calendars`, async (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'authorization_required',
            memberId: 'mem_pwa_owner',
            calendars: [],
          }),
        }),
      );
      await page.goto(`${fixture.origin}/family`);
      const primary = page.getByTestId('personal-calendar-primary');
      await expect(primary).toBeChecked();
      await waitForActiveController(page);
      await primary.uncheck();

      await triggerReplacementAndExpectBanner(page, fixture);
      await expect(primary).not.toBeChecked();
      await expect(page.getByRole('button', { name: '更新', exact: true })).toBeEnabled();
      expect(await navigationCount(page)).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  test('an unsaved busy calendar selection protects the screen during a PWA update', async ({
    page,
  }) => {
    const fixture = await createPwaFixtureServer();
    try {
      await mockOnboardingApis(page, makeFamily());
      await page.route(`**/api/families/${TEST_FAMILY_ID}/closures`, async (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ closures: [], hasMore: false }),
        }),
      );
      await page.route(`**/api/families/${TEST_FAMILY_ID}/personal-calendars`, async (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'authorization_required',
            memberId: 'mem_pwa_owner',
            calendars: [],
          }),
        }),
      );
      await page.route(`**/api/families/${TEST_FAMILY_ID}/busy-calendars`, async (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'ready',
            memberId: 'mem_pwa_owner',
            hasSavedSelection: false,
            calendars: [
              { id: 'primary', name: '自分のカレンダー', isPrimary: true, selected: false },
              { id: 'calendar-secondary', name: '仕事', isPrimary: false, selected: false },
            ],
          }),
        }),
      );
      await page.goto(`${fixture.origin}/family`);
      const primary = page.getByTestId('busy-calendar-primary');
      await expect(primary).not.toBeChecked();
      await waitForActiveController(page);
      await primary.check();

      await triggerReplacementAndExpectBanner(page, fixture);
      await expect(primary).toBeChecked();
      await expect(page.getByRole('button', { name: '更新', exact: true })).toBeEnabled();
      expect(await navigationCount(page)).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  test('untouched saved child drafts do not block an automatic update', async ({ page }) => {
    const fixture = await createPwaFixtureServer();
    try {
      await mockOnboardingApis(
        page,
        makeFamily({ id: 'mem_saved_child', name: 'ひな', color: 'ochre' }),
      );
      await page.goto(`${fixture.origin}/onboarding`);
      await expect(page.getByTestId('child-name-0')).toHaveValue('ひな');
      await expect(page.getByTestId('child-color-0')).toHaveValue('ochre');
      await waitForActiveController(page);
      await requestWorkerUpdate(page, fixture);
      await expectVersionAndReloadCount(page, 'B', 2);
      await expect(page.getByTestId('pwa-update-banner')).toHaveCount(0);
    } finally {
      await fixture.close();
    }
  });

  const childDraftChanges = [
    {
      name: 'child name edits',
      apply: async (page: import('@playwright/test').Page) => {
        await page.getByTestId('child-name-0').fill('はる');
      },
      assert: async (page: import('@playwright/test').Page) => {
        await expect(page.getByTestId('child-name-0')).toHaveValue('はる');
      },
    },
    {
      name: 'child color-only edits',
      apply: async (page: import('@playwright/test').Page) => {
        await page.getByTestId('child-color-0').selectOption('purple');
      },
      assert: async (page: import('@playwright/test').Page) => {
        await expect(page.getByTestId('child-color-0')).toHaveValue('purple');
      },
    },
    {
      name: 'new empty child rows',
      apply: async (page: import('@playwright/test').Page) => {
        await page.getByTestId('add-child-button').click();
        await expect(page.getByTestId('child-name-1')).toHaveValue('');
      },
      assert: async (page: import('@playwright/test').Page) => {
        await expect(page.getByTestId('child-name-1')).toHaveValue('');
      },
    },
    {
      name: 'child removals',
      apply: async (page: import('@playwright/test').Page) => {
        await page.getByTestId('remove-child-0').click();
        await expect(page.getByTestId('child-name-0')).toHaveCount(0);
      },
      assert: async (page: import('@playwright/test').Page) => {
        await expect(page.getByTestId('child-name-0')).toHaveCount(0);
      },
    },
  ] as const;

  for (const change of childDraftChanges) {
    test(`${change.name} block automatic reload and keep the update available`, async ({
      page,
    }) => {
      const fixture = await createPwaFixtureServer();
      try {
        await mockOnboardingApis(
          page,
          makeFamily({ id: 'mem_saved_child', name: 'ひな', color: 'ochre' }),
        );
        await page.goto(`${fixture.origin}/onboarding`);
        await expect(page.getByTestId('child-name-0')).toHaveValue('ひな');
        await change.apply(page);
        await waitForActiveController(page);

        await triggerReplacementAndExpectBanner(page, fixture);
        await expect(page.getByRole('button', { name: '更新', exact: true })).toBeEnabled();
        await change.assert(page);
      } finally {
        await fixture.close();
      }
    });
  }

  test('a pending child save blocks manual reload until refreshed values become clean', async ({
    page,
  }) => {
    const fixture = await createPwaFixtureServer();
    let releaseSave: (() => void) | undefined;
    try {
      let currentFamily = makeFamily({ id: 'mem_saved_child', name: 'ひな', color: 'ochre' });
      const onboardingApi = await mockOnboardingApis(page, currentFamily);
      let saveStarted: (() => void) | undefined;
      const saveRequestStarted = new Promise<void>((resolveStarted) => {
        saveStarted = resolveStarted;
      });
      const saveResponseGate = new Promise<void>((resolveSave) => {
        releaseSave = resolveSave;
      });
      await page.route(`**/api/families/${TEST_FAMILY_ID}/children`, async (route) => {
        const requestBody = route.request().postDataJSON() as {
          children: Array<{ name: string; color: string }>;
        };
        saveStarted?.();
        await saveResponseGate;
        currentFamily = {
          ...currentFamily,
          members: currentFamily.members
            .filter((member) => member.kind !== 'child')
            .concat(
              requestBody.children.map((child, index) => ({
                id: `mem_regenerated_${index}`,
                userId: null,
                kind: 'child' as const,
                name: child.name,
                color: child.color as FamilyPublic['members'][number]['color'],
                sortOrder: index + 1,
              })),
            ),
        };
        onboardingApi.setFamily(currentFamily);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ family: currentFamily }),
        });
      });

      await page.goto(`${fixture.origin}/onboarding`);
      await page.getByTestId('child-name-0').fill('はる');
      await waitForActiveController(page);
      await page.getByTestId('save-children-button').click();
      await saveRequestStarted;
      await requestWorkerUpdate(page, fixture);
      await expect(page.getByTestId('pwa-update-banner')).toBeVisible();
      const updateButton = page.getByRole('button', { name: '更新', exact: true });
      await expect(updateButton).toBeDisabled();
      expect(await navigationCount(page)).toBe(1);

      releaseSave?.();
      await expect(page.getByTestId('save-children-success')).toBeVisible();
      await expect(page.getByTestId('child-name-0')).toHaveValue('はる');
      await expect.poll(() => updateButton.isEnabled()).toBe(true);
      await expect(page.locator('meta[name="pwa-fixture-build"]')).toHaveAttribute('content', 'A');
      expect(await navigationCount(page)).toBe(1);

      await updateButton.click();
      await expectVersionAndReloadCount(page, 'B', 2);
    } finally {
      releaseSave?.();
      await fixture.close();
    }
  });

  test('a saved trimmed child draft with regenerated member IDs is clean for automatic update', async ({
    page,
  }) => {
    const fixture = await createPwaFixtureServer();
    try {
      let currentFamily = makeFamily({ id: 'mem_original_child', name: 'ひな', color: 'ochre' });
      const onboardingApi = await mockOnboardingApis(page, currentFamily);
      await page.route(`**/api/families/${TEST_FAMILY_ID}/children`, async (route) => {
        const requestBody = route.request().postDataJSON() as {
          children: Array<{ name: string; color: string }>;
        };
        currentFamily = {
          ...currentFamily,
          members: currentFamily.members
            .filter((member) => member.kind !== 'child')
            .concat(
              requestBody.children.map((child, index) => ({
                id: `mem_after_save_${index}`,
                userId: null,
                kind: 'child' as const,
                name: child.name,
                color: child.color as FamilyPublic['members'][number]['color'],
                sortOrder: index + 1,
              })),
            ),
        };
        onboardingApi.setFamily(currentFamily);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ family: currentFamily }),
        });
      });

      await page.goto(`${fixture.origin}/onboarding`);
      const childName = page.getByTestId('child-name-0');
      await expect(childName).toHaveValue('ひな');
      await waitForActiveController(page);
      const familyReadsBeforeSave = onboardingApi.familyReads;
      await childName.fill('  はる  ');
      await page.getByTestId('save-children-button').click();
      await expect(page.getByTestId('save-children-success')).toBeVisible();
      await expect.poll(() => onboardingApi.familyReads).toBeGreaterThan(familyReadsBeforeSave);
      await expect(childName).toHaveValue('  はる  ');
      expect(currentFamily.members.find((member) => member.kind === 'child')?.name).toBe('はる');

      await requestWorkerUpdate(page, fixture);
      await expectVersionAndReloadCount(page, 'B', 2);
      await expect(page.getByTestId('pwa-update-banner')).toHaveCount(0);
    } finally {
      await fixture.close();
    }
  });
});
