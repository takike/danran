import { z } from 'zod';

export const busyCalendarSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    isPrimary: z.boolean(),
    selected: z.boolean(),
  })
  .strict();
export type BusyCalendar = z.infer<typeof busyCalendarSchema>;

const busyCalendarListReadySchema = z
  .object({
    status: z.literal('ready'),
    memberId: z.string().min(1),
    hasSavedSelection: z.boolean(),
    calendars: z.array(busyCalendarSchema),
  })
  .strict();

export const busyCalendarListResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('authorization_required'),
      memberId: z.string().min(1),
      calendars: z.array(busyCalendarSchema).length(0),
    })
    .strict(),
  busyCalendarListReadySchema,
]);
export type BusyCalendarListResponse = z.infer<typeof busyCalendarListResponseSchema>;

export const updateBusyCalendarsInputSchema = z
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
export type UpdateBusyCalendarsInput = z.infer<typeof updateBusyCalendarsInputSchema>;

export const updateBusyCalendarsResponseSchema = z.discriminatedUnion('authorizationRequired', [
  z.object({ authorizationRequired: z.literal(true), authorizationUrl: z.string().url() }).strict(),
  z
    .object({
      authorizationRequired: z.literal(false),
      status: z.literal('ready'),
      memberId: z.string().min(1),
      hasSavedSelection: z.boolean(),
      calendars: z.array(busyCalendarSchema),
    })
    .strict(),
]);
export type UpdateBusyCalendarsResponse = z.infer<typeof updateBusyCalendarsResponseSchema>;

export const busyCalendarsErrorResponseSchema = z
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
export type BusyCalendarsErrorResponse = z.infer<typeof busyCalendarsErrorResponseSchema>;
