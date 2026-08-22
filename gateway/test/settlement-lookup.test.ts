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

test('ADMITTED_OUTCOME_UNKNOWN is terminal audit state, not a settlement', async () => {
  const log = storeLog();
  const stats = await runSettlementLookupOnce(log.store, 1000, 1000, 10, async () => ({
    kind: 'terminal_evidence',
    state: 'outcome_unknown',
    detail: 'admitted but outcome unavailable',
    encoded: null,
  }));
  assert.deepEqual(stats, { captured: 0, deferred: 0, failed: 1 });
  assert.deepEqual(log.terminals, ['outcome_unknown']);
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

test('a fresh lookup worker resumes the persisted request identity after restart', async () => {
  let pending = row();
  const captured: SettlementEvidence[] = [];
  const store: SettlementLookupStore = {
    async claim() { return captured.length > 0 ? [] : [pending]; },
    async defer(_id, state) { pending = { ...pending, attempts: pending.attempts + 1 }; assert.equal(state, 'accounting_pending'); },
    async record(_id, value) { captured.push(value); },
    async terminal() { throw new Error('unexpected terminal state'); },
  };

  const firstProcess = await runSettlementLookupOnce(store, 1000, 1000, 10, async () => ({
    kind: 'deferred',
    state: 'accounting_pending',
    detail: 'payee unavailable',
  }));
  assert.deepEqual(firstProcess, { captured: 0, deferred: 1, failed: 0 });
  assert.equal(pending.attempts, 1);

  // A new worker instance has no process memory from the first pass. It uses
  // only the durable row identity and captures the eventual signed claim.
  const restartedProcess = await runSettlementLookupOnce(store, 1000, 1000, 10, async (claimed) => {
    assert.equal(claimed.locRequestId, 'request-1');
    assert.equal(claimed.brokerJobId, 'broker-job-1');
    return { kind: 'evidence', evidence: evidence() };
  });
  assert.deepEqual(restartedProcess, { captured: 1, deferred: 0, failed: 0 });
  assert.equal(captured[0]!.requestId, 'request-1');
});
