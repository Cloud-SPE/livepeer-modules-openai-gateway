# RELIABILITY

Reliability properties this gateway is expected to uphold.

## Hard invariants

- **No duplicate execution.** An LOC-open retry uses the identical idempotency
  key and content. After broker dispatch, the gateway never automatically
  creates replacement paid work.
- **Gateway pays the network via the LOC, once per opened job.** Each
  `/v1/*` request opens a LOC job that issues one spend authorization and
  encumbers a ceiling for that exchange. Signed terminal broker evidence
  determines actual accounting and is submitted to LOC asynchronously. See
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
  upstream + transport, not by gateway buffering or usage parsing. Implementation
  detail: [`docs/design-docs/streaming-usage.md`](./docs/design-docs/streaming-usage.md).

## Soft invariants (best-effort, observable)

- **`p95` end-to-end latency for non-streaming chat** under nominal
  load stays within 1.5× upstream broker latency. Above that,
  something in the gateway is wrong.
- **The LOC owns route selection and failover.** The LOC returns a
  single route per job; per-candidate health cooldowns and multi-route
  failover do not live in the gateway. Retryable LOC-open failures repeat the
  identical request with bounded exponential backoff, including the typed
  `IDEMPOTENCY_IN_PROGRESS` state, bounded by `LOC_OPEN_MAX_ATTEMPTS`. See
  [`docs/design-docs/route-selector.md`](./docs/design-docs/route-selector.md).
- **Settlement is signed, durable, and async.** A lookup worker stores the
  complete broker-signed claim before a background settler submits it to LOC.
  Retries do not abandon transient failures; `LOC_SETTLE_ALERT_ATTEMPTS`
  controls alerting only.
- **Request outcome is not financial outcome.** `open`, `committed`, and
  `failed` describe what the gateway observed for the customer request. A
  failed response may still settle valid delivered work or become a LOC
  conservative charge. Only the separate signed-evidence and LOC-settlement
  fields describe accounting; no state is called `refunded`.
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
the LOC (signed settlement is delayed, not lost); it does **not** flip the gateway to
`down` on its own.

Implementation: `gateway/src/routes/health.ts`. See
[`docs/design-docs/boot-sequence.md`](./docs/design-docs/boot-sequence.md)
for how the checks compose into the boot story.

## Failure modes

| What can fail | Visible to user | Visible in `/health` |
|---|---|---|
| LOC unreachable / `LOC_API_KEY` invalid | `/v1/*` returns 503 — the job can't be opened. The SaaS surfaces (`/portal/*`, `/admin/*`, public) keep working off Postgres. | `loc: error` → `status: down` → **HTTP 503** |
| LOC returns insufficient credit balance on `POST /v1/jobs` | `/v1/*` returns `503`; no broker request occurs. | `loc` may still be `ok` if the LOC itself is reachable |
| LOC returns protocol, transport, or work-unit drift | Gateway fails closed before broker dispatch. | n/a |
| Settlement lookup or LOC settle is transiently unavailable | No response-path impact; the durable row remains retryable. | `pendingSettlements` rises (still `200` unless LOC ping also fails) |
| LOC advertises no offerings for the requested capability | Job open fails / no route — gateway returns the LOC error (typically `model_not_found` or `404`). | n/a |
| Selected broker returns 5xx / network error | Propagate `502`; recover the signed outcome independently by job or request ID. | n/a |
| Selected broker returns a protocol-compliant 4xx | Propagate the broker status/body. Persist its job identity and recover terminal evidence independently. | n/a |
| Broker terminal response omits required job/unit metadata or reports nonzero units for a non-streaming error | Fail closed as `502 protocol_response_invalid`; retain the reservation for request-ID recovery rather than inventing a zero-unit settlement. | n/a |
| Signed settlement exceeds the funded `max_total_units` | LOC rejects it as `usage_ceiling_exceeded`; retain the signed claim and surface a permanent reconciliation failure. The worker or estimator violated the funded bound. | n/a |
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
- **No customer-supplied idempotency contract on the OpenAI surface.** A second
  client POST is a new operation. Internally, every LOC open has a generated
  idempotency key that is retained and reused for identical recovery attempts;
  this prevents gateway retry ambiguity but does not deduplicate two distinct
  client calls.
- **In-process rate-limit only.** A multi-replica deploy doesn't
  share buckets; a user gets `N * per-replica-burst` effective
  burst. Distributed rate-limiting is a future plan.
- **No SLA.** This is beta.

## Protocol-4 recovery

Migration 0010 records the public LOC open intent before network I/O. After
the foreground retry grace period, recovery repeats identical opens solely
to recover identity; it never replays workload bytes. NO_RECORD and
ADMISSION_REJECTED remain eligible for polling. LOC independently requests
fenced non-admission evidence and exposes authoritative job status.
LOC status, signed broker evidence and customer outcome stay distinct; a
conservative full charge is never presented as a broker claim or refund.
The historical ten-attempt debit expiration no longer applies.
