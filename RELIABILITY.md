# RELIABILITY

Reliability properties this gateway is expected to uphold.

## Hard invariants

- **No charge, no commit.** v1 has no customer billing, so there is
  no ledger to commit or refund. The gateway is *always safe to
  retry* from the user's perspective: a failed request costs nothing.
- **Gateway pays the network exactly once per attempted upstream
  call.** Payment envelopes are minted *per broker attempt*. If a
  request is retried against a second broker, a second payment
  envelope is minted. This is the wire-spec contract — see
  [`docs/design-docs/payment-flow.md`](./docs/design-docs/payment-flow.md).
- **`/v1/*` is API-key-only.** No anonymous access, no cookie-session
  acceptance on `/v1/*`. A missing or invalid API key returns `401`
  in OpenAI shape with `WWW-Authenticate: Bearer`.
- **`/v1/*` is rate-limited per API key.** Default 60 req/min, burst
  30. Configurable. 429 returned with `Retry-After`. See
  [`SECURITY.md`](./SECURITY.md#per-api-key-rate-limit) and
  [`docs/exec-plans/completed/0001-v1-hardening.md`](./docs/exec-plans/completed/0001-v1-hardening.md).
- **Streaming is non-buffering.** SSE chunks for
  `/v1/chat/completions` with `stream: true` pipe to the client *as
  they arrive* from the broker. Latency-to-first-byte is bounded by
  upstream + transport, not by gateway buffering. Implementation
  detail: [`docs/design-docs/streaming-usage.md`](./docs/design-docs/streaming-usage.md).

## Soft invariants (best-effort, observable)

- **`p95` end-to-end latency for non-streaming chat** under nominal
  load stays within 1.5× upstream broker latency. Above that,
  something in the gateway is wrong.
- **Route failover happens.** If a selected broker returns a
  retryable error (5xx or 429) or times out, the gateway tries the
  next ranked candidate before failing. See
  [`docs/design-docs/route-selector.md`](./docs/design-docs/route-selector.md).
- **Route health backs off bad brokers.** A broker that fails the
  configured threshold (default 2 consecutive failures) enters a
  cooldown (default 30s) and is deprioritised in candidate
  selection.
- **Registry refresh is non-blocking.** The background task that
  populates the `models` table runs every
  `REGISTRY_REFRESH_INTERVAL_MS` (default 60s) and never blocks the
  request path. A failed refresh logs and retries.

## /health endpoint

The load-balancer contract. Returns the per-subsystem state:

```json
{
  "status": "ok" | "degraded" | "down",
  "checks": {
    "db":       { "status": "ok" | "error", "latencyMs": N, "error"?: "…" },
    "payer":    { "status": "ok" | "error" | "skipped", "latencyMs": N, "error"?: "…" },
    "registry": { "status": "ok" | "error" | "skipped", "latencyMs": N, "error"?: "…" }
  }
}
```

HTTP code semantics:

- `200 + status="ok"` — all subsystems healthy.
- `200 + status="degraded"` — DB is fine, but payer or registry
  socket is missing or unreachable. The gateway still serves
  `/portal/*`, `/admin/*`, and the public surface; `/v1/*` will
  500 at request time until the daemons come back.
- `503 + status="down"` — DB is unreachable. Drop the gateway from
  rotation.

The rule is intentional: a load balancer should keep the gateway in
rotation when it can still serve *something*. Only DB failure
disqualifies it entirely.

Implementation: `gateway/src/routes/health.ts`. See
[`docs/design-docs/boot-sequence.md`](./docs/design-docs/boot-sequence.md#step-9-server)
for how the checks compose into the boot story.

## Failure modes

| What can fail | Visible to user | Visible in `/health` |
|---|---|---|
| `service-registry-daemon` unreachable | Static-broker mode keeps serving (if `LIVEPEER_BROKER_URL` is set). Registry-driven mode: `/v1/*` returns 502 on first request because no candidates can be loaded. | `registry: error` → `status: degraded` |
| `payment-daemon` unreachable / not initialised at boot | `/v1/*` returns `500 api_error` because `buildPayment` throws. Reservation is opened then refunded. | `payer: error` → `status: degraded` |
| No brokers advertise the requested capability | `attemptCandidates` throws — gateway returns the last broker's error (typically `model_not_found` or `404`). | n/a |
| Selected broker returns 5xx / network error | Mark broker unhealthy, try next ranked candidate. After all candidates exhaust, propagate the last broker's error as `502`. | n/a |
| Selected broker returns 4xx | Propagate verbatim — that's the user's problem, not a routing issue. | n/a |
| Postgres unreachable | `/v1/*` returns 500 (api-key lookup throws); SaaS routes return 500. New requests fail until DB recovers. | `db: error` → `status: down` → **HTTP 503** |
| Resend unreachable | Signup still succeeds (waitlist row persists). The verification-email send is logged loudly and *not* retried. Admin can resend via `POST /admin/waitlist/:id/resend-verification`. | n/a |
| Rate-limit exhaustion for an API key | `429 rate_limit_exceeded` with `Retry-After`. Reservation is NOT opened. | n/a |

## Observability surface

- **Prometheus** at `/metrics`. Optionally Bearer-gated via
  `METRICS_TOKEN`. Surfaces process metrics (heap, GC, event-loop
  lag), HTTP counters + duration histograms, `proxy_reservations_total
  {capability,outcome}`, `waitlist_signups_total`,
  `livepeer_gateway_route_health_*`.
- **Structured JSON logs** to stdout via pino. Per-request fields:
  `reqId`, `req.method`, `req.url`, `res.statusCode`,
  `responseTime`, plus ad-hoc structured fields (e.g. `apiKeyId`,
  `email`, `err`).
- **`usage_reservations`** is the durable per-request log.
  Queryable via `/admin/usage` (aggregate) and `/portal/usage` (per
  user).

## What we explicitly accept

- **No retries on stream-mid-flight failures.** Once SSE bytes have
  reached the client, a broker disconnection terminates the stream.
  Users see a truncated response.
- **No idempotency keys in v1.** A duplicate POST creates duplicate
  upstream work. Most OpenAI SDKs don't retry POSTs automatically,
  so this rarely bites in practice.
- **In-process rate-limit only.** A multi-replica deploy doesn't
  share buckets; a user gets `N * per-replica-burst` effective
  burst. Distributed rate-limiting is a future plan.
- **No SLA.** This is beta.
