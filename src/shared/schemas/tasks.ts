import { z } from 'zod';
import { dateKeySchema, isoInstantStringSchema } from './date';
import { weekEventTimeSchema } from './week';

export const taskSourceSchema = z.enum(['import', 'items', 'conflict', 'manual']);

const dateDueSchema = z.object({ kind: z.literal('date'), dueAt: dateKeySchema }).strict();
const datetimeDueSchema = z
  .object({ kind: z.literal('datetime'), dueAt: isoInstantStringSchema })
  .strict();
const noDueSchema = z.object({ kind: z.literal('none') }).strict();

export const taskDueInputSchema = z.discriminatedUnion('kind', [
  dateDueSchema,
  datetimeDueSchema,
  noDueSchema,
]);

const taskDueSchema = z.discriminatedUnion('kind', [
  dateDueSchema,
  datetimeDueSchema,
  noDueSchema,
  z.object({ kind: z.literal('unknown') }).strict(),
]);

export const manualTaskCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    due: taskDueInputSchema,
    assigneeMemberId: z.string().trim().min(1).max(200).nullable(),
    eventId: z.string().trim().min(1).max(200).nullable().optional(),
    clientRequestId: z.string().uuid(),
  })
  .strict();
export type ManualTaskCreate = z.infer<typeof manualTaskCreateSchema>;

export const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    due: taskDueInputSchema.optional(),
    assigneeMemberId: z.string().trim().min(1).max(200).nullable().optional(),
    done: z.boolean().optional(),
    eventId: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export type TaskPatch = z.infer<typeof taskPatchSchema>;

const linkedEventNoneSchema = z.object({ state: z.literal('none') }).strict();
const linkedEventLookupSchema = z
  .object({ state: z.enum(['missing', 'unavailable']), eventId: z.string().min(1) })
  .strict();
const linkedEventReadySchema = z
  .object({
    state: z.literal('ready'),
    eventId: z.string().min(1),
    title: z.string(),
    time: weekEventTimeSchema,
    memberIds: z.array(z.string().min(1)),
    items: z.array(z.string()),
  })
  .strict();

export const linkedTaskEventSchema = z.discriminatedUnion('state', [
  linkedEventNoneSchema,
  linkedEventLookupSchema,
  linkedEventReadySchema,
]);

export const taskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    due: taskDueSchema,
    doneAt: z.number().int().nullable(),
    assigneeMemberId: z.string().min(1).nullable(),
    source: taskSourceSchema,
    linkedEvent: linkedTaskEventSchema,
  })
  .strict();
export type Task = z.infer<typeof taskSchema>;

export const taskListResponseSchema = z.object({ tasks: z.array(taskSchema) }).strict();
export const taskMutationResponseSchema = z.object({ task: taskSchema }).strict();
export const taskDeleteResponseSchema = z.object({ ok: z.literal(true) }).strict();

export const taskErrorResponseSchema = z
  .object({
    error: z.string(),
    code: z.enum([
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'FAMILY_NOT_READY',
      'INVALID_INPUT',
      'AUTO_TASK_IMMUTABLE',
      'RECURRING_EVENT_UNSUPPORTED',
      'REAUTH_REQUIRED',
      'CALENDAR_ACCESS_DENIED',
      'GOOGLE_TEMPORARY_ERROR',
      'GOOGLE_ERROR',
      'INTERNAL_ERROR',
    ]),
  })
  .strict();

export type TaskErrorResponse = z.infer<typeof taskErrorResponseSchema>;
