import { type CDPSession, chromium, expect, test } from '@playwright/test';

test.describe('PWA Capabilities and Regression Tests', () => {
  test('Manifest contains required fields and valid icon definitions', async ({ page }) => {
    const response = await page.goto('/manifest.webmanifest');
    expect(response).not.toBeNull();
    expect(response?.status()).toBe(200);

    const contentType = response?.headers()['content-type'] ?? '';
    expect(contentType).toMatch(/(application\/manifest\+json|application\/json)/);

    const manifest = await response?.json();
    expect(manifest.name).toBe('Danran');
    expect(manifest.short_name).toBe('だんらん');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.lang).toBe('ja');
    expect(manifest.background_color).toBe('#f6f3ee');
    expect(manifest.theme_color).toBe('#f6f3ee');

    expect(Array.isArray(manifest.icons)).toBe(true);
    const any192 = manifest.icons.find(
      (i: { sizes: string; purpose?: string }) =>
        i.sizes === '192x192' && (!i.purpose || i.purpose.includes('any')),
    );
    const any512 = manifest.icons.find(
      (i: { sizes: string; purpose?: string }) =>
        i.sizes === '512x512' && (!i.purpose || i.purpose.includes('any')),
    );
    const maskable512 = manifest.icons.find(
      (i: { sizes: string; purpose?: string }) =>
        i.sizes === '512x512' && i.purpose?.includes('maskable'),
    );

    expect(any192).toBeDefined();
    expect(any512).toBeDefined();
    expect(maskable512).toBeDefined();
  });

  test('PWA HTML metadata and Apple tags are correctly set', async ({ page }) => {
    await page.goto('/');

    const htmlLang = await page.locator('html').getAttribute('lang');
    expect(htmlLang).toBe('ja');

    // Strict single locator matching the plugin-injected link
    const manifestLink = page.locator('link[rel="manifest"]');
    await expect(manifestLink).toHaveAttribute('href', '/manifest.webmanifest');

    const themeColor = page.locator('meta[name="theme-color"]');
    await expect(themeColor).toHaveAttribute('content', '#f6f3ee');

    const appleCapable = page.locator('meta[name="apple-mobile-web-app-capable"]');
    await expect(appleCapable).toHaveAttribute('content', 'yes');

    const appleTitle = page.locator('meta[name="apple-mobile-web-app-title"]');
    await expect(appleTitle).toHaveAttribute('content', 'だんらん');

    const appleTouchIcon = page.locator('link[rel="apple-touch-icon"]');
    await expect(appleTouchIcon).toHaveAttribute('href', '/icons/apple-touch-icon.png');
  });

  test('Icons exist, load successfully with HTTP 200, and render expected dimensions', async ({
    page,
  }) => {
    await page.goto('/');

    const icons = [
      { url: '/icons/icon-192.png', width: 192, height: 192 },
      { url: '/icons/icon-512.png', width: 512, height: 512 },
      { url: '/icons/icon-512-maskable.png', width: 512, height: 512 },
      { url: '/icons/apple-touch-icon.png', width: 180, height: 180 },
    ];

    for (const icon of icons) {
      const resp = await page.request.get(icon.url);
      expect(resp.status()).toBe(200);
      expect(resp.headers()['content-type']).toContain('image/png');

      const dimensions = await page.evaluate(async (url) => {
        return new Promise<{ width: number; height: number }>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => reject(new Error(`Failed to load ${url}`));
          img.src = url;
        });
      }, icon.url);

      expect(dimensions.width).toBe(icon.width);
      expect(dimensions.height).toBe(icon.height);
    }
  });

  test('Service Worker registers, activates, and claims the page', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(
      async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.ready;
        return reg.active?.state === 'activated' && navigator.serviceWorker.controller !== null;
      },
      undefined,
      { timeout: 15_000 },
    );

    const isControlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
    expect(isControlled).toBe(true);
  });

  test('Cache inventory contains only public static app files and no /api resources', async ({
    page,
  }) => {
    await page.goto('/');

    await page.waitForFunction(
      async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.ready;
        return reg.active?.state === 'activated';
      },
      undefined,
      { timeout: 15_000 },
    );

    const cachedUrls = await page.evaluate(async () => {
      const cacheNames = await window.caches.keys();
      const urls: string[] = [];
      for (const name of cacheNames) {
        const cache = await window.caches.open(name);
        const requests = await cache.keys();
        for (const req of requests) {
          urls.push(req.url);
        }
      }
      return urls;
    });

    expect(cachedUrls.length).toBeGreaterThan(0);

    // Verify privacy invariant: zero /api resources or internal build/worker files stored in cache inventory
    const invalidEntries = cachedUrls.filter((url) => {
      const pathname = new URL(url).pathname;
      return (
        /^\/api(?:\/|$)/.test(pathname) ||
        pathname.includes('/danran/') ||
        pathname.includes('/danran_local/') ||
        pathname.includes('wrangler.json') ||
        pathname.includes('/.vite/')
      );
    });
    expect(invalidEntries).toHaveLength(0);

    // Verify app shell (index.html or root entry) is precached
    const hasAppShell = cachedUrls.some((url) => url.includes('index.html') || url.endsWith('/'));
    expect(hasAppShell).toBe(true);
  });

  test('API routes remain functional online under SW and do not fallback to SPA HTML', async ({
    page,
  }) => {
    await page.goto('/');

    await page.waitForFunction(
      async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.ready;
        return reg.active?.state === 'activated' && navigator.serviceWorker.controller !== null;
      },
      undefined,
      { timeout: 15_000 },
    );

    // In-browser fetch for /api/health through controlling Service Worker
    const healthResult = await page.evaluate(async () => {
      const res = await fetch('/api/health');
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        data: await res.json(),
      };
    });
    expect(healthResult.status).toBe(200);
    expect(healthResult.contentType).toContain('application/json');
    expect(healthResult.data).toEqual({ ok: true });

    // In-browser fetch for unknown API route
    const unknownResult = await page.evaluate(async () => {
      const res = await fetch('/api/unknown');
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        data: await res.json(),
      };
    });
    expect(unknownResult.status).toBe(404);
    expect(unknownResult.contentType).toContain('application/json');
    expect(unknownResult.data).toEqual({ error: 'Not Found' });

    // Direct browser navigation request to /api/health
    const navHealth = await page.goto('/api/health');
    expect(navHealth?.status()).toBe(200);
    expect(navHealth?.headers()['content-type']).toContain('application/json');
    const navHealthJson = await navHealth?.json();
    expect(navHealthJson).toEqual({ ok: true });

    // Direct browser navigation request to /api/nonexistent
    const navUnknown = await page.goto('/api/nonexistent');
    expect(navUnknown?.status()).toBe(404);
    expect(navUnknown?.headers()['content-type']).toContain('application/json');
    const navUnknownJson = await navUnknown?.json();
    expect(navUnknownJson).toEqual({ error: 'Not Found' });

    // Assert cache inventory after API requests contains no API or Worker/wrangler output
    const cachedUrlsAfterApi = await page.evaluate(async () => {
      const cacheNames = await window.caches.keys();
      const urls: string[] = [];
      for (const name of cacheNames) {
        const cache = await window.caches.open(name);
        const requests = await cache.keys();
        for (const req of requests) {
          urls.push(req.url);
        }
      }
      return urls;
    });

    const invalidEntriesAfterApi = cachedUrlsAfterApi.filter((url) => {
      const pathname = new URL(url).pathname;
      return (
        /^\/api(?:\/|$)/.test(pathname) ||
        pathname.includes('/danran/') ||
        pathname.includes('/danran_local/') ||
        pathname.includes('wrangler.json') ||
        pathname.includes('/.vite/')
      );
    });
    expect(invalidEntriesAfterApi).toHaveLength(0);
  });

  test('Offline reload and deep link serve precached shell and display Japanese offline screen', async ({
    page,
    context,
  }) => {
    await page.goto('/');

    await page.waitForFunction(
      async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.ready;
        return reg.active?.state === 'activated' && navigator.serviceWorker.controller !== null;
      },
      undefined,
      { timeout: 15_000 },
    );

    // Simulate going offline
    await context.setOffline(true);

    // Reload page while offline: precache serves shell
    await page.reload();

    // Verify offline screen appears
    const offlineScreen = page.locator('[data-testid="offline-screen"]');
    await expect(offlineScreen).toBeVisible();
    await expect(page.getByRole('heading', { name: 'オフラインです' })).toBeVisible();
    await expect(page.getByText('インターネット接続が切断されています')).toBeVisible();

    // Verify reload button meets accessibility requirements (>=44px)
    const reloadButton = page.getByRole('button', { name: '再読み込み' });
    await expect(reloadButton).toBeVisible();
    const box = await reloadButton.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }

    // Deep link while offline: navigateFallback serves index.html, offline screen shown
    await page.goto('/deep-link-sample');
    await expect(page.locator('[data-testid="offline-screen"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'オフラインです' })).toBeVisible();

    // Reconnection: restoring network via context triggers native browser online recovery
    await context.setOffline(false);

    await expect(page.locator('[data-testid="home-screen"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Danran' })).toBeVisible();
    await expect(page.getByText('準備中')).toBeVisible();
  });

  test('Offline API fetch fails instead of returning cached data or SPA HTML', async ({
    page,
    context,
  }) => {
    await page.goto('/');

    await page.waitForFunction(
      async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.ready;
        return reg.active?.state === 'activated' && navigator.serviceWorker.controller !== null;
      },
      undefined,
      { timeout: 15_000 },
    );

    // Warm /api/health online first to verify it is not erroneously cached
    const warmStatus = await page.evaluate(async () => {
      const res = await fetch('/api/health');
      return res.status;
    });
    expect(warmStatus).toBe(200);

    // Go offline
    await context.setOffline(true);

    // In-browser fetch to /api/health while offline must fail (network error)
    const fetchResult = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/health');
        return { success: true, status: res.status, text: await res.text() };
      } catch (err: unknown) {
        return { success: false, error: (err as Error).message };
      }
    });

    expect(fetchResult.success).toBe(false);
  });

  test('Chromium CDP reports valid app manifest and zero installability errors', async ({
    baseURL,
  }) => {
    const persistentContext = await chromium.launchPersistentContext('', {
      headless: true,
      baseURL,
    });
    let client: CDPSession | null = null;
    try {
      const page = await persistentContext.newPage();
      await page.goto('/');

      await page.waitForFunction(
        async () => {
          if (!('serviceWorker' in navigator)) return false;
          const reg = await navigator.serviceWorker.ready;
          return reg.active?.state === 'activated' && navigator.serviceWorker.controller !== null;
        },
        undefined,
        { timeout: 15_000 },
      );

      client = await persistentContext.newCDPSession(page);

      const manifestData = await client.send('Page.getAppManifest');
      expect(manifestData.manifest).toBeDefined();
      expect(manifestData.errors).toHaveLength(0);

      const installabilityData = await client.send('Page.getInstallabilityErrors');
      expect(installabilityData.installabilityErrors).toHaveLength(0);
    } finally {
      if (client) {
        await client.detach();
      }
      await persistentContext.close();
    }
  });

  test('Production build does not render /dev/ui showcase and serves Home screen', async ({
    page,
  }) => {
    await page.goto('/dev/ui');
    await expect(page.locator('[data-testid="home-screen"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Danran' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '部品一覧' })).toHaveCount(0);
  });
});
