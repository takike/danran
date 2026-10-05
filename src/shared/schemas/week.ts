import { z } from 'zod';
import { dateKeySchema, isoInstantStringSchema } from './date';
import { memberColorSchema, memberKindSchema } from './family';

const supportedDateKeySchema = dateKeySchema.refine((date) => {
  const year = Number(date.slice(0, 4));
  return year >= 1970 && year <= 2050;
}, 'Date year must be between 1970 and 2050');

const tokyoInstantSchema = isoInstantStringSchema.refine((value) => value.endsWith('+09:00'), {
  message: 'Week event times must use the +09:00 offset',
});

export const eventItemsSchema = z.array(z.string());

const allDayEventTimeSchema = z
  .object({
    kind: z.literal('all-day'),
    start: dateKeySchema,
    endExclusive: dateKeySchema,
  })
  .strict();

const timedEventTimeSchema = z
  .object({
    kind: z.literal('timed'),
    start: tokyoInstantSchema,
    endExclusive: tokyoInstantSchema,
  })
  .strict();

export const weekEventTimeSchema = z
  .discriminatedUnion('kind', [allDayEventTimeSchema, timedEventTimeSchema])
  .superRefine((value, ctx) => {
    const startsBeforeEnd =
      value.kind === 'all-day'
        ? value.start < value.endExclusive
        : Date.parse(value.start) < Date.parse(value.endExclusive);
    if (!startsBeforeEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endExclusive'],
        message: 'Event end must be after start',
      });
    }
  });

export const weekEventSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    time: weekEventTimeSchema,
    memberIds: z.array(z.string().min(1)),
    assigneeMemberId: z.string().min(1).nullable(),
    status: z.enum(['confirmed', 'tentative']),
    isRecurring: z.boolean(),
    isRoutine: z.boolean(),
    movedFrom: tokyoInstantSchema.nullable(),
    affectsAvailability: z.boolean(),
    source: z.enum(['manual', 'import', 'publish', 'external']),
    items: eventItemsSchema,
  })
  .strict();

export type WeekEvent = z.infer<typeof weekEventSchema>;

export const weekClosureSchema = z
  .object({
    label: z.string(),
    memberIds: z.array(z.string().min(1)),
  })
  .strict();

export const weekDaySchema = z
  .object({
    date: dateKeySchema,
    weekday: z.number().int().min(0).max(6),
    holidayName: z.string().nullable(),
    closures: z.array(weekClosureSchema),
    layout: z.enum(['weekend-card', 'expanded', 'compact']),
    eventIds: z.array(z.string().min(1)),
  })
  .strict();

export type WeekDay = z.infer<typeof weekDaySchema>;

export const weekMemberSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    color: memberColorSchema,
    kind: memberKindSchema,
    sortOrder: z.number().int(),
  })
  .strict();

export const weekResponseSchema = z
  .object({
    family: z
      .object({
        id: z.string().min(1),
        name: z.string(),
      })
      .strict(),
    members: z.array(weekMemberSchema),
    week: z
      .object({
        start: dateKeySchema,
        endInclusive: dateKeySchema,
        prevWeekStart: dateKeySchema,
        nextWeekStart: dateKeySchema,
        today: dateKeySchema,
      })
      .strict(),
    days: z.array(weekDaySchema),
    events: z.array(weekEventSchema),
  })
  .strict();

export type WeekResponse = z.infer<typeof weekResponseSchema>;

export const weekErrorResponseSchema = z
  .object({
    error: z.string(),
    code: z.enum([
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'INVALID_INPUT',
      'FAMILY_NOT_READY',
      'REAUTH_REQUIRED',
      'CALENDAR_ACCESS_DENIED',
      'GOOGLE_TEMPORARY_ERROR',
      'GOOGLE_ERROR',
      'INTERNAL_ERROR',
      'CALENDAR_PAGE_LIMIT',
    ]),
  })
  .strict();

export type WeekErrorResponse = z.infer<typeof weekErrorResponseSchema>;

export const weekQuerySchema = z
  .object({
    start: supportedDateKeySchema.optional(),
  })
  .strict();
