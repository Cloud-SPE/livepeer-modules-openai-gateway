import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

import { apiKeys } from './apiKeys.js';

// Cookie sessions for the portal UI. Sessions are tied to an api_key —
// to log in, the user proves possession of an API key, and a session is
// minted with its own opaque token (separate from the key).
//
// `session_hash` is SHA-256(session_token + IP_HASH_PEPPER).
//
// /v1/* never accepts a session cookie. /portal/* never accepts a Bearer
// API key. The two presentation surfaces don't cross.

export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    sessionHash: text('session_hash').notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    activeHashIdx: index('idx_user_sessions_active_hash')
      .on(t.sessionHash)
      .where(sql`${t.revokedAt} IS NULL`),
    apiKeyIdx: index('idx_user_sessions_api_key').on(t.apiKeyId),
  }),
);

export type UserSession = typeof userSessions.$inferSelect;
export type NewUserSession = typeof userSessions.$inferInsert;
