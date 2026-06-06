-- LOC (Livepeer Open Clearinghouse) durable settlement tracking.
--
-- Jobs are charged at issuance for the full estimate; settling with
-- actual units claws back the difference. The settle intent is written
-- on the reservation row at commit/refund time and a background settler
-- retries until LOC acks. quote_* / *_fingerprint_hex columns are
-- daemon-era leftovers and stay null going forward.

ALTER TABLE usage_reservations
    ADD COLUMN loc_job_id          TEXT,
    ADD COLUMN settle_state        TEXT,          -- NULL | 'pending' | 'settled' | 'failed'
    ADD COLUMN settle_actual_units BIGINT,
    ADD COLUMN settle_outcome      TEXT,
    ADD COLUMN settle_attempts     INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN settled_at          TIMESTAMPTZ,
    ADD COLUMN last_settle_error   TEXT;

CREATE INDEX idx_usage_reservations_settle_pending
    ON usage_reservations (settle_state)
    WHERE settle_state = 'pending';
