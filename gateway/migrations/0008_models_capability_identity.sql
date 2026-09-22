-- Offering ids are scoped to a capability. In particular, multiple OpenAI
-- capabilities may each publish an offering named "default".

ALTER TABLE models
    DROP CONSTRAINT models_pkey,
    ADD CONSTRAINT models_pkey PRIMARY KEY (capability, model_id);
