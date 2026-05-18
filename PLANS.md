# PLANS

Plans are first-class artifacts. Non-trivial work lands as an execution
plan under `docs/exec-plans/active/`; completed plans move to
`docs/exec-plans/completed/`. Lightweight changes go straight to PR.

## Active

| Plan | Status |
|---|---|

(none.)

## Completed

| Plan | Date | Summary |
|---|---|---|
| [`0001-v1-hardening`](./docs/exec-plans/completed/0001-v1-hardening.md) | 2026-05-18 | Closed the gap from "scaffold passes smoke" to "ready for first real user": enriched `/health`, per-API-key rate limit, DEPLOYMENT runbook, 4 design docs + 4 product specs, LICENSE + CONTRIBUTING. |
| [`0002-openapi-spec`](./docs/exec-plans/completed/0002-openapi-spec.md) | 2026-05-18 | OpenAPI 3.1 spec for `/api/*` + `/portal/*` + `/admin/*` via `@fastify/swagger` + `fastify-type-provider-zod`. Migrated 19 routes to schema-based registration; `/openapi.json` + `/docs` served. |
| [`0004-registry-catalog-split`](./docs/exec-plans/completed/0004-registry-catalog-split.md) | 2026-05-19 | Split the snapshot/catalog resolver path out of `RouteSelector`, added a dedicated `RegistryCatalog`, and moved `/v1/models` refresh plus admin candidate inspection onto that surface. |
| [`0005-onchain-only-runtime`](./docs/exec-plans/completed/0005-onchain-only-runtime.md) | 2026-05-19 | Removed the static gateway routing path and tightened boot, health, docs, and local run tooling to the resolver+payer on-chain runtime only. |
| [`0006-single-catalog-cache`](./docs/exec-plans/completed/0006-single-catalog-cache.md) | 2026-05-19 | Removed the in-process registry catalog cache so admin candidate inspection is live and `/v1/models` remains the only persisted catalog cache. |

## How to write a plan

Each plan is a markdown file at `docs/exec-plans/active/NNNN-slug.md` with:

1. **One-liner.** What is this plan about? Answerable in one sentence.
2. **Context.** Why does this exist? What's the trigger?
3. **Scope.** What's in. What's out.
4. **Approach.** Phases, files touched, decisions to lock.
5. **Acceptance.** How do we know this is done?
6. **Decision log.** Each non-obvious choice + why, dated.

When the plan completes, append a `## Outcome` section, then `git mv` it
into `docs/exec-plans/completed/`.

## Tech debt

Ongoing debt tracked in
[`docs/exec-plans/tech-debt-tracker.md`](./docs/exec-plans/tech-debt-tracker.md).
