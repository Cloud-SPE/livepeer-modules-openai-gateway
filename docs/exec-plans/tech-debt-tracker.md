# Tech debt tracker

Known debt that doesn't yet have a plan. Promote items into
`docs/exec-plans/active/` when ready to work on them.

## Open

### mock-broker / mock-payer harness for in-CI end-to-end coverage

**Found**: 2026-05-18 (during plan 0001)
**Impact**: `make smoke` exercises every code path *except* an actual
upstream call. The proxy → broker → runner path is unit-tested via
chat-helpers + registry-refresh tests, and verified to refund on
failure, but no test boots a fake broker + fake payer-daemon over UDS
to validate a happy-path 200 with usage settlement.
**Surface**: `gateway/src/proxy/livepeer/payment.ts` (needs a UDS
gRPC mock client/server), `gateway/src/proxy/service/routeSelector.ts`
(same for registry), `scripts/smoke.sh` (extend to spin up the
fakes via compose profile).
**Fix shape**: Two tiny Node/Go services that speak the two gRPC
proto surfaces; a `smoke` compose profile that brings them up
alongside the gateway; smoke script gains a full `/v1/chat/completions`
roundtrip with a canned response. Plan called for ~200 lines.

### `infra/` directory — observability + reverse-proxy configs

**Found**: 2026-05-18 (deferred from Phase 0)
**Impact**: Operators starting from scratch have to invent a
Grafana dashboard, Prometheus scrape config, Traefik/nginx
example. `DEPLOYMENT.md` covers prose; concrete files would
shorten time-to-first-deploy.
**Surface**: New top-level `infra/` with
`grafana/dashboards/*.json`, `prometheus/scrape-config.yaml`,
`traefik/dynamic-config.yaml`, maybe a `compose.infra.yml`.
**Fix shape**: Use the metric names already emitted by
`gateway/src/metrics.ts`. Reference dashboard for the four
counters + route-health gauges + Node defaults.

### CI: run `make smoke` in GitHub Actions

**Found**: 2026-05-18 (deferred from `## Hard blockers`)
**Impact**: Regressions in the SaaS shell or proxy lifecycle
don't fail PRs — only local smoke catches them. The lint/build/
test job is fine but doesn't cover wire-up.
**Surface**: `.github/workflows/ci.yml` — needs Docker buildx +
the smoke script.
**Fix shape**: Add a `smoke` job that `docker compose build`s,
runs `docker compose up -d`, waits for health, runs
`scripts/smoke.sh`. ~25 lines of YAML.

### CI: `docker` + `migrations` jobs gated off

**Found**: 2026-05-18
**Impact**: `if: false` on two jobs in `ci.yml`. Image build
isn't validated per-PR; migration syntax errors slip past lint.
**Surface**: `.github/workflows/ci.yml` lines tagged `if: false`.
**Fix shape**: Flip the flag once we have a `migrations` linter
(drizzle-kit check) and a buildx target. Done with the smoke
work above is natural.

### SPA client generation from OpenAPI

**Found**: 2026-05-18 (during plan 0002)
**Impact**: `web/{portal,admin}/lib/api.js` hand-rolls every
endpoint shape. Gateway response-shape changes silently break
SPAs at runtime instead of at PR review time.
**Surface**: `web/{portal,admin}/lib/api.gen.ts` (new),
`web/{portal,admin}/lib/api.js` (replace),
`web/{portal,admin}/components/*.js` (consume typed methods).
**Fix shape**: `openapi-typescript http://localhost:4001/openapi.json --output …` at build time
+ wrap with a `fetch` helper. SPAs are zero-build so we either
ship the generated `.ts` as `.js` (run tsc once at "build") or
emit JS directly via `openapi-fetch`.

### CI: spec-diff job

**Found**: 2026-05-18
**Impact**: A breaking API change in code doesn't fail PRs.
The OpenAPI spec drifts silently until someone integrates and
notices.
**Surface**: Commit a snapshot at `openapi.snapshot.json`; CI job
boots the gateway, fetches `/openapi.json`, diffs.
**Fix shape**: ~30 lines of YAML + a tiny diff script.

