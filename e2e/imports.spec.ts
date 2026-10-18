import { Buffer } from 'node:buffer';
import { type Page, expect, test } from '@playwright/test';

test.use({
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  timezoneId: 'UTC',
  locale: 'ja-JP',
});

const USER_A = 'usr_import_a';
const USER_B = 'usr_import_b';
const FAMILY_A = 'fam_import_a';
const FAMILY_B = 'fam_import_b';
const MEMBER_A = 'mem_import_a';
const MEMBER_B = 'mem_import_b';

type ImportJob = {
  id: string;
  status: 'pending';
  createdAt: number;
  createdByMemberId: string;
  attachment: { id: string; width: number; height: number };
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

async function syntheticThumbnail(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 480;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    context.fillStyle = '#f6d7a7';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#bd5b45';
    context.fillRect(24, 36, 272, 180);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('JPEG encode failed'))),
        'image/jpeg',
        0.8,
      );
    });
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(new Error('JPEG read failed'));
      reader.readAsDataURL(blob);
    });
  });
  return Buffer.from(base64, 'base64');
}

async function syntheticOrientedJpeg(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 4000;
    canvas.height = 2000;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    context.fillStyle = '#f6d7a7';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#bd5b45';
    context.fillRect(0, 0, 1800, 500);
    context.fillStyle = '#527b70';
    context.fillRect(2500, 1000, 1200, 800);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('JPEG encode failed'))),
        'image/jpeg',
        0.92,
      );
    });
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(new Error('JPEG read failed'));
      reader.readAsDataURL(blob);
    });
  });

  const jpeg = Buffer.from(base64, 'base64');
  expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  const tiff = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(exif.length + 2);
  return Buffer.concat([
    jpeg.subarray(0, 2),
    Buffer.from([0xff, 0xe1]),
    length,
    exif,
    jpeg.subarray(2),
  ]);
}

async function syntheticLandscapeJpeg(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 4000;
    canvas.height = 2000;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    context.fillStyle = '#e4edcc';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#397e72';
    context.fillRect(100, 150, 1200, 700);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('JPEG encode failed'))),
        'image/jpeg',
        0.9,
      );
    });
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(new Error('JPEG read failed'));
      reader.readAsDataURL(blob);
    });
  });
  return Buffer.from(base64, 'base64');
}

function jpegMetadata(bytes: Buffer) {
  let width = 0;
  let height = 0;
  let hasExif = false;
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === undefined || marker === 0xda || marker === 0xd9) break;
    const segmentLength = readUint16Be(bytes, offset + 2);
    const payloadStart = offset + 4;
    const payloadEnd = offset + 2 + segmentLength;
    if (payloadEnd > bytes.length || segmentLength < 2) break;
    if (
      marker === 0xe1 &&
      bytes[payloadStart] === 0x45 &&
      bytes[payloadStart + 1] === 0x78 &&
      bytes[payloadStart + 2] === 0x69 &&
      bytes[payloadStart + 3] === 0x66 &&
      bytes[payloadStart + 4] === 0x00 &&
      bytes[payloadStart + 5] === 0x00
    ) {
      hasExif = true;
    }
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      height = readUint16Be(bytes, payloadStart + 1);
      width = readUint16Be(bytes, payloadStart + 3);
    }
    offset = payloadEnd;
  }
  return { width, height, hasExif };
}

function readUint16Be(bytes: Uint8Array, offset: number): number {
  const highByte = bytes[offset];
  const lowByte = bytes[offset + 1];
  if (highByte === undefined || lowByte === undefined) return 0;
  return (highByte << 8) | lowByte;
}

