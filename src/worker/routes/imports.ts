import { inspectJpeg } from '@shared/domain/jpeg';
import { familyIdSchema } from '@shared/schemas/family';
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_DIMENSION,
  importClientRequestIdSchema,
  importDeleteResponseSchema,
  importErrorResponseSchema,
  importJobSchema,
  importListResponseSchema,
  importResourceIdSchema,
} from '@shared/schemas/imports';
import { getAuthConfig } from '@worker/auth/config';
import { getSessionUser } from '@worker/auth/session';
import { createDb } from '@worker/db';
import { attachments, families, importJobs, members } from '@worker/db/schema';
import type { WorkerEnv } from '@worker/env';
import { and, desc, eq, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { familySecurityMiddleware } from './families';

const MAX_PENDING_IMPORTS = 20;
type RouteContext = Context<{ Bindings: WorkerEnv }>;
type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'FAMILY_NOT_READY'
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'IMAGE_TOO_LARGE'
  | 'INVALID_JPEG'
  | 'EXIF_NOT_ALLOWED'
  | 'PENDING_LIMIT_REACHED'
  | 'UPLOAD_IN_PROGRESS'
  | 'COMMITTED_IMPORT'
  | 'INTERNAL_ERROR';

export const importsRoute = new Hono<{ Bindings: WorkerEnv }>();
importsRoute.use('*', familySecurityMiddleware);

function errorResponse(
  c: RouteContext,
  status: 400 | 401 | 404 | 409 | 413 | 415 | 500,
  code: ErrorCode,
) {
  const messages: Record<ErrorCode, string> = {
    UNAUTHORIZED: 'Unauthorized',
    FORBIDDEN: 'Forbidden',
    NOT_FOUND: 'Not found',
    FAMILY_NOT_READY: 'Family is not ready',
    INVALID_INPUT: 'Invalid request',
    UNSUPPORTED_MEDIA_TYPE: 'JPEG is required',
    IMAGE_TOO_LARGE: 'Image exceeds the size limit',
    INVALID_JPEG: 'Invalid JPEG image',
    EXIF_NOT_ALLOWED: 'Image metadata is not allowed',
    PENDING_LIMIT_REACHED: 'Pending import limit reached',
    UPLOAD_IN_PROGRESS: 'Upload is already in progress',
    COMMITTED_IMPORT: 'Committed imports cannot be deleted',
    INTERNAL_ERROR: 'Internal server error',
  };
  return c.json(importErrorResponseSchema.parse({ error: messages[code], code }), status);
}

async function authorizeFamilyAdult(c: RouteContext) {
  const db = createDb(c.env.DB);
  let session: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    const config = getAuthConfig(c.env);
    session = await getSessionUser(c, db, config.sessionSecret);
  } catch {
    return { response: errorResponse(c, 500, 'INTERNAL_ERROR') } as const;
  }
  if (!session) return { response: errorResponse(c, 401, 'UNAUTHORIZED') } as const;

  const parsedFamilyId = familyIdSchema.safeParse(c.req.param('id'));
  if (!parsedFamilyId.success) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  const familyId = parsedFamilyId.data;
  let familyRows: (typeof families.$inferSelect)[];
  try {
    familyRows = await db.select().from(families).where(eq(families.id, familyId));
  } catch {
    return { response: errorResponse(c, 500, 'INTERNAL_ERROR') } as const;
  }
  const family = familyRows[0];
  if (!family) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  let memberRows: (typeof members.$inferSelect)[];
  try {
    memberRows = await db
      .select()
      .from(members)
      .where(
        and(
          eq(members.familyId, familyId),
          eq(members.userId, session.user.id),
          eq(members.kind, 'adult'),
          eq(members.status, 'active'),
        ),
      );
  } catch {
    return { response: errorResponse(c, 500, 'INTERNAL_ERROR') } as const;
  }
  const caller = memberRows[0];
  if (!caller) return { response: errorResponse(c, 404, 'NOT_FOUND') } as const;
  if (family.creationStatus !== 'ready') {
    return { response: errorResponse(c, 409, 'FAMILY_NOT_READY') } as const;
  }
  return { db, family, caller } as const;
}

