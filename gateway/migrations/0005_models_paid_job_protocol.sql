-- Models are a rebuildable LOC catalog cache. Clear v0 rows before replacing
-- interaction_mode with the breaking paid-job/v1 protocol axes.
DELETE FROM models;

ALTER TABLE models DROP COLUMN interaction_mode;
ALTER TABLE models ADD COLUMN protocol text NOT NULL;
ALTER TABLE models ADD COLUMN transports jsonb NOT NULL;

ALTER TABLE models ADD CONSTRAINT models_protocol_check
  CHECK (protocol = 'paid-job/v1');
ALTER TABLE models ADD CONSTRAINT models_transports_check
  CHECK (
    jsonb_typeof(transports) = 'array'
    AND jsonb_array_length(transports) > 0
    AND transports <@ '["unary", "stream", "multipart"]'::jsonb
  );
