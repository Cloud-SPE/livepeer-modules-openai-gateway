// Env-driven configuration. Validated at boot — fail loud and early.
//
// This Config carries two surfaces:
//   • Proxy core fields (resolverSocket, payer socket, proto roots, …).
//     Field names match the source openai-gateway so verbatim-copied
//     proxy/ code resolves them unchanged. See proxy/livepeer/ and
//     proxy/service/.
//   • SaaS shell fields (auth pepper, admin token, base URL, …).
//     These are local to this repo; they support the hand-written
//     waitlist/sessions/api-keys/admin surfaces.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// REPO_ROOT for proto loading in development. In production, the
// Dockerfile copies proto/ to /app/proto.
const REPO_ROOT = resolve(__dirname, '..', '..');

function firstExistingPath(candidates: string[]): string {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[candidates.length - 1]!;
}

const DEFAULT_PROTO_ROOT = firstExistingPath([
  resolve('/app', 'proto'),
  resolve(REPO_ROOT, 'proto'),
]);

const ConfigSchema = z.object({
  // ── HTTP server ───────────────────────────────────────────────────
  port: z.coerce.number().int().positive().default(4001),
  host: z.string().default('0.0.0.0'),
  baseUrl: z.string().url().default('http://localhost:4001'),
  /** Public URL where the site SPA is hosted. Used for verification + API-key emails. */
  publicSiteUrl: z.string().url().default('http://localhost:4001'),
  /** Public URL where the portal SPA is hosted. Linked from the API-key delivery email. */
  publicPortalUrl: z.string().url().default('http://localhost:4001/portal/'),
  allowedOrigins: z.string().default('*'),

  // ── Database ──────────────────────────────────────────────────────
  databaseUrl: z.string().min(1),

  // ── SaaS shell auth / secrets ─────────────────────────────────────
  adminToken: z.string().optional(),
  apiKeyHashPepper: z.string().optional(),
  ipHashPepper: z.string().optional(),
  metricsToken: z.string().optional(),
  sessionTtlHours: z.coerce.number().int().positive().default(24),

  // ── Email (Phase 4) ──────────────────────────────────────────────
  resendApiKey: z.string().optional(),
  fromEmail: z.string().default('OpenAI Service <noreply@example.com>'),

  // ── Livepeer / proxy core ────────────────────────────────────────
  // Names mirror the source openai-gateway so verbatim-copied code
  // under proxy/ continues to work.
  resolverSocket: z.string().min(1),
  payerDaemonSocket: z
    .string()
    .default('/var/run/livepeer/payer-daemon.sock'),
  paymentProtoRoot: z.string().default(DEFAULT_PROTO_ROOT),
  resolverProtoRoot: z.string().default(DEFAULT_PROTO_ROOT),
  brokerCallTimeoutMs: z.coerce.number().int().positive().default(30000),
  routeFailureThreshold: z.coerce.number().int().positive().default(2),
  routeCooldownMs: z.coerce.number().int().positive().default(30000),
  registryRefreshIntervalMs: z.coerce.number().int().positive().default(60_000),

  // ── /v1/* rate limit ────────────────────────────────────────────
  v1RateLimitPerMinute: z.coerce.number().int().positive().default(60),
  v1RateLimitBurst: z.coerce.number().int().positive().default(30),

  // ── Logging ──────────────────────────────────────────────────────
  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

type ConfigEnv = z.infer<typeof ConfigSchema>;

export type Config = ConfigEnv;

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse({
    port: process.env['PORT'],
    host: process.env['HOST'],
    baseUrl: process.env['BASE_URL'],
    publicSiteUrl: process.env['PUBLIC_SITE_URL'],
    publicPortalUrl: process.env['PUBLIC_PORTAL_URL'],
    allowedOrigins: process.env['ALLOWED_ORIGINS'],
    databaseUrl: process.env['DATABASE_URL'],
    adminToken: process.env['ADMIN_TOKEN'],
    apiKeyHashPepper: process.env['API_KEY_HASH_PEPPER'],
    ipHashPepper: process.env['IP_HASH_PEPPER'],
    metricsToken: process.env['METRICS_TOKEN'],
    sessionTtlHours: process.env['SESSION_TTL_HOURS'],
    resendApiKey: process.env['RESEND_API_KEY'],
    fromEmail: process.env['FROM_EMAIL'],
    resolverSocket: process.env['LIVEPEER_RESOLVER_SOCKET'],
    payerDaemonSocket: process.env['LIVEPEER_PAYER_DAEMON_SOCKET'],
    paymentProtoRoot: process.env['LIVEPEER_PAYMENT_PROTO_ROOT'],
    resolverProtoRoot: process.env['LIVEPEER_RESOLVER_PROTO_ROOT'],
    brokerCallTimeoutMs: process.env['BROKER_CALL_TIMEOUT_MS'],
    routeFailureThreshold: process.env['LIVEPEER_ROUTE_FAILURE_THRESHOLD'],
    routeCooldownMs: process.env['LIVEPEER_ROUTE_COOLDOWN_MS'],
    registryRefreshIntervalMs: process.env['REGISTRY_REFRESH_INTERVAL_MS'],
    v1RateLimitPerMinute: process.env['V1_RATE_LIMIT_PER_MINUTE'],
    v1RateLimitBurst: process.env['V1_RATE_LIMIT_BURST'],
    logLevel: process.env['LOG_LEVEL'],
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const env = parsed.data;
  return env;
}
