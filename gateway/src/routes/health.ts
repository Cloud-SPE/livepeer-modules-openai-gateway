// Health checks for load-balancer routing decisions.
//
// `/health` and `/healthz` both return the same JSON. Status is
// `ok` if every required subsystem responds, `down` if a required one
// is failing. HTTP status: 200 for ok, 503 for down.
//
// Required subsystems:
//   - Postgres (always)
//   - payer-daemon
//   - service-registry-daemon

import { existsSync, statSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { ServerDeps } from '../server.js';

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
    payer: Check;
    registry: Check;
  };
}

const DB_PING_TIMEOUT_MS = 1500;

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

function checkSocket(path: string): Check {
  const started = Date.now();
  try {
    if (!existsSync(path)) {
      return {
        status: 'error',
        latencyMs: Date.now() - started,
        error: `socket not present: ${path}`,
      };
    }
    const st = statSync(path);
    if (!st.isSocket()) {
      return {
        status: 'error',
        latencyMs: Date.now() - started,
        error: `path is not a socket: ${path}`,
      };
    }
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
  if (checks.payer.status === 'error' || checks.registry.status === 'error') return 'down';
  return 'ok';
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  const handler = async (): Promise<{ code: number; body: HealthBody }> => {
    const deps = app.deps;
    const [db, payer, registry] = await Promise.all([
      checkDb(deps),
      Promise.resolve(checkSocket(deps.config.payerDaemonSocket)),
      Promise.resolve(checkSocket(deps.config.resolverSocket)),
    ]);
    const body: HealthBody = {
      status: rollUp({ db, payer, registry }),
      checks: { db, payer, registry },
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
