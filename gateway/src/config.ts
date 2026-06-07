// Env-driven configuration. Validated at boot — fail loud and early.
//
// This Config carries two surfaces:
//   • Proxy core fields (LOC clearinghouse URL/key, broker timeout, …).
//     The gateway sources routes + payment envelopes from the LOC
//     (Livepeer Open Clearinghouse) HTTP API. See loc/ and proxy/.
//   • SaaS shell fields (auth pepper, admin token, base URL, …).
//     These are local to this repo; they support the hand-written
//     waitlist/sessions/api-keys/admin surfaces.

import { z } from 'zod';

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
  resendBaseUrl: z.string().url().optional(),
  fromEmail: z.string().default('OpenAI Service <noreply@example.com>'),

  // ── Livepeer Open Clearinghouse (LOC) / proxy core ───────────────
  // The LOC owns route selection + payment-ticket minting. The gateway
  // opens a job per upstream call and settles actual units afterwards.
  locBaseUrl: z.string().url(),
  locApiKey: z.string().min(1),
  locTimeoutMs: z.coerce.number().int().positive().default(30000),
  locSettleIntervalMs: z.coerce.number().int().positive().default(15000),
  locSettleMaxAttempts: z.coerce.number().int().positive().default(20),
  locJobRetries: z.coerce.number().int().nonnegative().default(2),
  /** Offering id → runner-facing model name. The LOC offering id selects
   * the route, but brokers forward the JSON body verbatim to the runner,
   * which only accepts its own serving name (e.g. vLLM's model id).
   * Until the LOC exposes the registry's extra.openai.model, this map
   * bridges the two. JSON object in LOC_MODEL_MAP. */
  locModelMap: z.record(z.string(), z.string()).default({}),
  brokerCallTimeoutMs: z.coerce.number().int().positive().default(30000),
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

function parseJsonEnv(name: string): unknown {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${name}: ${(err as Error).message}`);
  }
}

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
    resendBaseUrl: process.env['RESEND_BASE_URL'],
    fromEmail: process.env['FROM_EMAIL'],
    locBaseUrl: process.env['LOC_BASE_URL'],
    locApiKey: process.env['LOC_API_KEY'],
    locTimeoutMs: process.env['LOC_TIMEOUT_MS'],
    locSettleIntervalMs: process.env['LOC_SETTLE_INTERVAL_MS'],
    locSettleMaxAttempts: process.env['LOC_SETTLE_MAX_ATTEMPTS'],
    locJobRetries: process.env['LOC_JOB_RETRIES'],
    locModelMap: parseJsonEnv('LOC_MODEL_MAP'),
    brokerCallTimeoutMs: process.env['BROKER_CALL_TIMEOUT_MS'],
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
