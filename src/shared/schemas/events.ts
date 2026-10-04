import { z } from 'zod';
import { dateKeySchema, isoInstantStringSchema } from './date';

const tokyoInstantSchema = isoInstantStringSchema.refine((value) => value.endsWith('+09:00'), {
  message: 'Event times must use the +09:00 offset',
});

const allDayTimeSchema = z
  .object({
    kind: z.literal('all-day'),
    start: dateKeySchema,
    endExclusive: dateKeySchema,
  })
  .strict();

const timedTimeSchema = z
  .object({
    kind: z.literal('timed'),
    start: tokyoInstantSchema,
    endExclusive: tokyoInstantSchema,
  })
  .strict();

export const eventInputTimeSchema = z
  .discriminatedUnion('kind', [allDayTimeSchema, timedTimeSchema])
  .superRefine((time, ctx) => {
    const valid =
      time.kind === 'all-day'
        ? time.start < time.endExclusive
        : Date.parse(time.start) < Date.parse(time.endExclusive);
    if (!valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endExclusive'],
        message: 'End must be after start',
      });
    }
  });

const commonInputShape = {
  title: z.string().trim().min(1).max(200),
  time: eventInputTimeSchema,
  memberIds: z.array(z.string().trim().min(1).max(200)).max(100),
  assigneeMemberId: z.string().trim().min(1).max(200).nullable(),
  items: z.array(z.string().trim().min(1).max(100)).max(20),
  status: z.enum(['confirmed', 'tentative']),
};

const validateEventInput = (value: { memberIds: string[] }, ctx: z.RefinementCtx) => {
  if ([...new Set(value.memberIds)].join(',').length > 1024) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['memberIds'],
      message: 'Member metadata is too long',
    });
  }
};

export const eventInputSchema = z.object(commonInputShape).strict().superRefine(validateEventInput);
export const createEventInputSchema = z
  .object({
    ...commonInputShape,
    clientRequestId: z.string().uuid(),
  })
  .strict()
  .superRefine(validateEventInput);

export const eventMutationResponseSchema = z.object({ eventId: z.string().min(1) }).strict();
export const eventDeleteResponseSchema = z.object({ ok: z.literal(true) }).strict();
export const eventErrorResponseSchema = z
  .object({
    error: z.string(),
    code: z.enum([
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'FAMILY_NOT_READY',
      'INVALID_INPUT',
      'RECURRING_EVENT_UNSUPPORTED',
      'REAUTH_REQUIRED',
      'CALENDAR_ACCESS_DENIED',
      'GOOGLE_TEMPORARY_ERROR',
      'GOOGLE_ERROR',
      'INTERNAL_ERROR',
    ]),
  })
  .strict();

export type EventErrorCode = z.infer<typeof eventErrorResponseSchema>['code'];

export type EventInput = z.infer<typeof eventInputSchema>;
export type CreateEventInput = z.infer<typeof createEventInputSchema>;
export type EventInputTime = z.infer<typeof eventInputTimeSchema>;
