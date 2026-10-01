import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
 * Family groups.
 * A family represents the core unit of shared scheduling.
 * `ownerUserId` is unique to enforce that a user can own at most one family at a time
 * and to prevent concurrent family creation races.
 * `familyCalendarId` is nullable and unique; it is set once the dedicated Google Calendar is created.
 * `creationStatus` records the lifecycle of family creation, preserving uncertainty
 * upon unexpected failures rather than blindly retrying calendar creation.
 */
export const families = sqliteTable('families', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull(),
  familyCalendarId: text('family_calendar_id').unique(),
  ownerUserId: text('owner_user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'restrict' }),
  dayStartHour: integer('day_start_hour', { mode: 'number' }).notNull().default(8),
  dayEndHour: integer('day_end_hour', { mode: 'number' }).notNull().default(20),
  creationStatus: text('creation_status', {
    enum: ['creating', 'ready', 'uncertain', 'failed'],
  })
    .notNull()
    .default('creating'),
  calendarCreationId: text('calendar_creation_id')
    .notNull()
    .default(sql`(lower(hex(randomblob(16))))`),
  createdAt: integer('created_at', { mode: 'number' }).notNull().default(sql`(unixepoch())`),
});

export type Family = typeof families.$inferSelect;
export type NewFamily = typeof families.$inferInsert;
export type FamilyRecord = Family;
export type NewFamilyRecord = NewFamily;

/**
 * Family members (adults with Google accounts or children without).
 * An adult member must have a non-null userId referencing users.id (unique per adult in initial version).
 * A child member must have a null userId.
 */
export const members = sqliteTable(
  'members',
  {
    id: text('id').primaryKey().notNull(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: ['adult', 'child'] }).notNull(),
    name: text('name').notNull(),
    color: text('color', {
      enum: ['indigo', 'green', 'ochre', 'purple', 'coral', 'teal', 'rose', 'slate'],
    }).notNull(),
    sortOrder: integer('sort_order', { mode: 'number' }).notNull().default(0),
    status: text('status', { enum: ['pending', 'active'] })
      .notNull()
      .default('active'),
  },
  (table) => [
    index('members_family_id_idx').on(table.familyId),
    index('members_family_id_sort_order_idx').on(table.familyId, table.sortOrder),
    index('members_status_idx').on(table.status),
    check(
      'members_user_id_kind_check',
      sql`(kind = 'adult' AND user_id IS NOT NULL) OR (kind = 'child' AND user_id IS NULL)`,
    ),
    check(
      'members_color_check',
      sql`color IN ('indigo', 'green', 'ochre', 'purple', 'coral', 'teal', 'rose', 'slate')`,
    ),
  ],
);

export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;
export type MemberRecord = Member;
export type NewMemberRecord = NewMember;

/**
 * Family invitations.
 * One-use bearer token (256-bit URL-safe), stored only as SHA-256 token_hash.
 * Token expires in 7 days.
 * Status lifecycle: available -> claiming -> (uncertain) -> used.
 * When claiming, claimed_user_id is bound so concurrent or replay claims cannot steal the invite,
 * even if Google ACL grant results in an uncertain network state.
 */
export const invites = sqliteTable(
  'invites',
  {
    id: text('id').primaryKey().notNull(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
    usedAt: integer('used_at', { mode: 'number' }),
    claimedUserId: text('claimed_user_id').references(() => users.id, { onDelete: 'restrict' }),
    status: text('status', {
      enum: ['available', 'claiming', 'uncertain', 'used'],
    })
      .notNull()
      .default('available'),
    createdAt: integer('created_at', { mode: 'number' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('invites_family_id_idx').on(table.familyId),
    index('invites_claimed_user_id_idx').on(table.claimedUserId),
    index('invites_status_idx').on(table.status),
  ],
);

export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
export type InviteRecord = Invite;
export type NewInviteRecord = NewInvite;

/**
 * Nursery/school closure days and custom family holidays.
 * An empty memberIds array signifies a family-wide closure; a non-empty array targets specific members.
 */
export const closureDays = sqliteTable(
  'closure_days',
  {
    id: text('id').primaryKey().notNull(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    label: text('label').notNull(),
    memberIds: text('member_ids', { mode: 'json' }).$type<string[]>().notNull(),
  },
  (table) => [index('closure_days_family_id_date_idx').on(table.familyId, table.date)],
);

export type ClosureDayRecord = typeof closureDays.$inferSelect;
export type NewClosureDayRecord = typeof closureDays.$inferInsert;
