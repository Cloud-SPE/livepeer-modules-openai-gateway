-- Durable paid-job/v1 identity and signed settlement recovery.
--
-- All columns are nullable so existing v1 rows remain valid. New paid-job
-- reservations populate the complete identity set before recovery begins.
-- There is intentionally no fixed retention deadline here: the upstream
-- authenticated deletion / finite retention contract is not yet final.

ALTER TABLE usage_reservations
    ADD COLUMN loc_idempotency_key          TEXT,
    ADD COLUMN loc_request_id               TEXT,
    ADD COLUMN payment_work_id              TEXT,
    ADD COLUMN broker_job_id                TEXT,
    ADD COLUMN job_protocol                 TEXT,
    ADD COLUMN job_transport                TEXT,
    ADD COLUMN settle_endpoint              TEXT,
    ADD COLUMN settlement_lookup_state      TEXT,
    ADD COLUMN settlement_lookup_attempts   INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN settlement_lookup_next_at    TIMESTAMPTZ,
    ADD COLUMN settlement_lookup_updated_at TIMESTAMPTZ,
    ADD COLUMN settlement_lookup_last_error TEXT,
    ADD COLUMN settlement_encoded           TEXT,
    ADD COLUMN settlement_envelope          JSONB,
    ADD COLUMN settlement_captured_at       TIMESTAMPTZ,
    ADD COLUMN terminal_evidence_type        TEXT,
    ADD COLUMN terminal_evidence_encoded     TEXT,
    ADD COLUMN broker_actual_units          NUMERIC(20, 0),
    ADD COLUMN broker_debited_units         NUMERIC(20, 0),
    ADD COLUMN broker_billed_value_wei      NUMERIC(78, 0),
    ADD COLUMN broker_settlement_outcome    TEXT,
    ADD COLUMN gateway_observed_units       NUMERIC(20, 0),
    ADD COLUMN gateway_observation_source   TEXT,
    ADD COLUMN loc_settled_units            NUMERIC(20, 0),
    ADD COLUMN loc_billed_value_wei         NUMERIC(78, 0),
    ADD COLUMN loc_settlement_outcome       TEXT;

CREATE UNIQUE INDEX idx_usage_reservations_loc_idempotency_key
    ON usage_reservations (loc_idempotency_key);
CREATE UNIQUE INDEX idx_usage_reservations_loc_request_id
    ON usage_reservations (loc_request_id);
CREATE INDEX idx_usage_reservations_settlement_lookup_pending
    ON usage_reservations (settlement_lookup_next_at)
    WHERE settlement_lookup_state IN ('pending', 'accounting_pending', 'in_flight');

ALTER TABLE usage_reservations
    ADD CONSTRAINT usage_reservations_job_protocol_check
        CHECK (job_protocol IS NULL OR job_protocol = 'paid-job/v1'),
    ADD CONSTRAINT usage_reservations_job_transport_check
        CHECK (job_transport IS NULL OR job_transport IN ('unary', 'stream', 'multipart')),
    ADD CONSTRAINT usage_reservations_settlement_lookup_state_check
        CHECK (
            settlement_lookup_state IS NULL
            OR settlement_lookup_state IN (
                'pending', 'accounting_pending', 'in_flight', 'ready',
                'not_admitted', 'no_record', 'evidence_expired', 'failed'
            )
        ),
    ADD CONSTRAINT usage_reservations_terminal_evidence_type_check
        CHECK (
            terminal_evidence_type IS NULL
            OR terminal_evidence_type IN ('not_admitted', 'evidence_expired', 'debit_failed')
        ),
    ADD CONSTRAINT usage_reservations_broker_actual_units_check
        CHECK (broker_actual_units IS NULL OR broker_actual_units >= 0),
    ADD CONSTRAINT usage_reservations_broker_debited_units_check
        CHECK (broker_debited_units IS NULL OR broker_debited_units >= 0),
    ADD CONSTRAINT usage_reservations_gateway_observed_units_check
        CHECK (gateway_observed_units IS NULL OR gateway_observed_units >= 0),
    ADD CONSTRAINT usage_reservations_loc_settled_units_check
        CHECK (loc_settled_units IS NULL OR loc_settled_units >= 0);

-- A v1 queue row has no signed claim and cannot be translated into a v2
-- settlement. Keep it for audit, but fail it visibly instead of coercing its
-- gateway observation into broker evidence.
UPDATE usage_reservations
SET settle_state = 'failed',
    last_settle_error = 'legacy unsigned settlement requires manual reconciliation'
WHERE settle_state = 'pending';
