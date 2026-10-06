import { parseIsoInstantMilliseconds } from '@shared/time/interval';
import { z } from 'zod';
import { dateKeySchema, isoInstantStringSchema } from './date';

export const weekdayCodeSchema = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
export type WeekdayCode = z.infer<typeof weekdayCodeSchema>;

export const routineCategorySchema = z.enum(['lesson', 'housework', 'other']);
export const routineIntervalSchema = z.union([z.literal(1), z.literal(2)]);
const clockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const routineInstanceStatusSchema = z.enum(['normal', 'skipped', 'moved']);
export type RoutineInstanceStatus = z.infer<typeof routineInstanceStatusSchema>;
export const routineAutoSkipReasonSchema = z.enum(['holiday', 'new_year']).nullable();
export const routineInstanceSchema = z
  .object({
    id: z.string().min(1),
    originalStart: isoInstantStringSchema,
    originalEnd: isoInstantStringSchema,
    start: isoInstantStringSchema.nullable(),
    end: isoInstantStringSchema.nullable(),
    status: routineInstanceStatusSchema,
    autoSkipReason: routineAutoSkipReasonSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const timestamps = [value.originalStart, value.originalEnd, value.start, value.end].filter(
      (timestamp): timestamp is string => timestamp !== null,
    );
    if (timestamps.some((timestamp) => !isoInstantStringSchema.safeParse(timestamp).success))
      return;
    if (
      parseIsoInstantMilliseconds(value.originalStart) >=
      parseIsoInstantMilliseconds(value.originalEnd)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['originalEnd'],
        message: 'End must follow start',
      });
    }
    if (value.status === 'skipped') {
      if (value.start !== null || value.end !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['start'],
          message: 'Skipped instances have no actual times',
        });
      }
      return;
    }
    if (value.start === null || value.end === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['start'],
        message: 'Active instances need actual times',
      });
      return;
    }
    const originalStart = parseIsoInstantMilliseconds(value.originalStart);
    const originalEnd = parseIsoInstantMilliseconds(value.originalEnd);
    const start = parseIsoInstantMilliseconds(value.start);
    const end = parseIsoInstantMilliseconds(value.end);
    if (start >= end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end'],
        message: 'End must follow start',
      });
    }
    if (value.status === 'normal' && (start !== originalStart || end !== originalEnd)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'Normal instances keep original times',
      });
    }
    if (value.status === 'moved' && start === originalStart && end === originalEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'Moved instances change their times',
      });
    }
  });
export type RoutineInstance = z.infer<typeof routineInstanceSchema>;

export const routineUpcomingSchema = z
  .object({
    status: z.enum(['ready', 'unavailable']),
    instances: z.array(routineInstanceSchema).max(4),
  })
  .strict();
export type RoutineUpcoming = z.infer<typeof routineUpcomingSchema>;

const routineMoveInputSchema = z
  .object({
    date: dateKeySchema,
    startTime: clockTimeSchema,
    endTime: clockTimeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const year = Number(value.date.slice(0, 4));
    if (year < 1970 || year > 2050) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['date'],
        message: 'Move date must be between 1970 and 2050',
      });
    }
    if (value.endTime <= value.startTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endTime'],
        message: 'End must follow start',
      });
    }
  });
export { routineMoveInputSchema };
export type RoutineMoveInput = z.infer<typeof routineMoveInputSchema>;

export const routineInstanceMutationResponseSchema = z
  .object({ instance: routineInstanceSchema })
  .strict();
export const routineInstanceActionInputSchema = z.object({}).strict();

export const routineSettingsInputSchema = z
  .object({ skipHolidays: z.boolean(), skipNewYear: z.boolean() })
  .strict();
export type RoutineSettingsInput = z.infer<typeof routineSettingsInputSchema>;

export const routineAutoSkipResponseSchema = z
  .object({ skipHolidays: z.boolean(), skipNewYear: z.boolean(), hasMore: z.boolean() })
  .strict();

export const routineInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    weekdays: z.array(weekdayCodeSchema).min(1).max(7),
    interval: routineIntervalSchema,
    startDate: dateKeySchema,
    startTime: clockTimeSchema,
    endTime: clockTimeSchema,
    endDate: dateKeySchema.nullable().default(null),
    memberIds: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
    assigneeMemberId: z.string().trim().min(1).max(200).nullable().default(null),
    category: routineCategorySchema,
    affectsAvailability: z.boolean().default(true),
    clientRequestId: z.string().uuid(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.weekdays).size !== value.weekdays.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weekdays'],
        message: 'Duplicate weekday',
      });
    }
    if (value.endTime <= value.startTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endTime'],
        message: 'End must follow start',
      });
    }
    if (value.endDate !== null && value.endDate < value.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'End date precedes start',
      });
    }
    if ([...new Set(value.memberIds)].join(',').length > 1024) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['memberIds'],
        message: 'Member metadata is too long',
      });
    }
  });

export type RoutineInput = z.infer<typeof routineInputSchema>;
export const createRoutineInputSchema = routineInputSchema;

export const routineCreateResponseSchema = z
  .object({ routineId: z.string().min(1), eventId: z.string().min(1) })
  .strict();
export const routineMutationResponseSchema = routineCreateResponseSchema;
export const routineDeleteResponseSchema = z.object({ ok: z.literal(true) }).strict();

export const routineSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().nullable(),
    weekdays: z.array(weekdayCodeSchema),
    interval: routineIntervalSchema.nullable(),
    startDate: dateKeySchema.nullable(),
    endDate: dateKeySchema.nullable(),
    startTime: clockTimeSchema.nullable(),
    endTime: clockTimeSchema.nullable(),
    memberIds: z.array(z.string()),
    assigneeMemberId: z.string().nullable(),
    category: routineCategorySchema,
    affectsAvailability: z.boolean(),
    skipHolidays: z.boolean(),
    skipNewYear: z.boolean(),
    autoSkipDue: z.boolean(),
    status: z.enum(['ready', 'missing', 'unsupported']),
    upcoming: routineUpcomingSchema,
  })
  .strict();

export type Routine = z.infer<typeof routineSchema>;
export const routineListResponseSchema = z.object({ routines: z.array(routineSchema) }).strict();

export const routineErrorResponseSchema = z
  .object({
    error: z.string(),
    code: z.enum([
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'FAMILY_NOT_READY',
      'INVALID_INPUT',
      'REAUTH_REQUIRED',
      'CALENDAR_ACCESS_DENIED',
      'GOOGLE_TEMPORARY_ERROR',
      'GOOGLE_ERROR',
      'INTERNAL_ERROR',
    ]),
  })
  .strict();