function mapImport(
  job: typeof importJobs.$inferSelect,
  attachment: typeof attachments.$inferSelect,
) {
  return importJobSchema.parse({
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    createdByMemberId: job.createdBy,
    attachment: { id: attachment.id, width: attachment.width, height: attachment.height },
  });
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_IMPORT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function findExisting(
  db: ReturnType<typeof createDb>,
  familyId: string,
  memberId: string,
  requestId: string,
) {
  const rows = await db
    .select({ job: importJobs, attachment: attachments })
    .from(importJobs)
    .innerJoin(attachments, eq(importJobs.attachmentId, attachments.id))
    .where(
      and(
        eq(importJobs.familyId, familyId),
        eq(importJobs.createdBy, memberId),
        eq(importJobs.clientRequestId, requestId),
      ),
    );
  return rows[0] ? mapImport(rows[0].job, rows[0].attachment) : null;
}

importsRoute.post('/:id/imports', async (c) => {
  const auth = await authorizeFamilyAdult(c);
  if ('response' in auth) return auth.response;
  if (
    (c.req.header('Content-Type') ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'image/jpeg'
  ) {
    return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
  }
  const requestIdResult = importClientRequestIdSchema.safeParse(
    c.req.header('X-Client-Request-Id'),
  );
  if (!requestIdResult.success) return errorResponse(c, 400, 'INVALID_INPUT');
  const requestId = requestIdResult.data;

  let existing: ReturnType<typeof mapImport> | null;
  try {
    existing = await findExisting(auth.db, auth.family.id, auth.caller.id, requestId);
  } catch {
    return errorResponse(c, 500, 'INTERNAL_ERROR');
  }
  if (existing) return c.json(existing, 200);

  let bytes: Uint8Array | null;
  try {
    bytes = await readBoundedBody(c.req.raw);
  } catch {
    return errorResponse(c, 400, 'INVALID_INPUT');
  }
  if (bytes === null) return errorResponse(c, 413, 'IMAGE_TOO_LARGE');
  if (bytes.length === 0) return errorResponse(c, 400, 'INVALID_INPUT');
  const jpeg = inspectJpeg(bytes);
  if (!jpeg) return errorResponse(c, 400, 'INVALID_JPEG');
  if (jpeg.hasExif) return errorResponse(c, 400, 'EXIF_NOT_ALLOWED');
  if (Math.max(jpeg.width, jpeg.height) > MAX_IMPORT_DIMENSION) {
    return errorResponse(c, 400, 'INVALID_INPUT');
  }

  const jobId = await sha256Hex(`${auth.family.id}/${auth.caller.userId}/${requestId}`);
  const attachmentId = `att_${jobId}`;
  const key = `families/${auth.family.id}/imports/${jobId}.jpg`;
  const now = Math.floor(Date.now() / 1000);
  let objectCreated = false;
  try {
    const putResult = await c.env.PHOTOS.put(key, bytes, {
      httpMetadata: { contentType: 'image/jpeg' },
      onlyIf: { etagDoesNotMatch: '*' },
    });
    if (!putResult) {
      existing = await findExisting(auth.db, auth.family.id, auth.caller.id, requestId);
      if (existing) return c.json(existing, 200);
      return errorResponse(c, 409, 'UPLOAD_IN_PROGRESS');
    }
    objectCreated = true;

    await auth.db.batch([
      auth.db.insert(attachments).select(
        auth.db
          .select({
            id: sql<string>`${attachmentId}`.as('id'),
            familyId: sql<string>`${auth.family.id}`.as('familyId'),
            r2Key: sql<string>`${key}`.as('r2Key'),
            contentType: sql<'image/jpeg'>`'image/jpeg'`.as('contentType'),
            width: sql<number>`${jpeg.width}`.as('width'),
            height: sql<number>`${jpeg.height}`.as('height'),
            byteSize: sql<number>`${bytes.length}`.as('byteSize'),
            createdBy: sql<string>`${auth.caller.id}`.as('createdBy'),
            createdAt: sql<number>`${now}`.as('createdAt'),
          })
          .from(families)
          .where(
            and(
              eq(families.id, auth.family.id),
              sql`(SELECT COUNT(*) FROM ${importJobs} WHERE ${importJobs.familyId} = ${auth.family.id} AND ${importJobs.status} = 'pending') < ${MAX_PENDING_IMPORTS}`,
              sql`NOT EXISTS (SELECT 1 FROM ${attachments} WHERE ${attachments.id} = ${attachmentId})`,
            ),
          ),
      ),
      auth.db.insert(importJobs).values({
        id: jobId,
        familyId: auth.family.id,
        attachmentId,
        status: 'pending',
        createdBy: auth.caller.id,
        clientRequestId: requestId,
        createdAt: now,
      }),
    ]);
  } catch {
    let consistencyReadSucceeded = false;
    try {
      existing = await findExisting(auth.db, auth.family.id, auth.caller.id, requestId);
      consistencyReadSucceeded = true;
      if (existing) return c.json(existing, 200);
    } catch {
      // The D1 batch may have committed. Preserve the object if D1 cannot confirm its state.
    }
    if (objectCreated && consistencyReadSucceeded) {
      try {
        await c.env.PHOTOS.delete(key);
      } catch {
        // R2 and D1 cannot share a transaction. A failed compensation can leave an orphaned object.
      }
    }
    try {
      const pendingRows = await auth.db
        .select({ count: sql<number>`COUNT(*)` })
        .from(importJobs)
        .where(and(eq(importJobs.familyId, auth.family.id), eq(importJobs.status, 'pending')));
      if ((pendingRows[0]?.count ?? 0) >= MAX_PENDING_IMPORTS) {
        return errorResponse(c, 409, 'PENDING_LIMIT_REACHED');
      }
    } catch {
      // Return the same sanitized error for storage and database failures.
    }
    return errorResponse(c, 500, 'INTERNAL_ERROR');
  }

  const saved = await findExisting(auth.db, auth.family.id, auth.caller.id, requestId);
  if (!saved) return errorResponse(c, 500, 'INTERNAL_ERROR');
  return c.json(saved, 201);
});

importsRoute.get('/:id/imports', async (c) => {
  const auth = await authorizeFamilyAdult(c);
  if ('response' in auth) return auth.response;
  try {
    const rows = await auth.db
      .select({ job: importJobs, attachment: attachments })
      .from(importJobs)
      .innerJoin(attachments, eq(importJobs.attachmentId, attachments.id))
      .where(eq(importJobs.familyId, auth.family.id))
      .orderBy(desc(importJobs.createdAt), desc(importJobs.id))
      .limit(50);
    return c.json(
      importListResponseSchema.parse({
        imports: rows.map((row) => mapImport(row.job, row.attachment)),
      }),
    );
  } catch {
    return errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

importsRoute.get('/:id/attachments/:attachmentId', async (c) => {
  const auth = await authorizeFamilyAdult(c);
  if ('response' in auth) return auth.response;
  const parsedAttachmentId = importResourceIdSchema.safeParse(c.req.param('attachmentId'));
  if (!parsedAttachmentId.success) return errorResponse(c, 404, 'NOT_FOUND');
  const rows = await auth.db
    .select()
    .from(attachments)
    .where(
      and(eq(attachments.id, parsedAttachmentId.data), eq(attachments.familyId, auth.family.id)),
    );
  const attachment = rows[0];
  if (!attachment) return errorResponse(c, 404, 'NOT_FOUND');
  try {
    const object = await c.env.PHOTOS.get(attachment.r2Key);
    if (!object) return errorResponse(c, 404, 'NOT_FOUND');
    c.header('Content-Type', 'image/jpeg');
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Disposition', 'inline');
    return c.body(object.body);
  } catch {
    return errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});

importsRoute.delete('/:id/imports/:importId', async (c) => {
  const auth = await authorizeFamilyAdult(c);
  if ('response' in auth) return auth.response;
  const parsedImportId = importResourceIdSchema.safeParse(c.req.param('importId'));
  if (!parsedImportId.success) return errorResponse(c, 404, 'NOT_FOUND');
  const rows = await auth.db
    .select({ job: importJobs, attachment: attachments })
    .from(importJobs)
    .innerJoin(attachments, eq(importJobs.attachmentId, attachments.id))
    .where(eq(importJobs.id, parsedImportId.data));
  const row = rows[0];
  if (!row) return c.json(importDeleteResponseSchema.parse({ ok: true }));
  if (row.job.familyId !== auth.family.id) return errorResponse(c, 404, 'NOT_FOUND');
  if (row.job.status === 'committed') return errorResponse(c, 409, 'COMMITTED_IMPORT');
  try {
    await c.env.PHOTOS.delete(row.attachment.r2Key);
  } catch {
    return errorResponse(c, 500, 'INTERNAL_ERROR');
  }
  try {
    await auth.db.batch([
      auth.db
        .delete(importJobs)
        .where(and(eq(importJobs.id, row.job.id), eq(importJobs.familyId, auth.family.id))),
      auth.db
        .delete(attachments)
        .where(
          and(eq(attachments.id, row.attachment.id), eq(attachments.familyId, auth.family.id)),
        ),
    ]);
    return c.json(importDeleteResponseSchema.parse({ ok: true }));
  } catch {
    return errorResponse(c, 500, 'INTERNAL_ERROR');
  }
});
