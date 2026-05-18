# DESIGN

Architectural overview at a glance. The deep version lives in
[`docs/design-docs/`](./docs/design-docs/).

## The pin

> **An OpenAI-compatible inference gateway whose backend is the Livepeer
> decentralized GPU network, with a thin SaaS shell for access control.**

Every architectural choice in this repo flows from that requirement.

## Shape in one sentence

A single TypeScript Fastify service translates OpenAI-shaped requests into
the Livepeer wire spec, picks a worker from `service-registry-daemon`,
mints a payment envelope via `payment-daemon`, and forwards the request to
the selected `capability-broker` — returning the response verbatim.

## Six layers

| # | Layer | What it does |
|---|---|---|
| 1 | OpenAI surface | `/v1/chat/completions`, `/v1/embeddings`, `/v1/images/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/rerank`. Streaming where applicable. |
| 2 | Wire translation | OpenAI request → `Livepeer-Capability` header + mode (`http-reqresp@v0` / `http-stream@v0` / `http-multipart@v0`). All in `gateway/src/proxy/livepeer/`. |
| 3 | Route selection | `service-registry-daemon` (gRPC over UDS) gives candidate brokers per capability. `routeSelector` ranks by constraints / extras / price; `routeHealth` tracks per-candidate failure cooldowns. |
| 4 | Payment | `payment-daemon` (gRPC over UDS) mints `Livepeer-Payment` envelopes. The gateway pays the network on behalf of every request — customers pay nothing in v1. |
| 5 | SaaS shell | Postgres-backed waitlist + email-verify + admin-approval + API-key issuance. Cookie sessions for the portal UI. `ADMIN_TOKEN` env var bootstraps admin access. |
| 6 | Usage tracking | Per-request reservations are opened, then committed or refunded with route-aware settlement metadata for visibility and future billing evolution. |

## What this gateway does NOT do (v1)

- **Charge customers.** No Stripe, no wallet, no rate cards.
- **Hardcode model lists.** `/v1/models` reflects what the on-chain
  registry advertises right now.
- **Realtime / WebSocket.** `/v1/realtime` is v2.
- **Run workloads in-process.** Capability execution happens on the
  network side; the gateway only forwards.

## Components

```
livepeer-modules-openai/
├── gateway/             # this service
├── web/{site,portal,admin}/   # 3 zero-build Lit SPAs
└── proto/               # gRPC protos shared with the daemons
```

External (Docker images pulled at runtime):

- `service-registry-daemon` (`tztcloud/livepeer-service-registry-daemon`)
- `payment-daemon` (`tztcloud/livepeer-payment-daemon`)

## Stack composition for `make dev`

```
  ┌────────────────┐    /v1/*    ┌────────┐                ┌────────────┐
  │  curl / SDK    │ ──────────► │gateway │ ─── UDS ──► │ registry-  │
  │  (host)        │             │        │            │ daemon     │
  └────────────────┘             └───┬────┘            └────────────┘
                                     │
                                     ├ UDS ─► payer-daemon
                                     │
                                     ▼
                              ┌──────────────┐
                              │   postgres   │
                              └──────────────┘
```

Capability workers are not part of this compose. The gateway runtime
itself remains on-chain only and does not support static registry
overlays.

## Open design questions

Tracked in [`docs/exec-plans/tech-debt-tracker.md`](./docs/exec-plans/tech-debt-tracker.md).