async function installHarness(page: Page, initialImports: ImportJob[] = []) {
  let userId = USER_A;
  let familyId = FAMILY_A;
  let jobs = [...initialImports];
  let failNextUpload = false;
  let failNextDelete = false;
  let failNextListStatus: number | undefined;
  let unauthenticated = false;
  let uploadGate: ReturnType<typeof deferred> | undefined;
  let listGate: ReturnType<typeof deferred> | undefined;
  let listGateStarted: ReturnType<typeof deferred> | undefined;
  let attachmentGate: ReturnType<typeof deferred> | undefined;
  let attachmentRequestStarted: (() => void) | undefined;
  const attachmentRequestStartedPromise = new Promise<void>((resolve) => {
    attachmentRequestStarted = resolve;
  });
  let gateListCall = 0;
  let listCalls = 0;
  const uploads: Array<{ body: Buffer; requestId: string }> = [];
  const attachmentBytes = await syntheticThumbnail(page);

  const memberId = () => (userId === USER_B ? MEMBER_B : MEMBER_A);
  await page.route('**/api/auth/me', async (route) =>
    unauthenticated
      ? route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Unauthorized' }),
        })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              id: userId,
              email: 'imports@example.test',
              displayName: userId === USER_B ? '別アカウント' : 'テスト利用者',
            },
          }),
        }),
  );
  await page.route('**/api/auth/logout', async (route) => {
    unauthenticated = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
  await page.route('**/api/families', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        families: [
          {
            id: familyId,
            name: userId === USER_B ? '別の家族' : 'サンプル家',
            familyCalendarId: 'cal_imports',
            ownerUserId: userId,
            creationStatus: 'ready',
            members: [
              {
                id: memberId(),
                userId,
                kind: 'adult',
                name: userId === USER_B ? 'みどり' : 'あおい',
                color: 'indigo',
                sortOrder: 0,
              },
            ],
          },
        ],
      }),
    }),
  );
  await page.route('**/api/families/*/imports**', async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/');
    const requestFamilyId = parts[3];
    const tail = parts.at(-1);
    const method = route.request().method();
    if (method === 'GET' && tail === 'imports') {
      listCalls += 1;
      const visibleJobs = requestFamilyId === FAMILY_A ? [...jobs] : [];
      if (listGate && listCalls === gateListCall) {
        listGateStarted?.resolve();
        await listGate.promise;
      }
      if (failNextListStatus) {
        const status = failNextListStatus;
        failNextListStatus = undefined;
        const code = status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : 'NOT_FOUND';
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Access denied', code }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ imports: visibleJobs }),
      });
      return;
    }
    if (method === 'POST' && tail === 'imports') {
      const body = route.request().postDataBuffer() ?? Buffer.alloc(0);
      uploads.push({ body, requestId: route.request().headers()['x-client-request-id'] ?? '' });
      if (uploadGate) {
        const gate = uploadGate;
        uploadGate = undefined;
        await gate.promise;
      }
      if (failNextUpload) {
        failNextUpload = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: '保存できませんでした。通信状態を確認して、もう一度お試しください。',
            code: 'INTERNAL_ERROR',
          }),
        });
        return;
      }
      const metadata = jpegMetadata(body);
      const created: ImportJob = {
        id: `import-${jobs.length + 1}`,
        status: 'pending',
        createdAt: 1_792_300_000 + jobs.length,
        createdByMemberId: memberId(),
        attachment: {
          id: `attachment-${jobs.length + 1}`,
          width: metadata.width,
          height: metadata.height,
        },
      };
      jobs = [created, ...jobs];
      try {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(created),
        });
      } catch {
        // The client aborts an in-flight upload when its user or family changes.
      }
      return;
    }
    if (method === 'DELETE') {
      if (failNextDelete) {
        failNextDelete = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: '写真を削除できませんでした。もう一度お試しください。',
            code: 'INTERNAL_ERROR',
          }),
        });
        return;
      }
      jobs = jobs.filter((job) => job.id !== tail);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Not found' }),
    });
  });
  await page.route('**/api/families/*/attachments/*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fulfill({ status: 404 });
      return;
    }
    attachmentRequestStarted?.();
    if (attachmentGate) {
      const gate = attachmentGate;
      attachmentGate = undefined;
      await gate.promise;
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: 'image/jpeg',
        headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
        body: attachmentBytes,
      });
    } catch {
      // A family switch can abort this request after its authorization context changed.
    }
  });

  return {
    uploads,
    get jobs() {
      return jobs;
    },
    get listCalls() {
      return listCalls;
    },
    set failNextUpload(value: boolean) {
      failNextUpload = value;
    },
    set failNextDelete(value: boolean) {
      failNextDelete = value;
    },
    set failNextListStatus(value: number | undefined) {
      failNextListStatus = value;
    },
    set unauthenticated(value: boolean) {
      unauthenticated = value;
    },
    set uploadGate(value: ReturnType<typeof deferred> | undefined) {
      uploadGate = value;
    },
    holdListOnCall(call: number) {
      gateListCall = call;
      const gate = deferred();
      const started = deferred();
      listGate = gate;
      listGateStarted = started;
      return { gate, started: started.promise };
    },
    holdNextAttachment() {
      const gate = deferred();
      attachmentGate = gate;
      return { gate, started: attachmentRequestStartedPromise };
    },
    switchIdentity(nextUserId: string, nextFamilyId: string) {
      userId = nextUserId;
      familyId = nextFamilyId;
    },
  };
}

