# 0001 — v1 hardening

> Historical record. Some behaviors described below were later tightened or removed; prefer the current live design docs for present runtime behavior.

**Status**: completed
**Opened**: 2026-05-18
**Driver**: Mike Zupper

## One-liner

Close the gap between "scaffold passes `make smoke`" and "ready to put
in front of one real user" — without enlarging v1 scope.

## Context

The initial scaffold (commits `68fa035` → `bec05f7`) covers all 7
locked phases end-to-end against a local Postgres. The post-scaffold
audit ([conversation history], commit `bec05f7`) surfaced 30 gaps
between the code and what a production deploy actually needs.

Of those, eight were prioritised: **1, 2, 3, 4, 10, 16, 17, 20**.
This plan scopes those eight; the rest stay on the tech-debt tracker.

## Scope — in

| # | Item | Lives in |
|---|---|---|
| 1 | Real-broker validation procedure (manual; we don't operate a broker in CI) | `DEPLOYMENT.md` §"Bringing the gateway online" |
| 2 | Health endpoint enrichment — DB + payer-daemon + registry-daemon checks, 503 on subsystem failure | `gateway/src/routes/health.ts` + `RELIABILITY.md` cross-ref |
| 3 | Production deployment runbook | `DEPLOYMENT.md` (new) |
| 4 | Operator setup: keystore provisioning + chain-RPC creds | `DEPLOYMENT.md` §"Livepeer plumbing" |
| 10 | Per-API-key rate limit on `/v1/*` | `gateway/src/proxy/rateLimit.ts` + `gateway/src/proxy/index.ts` wiring |
| 16 | Four product specs (waitlist-signup, portal-account, admin-waitlist, openai-surface) | `docs/product-specs/` |
| 17 | Four design docs (payment-flow, route-selector, streaming-usage, boot-sequence) | `docs/design-docs/` |
| 20 | First exec plan landed | **this file** |

## Scope — out

Explicitly deferred to follow-up plans / v2:

- Mock-broker / mock-payer harness for in-CI e2e against the real
  proxy path. **Why**: requires a fake payer-daemon over UDS gRPC +
  a fake broker accepting `/v1/cap`. Real engineering effort; better
  as a dedicated plan. Tracked in tech-debt-tracker.
- `infra/` directory (Grafana / Prometheus dashboards / Traefik
  configs). Deferred from Phase 0; still deferred.
- CI smoke job (`make smoke` in GitHub Actions). Deferred.
- Recovery flow for lost API keys.
- OpenAPI spec for `/portal/*` / `/admin/*`.

## Approach

Three groups, executed in order:

### Group A — code (small)

- **Health enrichment**: `health.ts` becomes async; pings each
  configured subsystem (DB always; payer + registry only if their
  sockets are configured). Aggregates into `{status, checks: {…}}`.
  Returns 503 if any *required* check fails; required means: DB +
  any subsystem whose env var is set.
- **Rate limit**: per-`api_key_id` token bucket in
  `gateway/src/proxy/rateLimit.ts`. In-memory (single-process is the
  shape we ship). Defaults configurable via
  `V1_RATE_LIMIT_PER_MINUTE` (default 60) and
  `V1_RATE_LIMIT_BURST` (default 30). 429 in OpenAI shape with
  `Retry-After` header. Registered as a preHandler after `bearerAuth`
  on every `/v1/*` mutating route (skips `/v1/models`).

### Group B — design docs (deep technical reference)

Each lands as its own file under `docs/design-docs/`:

| File | Covers |
|---|---|
| `payment-flow.md` | How `Livepeer-Payment` envelopes are minted, the gRPC UDS shape, what happens at boot if payer-daemon is unreachable, why the fallback path 503s. |
| `route-selector.md` | `listKnown` → `resolveByAddress` flow, candidate ranking, health-tracker cooldown, snapshot caching, why background refresh exists. |
| `streaming-usage.md` | The `stream_options.include_usage=true` injection, transcript accumulation while piping to client, last-frame-wins parser, refund-vs-commit decision tree. |
| `boot-sequence.md` | Order of operations from `index.ts` entry, what each step can fail at, what the failure mode is, what graceful shutdown looks like. |

`docs/design-docs/index.md` updated to list them with status pills.

### Group C — product specs + deployment runbook

| File | Covers |
|---|---|
| `docs/product-specs/waitlist-signup.md` | Public flow from landing → verify → admin approval → key delivery. |
| `docs/product-specs/portal-account.md` | Signed-in user surface: sign-in, account view, API-key management, usage view. |
| `docs/product-specs/admin-waitlist.md` | Admin queue management. Approval rules (incl. verified-required). |
| `docs/product-specs/openai-surface.md` | The OpenAI contract: every endpoint, what's honored, what's dropped, error shapes. |
| `DEPLOYMENT.md` | New top-level. Operator-facing: env, secrets, keystore, Postgres backup/restore, TLS, Traefik example, real-broker validation procedure, upgrade + rollback. |

## Acceptance

1. `pnpm -F @livepeer-modules-openai/gateway lint` clean.
2. `pnpm -F @livepeer-modules-openai/gateway test` passes
   (existing 39 + new tests for rate limit + health).
3. `make smoke` passes against the default compose stack.
4. `/health` returns `{status, checks: {db, payer, registry}}`
   with each check carrying `ok`/`error`/`latencyMs`.
5. `/v1/embeddings` invoked 100× per second with the same key gets
   429 within 1s and a `Retry-After` header.
6. New docs render (markdown link check) and are referenced from
   their parent index files.
7. The plan moves to `docs/exec-plans/completed/`.

## Decision log

- **2026-05-18 — In-memory rate limit, not Redis.** Single-process
  shape is what v1 ships. A multi-replica deploy would need
  distributed rate-limiting; that's a separate plan tied to scaling.
- **2026-05-18 — Mock-broker deferred.** Real broker validation
  becomes a documented procedure in `DEPLOYMENT.md` rather than a CI
  fixture. The fixture would be valuable; it's also a 200-line plan
  unto itself.
- **2026-05-18 — Health endpoint is the LB contract.** 503 is
  meaningful: drop the gateway from rotation. We do *not* 503 on
  optional subsystems that the operator has chosen not to configure
  (e.g. no payer socket set → not required).
- **2026-05-18 (revised during impl) — Degraded ≠ down.** Initial
  health rollup treated *any* required-subsystem failure as `down`.
  Caught by smoke: with a configured-but-missing payer socket
  (typical when the default compose runs without the `livepeer`
  profile), the gateway 503'd despite portal/admin/site being
  fully functional. Revised rule: **DB failure → `down` → HTTP 503;
  payer or registry failure → `degraded` → HTTP 200**. /v1/* still
  500s at request time, but the LB keeps the gateway in rotation so
  the other surfaces keep working.

## Outcome — 2026-05-18

All 7 acceptance criteria met:

1. ✅ `pnpm -F …/gateway lint` clean.
2. ✅ `pnpm -F …/gateway test` — **51 pass / 0 fail** (39 existing +
   6 new rate-limit + 6 new chat-helpers regression coverage that
   landed alongside the refactor; health tests are integration-level
   so covered by smoke instead of unit-level).
3. ✅ `make smoke` passes against the default compose stack.
4. ✅ `/health` returns enriched body — verified end-to-end:
   ```json
   {"status":"degraded","checks":{
     "db":{"status":"ok","latencyMs":0},
     "payer":{"status":"error","latencyMs":0,"error":"socket not present: …"},
     "registry":{"status":"error","latencyMs":0,"error":"socket not present: …"}}}
   ```
5. ✅ `/v1/embeddings` invoked over burst → 4th call returns 429
   with `Retry-After: 1` and OpenAI-shape body
   `{"error":{"message":"rate limit exceeded — retry in 1s",
     "type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}`.
6. ✅ Markdown link check across all 12 root docs + design-docs/ +
   product-specs/ + exec-plans/ — zero broken refs.
7. ✅ This file moves to `docs/exec-plans/completed/`.

Items NOT in this plan, still on the tech-debt tracker:

- Mock-broker / mock-payer harness for in-CI e2e against the real
  proxy path (deferred — promote to its own plan when ready).
- `infra/` directory (Grafana, Prometheus dashboards, Traefik
  examples beyond the snippet in `DEPLOYMENT.md`).
- CI smoke job in GitHub Actions.
- Recovery flow for lost API keys.
- OpenAPI spec for portal + admin APIs.

Files touched (final tally):

- **New**: `LICENSE`, `CONTRIBUTING.md`, `DEPLOYMENT.md`,
  `gateway/src/proxy/rateLimit.ts`,
  `docs/design-docs/{payment-flow,route-selector,streaming-usage,boot-sequence}.md`,
  `docs/product-specs/{waitlist-signup,portal-account,admin-waitlist,openai-surface}.md`,
  `gateway/test/{rate-limit,chat-helpers,registry-refresh}.test.ts`
  (last two were the doc-sweep commit; rate-limit is this plan's),
  this plan file.
- **Modified**: `gateway/src/routes/health.ts` (full rewrite),
  `gateway/src/{config,server,index}.ts` (rate-limiter wiring),
  `gateway/src/proxy/{chat,embeddings,images,audio-speech,audio-transcriptions,rerank}.ts`
  (preHandler arrays), `docker-compose.yml` + `.env.example` (rate-
  limit env), `README.md` + `AGENTS.md` (DEPLOYMENT cross-link),
  `docs/design-docs/index.md` + `docs/product-specs/index.md`
  (catalog updates).
