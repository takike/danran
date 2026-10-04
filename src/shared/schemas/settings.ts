import { z } from 'zod';
import { closureDaySchema } from './closure';
import { dateKeySchema } from './date';
import { memberColorSchema, memberNameSchema } from './family';

const supportedDateKeySchema = dateKeySchema.refine((date) => {
  const year = Number(date.slice(0, 4));
  return year >= 1970 && year <= 2050;
}, 'Date must be between 1970 and 2050');

export const updateMemberInputSchema = z
  .object({ name: memberNameSchema, color: memberColorSchema })
  .strict();
export type UpdateMemberInput = z.infer<typeof updateMemberInputSchema>;

export const createClosureRangeInputSchema = z
  .object({
    startDate: supportedDateKeySchema,
    endDate: supportedDateKeySchema.optional(),
    label: z.string().trim().min(1).max(40),
    memberIds: z
      .array(
        z
          .string()
          .min(1)
          .refine((id) => id === id.trim()),
      )
      .max(100),
  })
  .strict();
export type CreateClosureRangeInput = z.infer<typeof createClosureRangeInputSchema>;

export const settingsClosuresResponseSchema = z
  .object({ closures: z.array(closureDaySchema), hasMore: z.boolean() })
  .strict();
export type SettingsClosuresResponse = z.infer<typeof settingsClosuresResponseSchema>;

export const createClosureRangeResponseSchema = z
  .object({ closures: z.array(closureDaySchema) })
  .strict();
export type CreateClosureRangeResponse = z.infer<typeof createClosureRangeResponseSchema>;

export const deleteClosureResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type DeleteClosureResponse = z.infer<typeof deleteClosureResponseSchema>;
