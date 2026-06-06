# Payment flow

How the gateway pays the Livepeer network for every `/v1/*` request via
the **LOC — Livepeer Open Clearinghouse**: the job lifecycle, where the
keys live (they don't — the LOC holds them), and the failure modes.

## Why payment exists in v1

Even though v1 has **no customer billing**, the gateway still has to pay
the Livepeer network on behalf of each request. Network orchestrators
won't serve traffic without a valid payment envelope; removing payment
removes the product. See [core-beliefs §6](./core-beliefs.md).

What changed: the gateway no longer mints tickets itself. It holds no
keystore and never talks to the chain. Route selection AND payment
minting are delegated to the LOC, reached over HTTPS with an `X-API-Key`
header. The gateway operator holds a LOC account with a wei-denominated
**credit balance**; the LOC's pooled wallet signs PM tickets.

## Wire shape

Every outbound request from gateway → broker carries:

```
Livepeer-Capability: openai:chat-completions
Livepeer-Offering:   qwen3:8b
Livepeer-Mode:       http-reqresp@v0  (or http-stream / http-multipart)
Livepeer-Payment:    <opaque payment_envelope from the LOC>
Livepeer-Request-Id: <uuid>
```

The `Livepeer-Payment` value is opaque to the gateway — it's the
`payment_envelope` the LOC returned when the job was opened. The broker
URL is also LOC-supplied (the `broker_url` field of the job).

## Job lifecycle

### 1. Open a job

Per outbound attempt the gateway calls the LOC:

```
POST /v1/jobs
{ "capability": "...", "offering": "...", "estimated_units": <n> }
→ { job_id, work_id, broker_url, mode, payment_envelope,
    expected_value_wei, settle_endpoint, ... }
```

The LOC does **route selection and payment minting in one call**, and
**charges the operator's credit balance the expected value of the full
estimate at issuance** (charge-at-issuance). `estimated_units` comes from
the per-endpoint request handler's heuristic.

### 2. Forward to the broker

The gateway forwards the request to `broker_url` with `payment_envelope`
in the `Livepeer-Payment` header. The http-reqresp / http-stream /
http-multipart wire modules in `proxy/livepeer/` are unchanged.

### 3. Settle actual usage

After the response — success or failure — the same DB write that commits
or refunds the reservation enqueues a durable **settle intent**:
`usage_reservations.loc_job_id`, `settle_state='pending'`,
`settle_actual_units`. A background settler then calls:

```
POST /v1/jobs/{id}/settle
{ "actual_units": <n>, "outcome": "..." }
```

which **refunds the unused part of the estimate**. The settler runs every
`LOC_SETTLE_INTERVAL_MS` (default 15s), up to `LOC_SETTLE_MAX_ATTEMPTS`
(default 20). `409 job_already_settled` and `404 job_not_found` are
**terminal successes** (idempotent — the job is already accounted for).

- **Failed broker attempts settle with 0 units** → full refund.
- **Mode mismatch**: if the LOC returns a job whose `mode` doesn't match
  what the route needs, the gateway settles 0 with outcome
  `mode_mismatch` and opens a fresh job (`LOC_JOB_RETRIES`, also covering
  429/5xx). See [route-selector.md](./route-selector.md).

## Charge-at-issuance + durable async settlement

The estimate is charged up front; settlement only ever **refunds** the
unused part. This is deliberate:

- The refund is not on the request critical path. A transient LOC blip
  must not block the user's response or strand money.
- A missed settle means **over-paying the estimate** — bounded by the
  durable settler retrying until it lands. It never charges the user and
  never loses money beyond the (refundable) estimate.

## What we DO NOT do

- **No ticket-signing in the gateway.** The LOC owns the keystore +
  ticket lifecycle. The gateway holds no keys and never touches the
  chain.
- **No `INVALID_RECIPIENT_RAND` retry loop.** The daemon-era payment
  retry on recipient-rand changes is gone — the LOC owns the ticket
  lifecycle end to end.
- **No payment caching / reuse.** Each job mints its own envelope.
- **No payment validation.** The orchestrator-side `capability-broker`
  validates envelopes; the gateway treats them as opaque.

## Failure modes

| What fails | What the gateway does | Visible to user as |
|---|---|---|
| LOC unreachable / `LOC_API_KEY` invalid | `POST /v1/jobs` throws `LocApiError`. Reservation opened then refunded. | `/v1/*` returns `503`. `/health` flips `loc: error` → `down`. |
| LOC credit balance insufficient | Job open fails. Reservation refunded (settles 0). | `/v1/*` error; balance visible at `GET /admin/registry/loc`. |
| LOC returns a `mode` the route can't use | Settle 0 (`mode_mismatch`), re-open a fresh job (`LOC_JOB_RETRIES`). | If retries exhaust: surfaced error. |
| Broker rejects / 5xx / network error | Settle the job with 0 units (full refund); propagate the broker error. | `502` passthrough of the broker error. |
| Settler can't reach the LOC | Settle intent stays `pending`; retried up to `LOC_SETTLE_MAX_ATTEMPTS`. No user impact — refund delayed, not lost. | none directly; `pendingSettlements` in `/health` rises. |

## Operator setup

See [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md) §"LOC clearinghouse" for
config. Short version: set `LOC_BASE_URL` + `LOC_API_KEY` and keep the
account's credit balance funded. There is no keystore or chain RPC to
provision. `make loc-smoke` opens a 1-unit job and settles 0 against the
live LOC.

## Where it lives

| Concern | File |
|---|---|
| Typed LOC HTTP client (`openJob`, `settleJob`, `getBalance`, `health`) + `LocApiError` | `gateway/src/loc/client.ts` |
| Per-request open → dispatch → settle flow | `gateway/src/loc/dispatch.ts` |
| Durable background settler | `gateway/src/loc/settler.ts` |
| Settle columns | `gateway/migrations/0004_loc_settlement.sql` |
| Boot wiring | `gateway/src/index.ts` |
| Config | `gateway/src/config.ts` — `LOC_BASE_URL`, `LOC_API_KEY`, `LOC_TIMEOUT_MS`, `LOC_SETTLE_INTERVAL_MS`, `LOC_SETTLE_MAX_ATTEMPTS`, `LOC_JOB_RETRIES` |
| Health probe | `gateway/src/routes/health.ts` (LOC `health()` ping + `pendingSettlements`) |

## History

This replaces the daemon-era payment flow, where the gateway minted
`Livepeer-Payment` envelopes itself via a `payment-daemon` over a
unix-socket gRPC call (`CreatePayment`) using a funded local keystore.
That design — including its proto surface and the
`INVALID_RECIPIENT_RAND` retry loop — is described in the completed exec
plans under [`../exec-plans/completed/`](../exec-plans/completed/)
(see `0005-onchain-only-runtime.md`).
