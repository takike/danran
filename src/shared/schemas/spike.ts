import { z } from 'zod';

export const SPIKE_ACTIONS = [
  'insertCalendar',
  'insertAcl',
  'deleteCalendar',
  'insertCalendarList',
  'listEvents',
  'insertEvent',
  'deleteEvent',
] as const;

export const spikeActionSchema = z.enum(SPIKE_ACTIONS);
export type SpikeAction = z.infer<typeof spikeActionSchema>;

/**
 * Validated target calendar ID input: bounded, non-empty, no boundary whitespace,
 * rejects primary calendar, relative path segments ('.'/'..'), and invalid unicode.
 */
export const spikeCalendarIdSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((val) => val === val.trim(), {
    message: 'Calendar ID must not have leading or trailing whitespace',
  })
  .refine((val) => val !== '.' && val !== '..', {
    message: 'Calendar ID must not be relative path segments',
  })
  .refine((val) => val.toLowerCase() !== 'primary', {
    message: 'Primary calendar is not allowed in spike operations',
  })
  .refine(
    (val) => {
      try {
        encodeURIComponent(val);
        return true;
      } catch {
        return false;
      }
    },
    {
      message: 'Calendar ID contains invalid unicode characters',
    },
  );

/**
 * Validated target calendar ID for calendarList insert (alias of spikeCalendarIdSchema).
 */
export const spikeCalendarListIdSchema = spikeCalendarIdSchema;

/**
 * Validated target event ID input.
 */
export const spikeEventIdSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((val) => val === val.trim(), {
    message: 'Event ID must not have leading or trailing whitespace',
  })
  .refine((val) => val !== '.' && val !== '..', {
    message: 'Event ID must not be relative path segments',
  })
  .refine(
    (val) => {
      try {
        encodeURIComponent(val);
        return true;
      } catch {
        return false;
      }
    },
    {
      message: 'Event ID contains invalid unicode characters',
    },
  );

/**
 * Cryptographic receipt token input (HS256 compact JWT string).
 */
export const spikeReceiptTokenSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((val) => val === val.trim(), {
    message: 'Receipt token must not have leading or trailing whitespace',
  });

/**
 * Request payload for POST /api/spike/calendar-sharing.
 * Strict discriminated union by action.
 */
export const spikeOperationRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('insertCalendar'),
    })
    .strict(),

  z
    .object({
      action: z.literal('insertAcl'),
      calendarId: spikeCalendarIdSchema,
      email: z.string().email().max(254),
      receipt: spikeReceiptTokenSchema,
    })
    .strict(),

  z
    .object({
      action: z.literal('deleteCalendar'),
      calendarId: spikeCalendarIdSchema,
      receipt: spikeReceiptTokenSchema,
    })
    .strict(),

  z
    .object({
      action: z.literal('insertCalendarList'),
      calendarId: spikeCalendarListIdSchema,
    })
    .strict(),

  z
    .object({
      action: z.literal('listEvents'),
      calendarId: spikeCalendarIdSchema,
    })
    .strict(),

  z
    .object({
      action: z.literal('insertEvent'),
      calendarId: spikeCalendarIdSchema,
    })
    .strict(),

  z
    .object({
      action: z.literal('deleteEvent'),
      calendarId: spikeCalendarIdSchema,
      eventId: spikeEventIdSchema,
      receipt: spikeReceiptTokenSchema,
    })
    .strict(),
]);

export type SpikeOperationRequest = z.infer<typeof spikeOperationRequestSchema>;

/**
 * Response for GET /api/spike/calendar-sharing.
 */
export const spikeMetadataResponseSchema = z
  .object({
    user: z.object({
      id: z.string().min(1),
      displayName: z.string().min(1),
    }),
  })
  .strict();

export type SpikeMetadataResponse = z.infer<typeof spikeMetadataResponseSchema>;

/**
 * Success response for POST /api/spike/calendar-sharing.
 * Action-discriminated to enforce contract requirements (e.g., receipt on creation).
 */
export const spikeOperationSuccessResponseSchema = z.discriminatedUnion('action', [
  z
    .object({
      ok: z.literal(true),
      action: z.literal('insertCalendar'),
      calendarId: z.string().min(1),
      receipt: z.string().min(1),
      googleStatus: z.number().int().nullable().optional(),
    })
    .strict(),

  z
    .object({
      ok: z.literal(true),
      action: z.literal('insertAcl'),
      calendarId: z.string().min(1),
      googleStatus: z.number().int().nullable().optional(),
    })
    .strict(),

  z
    .object({
      ok: z.literal(true),
      action: z.literal('deleteCalendar'),
      calendarId: z.string().min(1),
      googleStatus: z.number().int().nullable().optional(),
    })
    .strict(),

  z
    .object({
      ok: z.literal(true),
      action: z.literal('insertCalendarList'),
      calendarId: z.string().min(1),
      googleStatus: z.number().int().nullable().optional(),
    })
    .strict(),

  z
    .object({
      ok: z.literal(true),
      action: z.literal('listEvents'),
      calendarId: z.string().min(1),
      eventCount: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      googleStatus: z.number().int().nullable().optional(),
    })
    .strict(),

  z
    .object({
      ok: z.literal(true),
      action: z.literal('insertEvent'),
      calendarId: z.string().min(1),
      eventId: z.string().min(1),
      receipt: z.string().min(1),
      googleStatus: z.number().int().nullable().optional(),
    })
    .strict(),

  z
    .object({
      ok: z.literal(true),
      action: z.literal('deleteEvent'),
      calendarId: z.string().min(1),
      eventId: z.string().min(1),
      googleStatus: z.number().int().nullable().optional(),
    })
    .strict(),
]);

export type SpikeOperationSuccessResponse = z.infer<typeof spikeOperationSuccessResponseSchema>;

/**
 * Error response for POST /api/spike/calendar-sharing.
 */
export const spikeOperationErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    action: spikeActionSchema.optional(),
    error: z.string(),
    code: z.string(),
    reason: z.string().nullable().optional(),
    googleStatus: z.number().int().nullable(),
    outcome: z.enum(['uncertain', 'failed']).optional(),
  })
  .strict();

export type SpikeOperationErrorResponse = z.infer<typeof spikeOperationErrorResponseSchema>;

/**
 * Full response schema for POST /api/spike/calendar-sharing.
 */
export const spikeOperationResponseSchema = z.union([
  spikeOperationSuccessResponseSchema,
  spikeOperationErrorResponseSchema,
]);

export type SpikeOperationResponse = z.infer<typeof spikeOperationResponseSchema>;

/**
 * Signed Receipt JWT Payload schema (cryptographically verified with SESSION_SECRET).
 */
export const spikeReceiptPayloadSchema = z
  .object({
    iss: z.literal('danran-spike'),
    aud: z.literal('danran-spike-ops'),
    sub: z.string().min(1),
    kind: z.enum(['calendar', 'event']),
    calendarId: z.string().min(1),
    eventId: z.string().min(1).optional(),
    exp: z.number().int(),
    iat: z.number().int(),
  })
  .strict();

export type SpikeReceiptPayload = z.infer<typeof spikeReceiptPayloadSchema>;
