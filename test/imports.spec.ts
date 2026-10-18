import { env } from 'cloudflare:test';
import { SESSION_COOKIE_NAME } from '@worker/auth/config';
import { createSession } from '@worker/auth/session';
import { createDb } from '@worker/db';
import { attachments, families, importJobs, members, sessions, users } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { app } from '@worker/index';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { setSignedCookie } from 'hono/cookie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ORIGIN = 'http://localhost:5173';
const SESSION_SECRET = 'imports-test-session-secret-with-enough-entropy';
const AES_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const TEST_ENV: WorkerEnv = {
  ...env,
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'imports-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'imports-test-google-client-secret',
  SESSION_SECRET,
  TOKEN_ENC_KEY: AES_KEY,
};

function segment(marker: number, data: number[]) {
  const length = data.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...data];
}

function jpeg(width = 320, height = 240, exif = false) {
  return new Uint8Array([
    0xff,
    0xd8,
    ...(exif ? segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0]) : []),
    ...segment(0xc0, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      3,
      1,
      0x11,
      0,
      2,
      0x11,
      0,
      3,
      0x11,
      0,
    ]),
    ...segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]),
    0x10,
    0xff,
    0x00,
    0x11,
    0xff,
    0xd9,
  ]);
}

describe('print import API', () => {
  const db = createDb(env.DB);
  let cookie = '';

  beforeEach(async () => {
    await db.delete(importJobs);
    await db.delete(attachments);
    await db.delete(members);
    await db.delete(families);
    await db.delete(sessions);
    await db.delete(users);
    await db.insert(users).values([
      {
        id: 'usr_imports_a',
        googleSub: 'sub-imports-a',
        email: 'a@example.test',
        displayName: 'A',
      },
      {
        id: 'usr_imports_b',
        googleSub: 'sub-imports-b',
        email: 'b@example.test',
        displayName: 'B',
      },
    ]);
    await db.insert(families).values([
      {
        id: 'fam_imports_a',
        name: 'A family',
        ownerUserId: 'usr_imports_a',
        familyCalendarId: 'cal-a',
        creationStatus: 'ready',
      },
      {
        id: 'fam_imports_b',
        name: 'B family',
        ownerUserId: 'usr_imports_b',
        familyCalendarId: 'cal-b',
        creationStatus: 'ready',
      },
    ]);
    await db.insert(members).values([
      {
        id: 'mem_imports_a',
        familyId: 'fam_imports_a',
        userId: 'usr_imports_a',
        kind: 'adult',
        name: 'A',
        color: 'indigo',
        status: 'active',
      },
      {
        id: 'mem_imports_b',
        familyId: 'fam_imports_b',
        userId: 'usr_imports_b',
        kind: 'adult',
        name: 'B',
        color: 'green',
        status: 'active',
      },
      {
        id: 'mem_imports_child',
        familyId: 'fam_imports_a',
        userId: null,
        kind: 'child',
        name: 'Child',
        color: 'rose',
        status: 'active',
      },
    ]);
    const { rawToken } = await createSession(db, 'usr_imports_a');
    const cookieApp = new Hono();
    cookieApp.get('/', async (c) => {
      await setSignedCookie(c, SESSION_COOKIE_NAME, rawToken, SESSION_SECRET, {
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      });
      return c.text('ok');
    });
    cookie =
      (await (await cookieApp.request('http://localhost/')).headers.get('set-cookie'))?.split(
        ';',
      )[0] ?? '';
  });

  afterEach(async () => {
    for (const familyId of ['fam_imports_a', 'fam_imports_b']) {
      const objects = await env.PHOTOS.list({ prefix: `families/${familyId}/imports/` });
      if (objects.objects.length > 0) {
        await env.PHOTOS.delete(objects.objects.map((object) => object.key));
      }
    }
    await db.delete(importJobs);
    await db.delete(attachments);
    await db.delete(members);
    await db.delete(families);
    await db.delete(sessions);
    await db.delete(users);
  });

  async function upload(
    familyId: string,
    requestId: string = crypto.randomUUID(),
    body: BodyInit = jpeg(),
    contentType = 'image/jpeg',
    workerEnv: WorkerEnv = TEST_ENV,
    extraHeaders: Record<string, string> = {},
  ) {
    return app.request(
      `${ORIGIN}/api/families/${familyId}/imports`,
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': 'XMLHttpRequest',
          'X-Client-Request-Id': requestId,
          'Content-Type': contentType,
          Cookie: cookie,
          ...extraHeaders,
        },
        body,
      },
      workerEnv,
    );
  }

  function environmentWithPhotos(overrides: Partial<R2Bucket>): WorkerEnv {
    const photos = new Proxy(env.PHOTOS, {
      get(target, property) {
        const override = Reflect.get(overrides, property);
        if (override !== undefined) return override;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { ...TEST_ENV, PHOTOS: photos };
  }

  it('stores a JPEG once and returns only the direct import job contract', async () => {
    const requestId = crypto.randomUUID();
    const response = await upload('fam_imports_a', requestId);
    expect(response.status, await response.clone().text()).toBe(201);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toMatchObject({
      status: 'pending',
      createdByMemberId: 'mem_imports_a',
      attachment: { width: 320, height: 240 },
    });
    expect(JSON.stringify(data)).not.toContain('families/fam_imports_a/imports/');
    const rows = await db.select().from(importJobs).where(eq(importJobs.familyId, 'fam_imports_a'));
    expect(rows).toHaveLength(1);
    const job = rows[0];
    if (!job) throw new Error('Expected saved import job');
    const stored = await db.select().from(attachments).where(eq(attachments.id, job.attachmentId));
    const attachment = stored[0];
    if (!attachment) throw new Error('Expected saved attachment');
    expect(stored[0]?.r2Key).toMatch(/^families\/fam_imports_a\/imports\/[a-f0-9]{64}\.jpg$/);
    expect(stored[0]?.contentType).toBe('image/jpeg');
    const replay = await upload('fam_imports_a', requestId, jpeg(20, 20));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(data);
    const image = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/attachments/${attachment.id}`,
      {
        headers: { Cookie: cookie },
      },
      TEST_ENV,
    );
    expect(image.status).toBe(200);
    expect(image.headers.get('Content-Type')).toBe('image/jpeg');
    expect(image.headers.get('Cache-Control')).toBe('private, no-store');
    expect(image.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(image.headers.get('Content-Disposition')).toBe('inline');
    const importId = typeof data.id === 'string' ? data.id : '';
    const deleted = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/imports/${importId}`,
      {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' },
      },
      TEST_ENV,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    const repeatedDelete = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/imports/${importId}`,
      {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' },
      },
      TEST_ENV,
    );
    expect(repeatedDelete.status).toBe(200);
    expect(await db.select().from(importJobs).where(eq(importJobs.id, importId))).toHaveLength(0);
    expect(
      await db.select().from(attachments).where(eq(attachments.id, attachment.id)),
    ).toHaveLength(0);
    expect(await env.PHOTOS.get(attachment.r2Key)).toBeNull();
  });

  it('rejects invalid media, malformed JPEG, EXIF, oversized dimensions, and measured body overflow', async () => {
    expect((await upload('fam_imports_a', crypto.randomUUID(), jpeg(), 'image/png')).status).toBe(
      415,
    );
    expect(
      (await upload('fam_imports_a', crypto.randomUUID(), new Uint8Array([1, 2, 3]))).status,
    ).toBe(400);
    const exif = await upload('fam_imports_a', crypto.randomUUID(), jpeg(320, 240, true));
    expect(exif.status).toBe(400);
    expect(await exif.json()).toMatchObject({ code: 'EXIF_NOT_ALLOWED' });
    const large = await upload('fam_imports_a', crypto.randomUUID(), jpeg(2001, 100));
    expect(large.status).toBe(400);
    const tooLarge = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3 * 1024 * 1024 + 1));
        controller.close();
      },
    });
    expect(
      (
        await upload('fam_imports_a', crypto.randomUUID(), tooLarge, 'image/jpeg', TEST_ENV, {
          'Content-Length': '1',
        })
      ).status,
    ).toBe(413);
    expect((await upload('fam_imports_a', 'not-a-uuid')).status).toBe(400);
  });

  it('hides another family import and enforces adult authentication and mutation headers', async () => {
    const other = await upload('fam_imports_b');
    expect(other.status).toBe(404);
    const foreignJobId = 'foreign-job';
    const foreignAttachmentId = 'foreign-attachment';
    await db.insert(attachments).values({
      id: foreignAttachmentId,
      familyId: 'fam_imports_b',
      r2Key: 'families/fam_imports_b/imports/foreign.jpg',
      contentType: 'image/jpeg',
      width: 10,
      height: 10,
      byteSize: 10,
      createdBy: 'mem_imports_b',
    });
    await db.insert(importJobs).values({
      id: foreignJobId,
      familyId: 'fam_imports_b',
      attachmentId: foreignAttachmentId,
      status: 'pending',
      createdBy: 'mem_imports_b',
      clientRequestId: crypto.randomUUID(),
    });
    const foreignDelete = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/imports/${foreignJobId}`,
      {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' },
      },
      TEST_ENV,
    );
    expect(foreignDelete.status).toBe(404);
    const noCsrf = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/imports/${crypto.randomUUID()}`,
      {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: ORIGIN },
      },
      TEST_ENV,
    );
    expect(noCsrf.status).toBe(403);
    const noAuth = await app.request(`${ORIGIN}/api/families/fam_imports_a/imports`, {}, TEST_ENV);
    expect(noAuth.status).toBe(401);
  });

  it('limits concurrent uploads to 20 pending jobs', async () => {
    const seedAttachments = Array.from({ length: 19 }, (_, i) => ({
      id: `quota_attachment_${i}`,
      familyId: 'fam_imports_a',
      r2Key: `families/fam_imports_a/imports/seed-${i}.jpg`,
      contentType: 'image/jpeg' as const,
      width: 10,
      height: 10,
      byteSize: 10,
      createdBy: 'mem_imports_a',
    }));
    for (const [i, attachment] of seedAttachments.entries()) {
      await db.insert(attachments).values(attachment);
      await db.insert(importJobs).values({
        id: `quota_job_${i}`,
        familyId: 'fam_imports_a',
        attachmentId: attachment.id,
        status: 'pending' as const,
        createdBy: 'mem_imports_a',
        clientRequestId: crypto.randomUUID(),
      });
    }
    const responses = await Promise.all([upload('fam_imports_a'), upload('fam_imports_a')]);
    const successCount = responses.filter((response) => response.status === 201).length;
    const limitedCount = responses.filter((response) => response.status === 409).length;
    expect(successCount).toBe(1);
    expect(limitedCount).toBe(1);
    const pending = await db
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.familyId, 'fam_imports_a'), eq(importJobs.status, 'pending')));
    expect(pending).toHaveLength(20);
  });

  it('does not overwrite or clean up the winning object when the same request ID races', async () => {
    const requestId = crypto.randomUUID();
    const responses = await Promise.all([
      upload('fam_imports_a', requestId),
      upload('fam_imports_a', requestId),
    ]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.every((response) => [200, 201, 409].includes(response.status))).toBe(true);
    const retry = await upload('fam_imports_a', requestId);
    expect(retry.status).toBe(200);
    const rows = await db
      .select()
      .from(importJobs)
      .where(
        and(eq(importJobs.familyId, 'fam_imports_a'), eq(importJobs.clientRequestId, requestId)),
      );
    expect(rows).toHaveLength(1);
    const job = rows[0];
    if (!job) throw new Error('Expected one winning import');
    const saved = await db.select().from(attachments).where(eq(attachments.id, job.attachmentId));
    const attachment = saved[0];
    if (!attachment) throw new Error('Expected winning attachment');
    expect(await env.PHOTOS.get(attachment.r2Key)).not.toBeNull();
  });

  it('rolls back both D1 rows and removes the new R2 object after a database insert failure', async () => {
    await env.DB.prepare(
      "CREATE TRIGGER fail_test_import_insert BEFORE INSERT ON import_jobs BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    ).run();
    try {
      const response = await upload('fam_imports_a');
      expect(response.status).toBe(500);
      expect(
        await db.select().from(importJobs).where(eq(importJobs.familyId, 'fam_imports_a')),
      ).toHaveLength(0);
      expect(
        await db.select().from(attachments).where(eq(attachments.familyId, 'fam_imports_a')),
      ).toHaveLength(0);
      expect(
        (await env.PHOTOS.list({ prefix: 'families/fam_imports_a/imports/' })).objects,
      ).toHaveLength(0);
    } finally {
      await env.DB.prepare('DROP TRIGGER IF EXISTS fail_test_import_insert').run();
    }
  });

  it('preserves the object when D1 committed but the batch response was lost', async () => {
    const proxiedDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            await target.batch(statements);
            throw new Error('simulated response loss');
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const response = await upload('fam_imports_a', crypto.randomUUID(), jpeg(), 'image/jpeg', {
      ...TEST_ENV,
      DB: proxiedDb,
    });
    expect(response.status).toBe(200);
    const rows = await db.select().from(importJobs).where(eq(importJobs.familyId, 'fam_imports_a'));
    const job = rows[0];
    if (!job) throw new Error('Expected committed import');
    const saved = await db.select().from(attachments).where(eq(attachments.id, job.attachmentId));
    expect(await env.PHOTOS.get(saved[0]?.r2Key ?? 'missing')).not.toBeNull();
  });

  it('sanitizes R2 put/get/delete errors and leaves D1 rows when delete fails', async () => {
    const failedPut = environmentWithPhotos({
      put: async () => {
        throw new Error('secret-key-name-photo-bytes');
      },
    });
    const putResponse = await upload(
      'fam_imports_a',
      crypto.randomUUID(),
      jpeg(),
      'image/jpeg',
      failedPut,
    );
    expect(putResponse.status).toBe(500);
    expect(await putResponse.text()).not.toContain('secret-key-name-photo-bytes');

    const savedResponse = await upload('fam_imports_a');
    const savedJob = (await savedResponse.json()) as { id: string; attachment: { id: string } };
    const failedGet = environmentWithPhotos({
      get: async () => {
        throw new Error('secret-key-name-photo-bytes');
      },
    });
    const getResponse = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/attachments/${savedJob.attachment.id}`,
      { headers: { Cookie: cookie } },
      failedGet,
    );
    expect(getResponse.status).toBe(500);
    expect(await getResponse.text()).not.toContain('secret-key-name-photo-bytes');
    const failedDelete = environmentWithPhotos({
      delete: async () => {
        throw new Error('secret-key-name-photo-bytes');
      },
    });
    const deleteResponse = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/imports/${savedJob.id}`,
      {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' },
      },
      failedDelete,
    );
    expect(deleteResponse.status).toBe(500);
    expect(await deleteResponse.text()).not.toContain('secret-key-name-photo-bytes');
    expect(await db.select().from(importJobs).where(eq(importJobs.id, savedJob.id))).toHaveLength(
      1,
    );
  });

  it('hides foreign attachments and lists only this family newest first', async () => {
    const firstResponse = await upload('fam_imports_a');
    const first = (await firstResponse.json()) as { id: string; attachment: { id: string } };
    await db.update(importJobs).set({ createdAt: 1 }).where(eq(importJobs.id, first.id));
    const secondResponse = await upload('fam_imports_a');
    const second = (await secondResponse.json()) as { id: string };
    await db.update(importJobs).set({ createdAt: 2 }).where(eq(importJobs.id, second.id));
    await db.insert(attachments).values({
      id: 'imports_foreign_attachment',
      familyId: 'fam_imports_b',
      r2Key: 'families/fam_imports_b/imports/foreign.jpg',
      contentType: 'image/jpeg',
      width: 10,
      height: 10,
      byteSize: 10,
      createdBy: 'mem_imports_b',
    });
    await db.insert(importJobs).values({
      id: 'imports_foreign_job',
      familyId: 'fam_imports_b',
      attachmentId: 'imports_foreign_attachment',
      status: 'pending',
      createdBy: 'mem_imports_b',
      clientRequestId: crypto.randomUUID(),
    });
    for (let chunkStart = 0; chunkStart < 51; chunkStart += 10) {
      const batchSize = Math.min(10, 51 - chunkStart);
      for (let offset = 0; offset < batchSize; offset++) {
        const index = chunkStart + offset;
        await db.insert(attachments).values({
          id: `imports_list_attachment_${index}`,
          familyId: 'fam_imports_a',
          r2Key: `families/fam_imports_a/imports/list-${index}.jpg`,
          contentType: 'image/jpeg',
          width: 10,
          height: 10,
          byteSize: 10,
          createdBy: 'mem_imports_a',
          createdAt: 30 + index,
        });
        await db.insert(importJobs).values({
          id: `imports_list_job_${index}`,
          familyId: 'fam_imports_a',
          attachmentId: `imports_list_attachment_${index}`,
          status: 'pending',
          createdBy: 'mem_imports_a',
          clientRequestId: crypto.randomUUID(),
          createdAt: 30 + index,
        });
      }
    }
    const unknown = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/attachments/not-found`,
      { headers: { Cookie: cookie } },
      TEST_ENV,
    );
    expect(unknown.status).toBe(404);
    const malformedAttachmentId = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/attachments/bad.id`,
      { headers: { Cookie: cookie } },
      TEST_ENV,
    );
    expect(malformedAttachmentId.status).toBe(404);
    const malformedImportId = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/imports/bad.id`,
      {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' },
      },
      TEST_ENV,
    );
    expect(malformedImportId.status).toBe(404);
    const foreign = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/attachments/foreign-attachment`,
      { headers: { Cookie: cookie } },
      TEST_ENV,
    );
    expect(foreign.status).toBe(404);
    const list = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/imports`,
      {
        headers: { Cookie: cookie },
      },
      TEST_ENV,
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { imports: Array<{ id: string; createdAt: number }> };
    expect(listed.imports).toHaveLength(50);
    expect(listed.imports.map(({ createdAt }) => createdAt)).toEqual(
      [...listed.imports.map(({ createdAt }) => createdAt)].sort((a, b) => b - a),
    );
    expect(listed.imports.some(({ id }) => id === 'imports_foreign_job')).toBe(false);
    expect(listed.imports.some(({ id }) => id === first.id)).toBe(false);
    expect(listed.imports.some(({ id }) => id === second.id)).toBe(false);
  });

  it('rejects wrong Origin and missing X-Requested-With on POST and DELETE', async () => {
    const wrongOrigin = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/imports`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'https://attacker.example',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Client-Request-Id': crypto.randomUUID(),
          'Content-Type': 'image/jpeg',
        },
        body: jpeg(),
      },
      TEST_ENV,
    );
    expect(wrongOrigin.status).toBe(403);
    const noRequestedWith = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/imports`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: ORIGIN,
          'X-Client-Request-Id': crypto.randomUUID(),
          'Content-Type': 'image/jpeg',
        },
        body: jpeg(),
      },
      TEST_ENV,
    );
    expect(noRequestedWith.status).toBe(403);
    const wrongDeleteOrigin = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/imports/missing`,
      {
        method: 'DELETE',
        headers: {
          Cookie: cookie,
          Origin: 'https://attacker.example',
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
      TEST_ENV,
    );
    expect(wrongDeleteOrigin.status).toBe(403);
    const noDeleteRequestedWith = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/imports/missing`,
      {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: ORIGIN },
      },
      TEST_ENV,
    );
    expect(noDeleteRequestedWith.status).toBe(403);
  });

  it('deletes failed and extracted imports and preserves committed imports', async () => {
    for (const status of ['failed', 'extracted'] as const) {
      const response = await upload('fam_imports_a');
      expect(response.status).toBe(201);
      const job = (await response.json()) as { id: string; attachment: { id: string } };
      await db.update(importJobs).set({ status }).where(eq(importJobs.id, job.id));
      const attachmentRows = await db
        .select()
        .from(attachments)
        .where(eq(attachments.id, job.attachment.id));
      const attachment = attachmentRows[0];
      if (!attachment) throw new Error(`Expected ${status} attachment`);
      const deleted = await app.request(
        `${ORIGIN}/api/families/fam_imports_a/imports/${job.id}`,
        {
          method: 'DELETE',
          headers: { Cookie: cookie, Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' },
        },
        TEST_ENV,
      );
      expect(deleted.status).toBe(200);
      expect(await db.select().from(importJobs).where(eq(importJobs.id, job.id))).toHaveLength(0);
      expect(
        await db.select().from(attachments).where(eq(attachments.id, attachment.id)),
      ).toHaveLength(0);
      expect(await env.PHOTOS.get(attachment.r2Key)).toBeNull();
    }

    const committedResponse = await upload('fam_imports_a');
    expect(committedResponse.status).toBe(201);
    const committedJob = (await committedResponse.json()) as {
      id: string;
      attachment: { id: string };
    };
    await db
      .update(importJobs)
      .set({ status: 'committed' })
      .where(eq(importJobs.id, committedJob.id));
    const attachmentRows = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, committedJob.attachment.id));
    const attachment = attachmentRows[0];
    if (!attachment) throw new Error('Expected committed attachment');
    const refused = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/imports/${committedJob.id}`,
      {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' },
      },
      TEST_ENV,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'COMMITTED_IMPORT' });
    expect(
      await db.select().from(importJobs).where(eq(importJobs.id, committedJob.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(attachments).where(eq(attachments.id, attachment.id)),
    ).toHaveLength(1);
    expect(await env.PHOTOS.get(attachment.r2Key)).not.toBeNull();
  });

  it('returns 401 for unauthenticated attachment access and 404 for inactive adults', async () => {
    const noSession = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/attachments/missing`,
      {},
      TEST_ENV,
    );
    expect(noSession.status).toBe(401);
    await db.update(members).set({ status: 'pending' }).where(eq(members.id, 'mem_imports_b'));
    const inactiveSession = await createSession(db, 'usr_imports_b');
    const inactiveCookieApp = new Hono();
    inactiveCookieApp.get('/', async (c) => {
      await setSignedCookie(c, SESSION_COOKIE_NAME, inactiveSession.rawToken, SESSION_SECRET, {
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      });
      return c.text('ok');
    });
    const inactiveCookie =
      (
        await (await inactiveCookieApp.request('http://localhost/')).headers.get('set-cookie')
      )?.split(';')[0] ?? '';
    const inactive = await app.request(
      `${ORIGIN}/api/families/fam_imports_a/attachments/missing`,
      { headers: { Cookie: inactiveCookie } },
      TEST_ENV,
    );
    expect(inactive.status).toBe(404);
    await db
      .update(families)
      .set({ creationStatus: 'creating' })
      .where(eq(families.id, 'fam_imports_a'));
    const notReady = await upload('fam_imports_a');
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toMatchObject({ code: 'FAMILY_NOT_READY' });
  });
});
