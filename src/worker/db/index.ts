import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

/**
 * Creates a typed Drizzle ORM client for Cloudflare D1.
 * Kept server-side only; no public dummy database HTTP endpoint is exposed.
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Database = ReturnType<typeof createDb>;
export * from './schema';
