import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runSettlementLookupOnce,
  type SettlementLookupStore,
} from '../src/loc/settlementLookup.js';
import type {
  PendingSettlementLookup,
  SettlementEvidence,
} from '../src/repo/usageReservations.js';

function row(): PendingSettlementLookup {
  return {
    id: 'reservation-1',
    brokerUrl: 'https://broker.example',
    brokerJobId: 'broker-job-1',
    locRequestId: 'request-1',
    paymentWorkId: 'payment-work-1',
    workUnit: 'tokens',
    attempts: 0,
  };
}

function evidence(): SettlementEvidence {
  return {
    encoded: 'encoded',
    envelope: {},
    requestId: 'request-1',
    brokerJobId: 'broker-job-1',
    paymentWorkId: 'payment-work-1',
    workUnit: 'tokens',
    actualUnits: '4',
    debitedUnits: '4',
    billedValueWei: '9',
    outcome: 'EXACT',
  };
}

function storeLog(): {
  store: SettlementLookupStore;
  records: SettlementEvidence[];
  deferrals: string[];
  terminals: string[];
} {
  const records: SettlementEvidence[] = [];
  const deferrals: string[] = [];
  const terminals: string[] = [];
  return {
    records,
    deferrals,
    terminals,
    store: {
      async claim() { return [row()]; },
      async defer(_id, state) { deferrals.push(state); },
      async record(_id, value) { records.push(value); },
      async terminal(_id, state) { terminals.push(state); },
    },
  };
}

test('terminal evidence is persisted before LOC settlement can be claimed', async () => {
  const log = storeLog();
  const stats = await runSettlementLookupOnce(log.store, 1000, 1000, 10, async () => ({
    kind: 'evidence',
    evidence: evidence(),
  }));
  assert.deepEqual(stats, { captured: 1, deferred: 0, failed: 0 });
  assert.equal(log.records.length, 1);
  assert.equal(log.deferrals.length, 0);
});

test('accounting_pending does not consume a terminal settlement attempt', async () => {
  const log = storeLog();
  const stats = await runSettlementLookupOnce(log.store, 1000, 1000, 10, async () => ({
    kind: 'deferred',
    state: 'accounting_pending',
    detail: 'pending',
  }));
  assert.deepEqual(stats, { captured: 0, deferred: 1, failed: 0 });
  assert.deepEqual(log.deferrals, ['accounting_pending']);
  assert.equal(log.records.length, 0);
});

test('NOT_ADMITTED is audit evidence, not a zero-unit settlement', async () => {
  const log = storeLog();
  const stats = await runSettlementLookupOnce(log.store, 1000, 1000, 10, async () => ({
    kind: 'terminal_evidence',
    state: 'not_admitted',
    detail: 'audit only',
    encoded: 'signed-non-admission',
  }));
  assert.deepEqual(stats, { captured: 0, deferred: 0, failed: 1 });
  assert.deepEqual(log.terminals, ['not_admitted']);
  assert.equal(log.records.length, 0);
});

test('signed DEBIT_FAILED is retained as an explicit non-success', async () => {
  const log = storeLog();
  const stats = await runSettlementLookupOnce(log.store, 1000, 1000, 10, async () => ({
    kind: 'evidence',
    evidence: { ...evidence(), outcome: 'DEBIT_FAILED', debitedUnits: '0' },
  }));
  assert.deepEqual(stats, { captured: 0, deferred: 0, failed: 1 });
  assert.equal(log.records[0]!.outcome, 'DEBIT_FAILED');
});

test('network failure remains durably retryable', async () => {
  const log = storeLog();
  const stats = await runSettlementLookupOnce(log.store, 1000, 1000, 10, async () => {
    throw new Error('network down');
  });
  assert.deepEqual(stats, { captured: 0, deferred: 1, failed: 0 });
  assert.deepEqual(log.deferrals, ['pending']);
});
