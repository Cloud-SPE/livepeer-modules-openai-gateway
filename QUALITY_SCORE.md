# QUALITY_SCORE

Rough grades for each domain. Updated as the codebase evolves.

Grading scale: **A** (load-bearing, well-tested, well-documented) →
**B** (works, gaps known) → **C** (skeleton, expect rough edges) →
**F** (not yet written / broken).

| Domain | Path | Grade | Notes |
|---|---|---|---|
| Harness scaffolding | `AGENTS.md`, `docs/` | C | Phase 0 — present but not exercised. |
| Gateway — proxy core | `gateway/src/proxy/` | C | Phases 3 + 4d landed. 5 /v1/* handlers + rerank; bearer auth; reservation lifecycle wired. Not yet exercised against a real broker. |
| Gateway — wire spec | `gateway/src/proxy/livepeer/` | C | Phase 3. Broker wire formats (reqresp / stream / multipart), headers, capability map. Payment minting now lives in the LOC, not here. |
| Gateway — LOC client | `gateway/src/loc/` | C | Typed HTTP client for the Livepeer Open Clearinghouse: job open/settle, catalog, balance. Replaces the embedded gRPC payment/registry clients. |
| Gateway — registry refresh | `gateway/src/registry/` | C | Phase 4b. LOC-backed catalog snapshot, upserts to `models` table. |
| Gateway — boot wiring | `gateway/src/index.ts` | C | Builds the LOC client (best-effort health probe), the LOC-backed registry catalog, then starts the background registry-refresh + LOC settler tasks. |
| Gateway — SaaS shell | `gateway/src/routes/{public,portal,admin}/` | C | Phase 4c. 19 endpoints; cookie sessions; admin-token gate. End-to-end verified against Postgres. |
| Gateway — schema | `gateway/src/schema/`, `gateway/migrations/` | C | Phase 4a. 5 tables, 11 indexes, single migration. Drizzle schema in TS. |
| Gateway — auth | `gateway/src/proxy/auth.ts`, `routes/portal/auth.ts`, `routes/admin/auth.ts` | C | Phase 4c+4d. Bearer for /v1/*; cookie sessions for portal; X-Admin-Token for admin. |
| Gateway — metrics | `gateway/src/metrics.ts` | C | Phase 4e. Prometheus exposition; HTTP/proxy/waitlist counters + route-health renderer. Optional Bearer gate via METRICS_TOKEN. |
| Web — site | `web/site/` | C | Phase 5. Zero-build Lit (`cc-signup-form`, `cc-verify-card`) + dev-server proxy to gateway. Static index + verify.html. |
| Web — portal | `web/portal/` | C | Phase 5. Hash-routed (account / api-keys / usage), cookie session auth, dev-server proxies `/api/*` + `/portal/*`. |
| Web — admin | `web/admin/` | C | Phase 5. Token in localStorage, waitlist queue + users + usage + registry-debug. Dev-server proxies `/api/*` + `/admin/*`. |
| Compose stack | `docker-compose.yml` | C | Root compose ships `db` + `gateway` only — no daemon sidecars or proto/gRPC; route selection + payment minting are delegated to the external LOC. `make smoke` runs the full e2e flow. |
| CI | `.github/workflows/` | C | Phase 0 scaffold; grows per phase. Runs `pnpm -r {lint,build,test}` + AGENTS.md link check on every push/PR. |
| Tests | `gateway/test/` | C | 45 tests across `crypto.ts`, `proxy/chat.ts` helpers, `registry/refresh.ts` (`candidatesToModelRows`), and `proxy/rateLimit.ts`. Pure-function coverage; integration paths covered by `make smoke`. |
| OpenAPI | `/openapi.json` + `/docs`, `gateway/src/schema/api.ts` | C | OpenAPI 3.1 covers all 19 non-`/v1/*` routes via `@fastify/swagger` + `fastify-type-provider-zod`. zod schemas are the single source; handlers get typed `req.body`/`req.params`/`req.query` for free. Production: gate `/docs` + `/openapi.json` behind reverse-proxy auth. |

## Promotion criteria

A domain promotes from **F → C** when:
- The files exist and the package builds.

From **C → B** when:
- Happy-path manually exercised end-to-end.
- A short doc lives under `docs/design-docs/` or `docs/product-specs/`.

From **B → A** when:
- Tests cover the happy path + at least three error paths.
- Cross-references are mechanically validated by CI.
- An exec plan in `docs/exec-plans/completed/` records the design history.

Don't downgrade silently. If a domain regresses, open a tech-debt entry
in [`docs/exec-plans/tech-debt-tracker.md`](./docs/exec-plans/tech-debt-tracker.md).
