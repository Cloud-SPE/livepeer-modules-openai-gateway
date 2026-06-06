# Route selector

How the gateway gets a broker for each `/v1/*` request. Short version:
**it doesn't select** — the **LOC (Livepeer Open Clearinghouse)** owns
route selection. The gateway opens a job and forwards to the single route
the LOC returns. This doc covers what that means, the one piece of
routing logic that *does* live in the gateway (the mode-mismatch retry),
and the separate catalog refresh that feeds `/v1/models`.

## Selection lives in the LOC

For each outbound attempt the gateway calls:

```
POST /v1/jobs
{ "capability": "...", "offering": "...", "estimated_units": <n> }
→ { job_id, work_id, broker_url, mode, payment_envelope,
    expected_value_wei, ... }
```

The LOC selects the route AND mints the payment envelope in one call,
charging the operator's credit balance the full estimate at issuance (see
[payment-flow.md](./payment-flow.md)). The gateway then forwards the
request to `broker_url` with `payment_envelope` in the `Livepeer-Payment`
header. The model id is the LOC offering id; there is no alias mapping.

## The one routing decision the gateway still makes: mode mismatch

The LOC returns a `mode` for the job (`http-reqresp@v0` /
`http-stream@v0` / `http-multipart@v0`). The gateway's per-endpoint
handler knows which wire module the route needs. If they don't match, the
gateway:

1. settles the job with **0 units** and outcome `mode_mismatch` (full
   refund), then
2. opens a **fresh job** and retries.

This retry loop (`gateway/src/loc/dispatch.ts`) also covers `429` and
`5xx` on job open, bounded by `LOC_JOB_RETRIES` (default 2 retries, so up
to 3 attempts total). If retries exhaust, the gateway surfaces the error.

`LocApiError` carries the LOC's status/code so the dispatch loop can
decide retryability. A broker-side `4xx` after dispatch is propagated
verbatim — that's the user's problem, not a routing issue — and the job
is settled with 0 units.

## What was dropped (and why)

The daemon-era gateway ran its own resolver-backed selector. All of the
following is **gone**, because the LOC returns a single route per job and
owns selection and the ticket lifecycle:

- **`Livepeer-Selector-Extra` / `Livepeer-Selector-Constraints` /
  `Livepeer-Selector-Max-Price-Wei` request-header hints.** Callers no
  longer steer selection from the request.
- **Preferred-`extra` ranking / constraint + max-price filtering.** The
  LOC applies whatever policy it applies.
- **Per-route health cooldown / failover across multiple candidates.**
  There is no candidate list in the gateway and no in-process health
  tracker. The LOC is the single selection authority; two systems
  ranking routes would just disagree about price and health.

This keeps one selection authority and removes a whole class of
gateway/daemon drift.

## Catalog refresh (separate from the hot path)

`/v1/models` does **not** open a job. It reads the `models` table, which a
background task refreshes from the LOC capability catalog:

- `gateway/src/registry/catalog.ts` is now LOC-backed: `inspect()` calls
  `GET /v1/capabilities` and `flattenCapabilities()` turns the response
  into `RouteCandidate[]` (one row per offering id).
- `gateway/src/registry/refresh.ts` runs every
  `config.registryRefreshIntervalMs` (default 60s), upserts the rows, and
  marks vanished offerings `active=false`. `/v1/models` reads
  `active=true` only and fails closed with `503 models_cache_unavailable`
  / `models_cache_stale` when the cache is not safe to serve.

The refresh is structurally unchanged from before, but the source is the
LOC catalog instead of a resolver. **Display metadata** (name,
description, provider, category) is no longer catalog-sourced — only
operator overrides populate it.

So there are two lifecycles:
- Per-request `POST /v1/jobs` to the LOC — for routing + payment.
- The `models` table refresh every 60s — for catalog reads.

## What we DO NOT do

- **No hot-path catalog reads.** Request routing opens a LOC job; it
  never reads the `models` cache.
- **No persisting selector state.** There is no selector state to
  persist — the LOC owns it.
- **No gateway-side candidate failover.** One job → one route. Retries
  re-open a job; they don't iterate a local candidate list.

## Where it lives

| Concern | File |
|---|---|
| Job open → dispatch → settle (incl. mode-mismatch retry) | `gateway/src/loc/dispatch.ts` |
| Typed LOC client | `gateway/src/loc/client.ts` |
| LOC-backed catalog snapshot loader | `gateway/src/registry/catalog.ts` |
| Background refresh → models table | `gateway/src/registry/refresh.ts` |
| Boot wiring + cancel hook | `gateway/src/index.ts` |
| Admin surface | `gateway/src/routes/admin/registry.ts` → `/admin/registry/{candidates,loc,models,summary,model-health}` |

## History

This replaces the daemon-era route selector, where the gateway queried a
`service-registry-daemon` over unix-socket gRPC (`SelectMany`,
`ListKnown`, `ResolveByAddress`), ranked candidates by constraints /
extras / price, and tracked per-candidate health cooldowns with failover.
That design — including its proto surface and the
`gateway-route-health` tracker — is described in the completed exec plans
under [`../exec-plans/completed/`](../exec-plans/completed/) (see
`0004-registry-catalog-split.md` and `0005-onchain-only-runtime.md`).
