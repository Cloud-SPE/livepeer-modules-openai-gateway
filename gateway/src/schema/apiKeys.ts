import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

import { waitlist } from './waitlist.js';

// One row per API key. A waitlist row can have many keys (revoke + reissue
// without losing identity). Lookups by hash; the prefix is shown to the user.
//
// `key_hash` is SHA-256(key + API_KEY_HASH_PEPPER). The plaintext key is
// shown to the user exactly once at issuance and never stored.

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    waitlistId: uuid('waitlist_id')
      .notNull()
      .references(() => waitlist.id, { onDelete: 'cascade' }),
    label: text('label'),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    hashIdx: index('idx_api_keys_hash').on(t.keyHash),
    waitlistIdx: index('idx_api_keys_waitlist').on(t.waitlistId),
  }),
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
