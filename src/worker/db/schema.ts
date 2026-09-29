import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

/**
 * Transient storage for OAuth authorization flows.
 * Enables single-use atomic consumption of PKCE code verifier and nonce,
 * bound cryptographically to the user's browser via signed cookie binding hash.
 */
export const oauthStates = sqliteTable('oauth_states', {
  stateHash: text('state_hash').primaryKey().notNull(),
  browserBindingHash: text('browser_binding_hash').notNull(),
  payloadEnc: text('payload_enc').notNull(),
  expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
  createdAt: integer('created_at', { mode: 'number' }).notNull().default(sql`(unixepoch())`),
});

export type OAuthState = typeof oauthStates.$inferSelect;
export type NewOAuthState = typeof oauthStates.$inferInsert;

/**
 * Persistent application sessions.
 * The primary key `id` stores the SHA-256 hash of the 256-bit raw session token.
 * The raw token is stored HMAC-signed in an HttpOnly cookie, never in plaintext in the DB.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

/**
 * Encrypted Google OAuth refresh tokens and granted scopes.
 * Refresh tokens are encrypted with AES-256-GCM at rest using TOKEN_ENC_KEY with AAD binding.
 * Scopes are stored as canonical space-separated string.
 */
export const googleTokens = sqliteTable('google_tokens', {
  userId: text('user_id')
    .primaryKey()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  refreshTokenEnc: text('refresh_token_enc').notNull(),
  scopes: text('scopes').notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull().default(sql`(unixepoch())`),
});

export type GoogleToken = typeof googleTokens.$inferSelect;
export type NewGoogleToken = typeof googleTokens.$inferInsert;

/**
 * Nursery/school closure days and custom family holidays.
 * Note: family_id is stored as a logical reference without a foreign key constraint
 * because the families table is owned and created by Task 1-4. When Task 1-4 introduces
 * the families table, a foreign key constraint will be added in a new migration.
 * An empty memberIds array signifies a family-wide closure; a non-empty array targets specific members.
 */
export const closureDays = sqliteTable(
  'closure_days',
  {
    id: text('id').primaryKey().notNull(),
    familyId: text('family_id').notNull(),
    date: text('date').notNull(),
    label: text('label').notNull(),
    memberIds: text('member_ids', { mode: 'json' }).$type<string[]>().notNull(),
  },
  (table) => [index('closure_days_family_id_date_idx').on(table.familyId, table.date)],
);

export type ClosureDayRecord = typeof closureDays.$inferSelect;
export type NewClosureDayRecord = typeof closureDays.$inferInsert;
