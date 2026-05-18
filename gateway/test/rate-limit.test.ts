import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter } from '../src/proxy/rateLimit.js';
import type { Config } from '../src/config.js';

function makeConfig(burst: number, perMinute: number): Config {
  return {
    v1RateLimitBurst: burst,
    v1RateLimitPerMinute: perMinute,
  } as Config;
}

describe('RateLimiter', () => {
  it('allows up to `burst` requests immediately', () => {
    const rl = createRateLimiter(makeConfig(5, 60));
    for (let i = 0; i < 5; i++) {
      const r = rl.consume('k', 1_000);
      assert.equal(r.allowed, true);
    }
    const denied = rl.consume('k', 1_000);
    assert.equal(denied.allowed, false);
  });

  it('refills 1 token per second at 60/min', () => {
    const rl = createRateLimiter(makeConfig(1, 60));
    assert.equal(rl.consume('k', 0).allowed, true);
    // Immediately after, no tokens.
    assert.equal(rl.consume('k', 1).allowed, false);
    // After 1 second, one token refilled.
    assert.equal(rl.consume('k', 1_001).allowed, true);
  });

  it('returns sensible Retry-After when denied', () => {
    const rl = createRateLimiter(makeConfig(1, 60));
    rl.consume('k', 0); // exhaust
    const r = rl.consume('k', 0);
    assert.equal(r.allowed, false);
    if (!r.allowed) {
      // 1 token at 60/min = 1s refill — Retry-After should be 1.
      assert.ok(r.retryAfterSeconds >= 1, `expected ≥1s, got ${r.retryAfterSeconds}`);
      assert.ok(r.retryAfterSeconds <= 2, `expected ≤2s, got ${r.retryAfterSeconds}`);
    }
  });

  it('isolates buckets per key', () => {
    const rl = createRateLimiter(makeConfig(1, 60));
    assert.equal(rl.consume('alice', 0).allowed, true);
    assert.equal(rl.consume('alice', 1).allowed, false);
    // Bob's bucket is independent.
    assert.equal(rl.consume('bob', 1).allowed, true);
  });

  it('caps refill at `burst` (no infinite accumulation)', () => {
    const rl = createRateLimiter(makeConfig(3, 60));
    // Use one immediately.
    rl.consume('k', 0);
    // Wait an hour — should refill to 3, not 60.
    for (let i = 0; i < 3; i++) {
      assert.equal(rl.consume('k', 3_600_000 + i).allowed, true);
    }
    assert.equal(rl.consume('k', 3_600_001).allowed, false);
  });

  it('returns size from inspect()', () => {
    const rl = createRateLimiter(makeConfig(1, 60));
    assert.equal(rl.inspect().size, 0);
    rl.consume('a', 0);
    rl.consume('b', 0);
    assert.equal(rl.inspect().size, 2);
  });
});
