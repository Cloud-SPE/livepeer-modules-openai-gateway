-- paid-job/v1 1.0.15 distinguishes an admitted exchange whose terminal
-- outcome cannot be recovered from one whose detailed evidence aged out.
-- Neither state authorizes a fabricated zero-unit settlement.

ALTER TABLE usage_reservations
    DROP CONSTRAINT usage_reservations_settlement_lookup_state_check,
    DROP CONSTRAINT usage_reservations_terminal_evidence_type_check,
    ADD CONSTRAINT usage_reservations_settlement_lookup_state_check
        CHECK (
            settlement_lookup_state IS NULL
            OR settlement_lookup_state IN (
                'pending', 'accounting_pending', 'in_flight', 'ready',
                'not_admitted', 'no_record', 'outcome_unknown',
                'evidence_expired', 'failed'
            )
        ),
    ADD CONSTRAINT usage_reservations_terminal_evidence_type_check
        CHECK (
            terminal_evidence_type IS NULL
            OR terminal_evidence_type IN (
                'not_admitted', 'outcome_unknown', 'evidence_expired',
                'debit_failed'
            )
        );
