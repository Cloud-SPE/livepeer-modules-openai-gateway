ALTER TABLE models
    ADD COLUMN units_per_price BIGINT,
    ADD COLUMN quote_id TEXT,
    ADD COLUMN quote_version TEXT,
    ADD COLUMN constraint_fingerprint_hex TEXT,
    ADD COLUMN route_fingerprint_hex TEXT;
