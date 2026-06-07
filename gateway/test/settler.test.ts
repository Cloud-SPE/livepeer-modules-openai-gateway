import test from 'node:test';
import assert from 'node:assert/strict';

import { runSettleOnce, type SettleStore } from '../src/loc/settler.js';
import { LocApiError, type LocClient, type SettleJobRequest } from '../src/loc/client.js';
import type { PendingSettlement } from '../src/repo/usageReservations.js';

interface StoreLog {
  settled: string[];
  failures: Array<{ id: string; errorText: string }>;
}

function fakeStore(rows: PendingSettlement[]): { store: SettleStore; log: StoreLog } {
  const log: StoreLog = { settled: [], failures: [] };
  const store: SettleStore = {
    async claimPendingSettlements() {
      return rows;
    },
    async markSettled(id) {
      log.settled.push(id);
    },
    async recordSettleFailure(id, errorText) {
      log.failures.push({ id, errorText });
    },
  };
  return { store, log };
}

function fakeLoc(
  settleImpl: (jobId: string, req: SettleJobRequest) => void,
): { loc: LocClient; settles: Array<{ jobId: string; req: SettleJobRequest }> } {
  const settles: Array<{ jobId: string; req: SettleJobRequest }> = [];
  const loc: LocClient = {
    async openJob() {
      throw new Error('not used');
    },
    async settleJob(jobId, req) {
      settles.push({ jobId, req });
      settleImpl(jobId, req);
      return {
        jobId,
        workId: 'w',
        actualUnits: req.actualUnits,
        billedValueWei: '0',
        refundWei: '0',
        outcome: req.outcome ?? '',
        closedAt: '',
      };
    },
    async listCapabilities() {
      return [];
    },
    async listOrchestrators() {
      return [];
    },
    async getBalance() {
      return { amountWei: '0' };
    },
    async health() {
      return { status: 'ok', version: 't', env: 't' };
    },
  };
  return { loc, settles };
}

function row(overrides: Partial<PendingSettlement> = {}): PendingSettlement {
  return {
    id: 'res-1',
    locJobId: 'job-1',
    settleActualUnits: 5,
    settleOutcome: 'committed',
    settleAttempts: 0,
    ...overrides,
  };
}

test('successful settle marks the row settled with actual units', async () => {
  const { store, log } = fakeStore([row()]);
  const { loc, settles } = fakeLoc(() => {});
  const stats = await runSettleOnce(store, loc, 20, 50);
  assert.deepEqual(stats, { settled: 1, failed: 0, retried: 0 });
  assert.deepEqual(log.settled, ['res-1']);
  assert.equal(settles[0]!.jobId, 'job-1');
  assert.equal(settles[0]!.req.actualUnits, 5);
  assert.equal(settles[0]!.req.outcome, 'committed');
});

test('409 job_already_settled is a terminal success', async () => {
  const { store, log } = fakeStore([row()]);
  const { loc } = fakeLoc(() => {
    throw new LocApiError({ status: 409, code: 'job_already_settled', message: 'dup' });
  });
  const stats = await runSettleOnce(store, loc, 20, 50);
  assert.deepEqual(stats, { settled: 1, failed: 0, retried: 0 });
  assert.deepEqual(log.settled, ['res-1']);
  assert.equal(log.failures.length, 0);
});

test('404 job_not_found is a terminal success', async () => {
  const { store, log } = fakeStore([row()]);
  const { loc } = fakeLoc(() => {
    throw new LocApiError({ status: 404, code: 'job_not_found', message: 'gone' });
  });
  const stats = await runSettleOnce(store, loc, 20, 50);
  assert.equal(stats.settled, 1);
  assert.deepEqual(log.settled, ['res-1']);
});

test('transient failure records a retry', async () => {
  const { store, log } = fakeStore([row()]);
  const { loc } = fakeLoc(() => {
    throw new LocApiError({ status: 503, code: 'daemon_unavailable', message: 'down' });
  });
  const stats = await runSettleOnce(store, loc, 20, 50);
  assert.deepEqual(stats, { settled: 0, failed: 0, retried: 1 });
  assert.equal(log.settled.length, 0);
  assert.equal(log.failures[0]!.id, 'res-1');
  assert.match(log.failures[0]!.errorText, /down/);
});

test('failure at maxAttempts counts as terminal failure', async () => {
  const { store, log } = fakeStore([row({ settleAttempts: 19 })]);
  const { loc } = fakeLoc(() => {
    throw new LocApiError({ status: 500, code: 'http_500', message: 'kaput' });
  });
  const stats = await runSettleOnce(store, loc, 20, 50);
  assert.deepEqual(stats, { settled: 0, failed: 1, retried: 0 });
  assert.equal(log.failures.length, 1);
});

test('mixed batch: each row classified independently', async () => {
  const { store, log } = fakeStore([
    row({ id: 'a', locJobId: 'job-a' }),
    row({ id: 'b', locJobId: 'job-b' }),
  ]);
  const { loc } = fakeLoc((jobId) => {
    if (jobId === 'job-b') {
      throw new LocApiError({ status: 503, code: 'daemon_unavailable', message: 'down' });
    }
  });
  const stats = await runSettleOnce(store, loc, 20, 50);
  assert.deepEqual(stats, { settled: 1, failed: 0, retried: 1 });
  assert.deepEqual(log.settled, ['a']);
  assert.equal(log.failures[0]!.id, 'b');
});