test('orients and strips a synthetic photo, saves it, opens it, and deletes it', async ({
  page,
}) => {
  const api = await installHarness(page);
  await page.goto('/import');
  await expect(page.getByTestId('import-screen')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'プリントを取り込む' })).toBeVisible();
  await expect(page.getByTestId('import-camera-button')).toBeVisible();
  await expect(page.getByRole('button', { name: '写真を選ぶ' })).toBeVisible();
  await expect(page.getByTestId('import-camera-input')).toHaveAttribute('accept', 'image/*');
  await expect(page.getByTestId('import-camera-input')).toHaveAttribute('capture', 'environment');
  await expect(page.getByTestId('import-picker-input')).not.toHaveAttribute('capture');

  const source = await syntheticOrientedJpeg(page);
  const uploadGate = deferred();
  api.uploadGate = uploadGate;
  await page.getByTestId('import-picker-input').setInputFiles({
    name: 'synthetic-orientation.jpg',
    mimeType: 'image/jpeg',
    buffer: source,
  });
  await expect(page.getByTestId('import-preview')).toBeVisible();
  await expect(page.getByText('保存中...')).toBeVisible();
  expect(api.uploads).toHaveLength(1);
  uploadGate.resolve();
  await expect(page.getByTestId('import-thumbnail-import-1')).toBeVisible();
  expect(api.uploads).toHaveLength(1);
  expect(api.uploads[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(api.uploads[0]?.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect(jpegMetadata(api.uploads[0]?.body ?? Buffer.alloc(0))).toEqual({
    width: 1000,
    height: 2000,
    hasExif: false,
  });
  await expect(page.getByText('読み取り待ち')).toBeVisible();
  const thumbnail = page.getByTestId('import-thumbnail-import-1');
  for (const control of [
    page.getByTestId('import-camera-button'),
    page.getByTestId('import-picker-button'),
    thumbnail,
    page.getByTestId('import-delete-import-1'),
  ]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }

  await thumbnail.focus();
  await thumbnail.click();
  await expect(page.getByTestId('import-viewer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('import-viewer')).toHaveCount(0);
  await expect(thumbnail).toBeFocused();

  if (process.env.DANRAN_SCREENSHOTS === '1') {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(thumbnail).toBeVisible();
    await expect(thumbnail).toBeEnabled();
    await expect
      .poll(() =>
        thumbnail
          .locator('img')
          .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    await page.screenshot({ path: 'docs/screenshots/s3-import-upload.png', fullPage: true });
  }

  await page.setViewportSize({ width: 445, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByTestId('import-picker-input').setInputFiles({
    name: 'synthetic-landscape.jpg',
    mimeType: 'image/jpeg',
    buffer: await syntheticLandscapeJpeg(page),
  });
  await expect(page.getByTestId('import-thumbnail-import-2')).toBeVisible();
  expect(api.uploads).toHaveLength(2);
  expect(jpegMetadata(api.uploads[1]?.body ?? Buffer.alloc(0))).toEqual({
    width: 2000,
    height: 1000,
    hasExif: false,
  });

  await page.getByTestId('import-delete-import-1').click();
  await expect(page.getByTestId('import-delete-confirmation')).toBeVisible();
  await page.getByTestId('import-delete-confirm-import-1').click();
  await expect(page.getByTestId('import-thumbnail-import-2')).toBeVisible();
  await page.getByTestId('import-delete-import-2').click();
  await expect(page.getByTestId('import-delete-confirmation')).toBeVisible();
  await page.getByTestId('import-delete-confirm-import-2').click();
  await expect(page.getByTestId('import-empty')).toBeVisible();
});

test('keeps the same request id for a retry and blocks a duplicate submit while pending', async ({
  page,
}) => {
  const api = await installHarness(page);
  api.failNextUpload = true;
  await page.goto('/import');
  await page.getByTestId('import-picker-input').setInputFiles({
    name: 'synthetic-retry.jpg',
    mimeType: 'image/jpeg',
    buffer: await syntheticOrientedJpeg(page),
  });
  await expect(page.getByTestId('import-upload-error')).toBeVisible();
  const firstRequestId = api.uploads[0]?.requestId;
  await page.getByTestId('import-retry').click();
  await expect(page.getByTestId('import-thumbnail-import-1')).toBeVisible();
  expect(api.uploads).toHaveLength(2);
  expect(api.uploads[1]?.requestId).toBe(firstRequestId);

  const gate = deferred();
  api.uploadGate = gate;
  await page.getByTestId('import-picker-input').setInputFiles({
    name: 'synthetic-double.jpg',
    mimeType: 'image/jpeg',
    buffer: await syntheticOrientedJpeg(page),
  });
  await expect(page.getByText('保存中...')).toBeVisible();
  const captureButton = page.getByTestId('import-camera-button');
  await expect(captureButton).toBeDisabled();
  await expect(page.getByTestId('import-picker-button')).toBeDisabled();
  expect(api.uploads).toHaveLength(3);
  gate.resolve();
  await expect(page.getByTestId('import-thumbnail-import-2')).toBeVisible();
});

test('retains the cached list during refresh and reports deletion failure without removing the photo', async ({
  page,
}) => {
  const existing: ImportJob = {
    id: 'import-existing',
    status: 'pending',
    createdAt: 1_792_200_000,
    createdByMemberId: MEMBER_A,
    attachment: { id: 'attachment-existing', width: 320, height: 480 },
  };
  const api = await installHarness(page, [existing]);
  await page.goto('/import');
  await expect(page.getByTestId('import-thumbnail-import-existing')).toBeVisible();
  const listRefresh = api.holdListOnCall(api.listCalls + 1);
  await page.getByTestId('import-picker-input').setInputFiles({
    name: 'synthetic-refresh.jpg',
    mimeType: 'image/jpeg',
    buffer: await syntheticOrientedJpeg(page),
  });
  await listRefresh.started;
  await expect(page.getByTestId('import-thumbnail-import-existing')).toBeVisible();
  await expect(page.getByText('更新中...')).toBeVisible();
  listRefresh.gate.resolve();
  await expect(page.getByTestId('import-thumbnail-import-2')).toBeVisible();

  api.failNextDelete = true;
  await page.getByTestId('import-delete-import-existing').click();
  await page.getByTestId('import-delete-confirm-import-existing').click();
  await expect(page.getByTestId('import-delete-error-import-existing')).toBeVisible();
  await expect(page.getByTestId('import-thumbnail-import-existing')).toBeVisible();
});

test('does not show the previous family list after identity changes and checks narrow layouts and tap targets', async ({
  page,
}) => {
  const privateJob: ImportJob = {
    id: 'import-private',
    status: 'pending',
    createdAt: 1_792_200_000,
    createdByMemberId: MEMBER_A,
    attachment: { id: 'attachment-private', width: 320, height: 480 },
  };
  await page.addInitScript(() => {
    const urlState = { created: 0, revoked: 0, active: new Set<string>() };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = create(object);
      urlState.created += 1;
      urlState.active.add(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      if (urlState.active.delete(url)) urlState.revoked += 1;
      revoke(url);
    };
    (window as unknown as { danranObjectUrlState: typeof urlState }).danranObjectUrlState =
      urlState;
  });
  const api = await installHarness(page, [privateJob]);
  await page.goto('/import');
  await expect(page.getByTestId('import-thumbnail-import-private')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { danranObjectUrlState: { created: number } }).danranObjectUrlState
            .created,
      ),
    )
    .toBeGreaterThan(0);
  api.switchIdentity(USER_B, FAMILY_B);
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes('/api/auth/me') && response.status() === 200,
    ),
    triggerVisibilityCycle(page),
  ]);
  await expect(page.getByTestId('import-empty')).toBeVisible();
  await expect(page.getByTestId('import-thumbnail-import-private')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { danranObjectUrlState: { revoked: number } }).danranObjectUrlState
            .revoked,
      ),
    )
    .toBeGreaterThan(0);

  await page.route('**/api/families/*/tasks', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [] }),
    }),
  );
  await page.goto('/tasks');
  const navigation = page.getByRole('navigation', { name: 'メインナビゲーション' });
  await navigation.getByRole('button', { name: 'プリントを撮影' }).click();
  await expect(page).toHaveURL(/\/import$/);
  await expect(page.getByRole('heading', { name: 'プリントを取り込む' })).toBeVisible();
  const controls = [
    page.getByTestId('import-camera-button'),
    page.getByTestId('import-picker-button'),
  ];
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  for (const width of [390, 445]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});

