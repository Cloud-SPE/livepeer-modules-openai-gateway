import type { FastifyBaseLogger } from 'fastify';

import type { Db } from '../db.js';
import * as usageRepo from '../repo/usageReservations.js';
import {
  BrokerSettlementContractError,
  lookupBrokerSettlement,
  type BrokerSettlementLookup,
} from './brokerSettlement.js';

export interface SettlementLookupStore {
  claim(limit: number): Promise<usageRepo.PendingSettlementLookup[]>;
  defer(
    id: string,
    state: 'pending' | 'accounting_pending' | 'in_flight' | 'no_record',
    nextAt: Date,
    detail: string | null,
  ): Promise<void>;
  record(id: string, evidence: usageRepo.SettlementEvidence): Promise<void>;
  terminal(
    id: string,
    state: 'not_admitted' | 'evidence_expired' | 'failed',
    detail: string,
    encoded?: string | null,
  ): Promise<void>;
}

export interface LookupPassStats {
  captured: number;
  deferred: number;
  failed: number;
}

function dbStore(db: Db): SettlementLookupStore {
  return {
    claim: (limit) => usageRepo.claimPendingSettlementLookups(db, limit),
    defer: (id, state, nextAt, detail) =>
      usageRepo.deferSettlementLookup(db, id, state, nextAt, detail),
    record: (id, evidence) => usageRepo.recordSettlementEvidence(db, id, evidence),
    terminal: (id, state, detail, encoded) =>
      usageRepo.recordSettlementLookupTerminal(db, id, state, detail, encoded),
  };
}

export async function runSettlementLookupOnce(
  source: Db | SettlementLookupStore,
  timeoutMs: number,
  retryMs: number,
  batchSize: number,
  lookup: (
    row: usageRepo.PendingSettlementLookup,
    timeoutMs: number,
  ) => Promise<BrokerSettlementLookup> = lookupBrokerSettlement,
): Promise<LookupPassStats> {
  const store: SettlementLookupStore = 'claim' in source ? source : dbStore(source);
  const rows = await store.claim(batchSize);
  const stats: LookupPassStats = { captured: 0, deferred: 0, failed: 0 };
  for (const row of rows) {
    try {
      const result = await lookup(row, timeoutMs);
      if (result.kind === 'evidence') {
        await store.record(row.id, result.evidence);
        if (result.evidence.outcome === 'DEBIT_FAILED') stats.failed += 1;
        else stats.captured += 1;
      } else if (result.kind === 'terminal_evidence') {
        await store.terminal(row.id, result.state, result.detail, result.encoded);
        stats.failed += 1;
      } else {
        await store.defer(row.id, result.state, nextAttempt(retryMs), result.detail);
        stats.deferred += 1;
      }
    } catch (error) {
      const detail = (error as Error).message ?? 'unknown settlement lookup error';
      if (error instanceof BrokerSettlementContractError || error instanceof usageRepo.SettlementEvidenceDriftError) {
        await store.terminal(row.id, 'failed', detail);
        stats.failed += 1;
      } else {
        await store.defer(row.id, 'pending', nextAttempt(retryMs), detail);
        stats.deferred += 1;
      }
    }
  }
  return stats;
}

export function startSettlementLookup(input: {
  db: Db;
  timeoutMs: number;
  intervalMs: number;
  batchSize?: number;
  log: FastifyBaseLogger | Console;
}): () => void {
  const batchSize = input.batchSize ?? 50;
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const stats = await runSettlementLookupOnce(
        input.db,
        input.timeoutMs,
        input.intervalMs,
        batchSize,
      );
      if (stats.captured + stats.deferred + stats.failed > 0) {
        input.log.info(stats, 'broker settlement lookup pass');
      }
    } finally {
      running = false;
    }
  };
  void run().catch((error) => input.log.error({ err: error }, 'settlement lookup pass failed'));
  const timer = setInterval(() => {
    void run().catch((error) => input.log.error({ err: error }, 'settlement lookup pass failed'));
  }, input.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function nextAttempt(retryMs: number): Date {
  return new Date(Date.now() + Math.max(1_000, retryMs));
}
