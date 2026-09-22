-- Nullable additions preserve historical payment-envelope rows.
ALTER TABLE usage_reservations
  ADD COLUMN loc_open_request jsonb,
  ADD COLUMN loc_open_recovery_state text,
  ADD COLUMN loc_open_next_at timestamptz,
  ADD COLUMN accounting_mode text,
  ADD COLUMN spend_authorization text,
  ADD COLUMN route_snapshot jsonb,
  ADD COLUMN settlement_domain_id text,
  ADD COLUMN loc_accounting_state text,
  ADD COLUMN loc_accounting_outcome text,
  ADD COLUMN loc_status_next_at timestamptz,
  ADD COLUMN loc_status_error text;
CREATE INDEX idx_usage_loc_open_recovery ON usage_reservations(loc_open_next_at)
  WHERE loc_open_recovery_state = 'pending' AND loc_job_id IS NULL;
CREATE INDEX idx_usage_loc_status ON usage_reservations(loc_status_next_at)
  WHERE loc_job_id IS NOT NULL AND loc_accounting_state IS DISTINCT FROM 'closed';
-- NO_RECORD must stay eligible for polling; silence is not non-admission.
DROP INDEX IF EXISTS idx_usage_reservations_settlement_lookup_pending;
CREATE INDEX idx_usage_reservations_settlement_lookup_pending
  ON usage_reservations(settlement_lookup_next_at)
  WHERE settlement_lookup_state IN ('pending','accounting_pending','in_flight','no_record');
