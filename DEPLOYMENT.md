# Deployment

Operator-facing runbook for deploying OpenAI Service to a real
environment. Pairs with [`README.md`](./README.md) (dev quickstart)
and [`docs/design-docs/boot-sequence.md`](./docs/design-docs/boot-sequence.md)
(what runs at startup).

If you only want to bring up dev: that's `make dev` per the README.
This doc is for production.

---

## Topology

A single-host or single-pod deployment of just two services — the
gateway and Postgres — with the gateway serving the checked-in site,
portal, and admin SPAs itself. Route selection and payment minting are
delegated to the external **LOC — Livepeer Open Clearinghouse** over
HTTPS:

```
                ┌────────────────────────────────────────┐
  internet ──►  │  reverse proxy (Traefik / nginx / LB)  │
                └────┬───────────────────────┬────────────┘
                     │ example.com           │ metrics.*
                     │ (/ , /portal/ ,       │ (basic auth)
                     │  /admin/ , /v1/*)     │
                     ▼                       ▼
                ┌────────┐               ┌────────┐
                │gateway │               │gateway │
                │  :4001 │               │ :4001  │
                └───┬────┘               └────────┘
        ┌───────────┴───────────────┐
        │                           │ HTTPS + X-API-Key
        ▼                           ▼
   ┌─────────┐              ┌─────────────────────┐
   │ postgres│              │ LOC clearinghouse   │
   │   :5432 │              │ (external)          │
   └─────────┘              │  jobs + settle +    │
                            │  capabilities       │
                            └──────────┬──────────┘
                                       ▼
                            chain (route selection +
                            pooled PM-ticket wallet)
```

The compose stack is only `db` + `gateway` — no daemon sidecars, no
unix-socket volumes, no chain keys on the host. The gateway reaches the
LOC at `LOC_BASE_URL` with an `X-API-Key` header.

---

## Pre-flight checklist

Before `docker compose up`:

- [ ] Domain DNS records pointing at the host (`example.com` and a
      metrics host, or your equivalent).
- [ ] TLS — Let's Encrypt or your CA of choice.
- [ ] Postgres data volume backed by durable storage.
- [ ] A reachable LOC clearinghouse and a valid `LOC_API_KEY` (see
      §"LOC clearinghouse" below).
- [ ] A funded LOC credit balance on that account (the LOC charges the
      estimate at job issuance).
- [ ] Resend account + API key (or commit to running without email
      and hand-delivering keys).
- [ ] A copy of `.env.example` with every value filled.
- [ ] Backups configured (see §"Postgres backup/restore").

---

## Secrets provisioning

The `.env.example` documents every required env var. The
non-negotiable secrets in production:

| Var | Why | Suggested generation |
|---|---|---|
| `POSTGRES_PASSWORD` | Postgres role auth. | `openssl rand -base64 32` |
| `ADMIN_TOKEN` | Bootstrap admin credential — see [`SECURITY.md`](./SECURITY.md). | `openssl rand -hex 32` |
| `API_KEY_HASH_PEPPER` | Server-side pepper for SHA-256 of API keys. | `openssl rand -hex 32` |
| `IP_HASH_PEPPER` | Same, for IPs / verification / session tokens. | `openssl rand -hex 32` |
| `METRICS_TOKEN` | Bearer token to fetch `/metrics`. Optional; deployer's choice between this and front-edge basic auth. | `openssl rand -hex 32` |
| `RESEND_API_KEY` | Email delivery. Optional but strongly recommended. | from your Resend dashboard |
| `RESEND_BASE_URL` | Override the Resend email API endpoint. Optional. | `https://api.resend.com/emails` |
| `LOC_API_KEY` | Auth for the LOC clearinghouse (sent as `X-API-Key`). Required for `/v1/*`. | from the LOC portal |

**Pepper rotation**: changing `API_KEY_HASH_PEPPER` invalidates every
existing API key. Rotating peppers is currently a planned outage —
v2 introduces dual-lookup. Until then, treat these as forever-fixed.

**Where they live**: keep them out of git. Use Docker compose's `.env`
(which is git-ignored by default here) or a secret manager fronting
the compose stack.

---

## LOC clearinghouse

The gateway does **not** hold chain keys, mint tickets, or run any
daemons. It delegates route selection and payment minting to the LOC
(Livepeer Open Clearinghouse). Per `/v1/*` request the gateway:

1. opens a job (`POST /v1/jobs {capability, offering, estimated_units}`);
   the LOC selects a route, mints the payment envelope, and charges the
   operator's credit balance the **full estimate** at issuance;
