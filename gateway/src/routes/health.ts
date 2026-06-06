// Health checks for load-balancer routing decisions.
//
// `/health` and `/healthz` both return the same JSON. Status is
// `ok` if every required subsystem responds, `down` if a required one
// is failing. HTTP status: 200 for ok, 503 for down.
//
// Required subsystems:
//   - Postgres (always)
//   - LOC clearinghouse (route selection + payment minting)
//
// `pendingSettlements` is informational: a growing backlog means the
// settler can't reach LOC (refunds are delayed, not lost), but it does
// not flip the gateway to down on its own.

import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { ServerDeps } from '../server.js';
import * as usageRepo from '../repo/usageReservations.js';

type CheckStatus = 'ok' | 'error';

interface Check {
  status: CheckStatus;
  latencyMs?: number;
  error?: string;
}

interface HealthBody {
  status: 'ok' | 'down';
  checks: {
    db: Check;
    loc: Check;
  };
  pendingSettlements: number | null;
}

const DB_PING_TIMEOUT_MS = 1500;
const LOC_PING_TIMEOUT_MS = 3000;

async function checkDb(deps: ServerDeps): Promise<Check> {
  const started = Date.now();
  try {
    await Promise.race([
      deps.db.execute(sql`SELECT 1`),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('db ping timeout')), DB_PING_TIMEOUT_MS),
      ),
    ]);
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - started, error: msg(err) };
  }
}

async function checkLoc(deps: ServerDeps): Promise<Check> {
  const started = Date.now();
  try {
    await Promise.race([
      deps.loc.health(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('loc ping timeout')), LOC_PING_TIMEOUT_MS),
      ),
    ]);
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - started, error: msg(err) };
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function rollUp(checks: HealthBody['checks']): HealthBody['status'] {
  if (checks.db.status === 'error') return 'down';
  if (checks.loc.status === 'error') return 'down';
  return 'ok';
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  const handler = async (): Promise<{ code: number; body: HealthBody }> => {
    const deps = app.deps;
    const [db, loc, pendingSettlements] = await Promise.all([
      checkDb(deps),
      checkLoc(deps),
      usageRepo.pendingSettleCount(deps.db).catch(() => null),
    ]);
    const body: HealthBody = {
      status: rollUp({ db, loc }),
      checks: { db, loc },
      pendingSettlements,
    };
    return { code: body.status === 'down' ? 503 : 200, body };
  };

  app.get('/health', async (_req, reply) => {
    const { code, body } = await handler();
    void reply.code(code).send(body);
  });

  app.get('/healthz', async (_req, reply) => {
    const { code, body } = await handler();
    void reply.code(code).send(body);
  });
}
