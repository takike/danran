import { z } from 'zod';

export const MAX_IMPORT_BYTES = 3 * 1024 * 1024;
export const MAX_IMPORT_DIMENSION = 2000;

export const importClientRequestIdSchema = z.string().uuid();
export const importResourceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const importJobSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['pending', 'extracted', 'failed', 'committed']),
  createdAt: z.number().int().nonnegative(),
  createdByMemberId: z.string().min(1),
  attachment: z.object({
    id: z.string().min(1),
    width: z.number().int().positive().max(MAX_IMPORT_DIMENSION),
    height: z.number().int().positive().max(MAX_IMPORT_DIMENSION),
  }),
});

export const importListResponseSchema = z.object({ imports: z.array(importJobSchema).max(50) });
export const importDeleteResponseSchema = z.object({ ok: z.literal(true) });

export const importErrorCodeSchema = z.enum([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'FAMILY_NOT_READY',
  'INVALID_INPUT',
  'UNSUPPORTED_MEDIA_TYPE',
  'IMAGE_TOO_LARGE',
  'INVALID_JPEG',
  'EXIF_NOT_ALLOWED',
  'PENDING_LIMIT_REACHED',
  'UPLOAD_IN_PROGRESS',
  'COMMITTED_IMPORT',
  'INTERNAL_ERROR',
]);

export const importErrorResponseSchema = z.object({
  error: z.string(),
  code: importErrorCodeSchema,
});

export type ImportJob = z.infer<typeof importJobSchema>;
export type ImportErrorCode = z.infer<typeof importErrorCodeSchema>;
