import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  numeric,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

import { apiKeys } from './apiKeys.js';

// One row per /v1/* proxy request. Mirrors the same reservation model
// even though v1 has no billing — the state machine stays for forward
// compatibility (and so the admin UI can show ok/error/refunded outcomes).
//
// While billing is off: success → state='committed'; broker failure →
// state='refunded'. reserved == committed == observed usage; no math.

export const usageReservations = pgTable(
  'usage_reservations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),

    // Stable per-request idempotency key + log correlation handle.
    workId: uuid('work_id').notNull(),

    capability: text('capability').notNull(),
    model: text('model').notNull(),
    brokerUrl: text('broker_url'),
    ethAddress: text('eth_address'),
    selectedCapability: text('selected_capability'),
    selectedOffering: text('selected_offering'),
    selectedWorkUnit: text('selected_work_unit'),
    unitsPerPrice: bigint('units_per_price', { mode: 'number' }),
    quoteId: text('quote_id'),
    quoteVersion: text('quote_version'),
    constraintFingerprintHex: text('constraint_fingerprint_hex'),
    routeFingerprintHex: text('route_fingerprint_hex'),

    state: text('state').notNull().default('open'),

    // "work units" = tokens for chat/embeddings, seconds for transcription,
    // image count for image generation, characters for speech.
    estimatedWorkUnits: bigint('estimated_work_units', { mode: 'number' }),
    committedWorkUnits: bigint('committed_work_units', { mode: 'number' }),

    pricePerWorkUnitWei: numeric('price_per_work_unit_wei', {
      precision: 78,
      scale: 0,
    }),

    latencyMs: integer('latency_ms'),
    statusCode: integer('status_code'),
    errorText: text('error_text'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => ({
    workIdIdx: uniqueIndex('idx_usage_reservations_work_id').on(t.workId),
    apiKeyCreatedIdx: index('idx_usage_reservations_api_key_created').on(
      t.apiKeyId,
      t.createdAt,
    ),
    openStateIdx: index('idx_usage_reservations_open_state')
      .on(t.state)
      .where(sql`${t.state} = 'open'`),
    stateCheck: check(
      'usage_reservations_state_check',
      sql`${t.state} IN ('open', 'committed', 'refunded')`,
    ),
  }),
);

export type UsageReservation = typeof usageReservations.$inferSelect;
export type NewUsageReservation = typeof usageReservations.$inferInsert;