### Per-route response runtime validation

**Found**: 2026-05-18
**Impact**: OpenAPI documents response schemas but doesn't
*enforce* them. A handler can return a wrong shape; clients eat
it. Drift goes uncaught.
**Surface**: All `/admin/*` and `/portal/*` handlers.
**Fix shape**: Flip `responseValidation: true` on
`fastify-type-provider-zod`. Start with `/admin/users/:id` (densest
shape). Observe for legit drift; expand.

### API-key recovery flow (lost-key reset)

**Found**: 2026-05-18
**Impact**: A user who loses their only API key has to email the
operator. No self-service.
**Surface**: New `/api/forgot-key` endpoint, magic-link email
flow.
**Fix shape**: Modeled after the verify-email flow. Token in
`waitlist` row, email link → portal page that mints a new key,
revokes any orphan sessions.

### Multi-replica / distributed rate-limit

**Found**: 2026-05-18
**Impact**: Running >1 gateway replica means a single API key
gets `N × per-replica-burst` effective burst. Acceptable for
beta; not for serious load.
**Surface**: `gateway/src/proxy/rateLimit.ts` (current: in-memory
token bucket).
**Fix shape**: Redis-backed `INCR` + TTL pattern, or a Lua
script. Replace the `RateLimiter` class while keeping the same
preHandler signature.

### Health check should ping payer-daemon over gRPC, not just stat the socket

**Found**: 2026-05-18 (during plan 0001 follow-up)
**Impact**: Socket exists ≠ daemon healthy. A wedged daemon
passes `/health` today.
**Surface**: `gateway/src/routes/health.ts` checkSocket function.
**Fix shape**: Add a cheap `Health` RPC call alongside socket
stat. Cache the result with a short TTL to avoid scrape-frequency
RPC traffic. Similar for the registry daemon.

### `proxy/livepeer/` doesn't trim API-key whitespace on hashApiKey

**Found**: 2026-05-18 (during plan 0001 product-spec writing)
**Impact**: A user who pastes their key with trailing newline /
spaces sees `invalid_api_key`. The hash is deterministic but
unforgiving.
**Surface**: `gateway/src/crypto.ts` `hashApiKey`,
`gateway/src/proxy/auth.ts`.
**Fix shape**: Trim before hashing in `hashApiKey`. One-line fix.
Add a test that `hashApiKey('  sk-x  ') === hashApiKey('sk-x')`.

### Mechanical import-graph linter

**Found**: 2026-05-18 (during full doc/code sweep)
**Impact**: `core-beliefs.md` §4 + `ARCHITECTURE.md` §3 describe a
one-way dependency rule (routes → proxy → wire) that today is only
enforced by reviewer attention. An agent could introduce an upward
import (`proxy/livepeer/payment.ts` importing from
`routes/portal/auth.ts`, say) and `tsc` would be happy.
**Surface**: `.eslintrc` or equivalent; tooling at `eslint-plugin-boundaries`
or `dependency-cruiser`. Wire into `pnpm -F gateway lint`.
**Fix shape**: Declare the four bands (`routes`, `proxy`, `repo/registry/email`,
`primitives`) and forbid upward imports. ~30 lines of config plus
the dep install.

### `/admin/waitlist/:id/reject` doesn't check current status

**Found**: 2026-05-18 (noted in `product-specs/admin-waitlist.md`)
**Impact**: Operator can reject an already-approved row, blanking
their access without revoking the api_keys. Minor; no real
foot-gun because the operator chose to do it.
**Surface**: `gateway/src/routes/admin/waitlist.ts` reject handler.
**Fix shape**: Add the same 409-if-not-pending check that approve
has. Maybe also revoke active api_keys when rejecting an
approved user.

## How to file an entry

```markdown
### Slug — one-line description

**Found**: YYYY-MM-DD by <whom>
**Impact**: what breaks / who notices / how often
**Surface**: paths affected
**Fix shape**: what a fix would look like, briefly
```

Don't add an entry that says "TODO." Either fix it now, file a real
plan, or describe the debt concretely.
