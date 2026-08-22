import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

import { apiKeys } from './apiKeys.js';

// One row per /v1/* proxy request. The open/committed/refunded state is the
// customer-visible gateway outcome used by admin reporting; it is deliberately
// separate from broker evidence and LOC settlement state below.

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
    // Quote identity columns are daemon-era leftovers: the LOC owns
    // quote/price bookkeeping, so these stay null. Kept nullable to
    // avoid a destructive migration of historical rows.
    quoteId: text('quote_id'),
    quoteVersion: text('quote_version'),
    constraintFingerprintHex: text('constraint_fingerprint_hex'),
    routeFingerprintHex: text('route_fingerprint_hex'),

    state: text('state').notNull().default('open'),

    // ── LOC settlement (durable async) ────────────────────────────
    // Set to pending only after signed broker evidence is durable. The
    // background settler retries POST /v1/jobs/{loc_job_id}/settle until
    // LOC acks (409 job_already_settled counts as settled).
    locJobId: text('loc_job_id'),
    // Five identities remain deliberately distinct. `workId` above is
    // this gateway's operation id; these bind the LOC open, payment,
    // and broker exchange records without guessing across namespaces.
    locIdempotencyKey: text('loc_idempotency_key'),
    locRequestId: text('loc_request_id'),
    paymentWorkId: text('payment_work_id'),
    brokerJobId: text('broker_job_id'),
    jobProtocol: text('job_protocol'),
    jobTransport: text('job_transport'),
    settleEndpoint: text('settle_endpoint'),

    // Broker settlement recovery. The encoded value is the exact
    // Livepeer-Settlement wire claim; the JSON value is its decoded
    // signed envelope for validation, support, and LOC submission.
    settlementLookupState: text('settlement_lookup_state'),
    settlementLookupAttempts: integer('settlement_lookup_attempts').notNull().default(0),
    settlementLookupNextAt: timestamp('settlement_lookup_next_at', { withTimezone: true }),
    settlementLookupUpdatedAt: timestamp('settlement_lookup_updated_at', { withTimezone: true }),
    settlementLookupLastError: text('settlement_lookup_last_error'),
    settlementEncoded: text('settlement_encoded'),
    settlementEnvelope: jsonb('settlement_envelope').$type<Record<string, unknown>>(),
    settlementCapturedAt: timestamp('settlement_captured_at', { withTimezone: true }),
    terminalEvidenceType: text('terminal_evidence_type'),
    terminalEvidenceEncoded: text('terminal_evidence_encoded'),

    // These are separate authorities, not interchangeable billing
    // estimates. Numeric strings retain the full uint64/uint256 range.
    brokerActualUnits: numeric('broker_actual_units', { precision: 20, scale: 0 }),
    brokerDebitedUnits: numeric('broker_debited_units', { precision: 20, scale: 0 }),
    brokerBilledValueWei: numeric('broker_billed_value_wei', { precision: 78, scale: 0 }),
    brokerSettlementOutcome: text('broker_settlement_outcome'),
    gatewayObservedUnits: numeric('gateway_observed_units', { precision: 20, scale: 0 }),
    gatewayObservationSource: text('gateway_observation_source'),
    locSettledUnits: numeric('loc_settled_units', { precision: 20, scale: 0 }),
    locBilledValueWei: numeric('loc_billed_value_wei', { precision: 78, scale: 0 }),
    locSettlementOutcome: text('loc_settlement_outcome'),
    settleState: text('settle_state'), // NULL | 'pending' | 'settled' | 'failed'
    settleActualUnits: bigint('settle_actual_units', { mode: 'number' }),
    settleOutcome: text('settle_outcome'),
    settleAttempts: integer('settle_attempts').notNull().default(0),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    lastSettleError: text('last_settle_error'),

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
    settlePendingIdx: index('idx_usage_reservations_settle_pending')
      .on(t.settleState)
      .where(sql`${t.settleState} = 'pending'`),
    settlementLookupPendingIdx: index('idx_usage_reservations_settlement_lookup_pending')
      .on(t.settlementLookupNextAt)
      .where(sql`${t.settlementLookupState} IN ('pending', 'accounting_pending', 'in_flight')`),
    locIdempotencyKeyIdx: uniqueIndex('idx_usage_reservations_loc_idempotency_key')
      .on(t.locIdempotencyKey),
    locRequestIdIdx: uniqueIndex('idx_usage_reservations_loc_request_id').on(t.locRequestId),
    stateCheck: check(
      'usage_reservations_state_check',
      sql`${t.state} IN ('open', 'committed', 'refunded')`,
    ),
    protocolCheck: check(
      'usage_reservations_job_protocol_check',
      sql`${t.jobProtocol} IS NULL OR ${t.jobProtocol} = 'paid-job/v1'`,
    ),
    transportCheck: check(
      'usage_reservations_job_transport_check',
      sql`${t.jobTransport} IS NULL OR ${t.jobTransport} IN ('unary', 'stream', 'multipart')`,
    ),
    lookupStateCheck: check(
      'usage_reservations_settlement_lookup_state_check',
      sql`${t.settlementLookupState} IS NULL OR ${t.settlementLookupState} IN ('pending', 'accounting_pending', 'in_flight', 'ready', 'not_admitted', 'no_record', 'outcome_unknown', 'evidence_expired', 'failed')`,
    ),
    terminalEvidenceTypeCheck: check(
      'usage_reservations_terminal_evidence_type_check',
      sql`${t.terminalEvidenceType} IS NULL OR ${t.terminalEvidenceType} IN ('not_admitted', 'outcome_unknown', 'evidence_expired', 'debit_failed')`,
    ),
  }),
);

export type UsageReservation = typeof usageReservations.$inferSelect;
export type NewUsageReservation = typeof usageReservations.$inferInsert;
