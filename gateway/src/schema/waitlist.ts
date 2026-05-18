import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

// `waitlist` is the user identity table.
//
// Flow:
//   1. Public signup → row with status='pending', email_verified_at=null.
//   2. Verification link → email_verified_at set.
//   3. Admin approves → status='approved', api_keys row issued + key
//      delivered by email.
//
// In v1, we don't carry a separate `users` table (no
// Stripe / no per-person Stripe customer to hang off of). If billing
// lands later, add a sibling `users` row keyed to this id.

export const waitlist = pgTable(
  'waitlist',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    email: text('email').notNull(),
    ipHash: text('ip_hash'),

    // Verification — tokens are stored as SHA-256(token + IP_HASH_PEPPER).
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    verificationTokenHash: text('verification_token_hash'),
    verificationTokenExpiresAt: timestamp('verification_token_expires_at', {
      withTimezone: true,
    }),

    // Approval lifecycle.
    status: text('status').notNull().default('pending'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: text('approved_by'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    emailIdx: uniqueIndex('idx_waitlist_email').on(t.email),
    statusIdx: index('idx_waitlist_status').on(t.status),
    verificationTokenIdx: uniqueIndex('idx_waitlist_verification_token').on(
      t.verificationTokenHash,
    ),
    createdAtIdx: index('idx_waitlist_created_at').on(t.createdAt),
    statusCheck: check(
      'waitlist_status_check',
      sql`${t.status} IN ('pending', 'approved', 'rejected')`,
    ),
  }),
);

export type Waitlist = typeof waitlist.$inferSelect;
export type NewWaitlist = typeof waitlist.$inferInsert;
