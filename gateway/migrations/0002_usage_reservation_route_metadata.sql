ALTER TABLE usage_reservations
    ADD COLUMN selected_capability TEXT,
    ADD COLUMN selected_offering TEXT,
    ADD COLUMN selected_work_unit TEXT,
    ADD COLUMN units_per_price BIGINT,
    ADD COLUMN quote_id TEXT,
    ADD COLUMN quote_version TEXT,
    ADD COLUMN constraint_fingerprint_hex TEXT,
    ADD COLUMN route_fingerprint_hex TEXT;