2. forwards the request to the returned `broker_url` with the
   `payment_envelope` in the `Livepeer-Payment` header;
3. settles actual usage afterwards (`POST /v1/jobs/{id}/settle
   {actual_units, outcome}`), and the LOC refunds the unused part.

Settlement runs in a durable background task, so a missed settle only
over-pays the estimate — it is never lost.

### Config

```bash
LOC_BASE_URL=https://loc.cloudspe.com   # default
LOC_API_KEY=…                           # required; sent as X-API-Key
LOC_TIMEOUT_MS=30000
LOC_SETTLE_INTERVAL_MS=15000            # background settler cadence
LOC_SETTLE_MAX_ATTEMPTS=20              # per-job settle retries
LOC_JOB_RETRIES=2                       # job-open retries on 429/5xx/mode-mismatch
```

### Funding

Top up the LOC account's **credit balance** (wei-denominated) through
the LOC portal. The LOC's pooled wallet signs the PM tickets; the
gateway never touches a keystore or chain RPC. Watch the balance via
`GET /admin/registry/loc` — if it runs dry, `POST /v1/jobs` fails and
`/v1/*` errors.

### Key rotation

Rotate `LOC_API_KEY` in the LOC portal, update `.env`, restart the
gateway. No on-host keystore to manage.

---

## Bringing the gateway online

The default compose stack (`db` + `gateway`) gets you all the way:

```bash
# 1. clone + env
git clone <repo>
cd livepeer-modules-openai
cp .env.example .env
$EDITOR .env   # fill every required value, incl. LOC_API_KEY

# 2. build
docker compose build gateway

# 3. full stack (db + gateway)
docker compose up -d
```

There are no daemon sidecars to run. The gateway talks to the external
LOC over HTTPS; confirm reachability before serving users:

```bash
make loc-smoke   # opens a 1-unit job and settles 0 against the live LOC
```

After startup the gateway is real. Don't ship to users until you've
done the **real-broker validation** below.

### Real-broker validation

Validate end-to-end against a real orchestrator:

1. **Sign up a test user** through the real flow:
   - `curl -X POST https://example.com/api/waitlist -d '{"name":"…","email":"you@…"}'`
   - Receive verification email, click it.
   - As admin (via the admin SPA or curl with `X-Admin-Token`),
     approve the row.
   - Receive the plaintext API key by email.

2. **Verify `/v1/models` is available and non-empty**:

   ```bash
   curl https://example.com/v1/models | jq '.data | length'
   # > 0
   ```

   If you get `503 models_cache_unavailable` or
   `503 models_cache_stale`, the LOC-backed cache is not yet safe to
   serve. Check `docker compose logs gateway` and the LOC status via
   `GET /admin/registry/loc`, then wait at least one refresh cycle.
   If you get `200` with `0`, the catalog refresh hasn't found any
   offerings. Check the gateway logs for LOC errors.

3. **Pick a model**, hit `/v1/chat/completions` with `stream: false`:

   ```bash
   curl https://example.com/v1/chat/completions \
     -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"qwen3:8b","messages":[{"role":"user","content":"say hi"}]}'
   ```

   Expect a 200 with an OpenAI-shaped response. If you get a 502,
   check `docker compose logs gateway` — it logs the LOC job it opened
   and the broker it forwarded to.

4. **Confirm the reservation row committed and enqueued a settle**:

   ```bash
   docker compose exec db psql -U openai_service -c \
     "SELECT capability,
             model,
             broker_url,
             loc_job_id,
             state,
             estimated_work_units,
             committed_work_units,
             settle_state,
             settle_actual_units,
             latency_ms
      FROM usage_reservations ORDER BY created_at DESC LIMIT 5;"
   ```

   The latest row should be `state=committed` with a non-null
   `committed_work_units`, a populated `loc_job_id`, and `settle_state`
   moving from `pending` to `settled` once the background settler runs.

5. **Confirm the models cache populated from the LOC catalog**:

   ```bash
   docker compose exec db psql -U openai_service -c \
     "SELECT model_id,
             capability,
             interaction_mode,
             active
      FROM models
      WHERE active = true
      ORDER BY snapshot_at DESC
      LIMIT 10;"
   ```

   Expect non-empty rows after at most one catalog refresh cycle.

6. **Repeat with `stream: true`** to validate the SSE path.

7. **Walk every endpoint**: embeddings → images → audio/speech →
   audio/transcriptions → rerank. Each one validates a different
   wire driver + work-unit shape.

If all seven checks work, the deploy is real-broker-validated.

---

## TLS termination

