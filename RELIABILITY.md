# RELIABILITY

Reliability properties this gateway is expected to uphold.

## Hard invariants

- **No charge, no commit.** v1 has no customer billing, so there is
  no ledger to commit or refund. The gateway is *always safe to
  retry* from the user's perspective: a failed request costs nothing.
- **Gateway pays the network via the LOC, once per opened job.** Each
  `/v1/*` request opens a LOC job that mints one payment envelope and
  charges the operator's credit balance the full estimate at issuance.
  Actual usage is settled afterwards so the LOC refunds the unused part.
  A missed settle over-pays the estimate (bounded by the durable
  settler); it never loses user money. See
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
- **The LOC owns route selection and failover.** The LOC returns a
  single route per job; per-candidate health cooldowns and multi-route
  failover no longer live in the gateway. On a 429/5xx job-open error
  or a returned `mode` the route can't use, the gateway re-opens a
  fresh job (`LOC_JOB_RETRIES`, default 2). See
  [`docs/design-docs/route-selector.md`](./docs/design-docs/route-selector.md).
- **Settlement is durable and async.** Every committed/refunded
  reservation enqueues a settle intent; a background settler (every
  `LOC_SETTLE_INTERVAL_MS`, default 15s, up to
  `LOC_SETTLE_MAX_ATTEMPTS`) reports actual units to the LOC. A growing
  backlog means refunds are *delayed, not lost*.
- **Catalog refresh is non-blocking.** The background task that
  populates the `models` table from the LOC capability catalog runs
  every `REGISTRY_REFRESH_INTERVAL_MS` (default 60s) and never blocks
  the request path. A failed refresh logs and retries.

## /health endpoint

The load-balancer contract. Returns the per-subsystem state:

```json
{
  "status": "ok" | "down",
  "checks": {
    "db":  { "status": "ok" | "error", "latencyMs": N, "error"?: "…" },
    "loc": { "status": "ok" | "error", "latencyMs": N, "error"?: "…" }
  },
  "pendingSettlements": N | null
}
```

HTTP code semantics:

- `200 + status="ok"` — Postgres and the LOC both respond.
- `503 + status="down"` — Postgres **or** the LOC is unreachable. Drop
  the gateway from rotation.

Both subsystems are required: `/v1/*` cannot serve without either, so a
failure of either flips the gateway to `down`. There is no `degraded`
state and no socket checks anymore.

`pendingSettlements` is informational — the count of `settle_state=
'pending'` reservations. A growing backlog means the settler can't reach
the LOC (refunds delayed, not lost); it does **not** flip the gateway to
`down` on its own.

Implementation: `gateway/src/routes/health.ts`. See
[`docs/design-docs/boot-sequence.md`](./docs/design-docs/boot-sequence.md)
for how the checks compose into the boot story.

## Failure modes

| What can fail | Visible to user | Visible in `/health` |
|---|---|---|
| LOC unreachable / `LOC_API_KEY` invalid | `/v1/*` returns 503 — the job can't be opened. The SaaS surfaces (`/portal/*`, `/admin/*`, public) keep working off Postgres. | `loc: error` → `status: down` → **HTTP 503** |
| LOC returns insufficient credit balance on `POST /v1/jobs` | `/v1/*` returns an error; reservation opened then refunded (settles 0). | `loc` may still be `ok` if the LOC itself is reachable |
| LOC returns a `mode` the route can't use | Gateway settles 0 (`mode_mismatch`) and re-opens a fresh job up to `LOC_JOB_RETRIES`; surfaces an error if retries exhaust. | n/a |
| Settler can't reach the LOC | No user impact — refunds are delayed, not lost. Backlog grows. | `pendingSettlements` rises (still `200` unless LOC ping also fails) |
| LOC advertises no offerings for the requested capability | Job open fails / no route — gateway returns the LOC error (typically `model_not_found` or `404`). | n/a |
| Selected broker returns 5xx / network error | Settle the job with 0 units (full refund) and propagate the broker's error as `502`. | n/a |
| Selected broker returns 4xx | Propagate verbatim — that's the user's problem, not a routing issue. | n/a |
| Postgres unreachable | `/v1/*` returns 500 (api-key lookup throws); SaaS routes return 500. New requests fail until DB recovers. | `db: error` → `status: down` → **HTTP 503** |
| Resend unreachable | Signup still succeeds (waitlist row persists). The verification-email send is logged loudly and *not* retried. Admin can resend via `POST /admin/waitlist/:id/resend-verification`. | n/a |
| Rate-limit exhaustion for an API key | `429 rate_limit_exceeded` with `Retry-After`. Reservation is NOT opened. | n/a |

## Observability surface

- **Prometheus** at `/metrics`. Optionally Bearer-gated via
  `METRICS_TOKEN`. Surfaces process metrics (heap, GC, event-loop
  lag), HTTP counters + duration histograms, `proxy_reservations_total
  {capability,outcome}`, `proxy_settle_total{outcome}`,
  `waitlist_signups_total`.
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
