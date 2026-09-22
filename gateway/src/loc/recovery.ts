// Recover accounting only. A restarted process never replays customer workload bytes.
import type { Db } from '../db.js';
import * as repo from '../repo/usageReservations.js';
import { LocApiError, type LocClient, type JobStatus, type OpenJobRequest, type OpenJobResponse } from './client.js';

export interface RecoveryStore {
  opens(): Promise<Array<{ id: string; workId: string; request: OpenJobRequest | null }>>;
  recover(workId: string, request: OpenJobRequest, job: OpenJobResponse): Promise<void>;
  deferOpen(id: string, refused: boolean): Promise<void>;
  statuses(): Promise<Array<{ id: string; jobId: string | null; requestId: string | null; workId: string | null }>>;
  record(id: string, status: JobStatus): Promise<void>;
  deferStatus(id: string, error: string): Promise<void>;
}

export async function runRecoveryOnce(store: RecoveryStore, loc: LocClient): Promise<void> {
  for (const row of await store.opens()) {
    if (!row.request) { await store.deferOpen(row.id, true); continue; }
    try {
      const job = await loc.openJob(row.request);
      await store.recover(row.workId, row.request, job);
    } catch (error) {
      const refused = error instanceof LocApiError && error.status >= 400 && error.status < 500 &&
        error.status !== 429 && !(error.status === 409 && error.code === 'IDEMPOTENCY_IN_PROGRESS');
      await store.deferOpen(row.id, refused);
    }
  }
  for (const row of await store.statuses()) {
    try {
      if (!row.jobId) continue;
      const status = await loc.getJob(row.jobId);
      if (status.requestId !== row.requestId || status.workId !== row.workId) throw new Error('LOC status identity drift');
      await store.record(row.id, status);
    } catch (error) {
      await store.deferStatus(row.id, (error as Error).message);
    }
  }
}

export function startRecovery(db: Db, loc: LocClient, intervalMs: number,
  log: { error: (value: unknown, message: string) => void }): () => void {
  const store: RecoveryStore = {
    opens: () => repo.pendingOpenIntents(db, 50),
    recover: (workId, request, job) => repo.recoverOpenIdentity(db, workId, request, job),
    deferOpen: (id, refused) => repo.deferOpenIntent(db, id, refused),
    statuses: () => repo.pendingLocStatuses(db, 50),
    record: (id, status) => repo.recordLocStatus(db, id, status),
    deferStatus: (id, error) => repo.deferLocStatus(db, id, error),
  };
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await runRecoveryOnce(store, loc); }
    catch (error) { log.error({ err: error }, 'LOC accounting recovery failed'); }
    finally { running = false; }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
