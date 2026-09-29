import { z } from 'zod';

/**
 * Validates a canonical calendar date key in YYYY-MM-DD format.
 * Uses Zod's built-in date validator to ensure real calendar dates (e.g., rejecting Feb 30 or Feb 29 on non-leap years).
 */
export const dateKeySchema = z.string().date();

export type DateKey = z.infer<typeof dateKeySchema>;

/**
 * Validates an ISO 8601 instant string with explicit timezone (offset or 'Z').
 * Timezone-less strings (e.g., "2026-10-05T00:00:00") and invalid offset ranges (e.g. "+99:99") are rejected.
 */
export const isoInstantStringSchema = z
  .string()
  .datetime({ offset: true })
  .refine(
    (val) => {
      const datePart = val.slice(0, 10);
      if (!dateKeySchema.safeParse(datePart).success) {
        return false;
      }
      const timestamp = Date.parse(val);
      if (!Number.isFinite(timestamp)) {
        return false;
      }
      const offsetMatch = val.match(/([+-])(\d{2}):(\d{2})$/);
      if (offsetMatch) {
        const hours = Number(offsetMatch[2]);
        const minutes = Number(offsetMatch[3]);
        if (hours > 23 || minutes >= 60) {
          return false;
        }
      }
      return true;
    },
    { message: 'Invalid ISO instant timestamp or timezone offset' },
  );

export type IsoInstantString = z.infer<typeof isoInstantStringSchema>;
