import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  validateSettlementEvidenceIdentity,
  type SettlementEvidenceIdentity,
} from '../src/repo/usageReservations.js';

const expected: SettlementEvidenceIdentity = {
  requestId: 'loc-request-1',
  brokerJobId: 'broker-job-1',
  paymentWorkId: 'payment-work-1',
  workUnit: 'tokens',
};

test('settlement evidence accepts only an exact four-way identity match', () => {
  assert.deepEqual(validateSettlementEvidenceIdentity(expected, { ...expected }), []);

  const differences = validateSettlementEvidenceIdentity(expected, {
    requestId: 'loc-request-2',
    brokerJobId: 'broker-job-2',
    paymentWorkId: 'payment-work-2',
    workUnit: 'characters',
  });
  assert.equal(differences.length, 4);
  assert.match(differences[0]!, /requestId/);
  assert.match(differences[1]!, /brokerJobId/);
  assert.match(differences[2]!, /paymentWorkId/);
  assert.match(differences[3]!, /workUnit/);
});

test('request-id recovery may discover a previously unobserved broker job id', () => {
  assert.deepEqual(
    validateSettlementEvidenceIdentity(
      { ...expected, brokerJobId: null },
      { ...expected, brokerJobId: 'broker-job-recovered' },
    ),
    [],
  );
});

test('paid-job evidence migration is forward-only for historical rows', async () => {
  const migrationUrl = new URL('../../migrations/0006_paid_job_settlement_evidence.sql', import.meta.url);
  const migration = await readFile(migrationUrl, 'utf8');

  assert.doesNotMatch(migration, /\b(?:DELETE|TRUNCATE|DROP)\b/i);
  for (const column of [
    'loc_idempotency_key',
    'loc_request_id',
    'payment_work_id',
    'broker_job_id',
    'settlement_encoded',
    'settlement_envelope',
    'terminal_evidence_encoded',
  ]) {
    assert.match(migration, new RegExp(`ADD COLUMN ${column}\\s+`));
    assert.doesNotMatch(migration, new RegExp(`ADD COLUMN ${column}[^,;]*NOT NULL`));
  }
  assert.match(migration, /settlement_lookup_attempts\s+INTEGER NOT NULL DEFAULT 0/);
  assert.doesNotMatch(migration, /24\s*hour/i);
});

test('admission terminal migration preserves distinct unknown and expired outcomes', async () => {
  const migrationUrl = new URL(
    '../../migrations/0007_paid_job_admission_terminal.sql',
    import.meta.url,
  );
  const migration = await readFile(migrationUrl, 'utf8');
  assert.doesNotMatch(migration, /\b(?:DELETE|TRUNCATE)\b/i);
  assert.match(migration, /'outcome_unknown'/);
  assert.match(migration, /'evidence_expired'/);
  assert.match(migration, /DROP CONSTRAINT usage_reservations_settlement_lookup_state_check/);
  assert.match(migration, /ADD CONSTRAINT usage_reservations_settlement_lookup_state_check/);
});

test('request outcome migration removes the false financial refund state', async () => {
  const migrationUrl = new URL(
    '../../migrations/0009_usage_outcome_not_refund.sql',
    import.meta.url,
  );
  const migration = await readFile(migrationUrl, 'utf8');
  assert.match(migration, /SET state = 'failed'/);
  assert.match(migration, /WHERE state = 'refunded'/);
  assert.match(migration, /CHECK \(state IN \('open', 'committed', 'failed'\)\)/);
  assert.doesNotMatch(migration, /settle_state\s*=/);
  assert.doesNotMatch(migration, /broker_actual_units\s*=/);
  assert.doesNotMatch(migration, /loc_billed_value_wei\s*=/);
});