test('drops an in-flight previous-family photo response after an account switch', async ({
  page,
}) => {
  const privateJob: ImportJob = {
    id: 'import-late-photo',
    status: 'pending',
    createdAt: 1_792_200_000,
    createdByMemberId: MEMBER_A,
    attachment: { id: 'attachment-late-photo', width: 320, height: 480 },
  };
  const api = await installHarness(page, [privateJob]);
  const photo = api.holdNextAttachment();
  await page.goto('/import');
  await expect(page.getByTestId('import-thumbnail-import-late-photo')).toBeVisible();
  await photo.started;
  api.switchIdentity(USER_B, FAMILY_B);
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes('/api/auth/me') && response.status() === 200,
    ),
    triggerVisibilityCycle(page),
  ]);
  await expect(page.getByTestId('import-empty')).toBeVisible();
  await expect(page.getByTestId('import-thumbnail-import-late-photo')).toHaveCount(0);
  photo.gate.resolve();
  await expect(page.getByTestId('import-thumbnail-import-late-photo')).toHaveCount(0);
});

test('discards an unsaved photo draft when the signed-in account changes', async ({ page }) => {
  const api = await installHarness(page);
  const upload = deferred();
  api.uploadGate = upload;
  await page.goto('/import');
  await page.getByTestId('import-picker-input').setInputFiles({
    name: 'synthetic-unsaved.jpg',
    mimeType: 'image/jpeg',
    buffer: await syntheticOrientedJpeg(page),
  });
  await expect(page.getByTestId('import-preview')).toBeVisible();
  await expect(page.getByText('保存中...')).toBeVisible();
  api.switchIdentity(USER_B, FAMILY_B);
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes('/api/auth/me') && response.status() === 200,
    ),
    triggerVisibilityCycle(page),
  ]);
  await expect(page.getByTestId('import-preview')).toHaveCount(0);
  await expect(page.getByTestId('import-empty')).toBeVisible();
  upload.resolve();
  await expect(page.getByTestId('import-thumbnail-import-1')).toHaveCount(0);
});

