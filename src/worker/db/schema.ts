import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Initial database scaffold containing the foundational users table for authentication/sessions.
 * Subsequent domain tables will be added incrementally alongside their owning tasks.
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey().notNull(),
  googleSub: text('google_sub').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at', { mode: 'number' }).notNull().default(sql`(unixepoch())`),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
