// In-memory token-bucket rate limit per api_key_id.
//
// Single-process shape: this assumes one gateway replica. A
// multi-replica deploy needs distributed rate-limiting (Redis or
// equivalent) — separate plan.
//
// Defaults (config-driven):
//   - burst: 30 (initial + max accumulated tokens)
//   - per-minute: 60 (refill rate)
//
// On exhaustion: 429 with OpenAI-shaped error body and a
// `Retry-After` header. The reservation is NOT opened — rate limit
// runs before openReservation() so 429s don't pollute
// usage_reservations.
//
// Buckets are evicted when idle > 1h to bound memory.

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Config } from '../config.js';

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  lastTouchedMs: number;
}

const EVICT_IDLE_MS = 60 * 60 * 1000;
const EVICT_INTERVAL_MS = 5 * 60 * 1000;

class RateLimiter {
  readonly #burst: number;
  readonly #refillPerMs: number;
  readonly #buckets = new Map<string, Bucket>();
  #evictHandle: NodeJS.Timeout | null = null;

  constructor(opts: { burst: number; perMinute: number }) {
    this.#burst = opts.burst;
    this.#refillPerMs = opts.perMinute / (60 * 1000);
  }

  start(): void {
    if (this.#evictHandle) return;
    this.#evictHandle = setInterval(() => this.#evict(), EVICT_INTERVAL_MS);
    this.#evictHandle.unref?.();
  }

  stop(): void {
    if (this.#evictHandle) {
      clearInterval(this.#evictHandle);
      this.#evictHandle = null;
    }
  }

  /**
   * Returns `{ allowed: true }` if the call may proceed, or
   * `{ allowed: false, retryAfterSeconds }` otherwise.
   */
  consume(key: string, now = Date.now()): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const b = this.#buckets.get(key) ?? {
      tokens: this.#burst,
      lastRefillMs: now,
      lastTouchedMs: now,
    };
    // Refill.
    const elapsed = Math.max(0, now - b.lastRefillMs);
    b.tokens = Math.min(this.#burst, b.tokens + elapsed * this.#refillPerMs);
    b.lastRefillMs = now;
    b.lastTouchedMs = now;

    if (b.tokens < 1) {
      this.#buckets.set(key, b);
      const deficit = 1 - b.tokens;
      const retryMs = Math.ceil(deficit / this.#refillPerMs);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
    }

    b.tokens -= 1;
    this.#buckets.set(key, b);
    return { allowed: true };
  }

  #evict(now = Date.now()): void {
    for (const [key, b] of this.#buckets) {
      if (now - b.lastTouchedMs > EVICT_IDLE_MS) this.#buckets.delete(key);
    }
  }

  /** Test-only inspect. */
  inspect(): { size: number } {
    return { size: this.#buckets.size };
  }
}

export type { RateLimiter };

export function createRateLimiter(config: Config): RateLimiter {
  return new RateLimiter({
    burst: config.v1RateLimitBurst,
    perMinute: config.v1RateLimitPerMinute,
  });
}

/**
 * Fastify preHandler. Must run AFTER `bearerAuth` so `req.proxyAuth`
 * is populated.
 */
export function rateLimitV1(limiter: RateLimiter) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = req.proxyAuth;
    // No auth → bearerAuth already 401'd; this branch is defensive.
    if (!auth) return;
    const res = limiter.consume(auth.apiKeyId);
    if (res.allowed) return;
    void reply
      .code(429)
      .header('Retry-After', String(res.retryAfterSeconds))
      .send({
        error: {
          message: `rate limit exceeded — retry in ${res.retryAfterSeconds}s`,
          type: 'rate_limit_exceeded',
          code: 'rate_limit_exceeded',
        },
      });
  };
}
