// Entry point. Boot order:
//   1. Load config + warn on missing peppers.
//   2. Connect Postgres + run migrations.
//   3. Build LOC client (health probe is best-effort — a LOC outage
//      degrades /v1/* to 503s, it doesn't take the gateway down).
//   4. Build registry catalog (LOC-backed).
//   5. Start background registry refresh + LOC settler tasks.
//   6. Build email client.
//   7. Build Fastify server, listen.

import { loadConfig } from './config.js';
import { createDb, createPool, runMigrations } from './db.js';
import { createEmailClient } from './email/index.js';
import { buildServer } from './server.js';
import { createLocClient } from './loc/client.js';
import { startSettler } from './loc/settler.js';
import { createRateLimiter } from './proxy/rateLimit.js';
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

  // ── LOC clearinghouse ───────────────────────────────────────────
  const loc = createLocClient({
    baseUrl: config.locBaseUrl,
    apiKey: config.locApiKey,
    timeoutMs: config.locTimeoutMs,
  });
  try {
    const locHealth = await loc.health();
    // eslint-disable-next-line no-console
    console.log(
      `[loc] connected to ${config.locBaseUrl} (version ${locHealth.version}, env ${locHealth.env})`,
    );
  } catch (err) {
    // Warn-and-continue: DB-backed endpoints stay up; /v1/* will 503
    // and /health reports the LOC as down until it recovers.
    // eslint-disable-next-line no-console
    console.warn(`[loc] health probe failed for ${config.locBaseUrl}:`, err);
  }

  // ── registry catalog (LOC-backed) ─────────────────────────────────
  const registryCatalog = createRegistryCatalog(loc);

  // ── email ────────────────────────────────────────────────────────
  const email = createEmailClient({
    apiKey: config.resendApiKey,
    baseUrl: config.resendBaseUrl,
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
    loc,
    registryCatalog,
    rateLimiter,
  });

  // ── background tasks ──────────────────────────────────────────────
  const cancelRefresh = startRegistryRefresh({
    registryCatalog,
    db,
    intervalMs: config.registryRefreshIntervalMs,
    log: app.log,
  });
  const cancelSettler = startSettler({
    db,
    loc,
    intervalMs: config.locSettleIntervalMs,
    maxAttempts: config.locSettleMaxAttempts,
    log: app.log,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      cancelRefresh();
      cancelSettler();
      rateLimiter.stop();
      await registryCatalog.close?.();
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
