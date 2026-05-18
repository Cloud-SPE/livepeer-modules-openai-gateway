# 0005 On-chain Only Runtime

> Historical record. This plan documents the removal of older runtime paths; prefer the current live design docs for present runtime behavior.

Remove the remaining static and off-chain fallback paths so the gateway always runs against the on-chain resolver and payer daemons.

## Context

The daemon-alignment work moved the live request path onto the resolver and payer `v1.3.0` contracts, but the repo still carries older runtime assumptions:

- gateway boot tolerates missing daemon wiring
- `RouteSelector` and `RegistryCatalog` still have static fallback branches
- `/health` treats missing daemons as degraded instead of down
- docs and smoke tooling still describe a non-on-chain development mode

That leaves the codebase advertising deployment shapes we do not want to support.

## Scope

In:

- remove static gateway routing / catalog branches
- require resolver socket config at boot
- require resolver + payer sockets for healthy runtime status
- remove operator-facing docs for `LIVEPEER_BROKER_URL` / `LIVEPEER_RECIPIENT_HEX`
- update local run instructions to reflect the on-chain-only stance

Out:

- changing the resolver protocol itself
- adding a local fake on-chain stack
- removing route/quote metadata already stored for diagnostics

## Approach

Phase 1:

- remove static config fields and runtime branches from config, selector, and catalog
- simplify refresh wiring now that resolver presence is mandatory

Phase 2:

- tighten `/health` semantics so missing resolver/payer is a hard failure
- update docs and scripts that still assume no-daemon mode

Phase 3:

- run gateway lint/tests
- close the plan

## Acceptance

This plan is done when:

- the gateway no longer accepts `LIVEPEER_BROKER_URL` / `LIVEPEER_RECIPIENT_HEX` as runtime inputs
- `RouteSelector` and `RegistryCatalog` have no static fallback branch
- `/health` reports missing resolver/payer as down
- docs no longer describe static broker or no-chain fallback as supported deployment modes

## Decision Log

- 2026-05-19: Keep the product explicitly on-chain only. Development convenience is not worth carrying a second unsupported runtime model through config, health, docs, and tests.

## Outcome

Implemented as planned.

- Removed static gateway routing and static catalog fallback branches.
- Removed `LIVEPEER_BROKER_URL` and `LIVEPEER_RECIPIENT_HEX` from runtime config.
- Tightened boot and `/health` so resolver + payer wiring is mandatory.
- Simplified local/dev documentation and compose entry points to the on-chain daemon-backed model.
