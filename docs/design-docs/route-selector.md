# Route selector

How the gateway picks a broker for each `/v1/*` request, preserves the
resolver's quote-bound route identity, and tracks per-broker health.
Catalog/debug snapshot reads now live on a separate registry-catalog
surface.

## Mode

The selector is resolver-driven only. It queries
`service-registry-daemon` over UDS gRPC, ranks candidates, and tracks
health. There is no static broker fallback in the current runtime.

## gRPC surface

From `proto/livepeer/registry/v1/resolver.proto`:

```protobuf
service Resolver {
  rpc SelectMany(SelectRequest) returns (SelectManyResult);
  rpc ListKnown(google.protobuf.Empty) returns (ListKnownResult);
  rpc ResolveByAddress(ResolveByAddressRequest) returns (ResolveResult);
}
```

There are now two distinct resolver call paths in the gateway:

1. **Hot path — `select()`**
   Calls `SelectMany(capability, offering)` and receives payment-ready
   routes in resolver order. Each selected `RouteCandidate` carries:
   - broker URL
   - operator eth address
   - capability / offering
   - `pricePerWorkUnitWei`
   - `workUnit`
   - `unitsPerPrice`
   - `quoteId`
   - `quoteVersion`
   - `constraintFingerprint`
   - `routeFingerprint`
2. **Catalog/debug path — `registryCatalog.inspect()`**
   Uses `ListKnown` + `ResolveByAddress` to build a flattened snapshot
   for `/admin/registry/candidates` and the background `/v1/models`
   refresh task.
`registryCatalog.inspect()` is live; it does not keep an in-process TTL
cache.

## Ranking

For an inbound request with `capability`, user-facing `model`/offering,
optional
`interactionMode`, plus selection hints from the request body
(`extra`, `constraints`, `maxPricePerUnitWei`):

1. **Selection RPC** requests `SelectMany(capability, offering)`.
   If the incoming OpenAI `model` id is not itself a resolver offering
   key, the selector uses `registryCatalog.inspect()` to map the model
   to one or more live offerings for that capability first, then calls
   `SelectMany` per offering.
2. **Filter** resolver-returned routes by `interactionMode`, required
   `constraints`, and max price.
3. **Stable reorder** by preferred `extra` match score only.
   Resolver order remains the primary ranking authority.
4. **Re-rank** via `RouteHealthTracker.rankCandidates()` — pushes
   cooling-down candidates to the back of the list.

The dispatch loop iterates the ranked list, trying candidates until
one succeeds or all fail. Once a route is selected, the gateway uses
the route's exact capability string end to end for:
- `Livepeer-Capability`
- payer-daemon `accepted_price.capability`
- reservation audit metadata

## Health tracking

`RouteHealthTracker` (extends `GenericRouteHealthTracker`, inlined
from upstream into `proxy/service/genericRouteHealth.ts`) keeps a
per-candidate state machine:

| Field | Meaning |
|---|---|
| `consecutiveFailures` | Reset to 0 on success. |
| `cooldownUntil` | When >= now, the candidate is in cooldown. |
| `lastFailureAt` / `lastFailureReason` | Diagnostic only. |
| `lastSuccessAt` | Diagnostic only. |

Cooldown opens when `consecutiveFailures ≥ config.routeFailureThreshold`
(default 2). Cooldown lasts `config.routeCooldownMs` (default 30s).

`shouldPenalize(err)` decides whether a failure counts:
- `LivepeerBrokerError` with status ≥ 500 → penalize (and retry).
- `LivepeerBrokerError` with status 429 → penalize (and retry).
- Other `LivepeerBrokerError` (4xx) → don't penalize, don't retry.
- Non-`LivepeerBrokerError` (network/timeout) → penalize, retry.

## Why a separate background refresh

`/v1/models` reads the `models` table, not the hot-path `SelectMany`
RPC. If it called the resolver on every catalog read, every request
would block on gRPC + chain-cache lookups and would need its own
catalog-specific selection contract.

`gateway/src/registry/refresh.ts` runs every
`config.registryRefreshIntervalMs` (default 60s) — calls
`registryCatalog.inspect()` live against the resolver,
flattens to `models` rows, upserts. Stale models get
`active=false`. `/v1/models` reads `active=true` only.

The cached model rows now preserve the quote-aware fields visible in
the inspection snapshot:
- `unitsPerPrice`
- `quoteId`
- `quoteVersion`
- `constraintFingerprintHex`
- `routeFingerprintHex`

This means there are two separate data lifecycles:
- Live `SelectMany` reads per request — for request-time routing.
- The `models` table refresh every 60s — for catalog reads.

Admin candidate inspection is a live resolver view. `/v1/models` is the
persisted cache view and now fails closed with `503
models_cache_unavailable` / `models_cache_stale` when the cache is not
safe to serve.

## What we DO NOT do

- **No cached hot-path route selection.** Request routing does not read
  any catalog cache; it calls `SelectMany` directly.
- **No persisting selector state across restarts.** Health tracking
  is in-memory; a fresh process starts every candidate clean.
- **No retry budget timeout.** We retry every candidate sequentially
  until all fail. The HTTP client itself has a connect timeout, but
  the loop will exhaust the candidate list.
- **No load balancing within a candidate.** Each `(broker, offering,
  ethAddress)` triple is one candidate. If a broker advertises many
  offerings, that's many candidates.

## Where it lives

| Concern | File |
|---|---|
| Hot-path selection + ranking | `gateway/src/proxy/service/routeSelector.ts` |
| Registry catalog snapshot loader | `gateway/src/registry/catalog.ts` |
| Generic health tracker + Prometheus renderer | `gateway/src/proxy/service/genericRouteHealth.ts` |
| RouteHealthTracker (typed wrapper) | `gateway/src/proxy/service/routeHealth.ts` |
| Background refresh → models table | `gateway/src/registry/refresh.ts` |
| Boot wiring + cancel hook | `gateway/src/index.ts` |
| Proto files | `proto/livepeer/registry/v1/*.proto` |
| Admin surface | `gateway/src/routes/admin/registry.ts` → `/admin/registry/{candidates,health,models}` |
| Metrics renderer | `metrics.ts` calls `renderRouteHealthMetrics` per scrape |
