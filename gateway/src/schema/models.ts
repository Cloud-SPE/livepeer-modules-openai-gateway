import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  bigint,
  numeric,
  index,
} from 'drizzle-orm/pg-core';

// Pure cache of the service-registry-daemon snapshot. Populated by the
// background refresh task (Phase 4b). `GET /v1/models` reads this.
//
// Per core belief #7: models reflect reality — no curated seed rows, no
// hardcoded list. If the registry stops advertising a model, it
// disappears here within one refresh cycle.

export const models = pgTable(
  'models',
  {
    modelId: text('model_id').primaryKey(),
    capability: text('capability').notNull(),
    interactionMode: text('interaction_mode'),

    // Display fields — pulled from registry extras when present, nullable
    // otherwise. Operators MAY override via UPDATE; the refresh task
    // doesn't touch human-set columns when an override flag is set
    // (see refresh task).
    name: text('name'),
    description: text('description'),
    provider: text('provider'),
    category: text('category'),

    ethAddress: text('eth_address'),
    pricePerWorkUnitWei: numeric('price_per_work_unit_wei', {
      precision: 78,
      scale: 0,
    }),
    brokerUrl: text('broker_url'),
    unitsPerPrice: bigint('units_per_price', { mode: 'number' }),
    quoteId: text('quote_id'),
    quoteVersion: text('quote_version'),
    constraintFingerprintHex: text('constraint_fingerprint_hex'),
    routeFingerprintHex: text('route_fingerprint_hex'),

    extraJson: jsonb('extra_json'),
    constraintsJson: jsonb('constraints_json'),

    active: boolean('active').notNull().default(true),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    capabilityIdx: index('idx_models_capability')
      .on(t.capability, t.modelId)
      .where(sql`${t.active} = true`),
    activeIdx: index('idx_models_active')
      .on(t.active, t.snapshotAt),
  }),
);

export type Model = typeof models.$inferSelect;
export type NewModel = typeof models.$inferInsert;
