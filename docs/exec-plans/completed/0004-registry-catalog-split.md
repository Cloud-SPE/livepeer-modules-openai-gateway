# 0004 Registry Catalog Split

Separate registry catalog/snapshot reads from the request-routing `RouteSelector` so `/v1/models` and admin inspection no longer depend on the route-selection abstraction.

## Context

The `v1.3.0` daemon alignment moved live request routing onto resolver `SelectMany`, but the background model refresh task and `/admin/registry/candidates` still call `routeSelector.inspect()`. That method rebuilds a registry snapshot via `ListKnown` + `ResolveByAddress`, which mixes two different concerns into one abstraction:

- request routing for `/v1/*`
- catalog/debug snapshot reads for `/v1/models` and admin inspection

That coupling makes the `RouteSelector` surface harder to reason about and obscures which code paths are quote-aware request routing versus snapshot-style introspection.

## Scope

In:

- introduce a dedicated registry catalog/snapshot reader for resolver-backed deployments
- move model refresh and admin candidate inspection to that surface
- keep static-routing behavior working without a resolver socket
- update tests and docs to reflect the split

Out:

- changing `/v1/models` to query gRPC directly on request
- removing snapshot-based inspection entirely
- changing live `SelectMany` routing semantics

## Approach

Phase 1:

- Add a `RegistryCatalog` abstraction that returns `RouteCandidate[]` snapshots.
- Reuse the current snapshot-loading logic, but move it out of `RouteSelector`.

Phase 2:

- Update the registry refresh task to depend on `RegistryCatalog`.
- Update admin registry candidate inspection to depend on `RegistryCatalog`.
- Keep `RouteSelector` focused on `select()`, route health, and outcome tracking.

Phase 3:

- Update tests/docs and move this plan to completed once verification passes.

## Acceptance

This plan is done when:

- `RouteSelector` no longer exposes or implements snapshot inspection
- registry refresh and admin candidate inspection use the dedicated catalog reader
- static-routing deployments still return a coherent catalog view
- gateway lint and tests pass

## Decision Log

- 2026-05-19: Keep snapshot inspection, but move it behind a dedicated abstraction instead of deleting it. `/v1/models` and admin inspection still need a catalog/debug surface, even though live routing is now `SelectMany`-based.

## Outcome

Implemented as planned.

- Added `gateway/src/registry/catalog.ts` as the dedicated resolver-backed catalog/snapshot reader.
- Removed snapshot inspection from `RouteSelector`; it now focuses on `SelectMany`, ranking, and route-health tracking.
- Rewired the registry refresh task and `/admin/registry/candidates` onto `RegistryCatalog`.
- Updated docs and tests to describe the split clearly.
