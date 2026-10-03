import { expect, test } from '@playwright/test';
import type { FamilyPublic } from '../src/shared/schemas/family';

test.use({
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
});

const VALID_TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABC43';

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

async function waitForTwoRafs(page: import('@playwright/test').Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

function requireFamily(
  family: FamilyPublic | null,
  message = 'currentFamily is required',
): FamilyPublic {
  if (!family) {
    throw new Error(message);
  }
  return family;
}

test.describe('Task 1-4: Family Onboarding and Invite/Join UI', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('Owner onboarding flow: create family -> add children -> issue invite with incremental ACL consent', async ({
    page,
  }) => {
    let currentFamily: FamilyPublic | null = null;

    // 1. Session query
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_owner', email: 'owner@example.test', displayName: 'オーナーパパ' },
        }),
      });
    });

    // 2. Families query (Strict schema: no extra dayStart, dayEnd, createdAt, or member status)
    await page.route('**/api/families', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ families: currentFamily ? [currentFamily] : [] }),
        });
      } else if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        expect(body.name).toBe('たなか家');
        const createdFamily: FamilyPublic = {
          id: 'fam_tanaka',
          name: 'たなか家',
          familyCalendarId: 'cal_tanaka_123',
          ownerUserId: 'usr_owner',
          creationStatus: 'ready',
          members: [
            {
              id: 'mem_owner',
              userId: 'usr_owner',
              kind: 'adult',
              name: 'オーナーパパ',
              color: 'indigo',
              sortOrder: 0,
            },
          ],
        };
        currentFamily = createdFamily;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ family: createdFamily }),
        });
      }
    });

    // 3. Children PUT
    await page.route('**/api/families/fam_tanaka/children', async (route) => {
      const body = route.request().postDataJSON();
      expect(body.children).toHaveLength(2);
      expect(body.children[0]).toEqual({ name: 'はな', color: 'ochre' });
      expect(body.children[1]).toEqual({ name: 'たろう', color: 'purple' });
      const baseFamily = requireFamily(currentFamily);
      const updatedMembers = [
        ...baseFamily.members,
        {
          id: 'mem_hana',
          userId: null,
          kind: 'child' as const,
          name: 'はな',
          color: 'ochre' as const,
          sortOrder: 1,
        },
        {
          id: 'mem_taro',
          userId: null,
          kind: 'child' as const,
          name: 'たろう',
          color: 'purple' as const,
          sortOrder: 2,
        },
      ];
      currentFamily = {
        ...baseFamily,
        members: updatedMembers,
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ family: currentFamily }),
      });
    });

    // 4. Invite POST
    let inviteAttempts = 0;
    await page.route('**/api/families/fam_tanaka/invites', async (route) => {
      inviteAttempts++;
      if (inviteAttempts === 1) {
        // First attempt requires incremental calendar.acls consent
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            authorizationRequired: true,
            authorizationUrl:
              'https://accounts.google.com/o/oauth2/v2/auth?scope=calendar.acls&client_id=mock',
          }),
        });
      } else {
        // Second attempt after consent returns invite URL
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            authorizationRequired: false,
            inviteUrl: `http://127.0.0.1:4173/invite#${VALID_TOKEN}`,
            expiresAt: 1790000000,
          }),
        });
      }
    });

    // Navigate to /onboarding
    await page.goto('/onboarding');
    await expect(page.locator('[data-testid="onboarding-screen"]')).toBeVisible();

    // Verify initial creation form
    const nameInput = page.locator('[data-testid="family-name-input"]');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('たなか家');

    const createBtn = page.locator('[data-testid="create-family-button"]');
    await createBtn.click();

    // After creation, ready state and child editor appear
    await expect(page.locator('[data-testid="family-name"]')).toHaveText('たなか家');
    await expect(page.locator('[data-testid="family-status"]')).toHaveText('準備完了');

    // Add 2 children
    const addChildBtn = page.locator('[data-testid="add-child-button"]');
    await addChildBtn.click();

    // Verify 8 palette options on child-color-0 (exact Japanese labels without relationship roles)
    const colorOptions = await page.locator('[data-testid="child-color-0"] option').all();
    expect(colorOptions).toHaveLength(8);
    const optionTexts = await Promise.all(colorOptions.map((opt) => opt.textContent()));
    expect(optionTexts).toEqual(['藍', '深緑', '黄土', '紫', '珊瑚', '青緑', '薔薇', '石板']);
    const optionValues = await Promise.all(colorOptions.map((opt) => opt.getAttribute('value')));
    expect(optionValues).toEqual([
      'indigo',
      'green',
      'ochre',
      'purple',
      'coral',
      'teal',
      'rose',
      'slate',
    ]);

    await page.locator('[data-testid="child-name-0"]').fill('はな');
    await page.locator('[data-testid="child-color-0"]').selectOption('ochre');

    await addChildBtn.click();
    await page.locator('[data-testid="child-name-1"]').fill('たろう');
    await page.locator('[data-testid="child-color-1"]').selectOption('purple');

    // Save children
    const saveChildrenBtn = page.locator('[data-testid="save-children-button"]');
    await saveChildrenBtn.click();
    await expect(page.locator('[data-testid="save-children-success"]')).toBeVisible();

    // Issue invite: First attempt redirects to incremental Google OAuth
    await page.route('https://accounts.google.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body>Mock Google Incremental Auth</body></html>',
      });
    });

    const issueInviteBtn = page.locator('[data-testid="issue-invite-button"]');
    await Promise.all([
      page.waitForURL((url) => url.hostname === 'accounts.google.com'),
      issueInviteBtn.click(),
    ]);
    expect(inviteAttempts).toBe(1);

    // Simulate returning from OAuth callback with acl=granted
    await page.goto('/onboarding?acl=granted');
    await expect(page.locator('[data-testid="acl-granted-message"]')).toBeVisible();

    // Issue invite again: now successfully outputs invite link
    const secondIssueBtn = page.locator('[data-testid="issue-invite-button"]');
    await secondIssueBtn.click();
    expect(inviteAttempts).toBe(2);

    const inviteInput = page.locator('[data-testid="invite-url-input"]');
    await expect(inviteInput).toBeVisible();
    await expect(inviteInput).toHaveValue(`http://127.0.0.1:4173/invite#${VALID_TOKEN}`);
    await expect(page.locator('[data-testid="invite-expiry-text"]')).toHaveText(
      '招待リンクは7日間有効です',
    );

    // Copy button
    const copyBtn = page.locator('[data-testid="copy-invite-button"]');
    await copyBtn.click();
    await expect(page.locator('[data-testid="copy-status"]')).toBeVisible();
  });

  test('Non-owner cannot issue invite links and sees guidance notice', async ({ page }) => {
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_member', email: 'member@example.test', displayName: '参加ママ' },
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
              id: 'fam_tanaka',
              name: 'たなか家',
              familyCalendarId: 'cal_123',
              ownerUserId: 'usr_different_owner',
              creationStatus: 'ready',
              members: [
                {
                  id: 'mem_1',
                  userId: 'usr_member',
                  kind: 'adult',
                  name: '参加ママ',
                  color: 'green',
                  sortOrder: 0,
                },
              ],
            },
          ],
        }),
      });
    });

    await page.goto('/onboarding');
    await expect(page.locator('[data-testid="onboarding-screen"]')).toBeVisible();
    await expect(page.locator('[data-testid="issue-invite-button"]')).toHaveCount(0);
    const nonOwnerNotice = page.locator('[data-testid="non-owner-notice"]');
    await expect(nonOwnerNotice).toBeVisible();
    await expect(nonOwnerNotice).toContainText('招待リンクの発行は家族カレンダーの作成者');
  });

  test('Owner uncertain family: no automatic reconcile, explicit reconcile button updates to ready', async ({
    page,
  }) => {
    let reconcileCalled = false;
    let reconciledFamily: FamilyPublic | null = null;

    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_owner', email: 'owner@example.test', displayName: '作成中パパ' },
        }),
      });
    });

    await page.route('**/api/families', async (route) => {
      const currentFamily: FamilyPublic = reconciledFamily ?? {
        id: 'fam_uncertain',
        name: 'さとう家',
        familyCalendarId: null,
        ownerUserId: 'usr_owner',
        creationStatus: 'uncertain',
        members: [
          {
            id: 'mem_owner',
            userId: 'usr_owner',
            kind: 'adult',
            name: '作成中パパ',
            color: 'indigo',
            sortOrder: 0,
          },
        ],
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ families: [currentFamily] }),
      });
    });

    let resolveReconcileEntered!: () => void;
    const reconcileEnteredPromise = new Promise<void>((resolve) => {
      resolveReconcileEntered = resolve;
    });
    let releaseReconcileGate!: () => void;
    const reconcileGatePromise = new Promise<void>((resolve) => {
      releaseReconcileGate = resolve;
    });

    await page.route('**/api/families/fam_uncertain/reconcile', async (route) => {
      reconcileCalled = true;
      resolveReconcileEntered();
      await reconcileGatePromise;
      reconciledFamily = {
        id: 'fam_uncertain',
        name: 'さとう家',
        familyCalendarId: 'cal_satou_reconciled',
        ownerUserId: 'usr_owner',
        creationStatus: 'ready',
        members: [
          {
            id: 'mem_owner',
            userId: 'usr_owner',
            kind: 'adult',
            name: '作成中パパ',
            color: 'indigo',
            sortOrder: 0,
          },
        ],
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ family: reconciledFamily }),
      });
    });

    await page.goto('/onboarding');
    const notice = page.locator('[data-testid="family-status-notice"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('作成状態を確認中です');

    // Invariant: reconcile API was NOT called automatically on mount
    expect(reconcileCalled).toBe(false);
    await expect(page.locator('[data-testid="create-family-button"]')).toHaveCount(0);

    // Explicit owner button is visible and enabled
    const reconcileBtn = page.locator('[data-testid="reconcile-family-button"]');
    await expect(reconcileBtn).toBeVisible();
    await expect(reconcileBtn).toHaveText('状態を確認する');
    await expect(reconcileBtn).toBeEnabled();

    // Click reconcile: pending state disables button with confirmation text
    await reconcileBtn.click();
    await reconcileEnteredPromise;
    await expect(reconcileBtn).toBeDisabled();
    await expect(reconcileBtn).toHaveText('確認中...');

    // Release gate and verify UI transitions to ready state
    releaseReconcileGate();
    await expect(page.locator('[data-testid="family-status"]')).toBeVisible();
    await expect(page.locator('[data-testid="family-status"]')).toHaveText('準備完了');
    await expect(page.locator('[data-testid="family-name"]')).toHaveText('さとう家');
    expect(reconcileCalled).toBe(true);
  });

  test('Uncertain first family creation refreshes status without retrying mutations', async ({
    page,
  }) => {
    let createAttempts = 0;
    let reconcileAttempts = 0;

    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_owner', email: 'owner@example.test', displayName: '作成中パパ' },
        }),
      });
    });

    await page.route('**/api/families', async (route) => {
      if (route.request().method() === 'GET') {
        const families: FamilyPublic[] =
          createAttempts === 0
            ? []
            : [
                {
                  id: 'fam_uncertain_create',
                  name: 'さとう家',
                  familyCalendarId: null,
                  ownerUserId: 'usr_owner',
                  creationStatus: 'uncertain',
                  members: [
                    {
                      id: 'mem_owner',
                      userId: 'usr_owner',
                      kind: 'adult',
                      name: '作成中パパ',
                      color: 'indigo',
                      sortOrder: 0,
                    },
                  ],
                },
              ];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ families }),
        });
      } else if (route.request().method() === 'POST') {
        createAttempts += 1;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: '処理結果を確認できませんでした。',
            code: 'UNCERTAIN_MUTATION',
          }),
        });
      }
    });

    await page.route('**/api/families/*/reconcile', async (route) => {
      reconcileAttempts += 1;
      await route.fulfill({ status: 500, body: '' });
    });

    await page.goto('/onboarding');
    await expect(page.locator('[data-testid="family-name-input"]')).toBeVisible();
    await page.locator('[data-testid="family-name-input"]').fill('さとう家');
    await page.locator('[data-testid="create-family-button"]').click();

    await expect(page.locator('[data-testid="family-status-notice"]')).toBeVisible();
    await expect(page.locator('[data-testid="family-status-notice"]')).toContainText(
      '作成状態を確認中です',
    );
    await expect(page.locator('[data-testid="reconcile-family-button"]')).toHaveText(
      '状態を確認する',
    );
    expect(createAttempts).toBe(1);
    expect(reconcileAttempts).toBe(0);
  });

  for (const lateStatus of [200, 401] as const) {
    test(`Late reconcile ${lateStatus} response after session switch cannot replace the new user family`, async ({
      page,
    }) => {
      let currentUserId = 'usr_owner_a';

      await page.route('**/api/auth/me', async (route) => {
        const isFirstOwner = currentUserId === 'usr_owner_a';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              id: currentUserId,
              email: `${currentUserId}@example.test`,
              displayName: isFirstOwner ? '元のオーナー' : '切替後のオーナー',
            },
          }),
        });
      });

      await page.route('**/api/families', async (route) => {
        const family: FamilyPublic =
          currentUserId === 'usr_owner_a'
            ? {
                id: 'fam_owner_a',
                name: '元の家族',
                familyCalendarId: null,
                ownerUserId: 'usr_owner_a',
                creationStatus: 'uncertain',
                members: [
                  {
                    id: 'mem_owner_a',
                    userId: 'usr_owner_a',
                    kind: 'adult',
                    name: '元のオーナー',
                    color: 'indigo',
                    sortOrder: 0,
                  },
                ],
              }
            : {
                id: 'fam_owner_b',
                name: '切替後の家族',
                familyCalendarId: 'cal_owner_b',
                ownerUserId: 'usr_owner_b',
                creationStatus: 'ready',
                members: [
                  {
                    id: 'mem_owner_b',
                    userId: 'usr_owner_b',
                    kind: 'adult',
                    name: '切替後のオーナー',
                    color: 'green',
                    sortOrder: 0,
                  },
                ],
              };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ families: [family] }),
        });
      });

      let resolveReconcileEntered!: () => void;
      const reconcileEntered = new Promise<void>((resolve) => {
        resolveReconcileEntered = resolve;
      });
      let releaseReconcile!: () => void;
      const reconcileGate = new Promise<void>((resolve) => {
        releaseReconcile = resolve;
      });
      let resolveReconcileHandlerFinished!: () => void;
      const reconcileHandlerFinished = new Promise<void>((resolve) => {
        resolveReconcileHandlerFinished = resolve;
      });

      await page.route('**/api/families/fam_owner_a/reconcile', async (route) => {
        resolveReconcileEntered();
        try {
          await reconcileGate;
          await route.fulfill({
            status: lateStatus,
            contentType: 'application/json',
            body:
              lateStatus === 200
                ? JSON.stringify({
                    family: {
                      id: 'fam_owner_a',
                      name: '元の家族',
                      familyCalendarId: 'cal_owner_a',
                      ownerUserId: 'usr_owner_a',
                      creationStatus: 'ready',
                      members: [
                        {
                          id: 'mem_owner_a',
                          userId: 'usr_owner_a',
                          kind: 'adult',
                          name: '元のオーナー',
                          color: 'indigo',
                          sortOrder: 0,
                        },
                      ],
                    },
                  })
                : JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }),
          });
        } catch {
          // The browser can abort the request when the authenticated identity changes.
        } finally {
          resolveReconcileHandlerFinished();
        }
      });

      await page.goto('/onboarding');
      await expect(page.locator('[data-testid="reconcile-family-button"]')).toBeVisible();
      await page.locator('[data-testid="reconcile-family-button"]').click();
      await reconcileEntered;

      currentUserId = 'usr_owner_b';
      const authRefresh = page.waitForResponse(
        (response) => response.url().includes('/api/auth/me') && response.status() === 200,
      );
      await triggerVisibilityCycle(page);
      await authRefresh;
      await expect(page.locator('[data-testid="family-name"]')).toHaveText('切替後の家族');

      releaseReconcile();
      await reconcileHandlerFinished;
      await waitForTwoRafs(page);
      await expect(page.locator('[data-testid="family-name"]')).toHaveText('切替後の家族');
    });
  }

  test('Non-owner cannot reconcile uncertain family; failed creation allows owner retry', async ({
    page,
  }) => {
    // 1. Non-owner viewing uncertain family has no reconcile button
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_member', email: 'member@example.test', displayName: '参加者' },
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
              id: 'fam_uncertain',
              name: 'さとう家',
              familyCalendarId: null,
              ownerUserId: 'usr_other_owner',
              creationStatus: 'uncertain',
              members: [
                {
                  id: 'mem_1',
                  userId: 'usr_member',
                  kind: 'adult',
                  name: '参加者',
                  color: 'green',
                  sortOrder: 1,
                },
              ],
            },
          ],
        }),
      });
    });

    await page.goto('/onboarding');
    await expect(page.locator('[data-testid="family-status-notice"]')).toBeVisible();
    await expect(page.locator('[data-testid="reconcile-family-button"]')).toHaveCount(0);

    // 2. Owner viewing failed status sees retry button and can retry creation
    await page.goto('about:blank');
    await page.unroute('**/api/auth/me');
    await page.unroute('**/api/families');

    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_owner', email: 'owner@example.test', displayName: 'オーナー' },
        }),
      });
    });

    let retryCreated = false;
    await page.route('**/api/families', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            families: [
              {
                id: 'fam_failed',
                name: '失敗後リトライ家',
                familyCalendarId: null,
                ownerUserId: 'usr_owner',
                creationStatus: retryCreated ? 'ready' : 'failed',
                members: [
                  {
                    id: 'mem_1',
                    userId: 'usr_owner',
                    kind: 'adult',
                    name: 'オーナー',
                    color: 'indigo',
                    sortOrder: 0,
                  },
                ],
              },
            ],
          }),
        });
      } else if (route.request().method() === 'POST') {
        retryCreated = true;
        const body = route.request().postDataJSON();
        expect(body.name).toBe('失敗後リトライ家');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            family: {
              id: 'fam_failed',
              name: '失敗後リトライ家',
              familyCalendarId: 'cal_retry_success',
              ownerUserId: 'usr_owner',
              creationStatus: 'ready',
              members: [
                {
                  id: 'mem_1',
                  userId: 'usr_owner',
                  kind: 'adult',
                  name: 'オーナー',
                  color: 'indigo',
                  sortOrder: 0,
                },
              ],
            },
          }),
        });
      }
    });

    await page.goto('/onboarding');
    const failedNotice = page.locator('[data-testid="family-status-notice"]');
    await expect(failedNotice).toBeVisible();
    await expect(failedNotice).toContainText('家族カレンダーの作成に失敗しました');

    const retryBtn = page.locator('[data-testid="retry-create-family-button"]');
    await expect(retryBtn).toBeVisible();
    await expect(retryBtn).toHaveText('家族カレンダーの作成を再試行');
    await retryBtn.click();

    // After retry succeeds, transitions to ready state
    await expect(page.locator('[data-testid="family-status"]')).toBeVisible();
    await expect(page.locator('[data-testid="family-status"]')).toHaveText('準備完了');
    expect(retryCreated).toBe(true);
  });

  test('Anonymous user at /invite: calls POST /api/auth/login with inviteToken, returns without auto-join', async ({
    page,
  }) => {
    let isAuthenticated = false;

    await page.route('**/api/auth/me', async (route) => {
      if (isAuthenticated) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: { id: 'usr_invited', email: 'invited@example.test', displayName: '招待ママ' },
          }),
        });
      } else {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Unauthorized' }),
        });
      }
    });

    let loginPayload: { inviteToken?: string } | null = null;
    await page.route('**/api/auth/login', async (route) => {
      loginPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authorizationUrl:
            'https://accounts.google.com/o/oauth2/v2/auth?state=encrypted_with_token',
        }),
      });
    });

    await page.route('https://accounts.google.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body>Mock Google Auth</body></html>',
      });
    });

    let inspectCalled = false;
    await page.route('**/api/invites/inspect', async (route) => {
      inspectCalled = true;
      const body = route.request().postDataJSON();
      expect(body.token).toBe(VALID_TOKEN);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          familyName: 'たなか家',
          status: 'available',
          alreadyMember: false,
        }),
      });
    });

    let joinCalled = false;
    await page.route('**/api/invites/join', async (route) => {
      joinCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          family: {
            id: 'fam_tanaka',
            name: 'たなか家',
            familyCalendarId: 'cal_123',
            ownerUserId: 'usr_owner',
            creationStatus: 'ready',
            members: [],
          },
        }),
      });
    });

    // Visit anonymous invite page
    await page.goto(`/invite#${VALID_TOKEN}`);
    await expect(page.locator('[data-testid="invite-screen"]')).toBeVisible();

    const loginWithInviteBtn = page.locator('[data-testid="login-with-invite-button"]');
    await expect(loginWithInviteBtn).toBeVisible();

    // Click login with invite
    await Promise.all([
      page.waitForURL((url) => url.hostname === 'accounts.google.com'),
      loginWithInviteBtn.click(),
    ]);

    expect(loginPayload).toEqual({ inviteToken: VALID_TOKEN });

    // Simulate login completion and return to /invite#token
    isAuthenticated = true;
    await page.goto(`/invite#${VALID_TOKEN}`);

    // Inspect API was called, but join API was NEVER called automatically!
    await expect(page.locator('[data-testid="inspect-family-name"]')).toBeVisible();
    await expect(page.locator('[data-testid="inspect-family-name"]')).toContainText('たなか家');
    expect(inspectCalled).toBe(true);
    expect(joinCalled).toBe(false);

    // Explicit confirmation button is displayed
    const joinBtn = page.locator('[data-testid="join-family-button"]');
    await expect(joinBtn).toBeVisible();
    await expect(joinBtn).toHaveText('この家族に参加する');
  });

  test('Authenticated join confirmation leads to success view with exact Google notification guide', async ({
    page,
  }) => {
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_invited', email: 'invited@example.test', displayName: '招待ママ' },
        }),
      });
    });

    await page.route('**/api/invites/inspect', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          familyName: 'たなか家',
          status: 'available',
          alreadyMember: false,
        }),
      });
    });

    await page.route('**/api/invites/join', async (route) => {
      const body = route.request().postDataJSON();
      expect(body.token).toBe(VALID_TOKEN);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          family: {
            id: 'fam_tanaka',
            name: 'たなか家',
            familyCalendarId: 'cal_123',
            ownerUserId: 'usr_owner',
            creationStatus: 'ready',
            members: [
              {
                id: 'm1',
                userId: 'usr_owner',
                kind: 'adult',
                name: 'パパ',
                color: 'indigo',
                sortOrder: 0,
              },
              {
                id: 'm2',
                userId: 'usr_invited',
                kind: 'adult',
                name: 'ママ',
                color: 'green',
                sortOrder: 1,
              },
            ],
          },
        }),
      });
    });

    await page.goto(`/invite#${VALID_TOKEN}`);
    const joinBtn = page.locator('[data-testid="join-family-button"]');
    await expect(joinBtn).toBeVisible();
    await joinBtn.click();

    // Verify success card and EXACT notification guide text
    const successCard = page.locator('[data-testid="join-success-card"]');
    await expect(successCard).toBeVisible();
    await expect(page.locator('[data-testid="joined-family-name"]')).toHaveText('たなか家');

    const notificationGuide = page.locator('[data-testid="notification-guide"]');
    await expect(notificationGuide).toBeVisible();
    await expect(notificationGuide).toHaveText(
      'Google から届く共有通知メールの『カレンダーを追加』を押すと、普段の Google カレンダーにも表示されます',
    );
  });

  test('Malformed token displays fixed error and calls zero invite API endpoints', async ({
    page,
  }) => {
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_test', email: 'test@example.test', displayName: 'テスト太郎' },
        }),
      });
    });

    let inviteApiCalled = false;
    await page.route('**/api/invites/**', async (route) => {
      inviteApiCalled = true;
      await route.fulfill({ status: 500 });
    });

    // 1. No token in hash
    await page.goto('/invite');
    const errorNotice = page.locator('[data-testid="invalid-token-error"]');
    await expect(errorNotice).toBeVisible();
    await expect(errorNotice).toContainText('無効な招待リンクです。URL を確認してください。');

    // 2. Short token
    await page.goto('/invite#too_short');
    await expect(errorNotice).toBeVisible();

    expect(inviteApiCalled).toBe(false);
  });

  test('Used and expired tokens show fixed errors; uncertain tokens allow explicit retry', async ({
    page,
  }) => {
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_test', email: 'test@example.test', displayName: 'テスト太郎' },
        }),
      });
    });

    // 1. Non-available states that return 200 JoinInfoResponse
    const validNonAvailableCases: Array<{
      status: 'used' | 'claiming' | 'uncertain';
      selector: string;
      text: string;
      btnText: string;
      btnDisabled: boolean;
    }> = [
      {
        status: 'used',
        selector: '[data-testid="invite-error-used"]',
        text: 'この招待リンクは既に使用されています。',
        btnText: '既に使用されています',
        btnDisabled: true,
      },
      {
        status: 'claiming',
        selector: '[data-testid="invite-status-notice"]',
        text: '参加処理が確認待ちです',
        btnText: '参加処理を確認中',
        btnDisabled: true,
      },
      {
        status: 'uncertain',
        selector: '[data-testid="invite-status-notice"]',
        text: '参加処理が確認待ちです',
        btnText: '参加状態を確認する',
        btnDisabled: false,
      },
    ];

    for (const tc of validNonAvailableCases) {
      await page.goto('about:blank');
      await page.unroute('**/api/invites/inspect');
      await page.route('**/api/invites/inspect', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            familyName: 'たなか家',
            status: tc.status,
            alreadyMember: false,
          }),
        });
      });

      await page.goto(`/invite#${VALID_TOKEN}`);
      const notice = page.locator(tc.selector);
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(tc.text);

      const joinBtn = page.locator('[data-testid="join-family-button"]');
      await expect(joinBtn).toBeVisible();
      if (tc.btnDisabled) {
        await expect(joinBtn).toBeDisabled();
      } else {
        await expect(joinBtn).toBeEnabled();
      }
      await expect(joinBtn).toContainText(tc.btnText);

      await page.unroute('**/api/invites/inspect');
    }

    // 2. Expired invite returns HTTP 410 Gone with EXPIRED_INVITE error code
    await page.goto('about:blank');
    await page.unroute('**/api/invites/inspect');
    await page.route('**/api/invites/inspect', async (route) => {
      await route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Invite link has expired.',
          code: 'EXPIRED_INVITE',
        }),
      });
    });

    await page.goto(`/invite#${VALID_TOKEN}`);
    const expiredAlert = page.locator('[data-testid="invite-error-expired"]');
    await expect(expiredAlert).toBeVisible();
    await expect(expiredAlert).toContainText('招待リンクの有効期限が切れています。');

    // No join button on expired error
    await expect(page.locator('[data-testid="join-family-button"]')).toHaveCount(0);
    await page.unroute('**/api/invites/inspect');
  });

  test('Join initial uncertain mutation: refetches inspect to uncertain, explicit retry confirmation succeeds', async ({
    page,
  }) => {
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_joiner', email: 'joiner@example.test', displayName: '参加者' },
        }),
      });
    });

    let inspectCallCount = 0;
    await page.route('**/api/invites/inspect', async (route) => {
      inspectCallCount++;
      if (inspectCallCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            familyName: 'たなか家',
            status: 'available',
            alreadyMember: false,
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            familyName: 'たなか家',
            status: 'uncertain',
            alreadyMember: false,
          }),
        });
      }
    });

    let joinCallCount = 0;
    let resolveSecondJoinEntered!: () => void;
    const secondJoinEnteredPromise = new Promise<void>((resolve) => {
      resolveSecondJoinEntered = resolve;
    });
    let releaseSecondJoinGate!: () => void;
    const secondJoinGatePromise = new Promise<void>((resolve) => {
      releaseSecondJoinGate = resolve;
    });

    await page.route('**/api/invites/join', async (route) => {
      joinCallCount++;
      if (joinCallCount === 1) {
        // First join attempt encounters uncertain mutation (e.g. Google network timeout)
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Calendar sharing state uncertain',
            code: 'UNCERTAIN_MUTATION',
          }),
        });
      } else {
        // Second join attempt (user clicked explicit retry) succeeds
        resolveSecondJoinEntered();
        await secondJoinGatePromise;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            family: {
              id: 'fam_tanaka',
              name: 'たなか家',
              familyCalendarId: 'cal_123',
              ownerUserId: 'usr_owner',
              creationStatus: 'ready',
              members: [
                {
                  id: 'm1',
                  userId: 'usr_owner',
                  kind: 'adult',
                  name: 'オーナー',
                  color: 'indigo',
                  sortOrder: 0,
                },
                {
                  id: 'm2',
                  userId: 'usr_joiner',
                  kind: 'adult',
                  name: '参加者',
                  color: 'green',
                  sortOrder: 1,
                },
              ],
            },
          }),
        });
      }
    });

    await page.goto(`/invite#${VALID_TOKEN}`);

    // First inspect returns available: join button is visible
    const joinBtn = page.locator('[data-testid="join-family-button"]');
    await expect(joinBtn).toBeVisible();
    await expect(joinBtn).toHaveText('この家族に参加する');

    // Click join -> fails with UNCERTAIN_MUTATION -> client invalidates/refetches inspect to uncertain
    const secondInspectPromise = page.waitForResponse(
      (res) => res.url().includes('/api/invites/inspect') && res.status() === 200,
    );
    await joinBtn.click();
    await secondInspectPromise;
    expect(inspectCallCount).toBe(2);

    // Notice is visible and join button changes to explicit retry button
    const notice = page.locator('[data-testid="invite-status-notice"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('参加処理が確認待ちです');

    // Button is now enabled for explicit retry with text 『参加状態を確認する』
    await expect(joinBtn).toBeVisible();
    await expect(joinBtn).toHaveText('参加状態を確認する');
    await expect(joinBtn).toBeEnabled();

    // Invariant: second join mutation was NOT called automatically
    expect(joinCallCount).toBe(1);

    // User explicitly clicks retry button
    await joinBtn.click();
    await secondJoinEnteredPromise;

    // While pending, button is disabled with confirmation text
    await expect(joinBtn).toBeDisabled();
    await expect(joinBtn).toHaveText('確認中...');

    // Release second join gate and verify success view with notification guide
    releaseSecondJoinGate();
    const successCard = page.locator('[data-testid="join-success-card"]');
    await expect(successCard).toBeVisible();
    await expect(page.locator('[data-testid="joined-family-name"]')).toHaveText('たなか家');

    const notificationGuide = page.locator('[data-testid="notification-guide"]');
    await expect(notificationGuide).toBeVisible();
    await expect(notificationGuide).toHaveText(
      'Google から届く共有通知メールの『カレンダーを追加』を押すと、普段の Google カレンダーにも表示されます',
    );
    expect(joinCallCount).toBe(2);
  });

  test('Uncertain inspect refresh does not refetch for a new identity after the invite query switches users', async ({
    page,
  }) => {
    let currentUserId = 'usr_joiner_a';
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: currentUserId,
            email: `${currentUserId}@example.test`,
            displayName: '参加者',
          },
        }),
      });
    });

    let inspectCallCount = 0;
    let resolveRefreshEntered!: () => void;
    const refreshEntered = new Promise<void>((resolve) => {
      resolveRefreshEntered = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let resolveRefreshHandlerFinished!: () => void;
    const refreshHandlerFinished = new Promise<void>((resolve) => {
      resolveRefreshHandlerFinished = resolve;
    });
    let resolveNewIdentityInspect!: () => void;
    const newIdentityInspectEntered = new Promise<void>((resolve) => {
      resolveNewIdentityInspect = resolve;
    });

    await page.route('**/api/invites/inspect', async (route) => {
      inspectCallCount += 1;
      const requestUserId = currentUserId;
      if (requestUserId === 'usr_joiner_a' && inspectCallCount === 2) {
        resolveRefreshEntered();
        try {
          await refreshGate;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              familyName: 'たなか家',
              status: 'uncertain',
              alreadyMember: false,
            }),
          });
        } catch {
          // The old identity's query may be cancelled when the session changes.
        } finally {
          resolveRefreshHandlerFinished();
        }
        return;
      }
      if (requestUserId === 'usr_joiner_b') {
        resolveNewIdentityInspect();
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          familyName: 'たなか家',
          status: 'available',
          alreadyMember: false,
        }),
      });
    });

    let joinCallCount = 0;
    await page.route('**/api/invites/join', async (route) => {
      joinCallCount += 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Calendar sharing state uncertain',
          code: 'UNCERTAIN_MUTATION',
        }),
      });
    });

    await page.goto(`/invite#${VALID_TOKEN}`);
    const joinBtn = page.locator('[data-testid="join-family-button"]');
    await expect(joinBtn).toHaveText('この家族に参加する');
    await joinBtn.click();
    await refreshEntered;

    currentUserId = 'usr_joiner_b';
    const authRefresh = page.waitForResponse(
      (response) => response.url().includes('/api/auth/me') && response.status() === 200,
    );
    await triggerVisibilityCycle(page);
    await authRefresh;
    await newIdentityInspectEntered;
    expect(inspectCallCount).toBe(3);

    releaseRefresh();
    await refreshHandlerFinished;
    await page.waitForLoadState('networkidle');
    await waitForTwoRafs(page);

    // The new identity gets its own initial inspect only; the old mutation does not refetch it.
    expect(inspectCallCount).toBe(3);
    expect(joinCallCount).toBe(1);
  });

  test('Regression: refetch failure (410 expired or 500 error) fails closed, hiding previous confirmation card and join button', async ({
    page,
  }) => {
    for (const testCase of [
      {
        status: 410,
        body: { error: 'Invite link has expired.', code: 'EXPIRED_INVITE' },
        selector: '[data-testid="invite-error-expired"]',
        text: '招待リンクの有効期限が切れています。',
      },
      {
        status: 500,
        body: { error: 'Internal Server Error' },
        selector: '[data-testid="inspect-error-alert"]',
        text: '招待情報の確認に失敗しました。',
      },
    ]) {
      await page.goto('about:blank');
      await page.route('**/api/auth/me', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: { id: 'usr_test', email: 'test@example.test', displayName: 'テスト太郎' },
          }),
        });
      });

      let joinCalled = false;
      await page.route('**/api/invites/join', async (route) => {
        joinCalled = true;
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
      });

      let inspectCount = 0;
      await page.route('**/api/invites/inspect', async (route) => {
        inspectCount++;
        if (inspectCount === 1) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              familyName: 'たなか家',
              status: 'available',
              alreadyMember: false,
            }),
          });
        } else {
          await route.fulfill({
            status: testCase.status,
            contentType: 'application/json',
            body: JSON.stringify(testCase.body),
          });
        }
      });

      await page.goto(`/invite#${VALID_TOKEN}`);

      // First inspect returns available 200: confirmation and join button are visible
      const familyName = page.locator('[data-testid="inspect-family-name"]');
      const joinBtn = page.locator('[data-testid="join-family-button"]');
      await expect(familyName).toBeVisible();
      await expect(familyName).toContainText('たなか家');
      await expect(joinBtn).toBeVisible();
      await expect(joinBtn).toBeEnabled();

      // Trigger actual query visibility/focus refetch and explicitly await that exact second request/result
      const refetchPromise = page.waitForResponse(
        (res) => res.url().includes('/api/invites/inspect') && res.status() === testCase.status,
      );
      await triggerVisibilityCycle(page);
      await refetchPromise;

      // Assert error UI is visible with fixed Japanese message
      const errorNotice = page.locator(testCase.selector);
      await expect(errorNotice).toBeVisible();
      await expect(errorNotice).toContainText(testCase.text);

      // Fail-closed invariant: assert old confirmation card, family name, and join button are absent
      await expect(page.locator('[data-testid="inspect-family-name"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="join-family-button"]')).toHaveCount(0);

      // Invariant: no POST /api/invites/join was executed
      expect(joinCalled).toBe(false);

      // Clean up routes for next iteration
      await page.unroute('**/api/invites/inspect');
      await page.unroute('**/api/invites/join');
      await page.unroute('**/api/auth/me');
    }
  });

  test('Logout / session change clears private family data and join success view', async ({
    page,
  }) => {
    let isAuthenticated = true;

    await page.route('**/api/auth/me', async (route) => {
      if (isAuthenticated) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: { id: 'usr_test', email: 'test@example.test', displayName: 'テスト太郎' },
          }),
        });
      } else {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Unauthorized' }),
        });
      }
    });

    await page.route('**/api/invites/inspect', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          familyName: 'たなか家',
          status: 'available',
          alreadyMember: false,
        }),
      });
    });

    await page.route('**/api/invites/join', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          family: {
            id: 'fam_1',
            name: 'たなか家',
            familyCalendarId: 'cal_1',
            ownerUserId: 'usr_other',
            creationStatus: 'ready',
            members: [
              {
                id: 'm1',
                userId: 'usr_other',
                name: 'パパ',
                color: 'indigo',
                kind: 'adult',
                sortOrder: 0,
              },
            ],
          },
        }),
      });
    });

    await page.goto(`/invite#${VALID_TOKEN}`);
    await page.locator('[data-testid="join-family-button"]').click();
    await expect(page.locator('[data-testid="join-success-card"]')).toBeVisible();

    // Session invalidated in background
    isAuthenticated = false;
    await triggerVisibilityCycle(page);

    // Private success data is cleared, transitions to anonymous join card
    await expect(page.locator('[data-testid="join-success-card"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="login-with-invite-button"]')).toBeVisible();
  });

  test('Race condition: late join response after user identity switch is discarded', async ({
    page,
  }) => {
    let currentUserId = 'usr_original';

    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: currentUserId,
            email: `${currentUserId}@example.test`,
            displayName: currentUserId === 'usr_original' ? '元ユーザー' : '切替ユーザー',
          },
        }),
      });
    });

    await page.route('**/api/invites/inspect', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          familyName: 'たなか家',
          status: 'available',
          alreadyMember: false,
        }),
      });
    });

    let staleJoinRequest: import('@playwright/test').Request | null = null;
    let resolveJoinEntered!: () => void;
    const joinEnteredPromise = new Promise<void>((resolve) => {
      resolveJoinEntered = resolve;
    });
    let releaseJoinGate!: () => void;
    const joinGatePromise = new Promise<void>((resolve) => {
      releaseJoinGate = resolve;
    });
    let resolveJoinFulfilled!: () => void;
    const joinFulfilledPromise = new Promise<void>((resolve) => {
      resolveJoinFulfilled = resolve;
    });

    await page.route('**/api/invites/join', async (route) => {
      staleJoinRequest = route.request();
      resolveJoinEntered();
      try {
        await joinGatePromise;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            family: {
              id: 'fam_late',
              name: '遅延家族',
              familyCalendarId: 'cal_late',
              ownerUserId: 'usr_original',
              creationStatus: 'ready',
              members: [
                {
                  id: 'm1',
                  userId: 'usr_original',
                  name: '元ユーザー',
                  color: 'indigo',
                  kind: 'adult',
                  sortOrder: 0,
                },
              ],
            },
          }),
        });
      } finally {
        resolveJoinFulfilled();
      }
    });

    await page.goto(`/invite#${VALID_TOKEN}`);
    const joinBtn = page.locator('[data-testid="join-family-button"]');
    await expect(joinBtn).toBeVisible();

    // Trigger join request and await click + entered
    await joinBtn.click();
    await joinEnteredPromise;
    expect(staleJoinRequest).not.toBeNull();

    // Preinstall completion listener for the exact stale join request
    const joinFinishedOrFailed = Promise.race([
      page.waitForEvent('requestfinished', (req) => req === staleJoinRequest),
      page.waitForEvent('requestfailed', (req) => req === staleJoinRequest),
    ]);

    // User switches identity in background
    currentUserId = 'usr_switched';
    const bAuthMePromise = page.waitForResponse(
      (res) => res.url().includes('/api/auth/me') && res.status() === 200,
    );
    const bInspectPromise = page.waitForResponse(
      (res) => res.url().includes('/api/invites/inspect') && res.status() === 200,
    );

    await triggerVisibilityCycle(page);
    await bAuthMePromise;
    await bInspectPromise;

    // BEFORE release: prove fresh state reached
    await expect(page.locator('[data-testid="inspect-family-name"]')).toBeVisible();
    await expect(page.locator('[data-testid="inspect-family-name"]')).toContainText('たなか家');
    await expect(page.locator('[data-testid="join-family-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="joined-family-name"]')).toHaveCount(0);

    // RELEASE gate finally always
    try {
      releaseJoinGate();
    } finally {
      await joinFulfilledPromise;
      await joinFinishedOrFailed;
      await waitForTwoRafs(page);
    }

    // AFTER release: prove old stale response never revives
    await expect(page.locator('[data-testid="joined-family-name"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="inspect-family-name"]')).toBeVisible();
    await expect(page.locator('[data-testid="join-family-button"]')).toBeVisible();
  });

  test('Race condition: late invite response after session 401 is discarded', async ({ page }) => {
    let isAuthenticated = true;

    await page.route('**/api/auth/me', async (route) => {
      if (isAuthenticated) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: { id: 'usr_owner', email: 'owner@example.test', displayName: 'オーナーパパ' },
          }),
        });
      } else {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Unauthorized' }),
        });
      }
    });

    await page.route('**/api/families', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          families: [
            {
              id: 'fam_owner',
              name: 'オーナー家',
              familyCalendarId: 'cal_123',
              ownerUserId: 'usr_owner',
              creationStatus: 'ready',
              members: [
                {
                  id: 'm1',
                  userId: 'usr_owner',
                  name: 'パパ',
                  color: 'indigo',
                  kind: 'adult',
                  sortOrder: 0,
                },
              ],
            },
          ],
        }),
      });
    });

    let staleInviteRequest: import('@playwright/test').Request | null = null;
    let resolveInviteEntered!: () => void;
    const inviteEnteredPromise = new Promise<void>((resolve) => {
      resolveInviteEntered = resolve;
    });
    let releaseInviteGate!: () => void;
    const inviteGatePromise = new Promise<void>((resolve) => {
      releaseInviteGate = resolve;
    });
    let resolveInviteFulfilled!: () => void;
    const inviteFulfilledPromise = new Promise<void>((resolve) => {
      resolveInviteFulfilled = resolve;
    });

    await page.route('**/api/families/fam_owner/invites', async (route) => {
      staleInviteRequest = route.request();
      resolveInviteEntered();
      try {
        await inviteGatePromise;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            authorizationRequired: false,
            inviteUrl: `http://127.0.0.1:4173/invite#${VALID_TOKEN}`,
            expiresAt: 1790000000,
          }),
        });
      } finally {
        resolveInviteFulfilled();
      }
    });

    await page.goto('/onboarding');
    const issueBtn = page.locator('[data-testid="issue-invite-button"]');
    await expect(issueBtn).toBeVisible();

    // Trigger invite issue and await click + entered
    await issueBtn.click();
    await inviteEnteredPromise;
    expect(staleInviteRequest).not.toBeNull();

    // Preinstall completion listener for the exact stale invite request
    const inviteFinishedOrFailed = Promise.race([
      page.waitForEvent('requestfinished', (req) => req === staleInviteRequest),
      page.waitForEvent('requestfailed', (req) => req === staleInviteRequest),
    ]);

    // Session invalidated in background before response arrives
    isAuthenticated = false;
    const authMe401Promise = page.waitForResponse(
      (res) => res.url().includes('/api/auth/me') && res.status() === 401,
    );

    await triggerVisibilityCycle(page);
    await authMe401Promise;

    // BEFORE release: prove fresh state reached
    await expect(page.locator('[data-testid="login-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="owner-invite-section"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="invite-url-container"]')).toHaveCount(0);

    // RELEASE gate finally always
    try {
      releaseInviteGate();
    } finally {
      await inviteFulfilledPromise;
      await inviteFinishedOrFailed;
      await waitForTwoRafs(page);
    }

    // AFTER release: prove stale invite URL is NEVER shown
    await expect(page.locator('[data-testid="invite-url-container"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="login-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="owner-invite-section"]')).toHaveCount(0);
  });

  test('Race condition: mutation 401 revokes session and stale metadata GET 200 cannot revalidate controls', async ({
    page,
  }) => {
    let sessionStatus = 200;

    await page.route('**/api/auth/me', async (route) => {
      if (sessionStatus === 200) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: { id: 'usr_owner', email: 'owner@example.test', displayName: 'オーナーパパ' },
          }),
        });
      } else {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Unauthorized' }),
        });
      }
    });

    let staleGetRequest: import('@playwright/test').Request | null = null;
    let resolveStaleGetEntered!: () => void;
    const staleGetEnteredPromise = new Promise<void>((resolve) => {
      resolveStaleGetEntered = resolve;
    });
    let releaseStaleGetGate!: () => void;
    const staleGetGatePromise = new Promise<void>((resolve) => {
      releaseStaleGetGate = resolve;
    });
    let resolveStaleGetFulfilled!: () => void;
    const staleGetFulfilledPromise = new Promise<void>((resolve) => {
      resolveStaleGetFulfilled = resolve;
    });
    let getCallCount = 0;

    await page.route('**/api/families', async (route) => {
      if (route.request().method() === 'GET') {
        getCallCount++;
        if (getCallCount === 1) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              families: [
                {
                  id: 'fam_owner',
                  name: 'オーナー家',
                  familyCalendarId: 'cal_123',
                  ownerUserId: 'usr_owner',
                  creationStatus: 'ready',
                  members: [
                    {
                      id: 'm1',
                      userId: 'usr_owner',
                      name: 'パパ',
                      color: 'indigo',
                      kind: 'adult',
                      sortOrder: 0,
                    },
                  ],
                },
              ],
            }),
          });
        } else {
          // Second GET held in gate
          staleGetRequest = route.request();
          resolveStaleGetEntered();
          try {
            await staleGetGatePromise;
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                families: [
                  {
                    id: 'fam_owner',
                    name: 'オーナー家',
                    familyCalendarId: 'cal_123',
                    ownerUserId: 'usr_owner',
                    creationStatus: 'ready',
                    members: [
                      {
                        id: 'm1',
                        userId: 'usr_owner',
                        name: 'パパ',
                        color: 'indigo',
                        kind: 'adult',
                        sortOrder: 0,
                      },
                    ],
                  },
                ],
              }),
            });
          } finally {
            resolveStaleGetFulfilled();
          }
        }
      }
    });

    await page.route('**/api/families/fam_owner/invites', async (route) => {
      // Invite mutation returns 401 Unauthorized
      sessionStatus = 401;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }),
      });
    });

    await page.goto('/onboarding');
    const issueBtn = page.locator('[data-testid="issue-invite-button"]');
    await expect(issueBtn).toBeVisible();

    // Trigger background families refetch via visibility
    await triggerVisibilityCycle(page);
    await staleGetEnteredPromise;
    expect(staleGetRequest).not.toBeNull();

    // Preinstall completion listener for the exact stale GET request
    const staleGetFinishedOrFailed = Promise.race([
      page.waitForEvent('requestfinished', (req) => req === staleGetRequest),
      page.waitForEvent('requestfailed', (req) => req === staleGetRequest),
    ]);

    // Issue invite fails with 401
    const invite401ResponsePromise = page.waitForResponse(
      (res) => res.url().includes('/api/families/fam_owner/invites') && res.status() === 401,
    );
    await issueBtn.click();
    await invite401ResponsePromise;

    // BEFORE release: prove fresh state reached (401 revocation cleared session)
    await expect(page.locator('[data-testid="login-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="owner-invite-section"]')).toHaveCount(0);

    // RELEASE stale GET response finally always
    try {
      releaseStaleGetGate();
    } finally {
      await staleGetFulfilledPromise;
      await staleGetFinishedOrFailed;
      await waitForTwoRafs(page);
    }

    // AFTER release: Stale GET 200 must NOT restore private family controls after 401 revocation
    await expect(page.locator('[data-testid="login-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="owner-invite-section"]')).toHaveCount(0);
  });

  test('Copy invite link renders fallback guidance when clipboard write fails', async ({
    page,
    context,
  }) => {
    // Clear clipboard permissions
    await context.clearPermissions();

    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_owner', email: 'owner@example.test', displayName: 'オーナーパパ' },
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
              id: 'fam_owner',
              name: 'たなか家',
              familyCalendarId: 'cal_123',
              ownerUserId: 'usr_owner',
              creationStatus: 'ready',
              members: [
                {
                  id: 'mem_1',
                  userId: 'usr_owner',
                  kind: 'adult',
                  name: 'オーナーパパ',
                  color: 'indigo',
                  sortOrder: 0,
                },
              ],
            },
          ],
        }),
      });
    });

    await page.route('**/api/families/fam_owner/invites', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authorizationRequired: false,
          inviteUrl: `http://127.0.0.1:4173/invite#${VALID_TOKEN}`,
          expiresAt: 1790000000,
        }),
      });
    });

    await page.goto('/onboarding');
    const issueBtn = page.locator('[data-testid="issue-invite-button"]');
    await issueBtn.click();
    await expect(page.locator('[data-testid="invite-url-input"]')).toBeVisible();

    // Mock clipboard write to throw Permission denied
    await page.evaluate(() => {
      if (navigator.clipboard) {
        navigator.clipboard.writeText = () => Promise.reject(new Error('Permission denied'));
      }
      document.execCommand = () => false;
    });

    const copyBtn = page.locator('[data-testid="copy-invite-button"]');
    await copyBtn.click();

    // Invariant: UI does NOT falsely claim success, shows fallback manual copy guidance
    await expect(page.locator('[data-testid="copy-status"]')).toHaveCount(0);
    const fallbackNotice = page.locator('text=お使いの環境では自動コピーができません');
    await expect(fallbackNotice).toBeVisible();
  });

  test('Strict URL validation through UI: malicious OAuth URLs are rejected with fixed error and prevent navigation', async ({
    page,
  }) => {
    // 1. In InviteJoinPage: Anonymous user clicks login-with-invite button
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
    });

    const maliciousAuthUrls = [
      'https://evil.com/o/oauth2/v2/auth',
      'https://accounts.google.com:8443/o/oauth2/v2/auth',
      'https://user:pass@accounts.google.com/o/oauth2/v2/auth',
    ];

    for (const badUrl of maliciousAuthUrls) {
      await page.route('**/api/auth/login', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ authorizationUrl: badUrl }),
        });
      });

      await page.goto(`/invite#${VALID_TOKEN}`);
      const loginBtn = page.locator('[data-testid="login-with-invite-button"]');
      await expect(loginBtn).toBeVisible();
      await loginBtn.click();

      // UI displays fixed error and does NOT navigate externally
      const alert = page.locator('role=alert');
      await expect(alert).toBeVisible();
      await expect(alert).toContainText('許可されていない認可先 URL です。');
      expect(page.url()).toContain('/invite');
    }

    // 2. In OnboardingPage: Owner issues invite and receives malicious incremental authorizationUrl
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_owner', email: 'owner@example.test', displayName: 'オーナー' },
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
              id: 'fam_owner',
              name: '検証家',
              familyCalendarId: 'cal_123',
              ownerUserId: 'usr_owner',
              creationStatus: 'ready',
              members: [
                {
                  id: 'mem_1',
                  userId: 'usr_owner',
                  kind: 'adult',
                  name: 'オーナー',
                  color: 'indigo',
                  sortOrder: 0,
                },
              ],
            },
          ],
        }),
      });
    });

    await page.route('**/api/families/fam_owner/invites', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authorizationRequired: true,
          authorizationUrl: 'https://evil.com/o/oauth2/v2/auth',
        }),
      });
    });

    await page.goto('/onboarding');
    const issueBtn = page.locator('[data-testid="issue-invite-button"]');
    await expect(issueBtn).toBeVisible();
    await issueBtn.click();

    const issueAlert = page.locator('[data-testid="issue-invite-error"]');
    await expect(issueAlert).toBeVisible();
    await expect(issueAlert).toContainText('許可されていない認可先 URL です。');
    expect(page.url()).toContain('/onboarding');
  });

  test('Strict URL validation through UI: malicious invite URLs are rejected with fixed error and produce no copiable link', async ({
    page,
  }) => {
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_owner', email: 'owner@example.test', displayName: 'オーナー' },
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
              id: 'fam_owner',
              name: '検証家',
              familyCalendarId: 'cal_123',
              ownerUserId: 'usr_owner',
              creationStatus: 'ready',
              members: [
                {
                  id: 'mem_1',
                  userId: 'usr_owner',
                  kind: 'adult',
                  name: 'オーナー',
                  color: 'indigo',
                  sortOrder: 0,
                },
              ],
            },
          ],
        }),
      });
    });

    const maliciousInviteUrls = [
      {
        url: `https://evil-phishing.test/invite#${VALID_TOKEN}`,
        error: '招待 URL の形式が無効です。',
      },
      {
        url: `http://user:pass@127.0.0.1:4173/invite#${VALID_TOKEN}`,
        error: '招待 URL の形式が無効です。',
      },
      {
        url: `http://127.0.0.1:4173/invite?leak=true#${VALID_TOKEN}`,
        error: '招待 URL の形式が無効です。',
      },
      {
        url: 'http://127.0.0.1:4173/invite#invalid_short_hash',
        error: '招待トークンの形式が無効です。',
      },
    ];

    for (const item of maliciousInviteUrls) {
      await page.route('**/api/families/fam_owner/invites', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            authorizationRequired: false,
            inviteUrl: item.url,
            expiresAt: 1790000000,
          }),
        });
      });

      await page.goto('/onboarding');
      const issueBtn = page.locator('[data-testid="issue-invite-button"]');
      await expect(issueBtn).toBeVisible();
      await issueBtn.click();

      const issueAlert = page.locator('[data-testid="issue-invite-error"]');
      await expect(issueAlert).toBeVisible();
      await expect(issueAlert).toContainText(item.error);

      // Invariant: Malicious invite links are NEVER made available to copy
      await expect(page.locator('[data-testid="invite-url-container"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="copy-invite-button"]')).toHaveCount(0);
    }
  });

  test('80-char names do not overflow horizontally and touch targets meet 44px minimum', async ({
    page,
  }) => {
    const longName = 'A'.repeat(80);
    const longChildName = 'B'.repeat(80);

    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_owner', email: 'owner@example.test', displayName: 'オーナーパパ' },
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
              id: 'fam_long',
              name: longName,
              familyCalendarId: 'cal_123',
              ownerUserId: 'usr_owner',
              creationStatus: 'ready',
              members: [
                {
                  id: 'mem_1',
                  userId: 'usr_owner',
                  kind: 'adult',
                  name: 'オーナーパパ',
                  color: 'indigo',
                  sortOrder: 0,
                },
                {
                  id: 'mem_2',
                  userId: null,
                  kind: 'child',
                  name: longChildName,
                  color: 'ochre',
                  sortOrder: 1,
                },
              ],
            },
          ],
        }),
      });
    });

    await page.goto('/onboarding');
    await expect(page.locator('[data-testid="onboarding-screen"]')).toBeVisible();

    // Await ready controls before measuring
    const familyNameHeading = page.locator('[data-testid="family-name"]');
    await expect(familyNameHeading).toBeVisible();
    await expect(familyNameHeading).toHaveText(longName);

    const memberLegend = page.locator('[data-testid="member-legend"]');
    await expect(memberLegend).toBeVisible();

    // Check no horizontal overflow beyond container / viewport (390px mobile view)
    const isOverflowing = await page.evaluate(() => {
      const screen = document.querySelector('[data-testid="onboarding-screen"]');
      if (!screen) return true;
      return screen.scrollWidth > screen.clientWidth;
    });
    expect(isOverflowing).toBe(false);

    // Touch targets meet 44px minimum
    const interactiveSelectors = [
      '[data-testid="back-to-home"]',
      '[data-testid="add-child-button"]',
      '[data-testid="save-children-button"]',
      '[data-testid="issue-invite-button"]',
    ];

    for (const sel of interactiveSelectors) {
      const el = page.locator(sel);
      await expect(el).toBeVisible();
      const box = await el.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test('Token hashchange updates invite UI and discards prior inspection state', async ({
    page,
  }) => {
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_test', email: 'test@example.test', displayName: 'テスト太郎' },
        }),
      });
    });

    const TOKEN_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const TOKEN_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

    await page.route('**/api/invites/inspect', async (route) => {
      const body = route.request().postDataJSON();
      if (body.token === TOKEN_A) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            familyName: '家族A',
            status: 'available',
            alreadyMember: false,
          }),
        });
      } else if (body.token === TOKEN_B) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            familyName: '家族B',
            status: 'available',
            alreadyMember: false,
          }),
        });
      }
    });

    await page.goto(`/invite#${TOKEN_A}`);
    await expect(page.locator('[data-testid="inspect-family-name"]')).toContainText('家族A');

    // Change hash to TOKEN_B via window.location.hash
    await page.evaluate((tok) => {
      window.location.hash = tok;
    }, TOKEN_B);

    await expect(page.locator('[data-testid="inspect-family-name"]')).toContainText('家族B');

    // Change hash to invalid token
    await page.evaluate(() => {
      window.location.hash = 'invalid_short';
    });

    await expect(page.locator('[data-testid="invalid-token-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="inspect-family-name"]')).toHaveCount(0);
  });

  test('Invite issue locks synchronously, stays disabled during authorization redirect, and unlocks on persisted pageshow', async ({
    page,
  }) => {
    const family: FamilyPublic = {
      id: 'fam_owner',
      name: 'たなか家',
      familyCalendarId: 'cal_owner',
      ownerUserId: 'usr_owner',
      creationStatus: 'ready',
      members: [
        {
          id: 'mem_owner',
          userId: 'usr_owner',
          kind: 'adult',
          name: 'オーナー',
          color: 'indigo',
          sortOrder: 0,
        },
      ],
    };
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_owner', email: 'owner@example.test', displayName: 'オーナー' },
        }),
      }),
    );
    await page.route('**/api/families', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ families: [family] }),
      }),
    );

    let inviteCount = 0;
    await page.route('**/api/families/fam_owner/invites', async (route) => {
      inviteCount++;
      if (inviteCount === 1) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'temporary failure' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authorizationRequired: true,
          authorizationUrl:
            'https://accounts.google.com/o/oauth2/v2/auth?scope=calendar.acls&client_id=mock',
        }),
      });
    });
    await page.route('https://accounts.google.com/**', async (route) => {
      await route.abort('aborted');
    });

    await page.goto('/onboarding');
    const button = page.locator('[data-testid="issue-invite-button"]');
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.locator('[data-testid="issue-invite-error"]')).toBeVisible();
    await expect(button).toBeEnabled();

    const firstGoogleFailure = page.waitForEvent('requestfailed', (request) =>
      request.url().startsWith('https://accounts.google.com/'),
    );
    const firstRetryPostCount = inviteCount;
    await button.evaluate((element: HTMLButtonElement) => {
      element.click();
      element.click();
    });
    await firstGoogleFailure;
    await expect.poll(() => inviteCount).toBe(firstRetryPostCount + 1);
    await expect(button).toHaveText('Google に移動中...');
    await expect(button).toBeDisabled();

    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    });
    await expect(button).toHaveText('Google に移動中...');
    await expect(button).toBeDisabled();
    await button.evaluate((element: HTMLButtonElement) => element.click());
    await expect.poll(() => inviteCount).toBe(2);

    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await expect(button).toBeEnabled();
    const nextRetryPostCount = inviteCount;
    const secondGoogleFailure = page.waitForEvent('requestfailed', (request) =>
      request.url().startsWith('https://accounts.google.com/'),
    );
    await button.click();
    await secondGoogleFailure;
    await expect.poll(() => inviteCount).toBe(nextRetryPostCount + 1);
    await expect(button).toHaveText('Google に移動中...');
    await expect(button).toBeDisabled();
  });

  test('Invite login locks synchronously, remains disabled while redirecting, and resets after persisted pageshow', async ({
    page,
  }) => {
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      }),
    );
    let loginCount = 0;
    await page.route('**/api/auth/login', async (route) => {
      loginCount++;
      if (loginCount === 1) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'temporary failure' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=mock',
        }),
      });
    });
    await page.route('https://accounts.google.com/**', async (route) => {
      await route.abort('aborted');
    });

    await page.goto(`/invite#${VALID_TOKEN}`);
    const button = page.locator('[data-testid="login-with-invite-button"]');
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.getByText('ログイン処理の開始に失敗しました。')).toBeVisible();
    await expect(button).toBeEnabled();

    const firstGoogleFailure = page.waitForEvent('requestfailed', (request) =>
      request.url().startsWith('https://accounts.google.com/'),
    );
    const firstRetryPostCount = loginCount;
    await button.evaluate((element: HTMLButtonElement) => {
      element.click();
      element.click();
    });
    await firstGoogleFailure;
    await expect.poll(() => loginCount).toBe(firstRetryPostCount + 1);
    await expect(button).toHaveText('Google に移動中...');
    await expect(button).toBeDisabled();

    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    });
    await expect(button).toHaveText('Google に移動中...');
    await expect(button).toBeDisabled();
    await button.evaluate((element: HTMLButtonElement) => element.click());
    await expect.poll(() => loginCount).toBe(2);

    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await expect(button).toBeEnabled();
    const nextRetryPostCount = loginCount;
    const secondGoogleFailure = page.waitForEvent('requestfailed', (request) =>
      request.url().startsWith('https://accounts.google.com/'),
    );
    await button.click();
    await secondGoogleFailure;
    await expect.poll(() => loginCount).toBe(nextRetryPostCount + 1);
    await expect(button).toHaveText('Google に移動中...');
    await expect(button).toBeDisabled();
  });

  test('ACL callback notices remain visible when logged out and ignore unknown error values', async ({
    page,
  }) => {
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      }),
    );
    await page.goto('/onboarding?error=acl_failed');
    await expect(page.locator('[data-testid="acl-error-message"]')).toContainText(
      '共有権限を追加できませんでした',
    );
    await expect(page.locator('[data-testid="login-button"]')).toBeVisible();

    await page.goto('/onboarding?error=acl_account_mismatch');
    await expect(page.locator('[data-testid="acl-account-mismatch-message"]')).toContainText(
      '別の Google アカウント',
    );

    await page.goto('/onboarding?error=unknown_private_value');
    expect(await page.locator('body').innerText()).not.toContain('unknown_private_value');
  });

  test('Saving children does not cancel or duplicate a pending invite, and invite can be retried', async ({
    page,
  }) => {
    const family: FamilyPublic = {
      id: 'fam_owner',
      name: 'たなか家',
      familyCalendarId: 'cal_owner',
      ownerUserId: 'usr_owner',
      creationStatus: 'ready',
      members: [
        {
          id: 'mem_owner',
          userId: 'usr_owner',
          kind: 'adult',
          name: 'オーナー',
          color: 'indigo',
          sortOrder: 0,
        },
      ],
    };
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_owner', email: 'owner@example.test', displayName: 'オーナー' },
        }),
      }),
    );
    await page.route('**/api/families', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ families: [family] }),
      }),
    );

    let inviteCount = 0;
    let enterFirstInvite: () => void = () => {};
    let releaseFirstInvite: () => void = () => {};
    const firstInviteEntered = new Promise<void>((resolve) => {
      enterFirstInvite = resolve;
    });
    const firstInviteGate = new Promise<void>((resolve) => {
      releaseFirstInvite = resolve;
    });
    let inviteHandlerDone: Promise<void> = Promise.resolve();
    await page.route('**/api/families/fam_owner/invites', async (route) => {
      inviteCount++;
      if (inviteCount === 1) {
        enterFirstInvite();
        inviteHandlerDone = (async () => {
          await firstInviteGate;
          try {
            await route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'temporary failure' }),
            });
          } catch {
            // The page may abort this request during lifecycle cleanup.
          }
        })();
        await inviteHandlerDone;
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            authorizationRequired: false,
            inviteUrl: `http://127.0.0.1:4173/invite#${VALID_TOKEN}`,
            expiresAt: 1790000000,
          }),
        });
      }
    });
    await page.route('**/api/families/fam_owner/children', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ family }),
      }),
    );

    await page.goto('/onboarding');
    const inviteButton = page.locator('[data-testid="issue-invite-button"]');
    try {
      await inviteButton.click();
      await firstInviteEntered;
      await page.locator('[data-testid="save-children-button"]').click();
      await expect(page.locator('[data-testid="save-children-success"]')).toBeVisible();
      expect(inviteCount).toBe(1);
      releaseFirstInvite();
      await inviteHandlerDone;
      await expect(inviteButton).toBeEnabled();
      await inviteButton.click();
      await expect.poll(() => inviteCount).toBe(2);
      await expect(page.locator('[data-testid="invite-url-input"]')).toHaveValue(
        `http://127.0.0.1:4173/invite#${VALID_TOKEN}`,
      );
    } finally {
      releaseFirstInvite();
      await inviteHandlerDone;
    }
  });

  test('A delayed invite response after persisted pageshow cannot overwrite a newer attempt', async ({
    page,
  }) => {
    const family: FamilyPublic = {
      id: 'fam_owner',
      name: 'たなか家',
      familyCalendarId: 'cal_owner',
      ownerUserId: 'usr_owner',
      creationStatus: 'ready',
      members: [
        {
          id: 'mem_owner',
          userId: 'usr_owner',
          kind: 'adult',
          name: 'オーナー',
          color: 'indigo',
          sortOrder: 0,
        },
      ],
    };
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_owner', email: 'owner@example.test', displayName: 'オーナー' },
        }),
      }),
    );
    await page.route('**/api/families', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ families: [family] }),
      }),
    );

    let inviteCount = 0;
    let firstInviteEntered = false;
    let firstInviteFinished = false;
    let secondInviteEntered = false;
    let secondInviteFinished = false;
    let releaseFirstInvite: () => void = () => {};
    let firstInviteRequest: import('@playwright/test').Request | null = null;
    const firstInviteGate = new Promise<void>((resolve) => {
      releaseFirstInvite = resolve;
    });
    let releaseSecondInvite: () => void = () => {};
    const secondInviteGate = new Promise<void>((resolve) => {
      releaseSecondInvite = resolve;
    });
    await page.route('**/api/families/fam_owner/invites', async (route) => {
      inviteCount++;
      if (inviteCount === 1) {
        firstInviteEntered = true;
        firstInviteRequest = route.request();
        try {
          await firstInviteGate;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              authorizationRequired: true,
              authorizationUrl:
                'https://accounts.google.com/o/oauth2/v2/auth?scope=calendar.acls&client_id=mock',
            }),
          });
        } catch {
          // The aborted original fetch can no longer receive the delayed response.
        } finally {
          firstInviteFinished = true;
        }
      } else {
        secondInviteEntered = true;
        try {
          await secondInviteGate;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              authorizationRequired: false,
              inviteUrl: `http://127.0.0.1:4173/invite#${VALID_TOKEN}`,
              expiresAt: 1790000000,
            }),
          });
        } finally {
          secondInviteFinished = true;
        }
      }
    });
    let googleRequests = 0;
    await page.route('https://accounts.google.com/**', async (route) => {
      googleRequests++;
      await route.abort('aborted');
    });

    await page.goto('/onboarding');
    const inviteButton = page.locator('[data-testid="issue-invite-button"]');
    await inviteButton.click();
    await expect.poll(() => firstInviteEntered).toBe(true);
    if (!firstInviteRequest) throw new Error('First invite request was not captured');
    const firstInviteFailed = page.waitForEvent(
      'requestfailed',
      (request) => request === firstInviteRequest,
    );
    try {
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await expect(inviteButton).toBeEnabled();
      await inviteButton.click();
      await expect.poll(() => secondInviteEntered).toBe(true);

      // The obsolete request settles while the newer request remains pending.
      releaseFirstInvite();
      await expect.poll(() => firstInviteFinished).toBe(true);
      await firstInviteFailed;
      await waitForTwoRafs(page);
      await expect(inviteButton).toHaveText('発行中...');
      await expect(inviteButton).toBeDisabled();
      expect(inviteCount).toBe(2);
      await inviteButton.click({ force: true });
      expect(inviteCount).toBe(2);

      releaseSecondInvite();
      await expect.poll(() => secondInviteFinished).toBe(true);
      await expect(page.locator('[data-testid="invite-url-input"]')).toHaveValue(
        `http://127.0.0.1:4173/invite#${VALID_TOKEN}`,
      );
      expect(googleRequests).toBe(0);
    } finally {
      releaseFirstInvite();
      releaseSecondInvite();
      if (firstInviteEntered) await expect.poll(() => firstInviteFinished).toBe(true);
      if (secondInviteEntered) await expect.poll(() => secondInviteFinished).toBe(true);
    }
  });
});
