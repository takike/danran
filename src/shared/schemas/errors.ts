import { z } from 'zod';

export const apiErrorResponseSchema = z.object({
  error: z.string(),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