for (const status of [401, 403, 404]) {
  test(`clears a cached photo when its list refresh returns ${status}`, async ({ page }) => {
    const privateJob: ImportJob = {
      id: `import-refresh-${status}`,
      status: 'pending',
      createdAt: 1_792_200_000,
      createdByMemberId: MEMBER_A,
      attachment: { id: `attachment-refresh-${status}`, width: 320, height: 480 },
    };
    const api = await installHarness(page, [privateJob]);
    await page.goto('/import');
    await expect(page.getByTestId(`import-thumbnail-import-refresh-${status}`)).toBeVisible();
    api.failNextListStatus = status;
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes('/api/families/') && response.status() === status,
      ),
      triggerVisibilityCycle(page),
    ]);
    await expect(page.getByTestId(`import-thumbnail-import-refresh-${status}`)).toHaveCount(0);
    if (status === 401) {
      await expect(page.getByText('続けるには Google でログインしてください。')).toBeVisible();
    }
  });
}

test('requires an authenticated session and a ready family before showing camera controls', async ({
  page,
}) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unauthorized' }),
    }),
  );
  await page.goto('/import');
  await expect(page.getByText('続けるには Google でログインしてください。')).toBeVisible();
  await expect(page.getByTestId('import-camera-input')).toHaveCount(0);

  await page.unroute('**/api/auth/me');
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: USER_A, email: 'imports@example.test', displayName: 'テスト利用者' },
      }),
    }),
  );
  await page.route('**/api/families', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ families: [] }),
    }),
  );
  await page.goto('/import');
  await expect(
    page.getByText('写真を保存するには、先に家族カレンダーを準備してください。'),
  ).toBeVisible();
  await expect(page.getByTestId('import-camera-input')).toHaveCount(0);
});
