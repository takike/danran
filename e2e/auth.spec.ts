import { expect, test } from '@playwright/test';

// Enforce service workers: 'block' for auth tests so Playwright page.route intercepts all /api/* requests reliably
test.use({
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
});

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

test.describe('Task 1-1: Browser Authentication and Session Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/families', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ families: [] }),
      });
    });
  });

  test('401 session initiates login via same-origin /api/auth/login navigation on Space keyboard press without external Google call', async ({
    page,
  }) => {
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
    });

    let loginNavigationCount = 0;
    await page.route('**/api/auth/login', async (route) => {
      loginNavigationCount++;
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body>Mocked Auth Login Target</body></html>',
      });
    });

    await page.goto('/');

    await expect(page.locator('[data-testid="home-screen"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Danran' })).toBeVisible();

    const loginButton = page.locator('[data-testid="login-button"]');
    await expect(loginButton).toBeVisible();

    // Focus and activate with keyboard Space key
    await loginButton.focus();
    await Promise.all([
      page.waitForURL((url) => url.pathname.includes('/api/auth/login')),
      page.keyboard.press('Space'),
    ]);

    expect(loginNavigationCount).toBe(1);
  });

  test('Authenticated user display name survives reload, wraps long unbroken names without horizontal overflow, and never exposes email', async ({
    page,
  }) => {
    const mockUser = {
      id: 'usr_test_98765',
      email: 'private.user@example.test',
      displayName: 'VeryLongUnbrokenLatinDisplayNameWithoutSpacesThatMustWrapCleanly',
    };

    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify({ user: mockUser }),
      });
    });

    await page.goto('/family');

    await expect(page.getByRole('heading', { name: '家族' })).toBeVisible();
    const displayName = page.locator('[data-testid="user-display-name"]');
    await expect(displayName).toBeVisible();
    await expect(displayName).toContainText(mockUser.displayName);

    // Invariant: Family settings shows only display name and logout; never expose user email
    const pageText = await page.innerText('body');
    expect(pageText).not.toContain('private.user@example.test');

    // Long unbroken name must not cause horizontal page overflow at 390px
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    // Verify session survives page reload
    await page.reload();

    await expect(page.locator('[data-testid="user-display-name"]')).toBeVisible();
    await expect(page.locator('[data-testid="user-display-name"]')).toContainText(
      mockUser.displayName,
    );
    const reloadedText = await page.innerText('body');
    expect(reloadedText).not.toContain('private.user@example.test');
  });

  test('Logout sends POST with X-Requested-With and privacy link is available in both logged in and logged out states', async ({
    page,
  }) => {
    let isAuthenticated = true;

    await page.route('**/api/auth/me', async (route) => {
      if (isAuthenticated) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: { id: 'usr_test', email: 'test@example.test', displayName: '佐藤花子' },
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

    let logoutMethod: string | null = null;
    let xRequestedWithHeader: string | null = null;

    await page.route('**/api/auth/logout', async (route) => {
      logoutMethod = route.request().method();
      xRequestedWithHeader = route.request().headers()['x-requested-with'] ?? null;
      isAuthenticated = false;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto('/family');

    const privacyLinkLoggedIn = page.locator('[data-testid="privacy-link"]');
    await expect(privacyLinkLoggedIn).toBeVisible();
    const logoutButton = page.locator('[data-testid="logout-button"]');
    await expect(logoutButton).toBeVisible();
    await logoutButton.click();

    // Verify CSRF defense invariants
    expect(logoutMethod).toBe('POST');
    expect(xRequestedWithHeader).toBe('XMLHttpRequest');

    // Transitions to logged out view
    await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();
    await expect(page.locator('[data-testid="user-display-name"]')).toHaveCount(0);

    await expect(page.getByText('続けるには Google でログインしてください。')).toBeVisible();
    const privacyLinkLoggedOut = page.locator('[data-testid="privacy-link"]');
    await expect(privacyLinkLoggedOut).toBeVisible();
  });

  test('Logout pending state disables button and prevents duplicate requests, and failed logout preserves account and supports retry', async ({
    page,
  }) => {
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_retry', email: 'retry@example.test', displayName: '鈴木一郎' },
        }),
      });
    });

    // 1. Pending logout gate & duplicate click prevention
    let resolveLogoutEntered!: () => void;
    const logoutEnteredPromise = new Promise<void>((resolve) => {
      resolveLogoutEntered = resolve;
    });
    let releaseLogoutGate!: () => void;
    const logoutGatePromise = new Promise<void>((resolve) => {
      releaseLogoutGate = resolve;
    });
    let logoutCalls = 0;

    await page.route('**/api/auth/logout', async (route) => {
      logoutCalls++;
      resolveLogoutEntered();
      await logoutGatePromise;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Logout failed' }),
      });
    });

    await page.goto('/family');

    const logoutButton = page.locator('[data-testid="logout-button"]');
    await expect(logoutButton).toBeVisible();

    // Click logout once to hold request pending in gate
    try {
      await logoutButton.click();
      await logoutEnteredPromise;

      // Verify button disabled state and aria-busy
      await expect(logoutButton).toBeDisabled();
      await expect(logoutButton).toHaveAttribute('aria-busy', 'true');
      await expect(logoutButton).toContainText('ログアウト中...');

      // Attempt duplicate click while pending (disabled button does not dispatch)
      await logoutButton.click({ force: true });
    } finally {
      // Unconditionally release gate
      releaseLogoutGate();
    }

    // Account remains preserved on screen; error alert is rendered
    await expect(page.locator('[data-testid="user-display-name"]')).toBeVisible();
    await expect(page.locator('[data-testid="user-display-name"]')).toContainText('鈴木一郎');
    await expect(page.getByText('ログアウトに失敗しました')).toBeVisible();

    // Assert duplicate click was ignored (only 1 request dispatched)
    expect(logoutCalls).toBe(1);

    // Button is re-enabled to support retry
    await expect(logoutButton).toBeEnabled();

    // 2. Setup successful logout on retry
    await page.route('**/api/auth/logout', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
    });

    // Retry logout
    await logoutButton.click();

    // Now logged out
    await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();
  });

  test('Session refetch on visibility change invalidates logged out user to login view immediately', async ({
    page,
  }) => {
    let isAuthenticated = true;

    await page.route('**/api/auth/me', async (route) => {
      if (isAuthenticated) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: { id: 'usr_tab', email: 'tab@example.test', displayName: '他タブ太郎' },
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

    await page.goto('/family');
    await expect(page.locator('[data-testid="user-display-name"]')).toContainText('他タブ太郎');

    // Simulate session ending in another tab: server now returns 401
    isAuthenticated = false;

    // Trigger visibility change and wait for revalidation response
    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/auth/me') && res.status() === 401),
      triggerVisibilityCycle(page),
    ]);

    // UI immediately updates to login view without displaying stale profile
    await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();
    await expect(page.locator('[data-testid="user-display-name"]')).toHaveCount(0);
  });

  test('Delayed in-flight /me request cannot resurrect authenticated session after logout success', async ({
    page,
  }) => {
    const mockUser = {
      id: 'usr_stale',
      email: 'stale@example.test',
      displayName: '競合花子',
    };

    let resolveSecondMeEntered!: () => void;
    const secondMeEntered = new Promise<void>((resolve) => {
      resolveSecondMeEntered = resolve;
    });
    let releaseSecondMeGate!: () => void;
    const secondMeGate = new Promise<void>((resolve) => {
      releaseSecondMeGate = resolve;
    });

    let meCallCount = 0;
    let secondMeRequest: import('@playwright/test').Request | null = null;

    await page.route('**/api/auth/me', async (route) => {
      meCallCount++;
      if (meCallCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ user: mockUser }),
        });
      } else {
        secondMeRequest = route.request();
        // Second call held in gate: signal route handler entered, await gate release
        resolveSecondMeEntered();
        await secondMeGate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ user: mockUser }),
        });
      }
    });

    await page.route('**/api/auth/logout', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto('/family');
    await expect(page.locator('[data-testid="user-display-name"]')).toContainText('競合花子');

    // Trigger background /me refetch via visibility change
    await triggerVisibilityCycle(page);

    // Explicitly wait until second /me route handler is entered (PROVES request is actively in flight!)
    await secondMeEntered;

    // Prepare listener requiring the recorded second /me request to actually abort
    const secondMeFailedPromise = page.waitForEvent(
      'requestfailed',
      (req) => req === secondMeRequest,
    );

    // Logout while second /me is in flight; logout cancellation must abort outstanding queries
    try {
      const logoutButton = page.locator('[data-testid="logout-button"]');
      await logoutButton.click();

      // Logged-out view is rendered
      await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();
    } finally {
      // Unconditionally release gate
      releaseSecondMeGate();
    }

    // Require the second request to actually abort with ERR_ABORTED
    const failedRequest = await secondMeFailedPromise;
    expect(failedRequest.failure()?.errorText).toContain('ERR_ABORTED');

    // Invariant: Stale async response must not restore / resurrect the signed-out user
    await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();
    await expect(page.locator('[data-testid="user-display-name"]')).toHaveCount(0);
  });

  test('Session refetch error hides stale profile and displays friendly error state', async ({
    page,
  }) => {
    let returnError = false;

    await page.route('**/api/auth/me', async (route) => {
      if (returnError) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Auth service unconfigured' }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: { id: 'usr_valid', email: 'v@example.test', displayName: '有効ユーザー' },
          }),
        });
      }
    });

    await page.goto('/family');
    await expect(page.locator('[data-testid="user-display-name"]')).toContainText('有効ユーザー');

    // Simulate backend outage on refetch
    returnError = true;

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/auth/me') && res.status() === 503),
      triggerVisibilityCycle(page),
    ]);

    // Invariant: Stale account data is NOT displayed as valid during error state
    await expect(page.locator('[data-testid="user-display-name"]')).toHaveCount(0);
    await expect(page.getByText('認証サービスに接続できませんでした')).toBeVisible();
    await expect(page.locator('[data-testid="retry-button"]')).toBeVisible();
  });

  test('Query 503 error and schema-invalid states display friendly retry UI and recover cleanly on retry', async ({
    page,
  }) => {
    let mode: '503' | 'schema_invalid' | 'healthy' = '503';

    await page.route('**/api/auth/me', async (route) => {
      if (mode === '503') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Auth service unconfigured' }),
        });
      } else if (mode === 'schema_invalid') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ user: { id: 12345, invalidField: true } }),
        });
      } else {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Unauthorized' }),
        });
      }
    });

    await page.goto('/');

    // Friendly Japanese retry message is shown
    await expect(page.getByText('認証サービスに接続できませんでした')).toBeVisible();
    const retryButton = page.locator('[data-testid="retry-button"]');
    await expect(retryButton).toBeVisible();

    // Never display raw backend error string
    const bodyText = await page.innerText('body');
    expect(bodyText).not.toContain('Auth service unconfigured');

    // Privacy link remains accessible during error state
    await expect(page.locator('[data-testid="privacy-link"]')).toBeVisible();

    // Transition to schema invalid and wait for observed response on retry
    mode = 'schema_invalid';
    const [invalidResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/auth/me') && res.status() === 200),
      retryButton.click(),
    ]);
    expect(invalidResponse.status()).toBe(200);
    const invalidBody = await invalidResponse.json();
    expect(invalidBody).toEqual({ user: { id: 12345, invalidField: true } });

    // Verify error state is rendered with retry button
    await expect(page.getByText('認証サービスに接続できませんでした')).toBeVisible();
    await expect(retryButton).toBeVisible();

    // Transition to healthy 401 and wait for observed response on retry
    mode = 'healthy';
    const [healthyResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/auth/me') && res.status() === 401),
      retryButton.click(),
    ]);
    expect(healthyResponse.status()).toBe(401);

    // Transitions to login button and error alert is dismissed
    await expect(page.locator('[data-testid="login-button"]')).toBeVisible();
    await expect(page.getByText('認証サービスに接続できませんでした')).toHaveCount(0);
  });

  test('OAuth callback denial shows Japanese cancel notice and untrusted error parameters are ignored', async ({
    page,
  }) => {
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
    });

    // 1. Visit with fixed error=access_denied
    await page.goto('/?error=access_denied');

    const notice = page.locator('[data-testid="access-denied-message"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Google ログインがキャンセルされました。');

    // 2. Visit with untrusted arbitrary query parameter
    const untrustedPayload = '<img src=x onerror=alert(1)>untrusted_xss_probe';
    await page.goto(`/?error=${encodeURIComponent(untrustedPayload)}`);

    // Invariant: Never echo arbitrary query or error parameters to the DOM
    const rawBody = await page.innerHTML('body');
    expect(rawBody).not.toContain('untrusted_xss_probe');
    expect(rawBody).not.toContain('alert(1)');
  });

  test('OAuth callback notices use fixed text for logged-out and logged-in users', async ({
    page,
  }) => {
    let loggedIn = false;
    await page.route('**/api/auth/me', async (route) => {
      if (loggedIn) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: { id: 'usr_notice', email: 'private@example.test', displayName: '利用者' },
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

    const expiredText =
      '手続きの有効期限が切れたか、すでに完了しています。必要ならもう一度操作してください。';
    await page.goto('/?error=auth_expired');
    await expect(page.locator('[data-testid="auth-expired-message"]')).toContainText(expiredText);
    await expect(page.locator('[data-testid="login-button"]')).toBeVisible();

    await page.goto('/?error=auth_failed');
    await expect(page.locator('[data-testid="auth-failed-message"]')).toContainText(
      'もう一度お試しください',
    );
    await expect(page.locator('[data-testid="auth-failed-message"]')).toContainText(
      '許可画面の項目にチェックが入っているか確認',
    );

    loggedIn = true;
    await page.goto('/?error=auth_expired');
    await expect(page.locator('[data-testid="auth-expired-message"]')).toContainText(expiredText);
    await expect(page.locator('[data-testid="user-display-name"]')).toHaveCount(0);
    await page.goto('/family?error=auth_expired');
    await expect(page.locator('[data-testid="auth-expired-message"]')).toContainText(expiredText);
    await expect(page.locator('[data-testid="user-display-name"]')).toContainText('利用者');

    await page.goto('/?error=unknown_sensitive_value');
    expect(await page.locator('body').innerText()).not.toContain('unknown_sensitive_value');
  });

  test('/privacy route loads directly without ANY auth request and returns to home root', async ({
    page,
  }) => {
    let authMeRequested = false;
    let anyAuthRequested = false;

    await page.route('**/api/auth/**', async (route) => {
      anyAuthRequested = true;
      if (route.request().url().includes('/api/auth/me')) {
        authMeRequested = true;
      }
      await route.abort('failed');
    });

    await page.goto('/privacy');

    // Privacy policy rendered correctly
    await expect(page.locator('[data-testid="privacy-screen"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'プライバシーポリシー' })).toBeVisible();
    await expect(page.getByText('ログイン情報')).toBeVisible();
    await expect(page.getByText('カレンダー情報')).toBeVisible();

    // Verify zero requests to /api/auth/me or any auth endpoint occurred
    expect(authMeRequested).toBe(false);
    expect(anyAuthRequested).toBe(false);

    // Verify link back to home functions properly and targets root pathname '/'
    const backLink = page.locator('[data-testid="back-to-home"]');
    await expect(backLink).toBeVisible();
    await backLink.click();
    await page.waitForURL((url) => url.pathname === '/');
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('All interactive controls meet >= 44px tap target and page has no horizontal overflow at 390px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    // 1. Check logged-out home
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
    });

    await page.goto('/');

    const loginButton = page.locator('[data-testid="login-button"]');
    const loginBox = await loginButton.boundingBox();
    expect(loginBox).not.toBeNull();
    if (loginBox) {
      expect(loginBox.height).toBeGreaterThanOrEqual(44);
      expect(loginBox.width).toBeGreaterThanOrEqual(44);
    }

    const privacyLink = page.locator('[data-testid="privacy-link"]');
    const privacyBox = await privacyLink.boundingBox();
    expect(privacyBox).not.toBeNull();
    if (privacyBox) {
      expect(privacyBox.height).toBeGreaterThanOrEqual(44);
      expect(privacyBox.width).toBeGreaterThanOrEqual(44);
    }

    const homeOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(homeOverflow).toBe(false);

    // 2. Check logged-in controls
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_size', email: 'size@example.test', displayName: 'サイズ確認' },
        }),
      });
    });

    await page.goto('/family');

    const logoutButton = page.locator('[data-testid="logout-button"]');
    const logoutBox = await logoutButton.boundingBox();
    expect(logoutBox).not.toBeNull();
    if (logoutBox) {
      expect(logoutBox.height).toBeGreaterThanOrEqual(44);
      expect(logoutBox.width).toBeGreaterThanOrEqual(44);
    }

    const loggedInOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(loggedInOverflow).toBe(false);

    // 3. Check privacy page controls and viewport
    await page.goto('/privacy');

    const backHomeLink = page.locator('[data-testid="back-to-home"]');
    const backBox = await backHomeLink.boundingBox();
    expect(backBox).not.toBeNull();
    if (backBox) {
      expect(backBox.height).toBeGreaterThanOrEqual(44);
      expect(backBox.width).toBeGreaterThanOrEqual(44);
    }

    const privacyOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(privacyOverflow).toBe(false);
  });
});
