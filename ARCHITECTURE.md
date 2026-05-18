# ARCHITECTURE

Top-level map of the repository. Follows the
[ARCHITECTURE.md convention](https://matklad.github.io/2021/02/06/ARCHITECTURE.md.html):
this file is for *bird's-eye orientation*. Deeper detail lives in
[`docs/design-docs/`](./docs/design-docs/) and in each
file's docstring.

For "what does this thing do?" see [`DESIGN.md`](./DESIGN.md).
For invariants, see
[`docs/design-docs/core-beliefs.md`](./docs/design-docs/core-beliefs.md).

---

## 1. System overview

```mermaid
flowchart LR
  user[Developer<br/>OpenAI SDK] -->|/v1/*<br/>Bearer sk-…| GW
  visitor[Web visitor] -->|HTTP| SITE
  portalUser[Approved user] -->|HTTP + cookie| PORTAL
  admin[Operator] -->|HTTP + X-Admin-Token| ADMIN

  SITE[web/site<br/>Lit zero-build] -->|/api/*| GW
  PORTAL[web/portal<br/>Lit zero-build] -->|/api/*, /portal/*| GW
  ADMIN[web/admin<br/>Lit zero-build] -->|/api/*, /admin/*| GW

  GW[gateway<br/>TS / Fastify] -->|SQL| DB[(Postgres)]
  GW -->|gRPC UDS| REG[service-registry-daemon]
  GW -->|gRPC UDS| PAYER[payment-daemon]
  GW -->|Livepeer-* headers<br/>+ Livepeer-Payment| BROKER[capability-broker<br/>on orchestrator host]
  BROKER --> WORKER[capability worker<br/>chat / embeddings / audio / tts / images / rerank]
  GW -->|optional| RESEND[Resend<br/>email]

  REG -.->|reads| CHAIN[(EVM chain<br/>AI service registry)]
  PAYER -.->|reads| CHAIN

  classDef ours fill:#1f3a2a,stroke:#4cd97b,color:#e8eaed;
  classDef ext fill:#1a1c20,stroke:#9aa0a6,color:#9aa0a6,stroke-dasharray: 4 2;
  class GW,SITE,PORTAL,ADMIN,DB ours;
  class REG,PAYER,BROKER,WORKER,RESEND,CHAIN ext;
```

Green = in this repo. Dashed gray = external runtime peers (run as
their own containers / on other hosts).

---

## 2. Components

| Component | Path | Purpose | Owns |
|---|---|---|---|
| **Gateway** | `gateway/` | Translates OpenAI requests → Livepeer wire. Hosts the SaaS shell (waitlist, sessions, API keys, admin). | The only stateful service in this repo (besides Postgres). |
| **Marketing site** | `web/site/` | Public landing + waitlist signup + email-verification page. | Generic copy; rebrand at deploy time. |
| **Portal** | `web/portal/` | Authenticated user dashboard: account, API keys, usage. | Cookie-session UX. |
| **Admin** | `web/admin/` | Operator console: waitlist queue, users, usage, registry debug. | `X-Admin-Token` UX (stored in localStorage). |
| **Protos** | `proto/` | Vendored gRPC definitions for `payment-daemon` + `service-registry-daemon`. | Loaded at runtime by the gateway. |

The two Livepeer daemons (`service-registry-daemon`,
`payment-daemon`) are pulled as official Docker images
(`tztcloud/livepeer-*-daemon`) and run alongside the gateway in the
`livepeer` compose profile. They are **not** in this repository.

---

## 3. Gateway internal layering

```
            ┌────────────────────────────────────────────┐
            │ index.ts / server.ts  (app wiring)         │
            ├────────────────────────────────────────────┤
            │ routes/{public,portal,admin}/  proxy/      │  ← HTTP surface
            ├────────────────────────────────────────────┤
            │ proxy/service/  proxy/livepeer/  email/    │  ← service / wire
            ├────────────────────────────────────────────┤
            │ repo/  schema/  registry/                  │  ← data / RPC
            ├────────────────────────────────────────────┤
            │ config.ts  db.ts  crypto.ts  metrics.ts    │  ← primitives
            └────────────────────────────────────────────┘
```

Edges go *down* only. Cross-cutting concerns (config, db pool,
email client, route selector, rate limiter) are bundled into
`ServerDeps` in `index.ts` and threaded to every handler via
`app.decorate('deps', deps)` on the Fastify instance. Handlers read
them via `app.deps`. Enforcement is `tsc` + reviewer attention; a
mechanical import-graph linter is on the tech-debt tracker.

### Source-of-truth split

| Subtree | Origin | Notes |
|---|---|---|
| `proxy/livepeer/`, `proxy/service/` | Copied verbatim from upstream `livepeer-network-modules/openai-gateway/` | Load-bearing wire mechanics — streaming usage parsing, payment minting, failover. Don't churn. |
| `proxy/service/genericRouteHealth.ts` | Inlined upstream `gateway-route-health` package | The TS class + Prometheus renderer. |
| `proxy/{chat,embeddings,audio-speech,audio-transcriptions,images}.ts` | Adapted from upstream | Stripped of `customer-portal` + `chatBilling`/`nonChatBilling`; rewired to local `apiKeys` + `usage_reservations`. |
| `proxy/rerank.ts` | Ported from an earlier Rust implementation of the same surface | TS reimplementation. |
| Everything else (`routes/`, `repo/`, `schema/`, `crypto.ts`, `email/`, `metrics.ts`, `db.ts`, `config.ts`, `server.ts`, `index.ts`) | Hand-written in this repo | Built directly for this repository. |

---

## 4. Data storage

```mermaid
erDiagram
  WAITLIST ||--o{ API_KEYS : "owns"
  API_KEYS ||--o{ USER_SESSIONS : "issues"
  API_KEYS ||--o{ USAGE_RESERVATIONS : "logs"
  MODELS }o..o{ MODELS_CACHE_REFRESH : "(no FK)<br/>refreshed from registry"

  WAITLIST {
    uuid id PK
    text email UK
    text name
    text ip_hash
    timestamptz email_verified_at
    text verification_token_hash UK "nullable"
    timestamptz verification_token_expires_at
    text status "pending|approved|rejected"
    timestamptz approved_at
    text approved_by
    timestamptz created_at
  }

  API_KEYS {
    uuid id PK
    uuid waitlist_id FK
    text label
    text key_prefix "sk-XXXXNNNN"
    text key_hash "SHA-256+pepper"
    timestamptz created_at
    timestamptz last_used_at
    timestamptz revoked_at
  }

  USER_SESSIONS {
    uuid id PK
    uuid api_key_id FK
    text session_hash
    timestamptz expires_at
    timestamptz revoked_at
    timestamptz created_at
  }

  USAGE_RESERVATIONS {
    uuid id PK
    uuid api_key_id FK
    uuid work_id UK
    text capability
    text model
    text broker_url
    text eth_address
    text state "open|committed|refunded"
    bigint estimated_work_units
    bigint committed_work_units
    numeric price_per_work_unit_wei
    integer latency_ms
    integer status_code
    text error_text
    timestamptz created_at
    timestamptz resolved_at
  }

  MODELS {
    text model_id PK
    text capability
    text interaction_mode
    text name
    text description
    text provider
    text category
    text eth_address
    numeric price_per_work_unit_wei
    text broker_url
    jsonb extra_json
    jsonb constraints_json
    boolean active
    timestamptz snapshot_at
  }
```

**One Postgres database. One migration track.** `gateway/migrations/`
holds numbered `.sql` files applied in order at boot by a
home-grown runner (`gateway/src/db.ts`). The current shape is the
single migration `0001_initial.sql`.

### Why the state machine on `usage_reservations`

v1 has no billing math, so `open → committed | refunded` is purely
observational. The schema is intentionally forward-compatible: when
billing lands, the same rows + state machine can carry money math
without a schema change.

### Why a `models` cache table

`/v1/models` must be cheap. Querying the gRPC resolver on every call
would couple catalog reads to chain availability + add 100ms+ to
every `models` request. The background refresh task (every
`REGISTRY_REFRESH_INTERVAL_MS`, default 60s) writes the latest
snapshot into `models`; the HTTP handler reads from there. Stale rows
get `active=false` so disappearance is reflected within one refresh.

---

## 5. Process flows

### 5.1 Signup → verify → approve → key

```mermaid
sequenceDiagram
  participant V as Visitor
  participant SITE as web/site
  participant GW as gateway
  participant DB as postgres
  participant RES as Resend
  participant ADM as Operator (web/admin)

  V->>SITE: fill signup form
  SITE->>GW: POST /api/waitlist {name, email}
  GW->>DB: INSERT waitlist (status=pending, verification_token_hash=…)
  GW->>RES: send verification email<br/>(link → PUBLIC_SITE_URL/verify.html?token=…)
  GW-->>SITE: {ok: true}
  SITE-->>V: "check your inbox"

  V->>SITE: click link → /verify.html?token=…
  SITE->>GW: GET /api/verify?token=…
  GW->>DB: UPDATE waitlist SET email_verified_at=now(), token_hash=NULL
  GW-->>SITE: {ok: true, message: "Email verified…"}

  ADM->>GW: GET /admin/waitlist?status=pending
  Note over ADM,GW: Operator reviews queue
  ADM->>GW: POST /admin/waitlist/:id/approve<br/>(X-Admin-Token)
  GW->>DB: tx: INSERT api_keys + UPDATE waitlist status=approved
  GW->>RES: send API-key delivery email<br/>(plaintext key shown once)
  GW-->>ADM: {ok: true}
```

### 5.2 `/v1/*` request lifecycle

```mermaid
sequenceDiagram
  participant C as OpenAI SDK client
  participant GW as gateway
  participant DB as postgres
  participant PAY as payment-daemon
  participant REG as service-registry-daemon
  participant BRK as capability-broker
  participant RNR as runner

  C->>GW: POST /v1/chat/completions<br/>Authorization: Bearer sk-…
  GW->>DB: SELECT api_keys WHERE key_hash=…
  Note over GW,DB: 401 if missing/revoked/unapproved
  GW->>DB: INSERT usage_reservations (state='open', work_id)
  GW->>REG: gRPC: select candidates by capability+offering
  REG-->>GW: ranked candidates
  GW->>PAY: gRPC: CreatePayment(face_value, recipient, capability)
  PAY-->>GW: payment_bytes
  GW->>BRK: POST /v1/cap<br/>Livepeer-Capability, Livepeer-Payment, …
  BRK->>RNR: forward request
  RNR-->>BRK: response (SSE stream or unary)
  BRK-->>GW: response

  alt success
    GW->>DB: UPDATE usage_reservations<br/>state='committed', committed_work_units=…
    GW-->>C: response (200, SSE or JSON)
  else upstream failure
    Note over GW: failover loop:<br/>retry next candidate
    GW->>DB: UPDATE usage_reservations<br/>state='refunded', error_text=…
    GW-->>C: OpenAI-shaped error<br/>(502/500)
  end
```

### 5.3 Registry refresh

```mermaid
sequenceDiagram
  participant T as gateway boot
  participant TIMER as setInterval (60s)
  participant RS as RouteSelector<br/>(in-process)
  participant REG as service-registry-daemon
  participant DB as postgres

  T->>TIMER: startRegistryRefresh()
  loop every REGISTRY_REFRESH_INTERVAL_MS
    TIMER->>RS: inspect()
    RS->>REG: ListKnown → ResolveByAddress(per addr)
    REG-->>RS: nodes + capabilities + offerings
    RS-->>TIMER: RouteCandidate[]
    TIMER->>DB: BEGIN<br/>UPSERT models (one row per modelId)<br/>UPDATE active=false where modelId NOT IN (…)<br/>COMMIT
  end

  Note over DB: /v1/models reads this table — never queries the registry directly.
```

### 5.4 Portal cookie auth

```mermaid
sequenceDiagram
  participant U as User (with API key from email)
  participant P as web/portal
  participant GW as gateway
  participant DB as postgres

  U->>P: visit /
  P->>GW: GET /portal/account
  GW-->>P: 401
  P-->>U: render <cc-login>
  U->>P: paste API key, submit
  P->>GW: POST /portal/login {apiKey}
  GW->>DB: SELECT api_keys WHERE key_hash=…
  GW->>DB: INSERT user_sessions (session_hash, expires_at)
  GW-->>P: Set-Cookie: openai_service_session=…
  P->>GW: GET /portal/account (cookie attached)
  GW->>DB: lookup session → api_key → waitlist
  GW-->>P: {email, name, waitlistId}
```

---

## 6. External dependencies

| What | How it talks to us |
|---|---|
| OpenAI SDK clients | HTTPS → `/v1/*` |
| Portal / admin / site users | HTTPS → static SPAs + JSON APIs |
| `service-registry-daemon` | gRPC over UDS (`/var/run/livepeer/service-registry.sock`) |
| `payment-daemon` | gRPC over UDS (`/var/run/livepeer/payer-daemon.sock`) |
| `capability-broker` (on orch host) | HTTPS, per the Livepeer wire spec |
| Postgres | TCP, single DB for all SaaS data |
| Resend | HTTPS, email delivery (optional in dev) |
| EVM chain (Arbitrum One by default) | Indirectly — only via the two daemons |

---

## 7. Boundaries that matter

- **The proxy doesn't know about humans.** `/v1/*` authenticates via
  API key and joins to `usage_reservations.api_key_id`. Names + emails
  live in `waitlist`. The only join between the two namespaces is
  `api_keys.waitlist_id`.
- **The wire spec is product-agnostic.** `proxy/livepeer/` only knows
  `Livepeer-Capability` headers + interaction modes. Mapping OpenAI →
  capability happens in the per-endpoint handlers
  (`proxy/{chat,embeddings,…}.ts`).
- **The SaaS shell is product-agnostic.** Auth, waitlist, sessions,
  admin could be reused for a different inference surface. OpenAI
  specifics live entirely in `proxy/`.
- **Runners don't import from the gateway and vice versa.** The only
  contract between them is the HTTP capability endpoint a runner
  exposes, mediated by the broker. Either could be deleted without
  breaking the other.

---

## 8. Observability

- **Prometheus** `/metrics` on the gateway, optionally Bearer-gated
  via `METRICS_TOKEN`. Surfaces:
  - Default Node process metrics (heap, GC, event-loop lag) under
    prefix `openai_service_*`
  - HTTP: `openai_service_http_requests_total{method,route,status}`,
    `openai_service_http_request_duration_seconds`
  - Proxy: `openai_service_proxy_reservations_total{capability,outcome}`
  - Waitlist: `openai_service_waitlist_signups_total`
  - Route health (from `gateway-route-health` renderer):
    `livepeer_gateway_route_health_*`
- **Structured JSON logs** to stdout via Fastify's pino logger.
  Request IDs propagated as `Livepeer-Request-Id` on `/v1/*`.
- **`usage_reservations`** is the durable per-request log (queryable
  via `/admin/usage` and `/portal/usage`).

---

## 9. Deployment shape

```mermaid
flowchart TB
  subgraph host[Single host or k8s pod]
    GW[gateway]
    DB[(postgres)]
    REG[service-registry-daemon]
    PAYER[payment-daemon]
    UDS[(livepeer-run<br/>volume<br/>UDS sockets)]
  end

  GW <-->|TCP| DB
  GW <-->|UDS| UDS
  REG <-->|UDS| UDS
  PAYER <-->|UDS| UDS

  CDN[CDN / static host]
  cdn_site[web/site] --> CDN
  cdn_portal[web/portal] --> CDN
  cdn_admin[web/admin] --> CDN

  proxy[Reverse proxy<br/>Traefik / nginx / Cloud LB] -->|host: api.*| GW
  proxy -->|host: example.com| CDN
  proxy -->|host: portal.*| CDN
  proxy -->|host: admin.*| CDN
  proxy -->|host: metrics.*<br/>+ basic auth| GW

  classDef ours fill:#1f3a2a,stroke:#4cd97b,color:#e8eaed;
  classDef ext fill:#1a1c20,stroke:#9aa0a6,color:#9aa0a6,stroke-dasharray: 4 2;
  class GW,DB,UDS,cdn_site,cdn_portal,cdn_admin ours;
  class REG,PAYER,CDN,proxy ext;
```

In dev, the same shape collapses: `docker compose up -d` runs gateway
+ db; each SPA runs via its own `dev-server.js` with a path-prefix
proxy to the gateway.

---

## 10. Out of scope here

- The Livepeer wire spec itself — owned by `livepeer-network-protocol`
  in the source monorepo.
- The on-chain service registry contracts — operated separately.
- Production deployment infra (Grafana, Prometheus, Traefik configs)
  — deferred; will land under `infra/` later (tracked in
  `docs/exec-plans/tech-debt-tracker.md` when prioritized).
- Real upstream proxying validation — needs a real
  `capability-broker` + `payment-daemon`. Everything up to and
  including the broker call is unit-tested via the smoke flow.
