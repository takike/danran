import { z } from 'zod';
import { dateKeySchema } from './date';

export const weekdayCodeSchema = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
export type WeekdayCode = z.infer<typeof weekdayCodeSchema>;

export const routineCategorySchema = z.enum(['lesson', 'housework', 'other']);
export const routineIntervalSchema = z.union([z.literal(1), z.literal(2)]);
const clockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

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
    status: z.enum(['ready', 'missing', 'unsupported']),
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
