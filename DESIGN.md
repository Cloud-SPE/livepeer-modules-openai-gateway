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
Clearinghouse)** — which picks the route and issues the spend authorization —
and forwards the request to the broker the LOC returns, returning the
response verbatim. Actual usage is settled back to the LOC afterwards.

## Six layers

| # | Layer | What it does |
|---|---|---|
| 1 | OpenAI surface | `/v1/chat/completions`, `/v1/embeddings`, `/v1/images/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/rerank`. Streaming where applicable. |
| 2 | Wire translation | OpenAI request → `POST /v1/job` with `Livepeer-Protocol: paid-job/v1`; ordinary HTTP selects unary, stream, or multipart transport. |
| 3 | Route selection + payment | Idempotent `POST /v1/jobs` to LOC returns one route, stable request identity, work unit, funded envelope, and settlement endpoint. |
| 4 | Settlement | A broker-signed claim is retrieved independently of the response body, stored durably, and submitted to LOC. Estimates only bound funding. |
| 5 | SaaS shell | Postgres-backed waitlist + email-verify + admin-approval + API-key issuance. Cookie sessions for the portal UI. `ADMIN_TOKEN` env var bootstraps admin access. |
| 6 | Evidence and settlement | Customer outcomes, broker claims, and LOC settlement are recorded separately; only a persisted signed broker claim can enter the durable settlement queue. |

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

- **LOC — Livepeer Open Clearinghouse**, run from its sibling checkout for
  localhost integration and reached with an `X-API-Key` header.

## Funded ceiling + durable signed settlement

LOC reserves the request's funded ceiling at `POST /v1/jobs`. After broker
execution, the gateway retrieves and persists the signed terminal claim. A
background settler submits that exact evidence to LOC. Transient failures retry
without abandonment; `LOC_SETTLE_ALERT_ATTEMPTS` only controls alerting. A
`409 job_already_settled` is terminal success after a lost response. Evidence,
identity, and work-unit failures stop for operator review.

Why durable + async rather than inline: accounting is not on the response
critical path, and a transient LOC blip must not block the user's response or
discard evidence. The durable workers retain lookup and settlement work until
it reaches an explicit terminal state.

### Why the gateway does not rank routes

Selection used to live in the gateway (a resolver-backed `routeSelector`
with per-candidate health cooldowns + failover across many candidates,
plus `Livepeer-Selector-*` request-header hints, preferred-`extra`
ranking, max-price filtering, and an `INVALID_RECIPIENT_RAND` payment
retry loop). All of that is **dropped**: the LOC returns a single route
per job and owns selection and the ticket lifecycle end to end. The
gateway validates LOC's protocol, selected HTTP transport, and work unit before
broker dispatch. Transient open failures retry the identical request under the
same idempotency key; the gateway never replaces an admitted job.

Capability workers are not part of this repo or compose.

## Open design questions

Tracked in [`docs/exec-plans/tech-debt-tracker.md`](./docs/exec-plans/tech-debt-tracker.md).
