import { z } from 'zod';
import { dateKeySchema, isoInstantStringSchema } from './date';

const supportedDateKeySchema = dateKeySchema.refine((date) => {
  const year = Number(date.slice(0, 4));
  return year >= 1970 && year <= 2050;
}, 'Date year must be between 1970 and 2050');

const tokyoInstantSchema = isoInstantStringSchema.refine((value) => value.endsWith('+09:00'), {
  message: 'Busy interval times must use the +09:00 offset',
});

export const busyIntervalSchema = z
  .object({
    start: tokyoInstantSchema,
    end: tokyoInstantSchema,
  })
  .strict()
  .superRefine((interval, ctx) => {
    if (Date.parse(interval.start) >= Date.parse(interval.end)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end'],
        message: 'Busy interval end must follow start',
      });
    }
  });

export const busyWeekMemberSchema = z
  .object({
    memberId: z.string().min(1),
    status: z.enum(['ready', 'not_shared', 'unavailable']),
    busy: z.array(busyIntervalSchema),
  })
  .strict()
  .superRefine((member, ctx) => {
    if (member.status !== 'ready' && member.busy.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['busy'],
        message: 'Busy intervals must be empty unless status is ready',
      });
    }
  });

export const busyWeekResponseSchema = z
  .object({
    family: z.object({ id: z.string().min(1) }).strict(),
    week: z
      .object({
        start: supportedDateKeySchema,
        endInclusive: supportedDateKeySchema,
        prevWeekStart: dateKeySchema,
        nextWeekStart: dateKeySchema,
        today: dateKeySchema,
      })
      .strict(),
    members: z.array(busyWeekMemberSchema),
  })
  .strict();

export type BusyWeekResponse = z.infer<typeof busyWeekResponseSchema>;

export const busyWeekErrorResponseSchema = z
  .object({
    error: z.string(),
    code: z.enum(['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'INVALID_INPUT', 'INTERNAL_ERROR']),
  })
  .strict();

export type BusyWeekErrorResponse = z.infer<typeof busyWeekErrorResponseSchema>;