The gateway speaks plain HTTP. Put a reverse proxy in front.

### Traefik (compose-friendly)

Add Traefik labels to the gateway service. Example:

```yaml
gateway:
  # … existing service config …
  labels:
    - "traefik.enable=true"
    - "traefik.http.routers.api.entrypoints=websecure"
    - "traefik.http.routers.api.rule=Host(`example.com`)"
    - "traefik.http.routers.api.tls.certresolver=letsencrypt"
    - "traefik.http.services.api.loadbalancer.server.port=4001"

    # /metrics with basic auth
    - "traefik.http.routers.metrics.rule=Host(`metrics.example.com`)"
    - "traefik.http.routers.metrics.middlewares=metrics-auth"
    - "traefik.http.middlewares.metrics-auth.basicauth.users=ops:$$apr1$$…"
```

### nginx

Stock reverse-proxy block, terminate TLS, forward to
`127.0.0.1:4001`. The only non-obvious bit: **disable proxy buffering
for `/v1/chat/completions`** so streaming works.

```nginx
location /v1/chat/completions {
  proxy_pass http://127.0.0.1:4001;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_cache off;
}
```

---

## SPA hosting

The gateway serves the checked-in SPAs directly:

- site shell + assets at `/`
- portal shell at `/portal/`, assets at `/portal/static/*`
- admin shell at `/admin/`, assets at `/admin/static/*`

The separate `dev-server.js` scripts under `web/` are only for local
development ergonomics.

**Generic branding reminder**: the marketing site says "OpenAI
Service." If you want to rebrand, edit
`web/site/index.html` + `web/site/index.css` + the favicon. No
gateway code touches.

---

## Postgres backup + restore

### Backup

Take logical backups daily and ship them off-host:

```bash
docker compose exec -T db pg_dump -U openai_service \
  --format=custom \
  openai_service > openai_service-$(date +%F).pgdump
```

Drive this from cron or a systemd timer; encrypt and ship to S3 /
GCS / Backblaze. Keep at least 7 days of point-in-time backups
locally + 30 days off-site.

### Restore

```bash
# Bring down the gateway so nothing connects mid-restore:
docker compose stop gateway

# Drop + recreate the schema (DANGER):
docker compose exec db psql -U openai_service -c \
  "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Restore the dump:
docker compose exec -T db pg_restore -U openai_service -d openai_service \
  < openai_service-2026-05-18.pgdump

# Migrations should report no work needed (they were captured in the
# dump). If they do work, that's fine — the runner is idempotent.
docker compose start gateway
```

### Schema migrations

Migrations live in `gateway/migrations/`. They are applied at boot
by the gateway's home-grown numbered-SQL runner, recorded in
`_schema_migrations`, and are **idempotent** — re-running is safe.

For zero-downtime schema changes:

1. Author the migration so it's backward-compatible with the old
   gateway (add nullable columns, don't drop columns / rename tables
   without a two-phase plan).
2. Roll out a new gateway image. The runner applies on boot.
3. Roll out follow-up migrations / cleanups after the new gateway is
   serving 100% of traffic.

#### Upgrade note — LOC settlement (`0004_loc_settlement.sql`)

The move to the LOC clearinghouse adds one migration,
`0004_loc_settlement.sql`, which is the operationally relevant one for
upgrades from the daemon-era gateway. It adds nullable settle columns
only, so the rollout is forward-compatible:

- `usage_reservations` gains `loc_job_id`, `settle_state`
  (`NULL | pending | settled | failed`), `settle_actual_units`, and
  `settle_outcome`, plus a partial index on `settle_state='pending'`
  that the background settler drains.

Operationally:

1. Deploy the new gateway image.
2. Let the boot-time migration runner apply `0004_loc_settlement.sql`.
3. Confirm new `/v1/*` traffic populates `loc_job_id` and that
   `settle_state` moves `pending → settled` as the settler runs.

The earlier `0002`/`0003` migrations (route/quote diagnostic columns
from the daemon era) remain applied; they are simply no longer written
to. There are no daemon images to align — the gateway only needs a
reachable LOC and a valid `LOC_API_KEY`.

---

## Log shipping

The gateway logs structured JSON to stdout via pino. Compose captures
this in the Docker log driver. To centralize:

- **Loki + Promtail / Alloy** — scrape Docker logs, ship to Loki.
- **Vector** — Docker → Vector → wherever.
- **Datadog / CloudWatch / etc.** — point your agent at the Docker
  log socket.

Key log fields for queries: `level`, `reqId`, `req.method`, `req.url`,
`res.statusCode`, `responseTime`, plus structured ad-hoc fields like
`err`, `email`, `apiKeyId`.

