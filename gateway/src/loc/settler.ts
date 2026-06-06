// Background settler: drains the durable settle queue written by
// reservation commit/refund (usage_reservations.settle_state='pending')
// against LOC's POST /v1/jobs/{id}/settle.
//
// LOC charges the full estimate at job issuance; settling with actual
// units refunds the difference. Missing a settle means permanently
// over-paying the estimate, so this retries until LOC acks. 409
// job_already_settled / 404 job_not_found are terminal successes —
// double-settles are expected (dispatch fires best-effort inline
// settles for retried jobs) and idempotent-safe.

import type { FastifyBaseLogger } from 'fastify';

import type { Db } from '../db.js';
import * as usageRepo from '../repo/usageReservations.js';
import { proxySettleTotal } from '../metrics.js';
import { LocApiError, type LocClient } from './client.js';

export interface StartSettlerInput {
  db: Db;
  loc: LocClient;
  intervalMs: number;
  maxAttempts: number;
  batchSize?: number;
  log: FastifyBaseLogger | Console;
}

/** Cancel function — call to stop the periodic settler. */
export type CancelSettler = () => void;

const DEFAULT_BATCH_SIZE = 50;

export function startSettler(input: StartSettlerInput): CancelSettler {
  const { db, loc, intervalMs, maxAttempts, log } = input;
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;

  // Guard against overlapping runs when a batch outlives the interval.
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const stats = await runSettleOnce(db, loc, maxAttempts, batchSize);
      if (stats.settled + stats.failed + stats.retried > 0) {
        log.info(stats, 'LOC settle pass');
      }
    } finally {
      running = false;
    }
  };

  void run().catch((err) => {
    log.error({ err }, 'LOC settle pass failed (initial)');
  });

  const handle = setInterval(() => {
    void run().catch((err) => {
      log.error({ err }, 'LOC settle pass failed');
    });
  }, intervalMs);
  // Don't keep the process alive just for this timer.
  handle.unref?.();

  return () => clearInterval(handle);
}

export interface SettlePassStats {
  settled: number;
  failed: number;
  retried: number;
}

/** Persistence surface the settle pass needs — usageRepo in production,
 * fakes in unit tests. */
export interface SettleStore {
  claimPendingSettlements(limit: number): Promise<usageRepo.PendingSettlement[]>;
  markSettled(id: string): Promise<void>;
  recordSettleFailure(id: string, errorText: string, maxAttempts: number): Promise<void>;
}

function dbStore(db: Db): SettleStore {
  return {
    claimPendingSettlements: (limit) => usageRepo.claimPendingSettlements(db, limit),
    markSettled: (id) => usageRepo.markSettled(db, id),
    recordSettleFailure: (id, errorText, maxAttempts) =>
      usageRepo.recordSettleFailure(db, id, errorText, maxAttempts),
  };
}

/** One settle pass over the pending queue. Exported for unit tests. */
export async function runSettleOnce(
  db: Db | SettleStore,
  loc: LocClient,
  maxAttempts: number,
  batchSize: number,
): Promise<SettlePassStats> {
  const store: SettleStore =
    'claimPendingSettlements' in db ? (db as SettleStore) : dbStore(db as Db);
  const pending = await store.claimPendingSettlements(batchSize);
  const stats: SettlePassStats = { settled: 0, failed: 0, retried: 0 };

  for (const row of pending) {
    try {
      await loc.settleJob(row.locJobId, {
        actualUnits: row.settleActualUnits,
        ...(row.settleOutcome ? { outcome: row.settleOutcome } : {}),
      });
      await store.markSettled(row.id);
      stats.settled += 1;
      proxySettleTotal.inc({ outcome: 'settled' });
    } catch (err) {
      if (isTerminalSettleAck(err)) {
        // Already settled (or LOC dropped the job) — nothing left to claw back.
        await store.markSettled(row.id);
        stats.settled += 1;
        proxySettleTotal.inc({ outcome: 'already_settled' });
        continue;
      }
      const message = (err as Error).message ?? 'unknown settle error';
      await store.recordSettleFailure(row.id, message, maxAttempts);
      if (row.settleAttempts + 1 >= maxAttempts) {
        stats.failed += 1;
        proxySettleTotal.inc({ outcome: 'failed' });
      } else {
        stats.retried += 1;
        proxySettleTotal.inc({ outcome: 'retried' });
      }
    }
  }

  return stats;
}

function isTerminalSettleAck(err: unknown): boolean {
  if (!(err instanceof LocApiError)) return false;
  return (
    err.code === 'job_already_settled' ||
    err.code === 'job_not_found' ||
    err.status === 409 ||
    err.status === 404
  );
}
