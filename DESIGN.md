# DESIGN

Architectural overview at a glance. The deep version lives in
[`docs/design-docs/`](./docs/design-docs/).

## The pin

> **An OpenAI-compatible inference gateway whose backend is the Livepeer
> decentralized GPU network, with a thin SaaS shell for access control.**

Every architectural choice in this repo flows from that requirement.

## Shape in one sentence

A single TypeScript Fastify service translates OpenAI-shaped requests into
the Livepeer wire spec, opens a job on the **LOC (Livepeer Open
Clearinghouse)** — which picks the route AND mints the payment envelope —
and forwards the request to the broker the LOC returns, returning the
response verbatim. Actual usage is settled back to the LOC afterwards.

## Six layers

| # | Layer | What it does |
|---|---|---|
| 1 | OpenAI surface | `/v1/chat/completions`, `/v1/embeddings`, `/v1/images/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/rerank`. Streaming where applicable. |
| 2 | Wire translation | OpenAI request → `Livepeer-Capability` header + mode (`http-reqresp@v0` / `http-stream@v0` / `http-multipart@v0`). All in `gateway/src/proxy/livepeer/`. |
| 3 | Route selection + payment | `POST /v1/jobs` to the LOC returns a single route (`broker_url`, `mode`) AND the `payment_envelope` in one call. The LOC owns selection and mints the PM ticket; the gateway forwards the envelope in the `Livepeer-Payment` header. `gateway/src/loc/`. |
| 4 | Settlement | The gateway charges the LOC credit balance the full estimate at issuance, then a durable background settler reports actual units so the LOC refunds the unused part. Customers pay nothing in v1; the operator pays the network via the LOC. |
| 5 | SaaS shell | Postgres-backed waitlist + email-verify + admin-approval + API-key issuance. Cookie sessions for the portal UI. `ADMIN_TOKEN` env var bootstraps admin access. |
| 6 | Usage tracking | Per-request reservations are opened, then committed or refunded; the same write enqueues a durable settle intent for visibility and future billing evolution. |

## What this gateway does NOT do (v1)

- **Charge customers.** No Stripe, no wallet, no rate cards.
- **Hardcode model lists.** `/v1/models` reflects what the LOC
  capability catalog advertises right now.
- **Hold chain keys or talk to the chain.** The LOC owns the pooled
  PM-ticket wallet and all chain access.
- **Realtime / WebSocket.** `/v1/realtime` is v2.
- **Run workloads in-process.** Capability execution happens on the
  network side; the gateway only forwards.

## Components

```
livepeer-modules-openai/
├── gateway/             # this service (incl. src/loc/ — LOC client)
└── web/{site,portal,admin}/   # 3 zero-build Lit SPAs
```

External (not in this repo, not in compose):

- **LOC — Livepeer Open Clearinghouse** (`https://loc.cloudspe.com`),
  reached over HTTPS with an `X-API-Key` header.

## Charge-at-issuance + durable async settlement

The LOC charges the operator's credit balance the **full estimate** when
the job is issued (`POST /v1/jobs`). After the response — success or
failure — the gateway records the actual units and a durable settle
intent (`usage_reservations.settle_state='pending'`). A background
settler (`gateway/src/loc/settler.ts`, every `LOC_SETTLE_INTERVAL_MS`,
up to `LOC_SETTLE_MAX_ATTEMPTS`) calls `POST /v1/jobs/{id}/settle`, which
**refunds the unused part of the estimate**. Failed broker attempts
settle with 0 units (full refund). `409 job_already_settled` and
`404 job_not_found` are terminal successes (idempotent).

Why durable + async rather than inline: the refund is not on the request
critical path, and a transient LOC blip must not block the user's
response or strand money. A missed settle only ever means *over-paying
the estimate* — bounded by the durable settler retrying until it lands.

### Why the gateway no longer ranks routes

Selection used to live in the gateway (a resolver-backed `routeSelector`
with per-candidate health cooldowns + failover across many candidates,
plus `Livepeer-Selector-*` request-header hints, preferred-`extra`
ranking, max-price filtering, and an `INVALID_RECIPIENT_RAND` payment
retry loop). All of that is **dropped**: the LOC returns a single route
per job and owns selection and the ticket lifecycle end to end. The
gateway's only routing concern now is a **mode-mismatch retry** — if the
LOC returns a `mode` that doesn't match the wire module the route needs
(`http-reqresp@v0` / `http-stream@v0` / `http-multipart@v0`), the gateway
settles 0 with outcome `mode_mismatch` and opens a fresh job
(`LOC_JOB_RETRIES`, also covering 429/5xx). This keeps one selection
authority and avoids two systems disagreeing about price or health.

Capability workers are not part of this repo or compose.

## Open design questions

Tracked in [`docs/exec-plans/tech-debt-tracker.md`](./docs/exec-plans/tech-debt-tracker.md).
