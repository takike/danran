import { z } from 'zod';
import { weekEventTimeSchema, weekResponseSchema } from './week';

export const personalCalendarSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    isPrimary: z.boolean(),
    selected: z.boolean(),
  })
  .strict();
export type PersonalCalendar = z.infer<typeof personalCalendarSchema>;

const personalCalendarListReadySchema = z
  .object({
    status: z.literal('ready'),
    memberId: z.string().min(1),
    hasSavedSelection: z.boolean(),
    calendars: z.array(personalCalendarSchema),
  })
  .strict();

export const personalCalendarListResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('authorization_required'),
      memberId: z.string().min(1),
      calendars: z.array(personalCalendarSchema).length(0),
    })
    .strict(),
  personalCalendarListReadySchema,
]);
export type PersonalCalendarListResponse = z.infer<typeof personalCalendarListResponseSchema>;

export const updatePersonalCalendarsInputSchema = z
  .object({
    calendarIds: z
      .array(
        z
          .string()
          .min(1)
          .max(1024)
          .refine((id) => id === id.trim() && id !== '.' && id !== '..'),
      )
      .max(10)
      .refine((ids) => new Set(ids).size === ids.length, 'Calendar IDs must be unique'),
  })
  .strict();
export type UpdatePersonalCalendarsInput = z.infer<typeof updatePersonalCalendarsInputSchema>;

export const updatePersonalCalendarsResponseSchema = z.discriminatedUnion('authorizationRequired', [
  z.object({ authorizationRequired: z.literal(true), authorizationUrl: z.string().url() }).strict(),
  z
    .object({
      authorizationRequired: z.literal(false),
      status: z.literal('ready'),
      memberId: z.string().min(1),
      hasSavedSelection: z.boolean(),
      calendars: z.array(personalCalendarSchema),
    })
    .strict(),
]);
export type UpdatePersonalCalendarsResponse = z.infer<typeof updatePersonalCalendarsResponseSchema>;

export const personalEventSchema = z
  .object({
    id: z.string().min(1),
    calendarId: z.string().min(1),
    title: z.string(),
    time: weekEventTimeSchema,
    isRoutine: z.boolean(),
  })
  .strict();
export type PersonalEvent = z.infer<typeof personalEventSchema>;

export const personalWeekResponseSchema = z
  .object({
    family: z.object({ id: z.string().min(1) }).strict(),
    memberId: z.string().min(1),
    week: weekResponseSchema.shape.week,
    status: z.enum(['authorization_required', 'unselected', 'ready']),
    events: z.array(personalEventSchema),
  })
  .strict();
export type PersonalWeekResponse = z.infer<typeof personalWeekResponseSchema>;

export const personalEventsErrorResponseSchema = z
  .object({
    error: z.string(),
    code: z.enum([
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'INVALID_INPUT',
      'REAUTH_REQUIRED',
      'CALENDAR_ACCESS_DENIED',
      'GOOGLE_TEMPORARY_ERROR',
      'GOOGLE_ERROR',
      'INTERNAL_ERROR',
      'CALENDAR_PAGE_LIMIT',
    ]),
  })
  .strict();
export type PersonalEventsErrorResponse = z.infer<typeof personalEventsErrorResponseSchema>;
