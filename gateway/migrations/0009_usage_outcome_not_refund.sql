-- `state` records the customer-visible gateway request outcome, not financial
-- accounting. Under paid-job/v1 a failed response may still have a valid
-- broker settlement or LOC conservative charge, so "refunded" is false and
-- dangerously conflates two independent lifecycles.

ALTER TABLE usage_reservations
    DROP CONSTRAINT usage_reservations_state_check;

UPDATE usage_reservations
SET state = 'failed'
WHERE state = 'refunded';

ALTER TABLE usage_reservations
    ADD CONSTRAINT usage_reservations_state_check
        CHECK (state IN ('open', 'committed', 'failed'));