---

## OpenAPI / Swagger UI

The gateway publishes OpenAPI 3.1 for its non-`/v1/*` surface:

- `GET /openapi.json` — spec
- `GET /docs` — interactive Swagger UI

**In production**, gate both behind the reverse proxy. The spec
documents admin operations (paths, schemas) that an attacker can use
to map your surface. Treat it like `/metrics`:

```
# Traefik example — admin-auth middleware on Swagger UI
- "traefik.http.routers.docs.rule=Host(`example.com`) && PathPrefix(`/docs`)"
- "traefik.http.routers.docs.middlewares=docs-auth"
- "traefik.http.middlewares.docs-auth.basicauth.users=ops:$$apr1$$…"

- "traefik.http.routers.openapi.rule=Host(`example.com`) && Path(`/openapi.json`)"
- "traefik.http.routers.openapi.middlewares=docs-auth"
```

For end-user-facing OpenAI compatibility docs, point clients at
[OpenAI's published spec](https://github.com/openai/openai-openapi) —
we conform to it for `/v1/*`.

---

## Metrics

Prometheus scrapes `/metrics`. Surfaces:

- Default Node process metrics (heap, GC, event-loop lag) under
  prefix `openai_service_*`
- `openai_service_http_requests_total{method,route,status}`
- `openai_service_http_request_duration_seconds`
- `openai_service_proxy_reservations_total{capability,outcome}`
- `openai_service_proxy_settle_total{outcome}`
- `openai_service_waitlist_signups_total`

Recommended starter alerts:

- 5xx rate above 1% sustained 5 min on `/v1/*`
- `proxy_reservations_total{outcome="refunded"}` rising sharply
  vs `committed`
- `pendingSettlements` (from `/health`) climbing — the settler can't
  reach the LOC; refunds are delayed
- Event-loop lag > 100ms p95

---

## Upgrades

```bash
# 1. Pull the new image (or rebuild from a new tag)
git fetch origin && git checkout v1.x
docker compose build gateway

# 2. Apply
docker compose up -d gateway

# 3. Watch for clean boot:
docker compose logs -f gateway
# Look for:
#   [migrations] migration NNNN_xxx.sql: applied
#   Server listening at http://0.0.0.0:4001

# 4. Confirm /health is 200:
curl -sf http://localhost:4001/health | jq .

# 5. Smoke a /v1/* call as in "Real-broker validation" §3.
```

### Rollback

If the new gateway image misbehaves:

```bash
git checkout v1.previous
docker compose build gateway
docker compose up -d gateway
```

Watch out for **migration rollback**: a forward migration that's
already been applied won't be undone by checking out the old image.
If you need to roll a migration back, write a fresh migration that
undoes it (don't edit history).

---

## Common failure modes

| Symptom | Likely cause | Where to look |
|---|---|---|
| `/health` shows `db: error` | Postgres down or wrong DATABASE_URL | `docker compose logs db` |
| `/health` shows `loc: error` (→ HTTP 503) | LOC unreachable, wrong `LOC_BASE_URL`, or invalid `LOC_API_KEY` | gateway logs; `GET /admin/registry/loc` |
| `/v1/models` returns empty `data: []` | LOC advertises no offerings, or catalog refresh hasn't run yet | gateway logs; `GET /admin/registry/loc`; wait one refresh cycle |
| Every `/v1/*` returns 503 | LOC unreachable or job-open failing | gateway logs (logs each opened job + retries) |
| `/v1/*` errors with insufficient funds | LOC credit balance exhausted | `GET /admin/registry/loc` (balance); top up in the LOC portal |
| `/health` `pendingSettlements` climbing | Settler can't reach the LOC; refunds delayed (not lost) | gateway logs; LOC reachability |
| Verification emails not arriving | RESEND_API_KEY missing/invalid | gateway logs — search for `verification email send failed` |
| Operator can't log into admin | ADMIN_TOKEN env var missing or mismatched | `docker compose exec gateway env | grep ADMIN_TOKEN` |
| Sudden 503s after redeploy | Migration hung the gateway boot | gateway logs — last `[migrations]` line |

---

## What this runbook does NOT cover (v1)

- **Multi-replica deploys** with shared session state / rate limits.
  Single-process shape only.
- **Blue-green / canary** rollouts. Plain stop-old / start-new.
- **Automatic backups**. Wire your own cron.
- **DDoS protection**. Front-edge concern (Cloudflare / Fastly).
- **Multi-region**. Replicate Postgres + run a gateway near each
  region; not in scope here.
