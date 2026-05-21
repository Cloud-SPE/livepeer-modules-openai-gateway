# Deployment

Operator-facing runbook for deploying OpenAI Service to a real
environment. Pairs with [`README.md`](./README.md) (dev quickstart)
and [`docs/design-docs/boot-sequence.md`](./docs/design-docs/boot-sequence.md)
(what runs at startup).

If you only want to bring up dev: that's `make dev` per the README.
This doc is for production.

---

## Topology

A single-host or single-pod deployment of the three load-bearing
services, with the gateway serving the checked-in site, portal, and
admin SPAs itself:

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
        ┌───────────┼─────────────┐
        │           │             │
        ▼           ▼             ▼
   ┌─────────┐ ┌─────────┐  ┌──────────┐
   │ postgres│ │ payer-  │  │service-  │
   │   :5432 │ │ daemon  │  │registry- │
   └─────────┘ │  (UDS)  │  │ daemon   │
               └────┬────┘  └────┬─────┘
                    │            │
                    ▼            ▼
                  chain RPC  +  on-chain registry
```

The gateway, postgres, and the two daemons share a `livepeer-run`
volume for their UDS sockets. Daemons read the same EVM chain RPC.

---

## Pre-flight checklist

Before `docker compose up`:

- [ ] Domain DNS records pointing at the host (`example.com` and a
      metrics host, or your equivalent).
- [ ] TLS — Let's Encrypt or your CA of choice.
- [ ] Postgres data volume backed by durable storage.
- [ ] An EVM JSON-RPC endpoint (Arbitrum One default).
- [ ] A funded Ethereum keystore for the payer-daemon (see
      §"Keystore provisioning" below).
- [ ] An `AI_SERVICE_REGISTRY_ADDRESS` for the chain you're on.
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

**Pepper rotation**: changing `API_KEY_HASH_PEPPER` invalidates every
existing API key. Rotating peppers is currently a planned outage —
v2 introduces dual-lookup. Until then, treat these as forever-fixed.

**Where they live**: keep them out of git. Use Docker compose's `.env`
(which is git-ignored by default here) or a secret manager fronting
the compose stack.

---

## Keystore provisioning (payer-daemon)

The payer-daemon needs an Ethereum keystore + password to mint
payment tickets. Without this, `/v1/*` returns 503.

1. **Generate a fresh wallet** (or use an existing one):

   ```bash
   docker run --rm -v $(pwd)/.keystore:/keystore ethereum/client-go:stable \
     account new --keystore /keystore
   ```

   This produces `UTC--<timestamp>--<address>` in `.keystore/`.

2. **Rename to `keystore.json`** for the daemon's expected path:

   ```bash
   mv .keystore/UTC--*--* .keystore/keystore.json
   ```

3. **Write the password file**:

   ```bash
   printf '%s' "your-keystore-password" > .keystore/keystore-password
   chmod 600 .keystore/keystore-password
   ```

4. **Fund the wallet** with enough ETH (on Arbitrum One, ~$5 in ETH
   for gas covers months of payment minting at low traffic). Use any
   bridge or buy on a CEX → withdraw to Arbitrum.

5. **Point compose at the directory**:

   ```bash
   LIVEPEER_KEYSTORE_DIR=/srv/openai-service/.keystore
   ```

   This path is mounted read-only into the payer-daemon container at
   `/etc/livepeer/`.

**Rotation**: replace the keystore + password files, restart the
payer-daemon. Open tickets continue to settle against the old
wallet's escrow until expiry; new tickets sign with the new key.

---

## Chain RPC

The two daemons each need an EVM JSON-RPC endpoint:

```bash
CHAIN_RPC=https://arb1.arbitrum.io/rpc   # public Arbitrum One
# Or a paid endpoint for production load.
```

For production, **use a paid endpoint** (Alchemy, Infura, QuickNode,
Ankr, …). Public endpoints rate-limit and won't carry sustained
traffic. The resolver and payer daemons both use this same `CHAIN_RPC`
value.

**Chain ID** is wired separately in `.env` (default 42161 = Arbitrum
One).

---

## Bringing the gateway online

The default compose stack gets you most of the way; the `livepeer`
```bash
# 1. clone + env
git clone <repo>
cd livepeer-modules-openai
cp .env.example .env
$EDITOR .env   # fill every required value

# 2. build
docker compose build gateway

# 3. full stack (db + gateway + resolver + payer)
docker compose up -d
```

The compose defaults in this repo target `service-registry-daemon`
and `payment-daemon` `v1.3.0`, which is the gateway-compatible line
for the current branch. The daemon wiring is intentionally opinionated:
one `CHAIN_RPC`, one `CHAIN_ID`, on-chain discovery only, unsigned
registrations rejected, and no static overlays. If you override daemon
tags, keep them on a `v1.3.x`-compatible contract surface.

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
   `503 models_cache_stale`, the registry-backed cache is not yet safe
   to serve. Check `docker compose logs gateway` and
   `docker compose logs service-registry-daemon`, then wait at least one
   refresh cycle.
   If you get `200` with `0`, the registry refresh hasn't found any
   candidates. Check `docker compose logs service-registry-daemon` for
   chain errors.

3. **Pick a model**, hit `/v1/chat/completions` with `stream: false`:

   ```bash
   curl https://example.com/v1/chat/completions \
     -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"qwen3:8b","messages":[{"role":"user","content":"say hi"}]}'
   ```

   Expect a 200 with an OpenAI-shaped response. If you get a 502,
   check `docker compose logs gateway` — the failover loop will have
   logged each broker it tried.

4. **Confirm the reservation row settled**:

   ```bash
   docker compose exec db psql -U openai_service -c \
     "SELECT capability,
             model,
             selected_capability,
             selected_offering,
             quote_id,
             quote_version,
             state,
             estimated_work_units,
             committed_work_units,
             latency_ms
      FROM usage_reservations ORDER BY created_at DESC LIMIT 5;"
   ```

   The latest row should be `state=committed` with a non-null
   `committed_work_units`, a sensible `latency_ms`, and populated
   `selected_capability` / `selected_offering` / `quote_id` fields.

5. **Confirm the models cache has quote-aware inspection metadata**:

   ```bash
   docker compose exec db psql -U openai_service -c \
     "SELECT model_id,
             capability,
             quote_id,
             quote_version,
             units_per_price
      FROM models
      WHERE active = true
      ORDER BY snapshot_at DESC
      LIMIT 10;"
   ```

   Expect non-empty rows after at most one registry refresh cycle.

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

#### Upgrade note — daemon alignment (`f98ba48`)

The commit `f98ba48` (`Align gateway with v1.3.0 resolver and payer daemons`)
requires two new gateway migrations:

- `0002_usage_reservation_route_metadata.sql`
- `0003_models_quote_metadata.sql`

They add nullable quote-aware diagnostic fields only, so the rollout is
forward-compatible:

- `usage_reservations` gains selected route / quote metadata
  (`selected_capability`, `selected_offering`, `selected_work_unit`,
  `units_per_price`, `quote_id`, `quote_version`,
  `constraint_fingerprint_hex`, `route_fingerprint_hex`)
- `models` gains cached inspection metadata
  (`units_per_price`, `quote_id`, `quote_version`,
  `constraint_fingerprint_hex`, `route_fingerprint_hex`)

Operationally:

1. Deploy the gateway image containing `f98ba48`.
2. Let the boot-time migration runner apply both migrations.
3. Confirm new `/v1/*` traffic starts populating the added reservation
   fields.
4. Confirm the background registry refresh starts populating the added
   model-cache fields.

This commit also assumes `service-registry-daemon` and `payment-daemon`
are already on the `v1.3.0`-compatible contract surface. The repo's
current compose and `.env.example` defaults now point at `v1.3.0`
directly.

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
- `openai_service_waitlist_signups_total`
- `livepeer_gateway_route_health_*` (from the inlined
  gateway-route-health renderer)

Recommended starter alerts:

- 5xx rate above 1% sustained 5 min on `/v1/*`
- `proxy_reservations_total{outcome="refunded"}` rising sharply
  vs `committed`
- `livepeer_gateway_route_health_cooldowns_opened_total` rising —
  brokers going unhealthy
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
| `/health` shows `payer: error` | Payer-daemon not running, or socket path mismatch | `docker compose logs payer-daemon` |
| `/health` shows `registry: error` | Registry-daemon not running, or chain RPC unreachable | `docker compose logs service-registry-daemon` |
| `/v1/models` returns empty `data: []` | No candidates from registry — either no orchestrators advertising, or registry-daemon hasn't synced yet | Logs of registry-daemon; wait one refresh cycle |
| Every `/v1/*` returns 502 | All brokers failing, or payer-daemon can't mint | gateway logs (failover loop logs each candidate) |
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
