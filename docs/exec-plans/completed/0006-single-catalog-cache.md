# 0006 Single Catalog Cache

> Historical record. This plan documents the cache-shape change; prefer the current live design docs for present runtime behavior.

Remove the in-process resolver snapshot cache so the gateway has one catalog cache approach instead of two.

## Context

The gateway currently keeps two separate catalog freshness layers:

- an in-memory resolver snapshot cache inside `RegistryCatalog`
- the persisted `models` cache refreshed into Postgres

That makes admin/catalog behavior harder to reason about because there are two independent staleness windows for the same conceptual data.

## Scope

In:

- remove the in-memory `RegistryCatalog` TTL cache
- remove the related config/env surface
- update docs to describe the remaining cache model accurately

Out:

- changing hot-path `SelectMany` routing
- removing the persisted `models` cache
- changing admin candidate inspection to read from the DB instead of the resolver

## Approach

1. Make `registryCatalog.inspect()` always call resolver RPCs live.
2. Remove `resolverSnapshotTtlMs` config and any references to a catalog TTL.
3. Update docs/specs to describe:
   - live resolver inspection for admin candidates
   - persisted `models` cache for `/v1/models`

## Acceptance

This plan is done when:

- `RegistryCatalog` no longer memoizes snapshots in process
- `LIVEPEER_RESOLVER_SNAPSHOT_TTL_MS` / `resolverSnapshotTtlMs` are gone
- docs no longer claim admin candidate inspection is TTL-cached

## Decision Log

- 2026-05-19: Keep `/admin/registry/candidates` as a live resolver view rather than forcing it through the DB cache. That preserves a direct “current resolver state vs cached models table” diagnostic comparison while still eliminating the redundant in-memory cache layer.

## Outcome

Implemented as planned.

- Removed the in-process `RegistryCatalog` snapshot memoization layer.
- Removed `resolverSnapshotTtlMs` from gateway config.
- Kept `/admin/registry/candidates` as a live resolver view.
- Kept `/v1/models` on the persisted `models` cache refreshed in the background.
