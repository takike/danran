import { z } from 'zod';
import { dateKeySchema } from './date';

/**
 * Validates opaque system identifiers (id, familyId, memberId).
 * Rejects leading/trailing whitespace without silent rewriting.
 */
const opaqueIdSchema = z
  .string()
  .min(1)
  .refine((val) => val === val.trim() && val.length > 0, {
    message: 'Identifier must not contain leading or trailing whitespace',
  });

/**
 * Shared member IDs array schema with uniqueness validation.
 */
const baseMemberIdsSchema = z
  .array(opaqueIdSchema)
  .refine((items) => new Set(items).size === items.length, {
    message: 'Duplicate memberIds are not allowed',
  });

/**
 * Validates a stored closure day record (e.g. daycare closure, school holiday).
 * Requires memberIds explicitly so stored data never silently broadens to family-wide.
 * An empty memberIds array signifies a family-wide closure;
 * a non-empty array targets only the specified members.
 */
export const closureDaySchema = z.object({
  id: opaqueIdSchema,
  familyId: opaqueIdSchema,
  date: dateKeySchema,
  label: z.string().trim().min(1),
  memberIds: baseMemberIdsSchema,
});

export type ClosureDay = z.infer<typeof closureDaySchema>;

/**
 * Validates inputs for creating a new closure day.
 * Rejects unknown fields (.strict()) and permits omitting memberIds (defaults to family-wide []).
 */
export const createClosureDaySchema = z
  .object({
    id: opaqueIdSchema.optional(),
    familyId: opaqueIdSchema,
    date: dateKeySchema,
    label: z.string().trim().min(1),
    memberIds: baseMemberIdsSchema.default([]),
  })
  .strict();

export type CreateClosureDay = z.input<typeof createClosureDaySchema>;
export type CreateClosureDayParsed = z.output<typeof createClosureDaySchema>;
