// Entry point. Boot order:
//   1. Load config + warn on missing peppers.
//   2. Connect Postgres + run migrations.
//   3. Init payer-daemon gRPC client (best-effort; warns if unset).
//   4. Build route selector + registry catalog.
//   5. Start background registry refresh task.
//   6. Build email client.
//   7. Build Fastify server, listen.

import { existsSync } from 'node:fs';

import { loadConfig } from './config.js';
import { createDb, createPool, runMigrations } from './db.js';
import { createEmailClient } from './email/index.js';
import { buildServer } from './server.js';
import * as payment from './proxy/livepeer/payment.js';
import { createRateLimiter } from './proxy/rateLimit.js';
import { createRouteSelector } from './proxy/service/routeSelector.js';
import { createRegistryCatalog } from './registry/catalog.js';
import { startRegistryRefresh } from './registry/refresh.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);

  // Pepper hygiene — log before anything else.
  // eslint-disable-next-line no-console
  if (!config.apiKeyHashPepper) {
    console.warn(
      'API_KEY_HASH_PEPPER is unset — API keys are hashed without a pepper. ' +
        'A DB leak alone is enough to confirm guessed keys. Set this in production.',
    );
  }
  // eslint-disable-next-line no-console
  if (!config.ipHashPepper) {
    console.warn(
      'IP_HASH_PEPPER is unset — client IPs are hashed without a pepper and ' +
        'can be confirmed against the IPv4 space with a rainbow table. ' +
        'Set this in production.',
    );
  }

  await runMigrations(db, {
    log: (msg) => {
      // eslint-disable-next-line no-console
      console.log(`[migrations] ${msg}`);
    },
  });

  // ── payer-daemon ────────────────────────────────────────────────
  if (!existsSync(config.payerDaemonSocket)) {
    throw new Error(`payer-daemon socket not present: ${config.payerDaemonSocket}`);
  }
  await payment.init({
    socketPath: config.payerDaemonSocket,
    protoRoot: config.paymentProtoRoot,
  });
  // eslint-disable-next-line no-console
  console.log(
    `[payer] connected to payer-daemon at ${config.payerDaemonSocket}`,
  );

  // ── route selector ───────────────────────────────────────────────
  const registryCatalog = createRegistryCatalog(config);
  const routeSelector = createRouteSelector(config, registryCatalog);

  // ── email ────────────────────────────────────────────────────────
  const email = createEmailClient({
    apiKey: config.resendApiKey,
    fromEmail: config.fromEmail,
    log: console,
  });
  if (!email.enabled) {
    // eslint-disable-next-line no-console
    console.warn(
      'RESEND_API_KEY unset — verification + API-key emails will be logged instead of sent.',
    );
  }

  // ── rate limiter ─────────────────────────────────────────────────
  const rateLimiter = createRateLimiter(config);
  rateLimiter.start();

  // ── server ───────────────────────────────────────────────────────
  const app = await buildServer({
    config,
    db,
    pool,
    email,
    routeSelector,
    registryCatalog,
    rateLimiter,
  });

  // ── registry refresh ─────────────────────────────────────────────
  const cancelRefresh = startRegistryRefresh({
    registryCatalog,
    db,
    intervalMs: config.registryRefreshIntervalMs,
    log: app.log,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      cancelRefresh();
      rateLimiter.stop();
      payment.shutdown();
      await registryCatalog.close?.();
      await routeSelector.close?.();
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
