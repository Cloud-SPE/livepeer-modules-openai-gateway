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

  SITE[web/site<br/>Lit zero-build] -->|served by gateway| GW
  PORTAL[web/portal<br/>Lit zero-build] -->|served by gateway at /portal/| GW
  ADMIN[web/admin<br/>Lit zero-build] -->|served by gateway at /admin/| GW

  GW[gateway<br/>TS / Fastify] -->|SQL| DB[(Postgres)]
  GW -->|HTTPS + X-API-Key<br/>jobs + settle| LOC[LOC clearinghouse<br/>route selection + PM tickets]
  GW -->|Livepeer-* headers<br/>+ Livepeer-Payment| BROKER[capability-broker<br/>on orchestrator host]
  BROKER --> WORKER[capability worker<br/>chat / embeddings / audio / tts / images / rerank]
  GW -->|optional| RESEND[Resend<br/>email]

  LOC -.->|selects routes,<br/>signs tickets| CHAIN[(EVM chain<br/>AI service registry)]

  classDef ours fill:#1f3a2a,stroke:#4cd97b,color:#e8eaed;
  classDef ext fill:#1a1c20,stroke:#9aa0a6,color:#9aa0a6,stroke-dasharray: 4 2;
  class GW,SITE,PORTAL,ADMIN,DB ours;
  class LOC,BROKER,WORKER,RESEND,CHAIN ext;
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
| **Admin** | `web/admin/` | Operator console: waitlist queue, users, usage, LOC + catalog debug. | `X-Admin-Token` UX (stored in localStorage). |

Route selection and payment minting are delegated to the **LOC —
Livepeer Open Clearinghouse**, an external HTTP service
(the sibling localhost service in development) reached with an `X-API-Key`
header. The gateway opens a job per `/v1/*` request and settles actual
usage afterwards. The LOC owns chain access and the pooled wallet that
signs payment (PM) tickets; this repo holds no keys and never talks to
the chain. The LOC is **not** in this repository and is not part of the
compose stack.

---

## 3. Gateway internal layering

```
            ┌────────────────────────────────────────────┐
            │ index.ts / server.ts  (app wiring)         │
            ├────────────────────────────────────────────┤
            │ routes/{public,portal,admin}/  proxy/      │  ← HTTP surface
            ├────────────────────────────────────────────┤
            │ loc/  proxy/livepeer/  email/              │  ← service / wire
            ├────────────────────────────────────────────┤
            │ repo/  schema/  registry/                  │  ← data / catalog
            ├────────────────────────────────────────────┤
            │ config.ts  db.ts  crypto.ts  metrics.ts    │  ← primitives
            └────────────────────────────────────────────┘
```

Edges go *down* only. Cross-cutting concerns (config, db pool,
email client, LOC client, rate limiter) are bundled into
`ServerDeps` in `index.ts` and threaded to every handler via
`app.decorate('deps', deps)` on the Fastify instance. Handlers read
them via `app.deps`. Enforcement is `tsc` + reviewer attention; a
mechanical import-graph linter is on the tech-debt tracker.

### Source-of-truth split

| Subtree | Origin | Notes |
|---|---|---|
| `proxy/livepeer/` | Hand-maintained protocol adapters | `/v1/job` unary, stream, and multipart transports; no accounting policy. |
| `loc/` | Hand-written in this repo | Typed LOC client, idempotent open/dispatch, signed evidence lookup, and durable settlement workers. |
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
  MODELS }o..o{ MODELS_CACHE_REFRESH : "(no FK)<br/>refreshed from LOC catalog"

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
    text state "open|committed|failed"
    bigint estimated_work_units
    bigint committed_work_units
    numeric price_per_work_unit_wei
    integer latency_ms
    integer status_code
    text error_text
    text loc_job_id
    text settle_state "pending|settled|failed (nullable)"
    bigint settle_actual_units
    text settle_outcome
    timestamptz created_at
    timestamptz resolved_at
  }

  MODELS {
    text model_id PK
    text capability
    text protocol
    jsonb transports
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
home-grown runner (`gateway/src/db.ts`). The current shape is
`0001_initial.sql` through `0009_usage_outcome_not_refund.sql`. Migrations
`0004`–`0009` are the breaking paid-job/v1 transition: LOC and broker
identities, protocol/transport catalog axes, exact signed evidence, request-ID
recovery states, capability-scoped model IDs, and the customer outcome
`failed`. The rebuildable v0 model cache is cleared rather than dual-read.

### Why the state machine on `usage_reservations`

`open → committed | failed` records the customer-visible gateway outcome;
it is not network accounting evidence. Broker settlement lookup persists the
complete signed claim and only then sets `settle_state='pending'`. The
background settler submits that exact claim to LOC. Gateway observations,
signed broker evidence, and LOC settlement state stay distinct.

### Why a `models` cache table

`/v1/models` must be cheap. Calling the LOC catalog on every request
would couple catalog reads to LOC availability + add latency to every
`models` request. The background refresh task (every
`REGISTRY_REFRESH_INTERVAL_MS`, default 60s) reads the LOC
`GET /v1/capabilities`, flattens it, and writes the latest snapshot into
`models`; the HTTP handler reads from there. Stale rows get
`active=false` so disappearance is reflected within one refresh. Display
metadata is operator-override only; the model id is the LOC offering id.

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
  participant LOC as LOC clearinghouse
  participant BRK as capability-broker
  participant RNR as runner
  participant LOOK as evidence lookup
  participant SET as LOC settler

  C->>GW: POST /v1/chat/completions<br/>Authorization: Bearer sk-…
  GW->>DB: SELECT api_keys WHERE key_hash=…
  Note over GW,DB: 401 if missing/revoked/unapproved
  GW->>DB: INSERT usage_reservations (state='open', work_id)
  GW->>LOC: POST /v1/jobs<br/>Idempotency-Key + transport + funded ceiling
  Note over LOC: selects one route and mints<br/>the bounded payment envelope
  LOC-->>GW: {job_id, request_id, work_id, broker_url,<br/>protocol, transport, work_unit, payment_envelope}
  GW->>DB: persist LOC and payment identities
  GW->>BRK: POST /v1/job<br/>Protocol + LOC request ID + payment
  BRK->>RNR: forward request
  RNR-->>BRK: response (SSE stream or unary)
  BRK-->>GW: response

  alt success
    GW->>DB: state='committed'; persist broker job ID
    GW-->>C: response (200, SSE or JSON)
  else upstream failure
    GW->>DB: state='failed', error_text=…<br/>accounting remains independent
    GW-->>C: OpenAI-shaped error<br/>(502/500)
  end

  loop every LOC_SETTLE_INTERVAL_MS
    LOOK->>DB: SELECT pending evidence lookups
    LOOK->>BRK: GET settlement by job ID or request ID
    BRK-->>LOOK: signed terminal claim or pending state
    LOOK->>DB: persist exact signed claim before settlement
    SET->>DB: SELECT signed pending settlements
    SET->>LOC: POST /v1/jobs/{id}/settle<br/>signed evidence + bound identities
    LOC-->>SET: verified accounting result
    SET->>DB: settle_state='settled'
  end
```

### 5.3 Catalog refresh

```mermaid
sequenceDiagram
  participant T as gateway boot
  participant TIMER as setInterval (60s)
  participant CAT as registryCatalog<br/>(LOC-backed)
  participant LOC as LOC clearinghouse
  participant DB as postgres

  T->>TIMER: startRegistryRefresh()
  loop every REGISTRY_REFRESH_INTERVAL_MS
    TIMER->>CAT: inspect()
    CAT->>LOC: GET /v1/capabilities
    LOC-->>CAT: capabilities + offerings
    CAT-->>TIMER: RouteCandidate[]
    TIMER->>DB: BEGIN<br/>UPSERT models (one row per offering id)<br/>UPDATE active=false where modelId NOT IN (…)<br/>COMMIT
  end

  Note over DB: /v1/models reads this table — never queries the LOC directly.
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
| LOC clearinghouse | HTTP(S) + `X-API-Key` (`LOC_BASE_URL`); jobs + settle + capabilities |
| `capability-broker` | HTTP(S), always using the URL returned by the LOC job; localhost pilot returns `127.0.0.1:8411` |
| Local audio-duration estimator | Gateway-owned implementation of the advertised `multipart-audio-duration/v1` funding contract; no Modules source or package dependency |
| Postgres | TCP, single DB for all SaaS data |
| Resend | HTTPS, email delivery (optional in dev) |
| EVM chain (Arbitrum One by default) | Indirectly — only via the LOC, which owns chain access and the PM-ticket wallet |

---

## 7. Boundaries that matter

- **The proxy doesn't know about humans.** `/v1/*` authenticates via
  API key and joins to `usage_reservations.api_key_id`. Names + emails
  live in `waitlist`. The only join between the two namespaces is
  `api_keys.waitlist_id`.
- **The wire spec is product-agnostic.** `proxy/livepeer/` only knows
  paid-job headers and HTTP transports. Mapping OpenAI →
  capability happens in the per-endpoint handlers
  (`proxy/{chat,embeddings,…}.ts`).
- **The SaaS shell is product-agnostic.** Auth, waitlist, sessions,
  admin could be reused for a different inference surface. OpenAI
  specifics live entirely in `proxy/`.
- **Runner implementations do not cross the boundary.** Workload execution is
  mediated by broker HTTP. The gateway-owned audio-duration estimator
  implements a published funding contract; it does not import runner, broker,
  or Modules implementation code.

---

## 8. Observability

- **Prometheus** `/metrics` on the gateway, optionally Bearer-gated
  via `METRICS_TOKEN`. Surfaces:
  - Default Node process metrics (heap, GC, event-loop lag) under
    prefix `openai_service_*`
  - HTTP: `openai_service_http_requests_total{method,route,status}`,
    `openai_service_http_request_duration_seconds`
  - Proxy: `openai_service_proxy_reservations_total{capability,outcome}`
  - Settler: `openai_service_proxy_settle_total{outcome}`
  - Waitlist: `openai_service_waitlist_signups_total`
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
  end

  GW <-->|TCP| DB
  GW <-->|HTTPS + X-API-Key| LOC[LOC clearinghouse<br/>external]

  proxy[Reverse proxy<br/>Traefik / nginx / Cloud LB] -->|host: api.*| GW
  proxy -->|host: example.com| GW
  proxy -->|host: metrics.*<br/>+ basic auth| GW

  classDef ours fill:#1f3a2a,stroke:#4cd97b,color:#e8eaed;
  classDef ext fill:#1a1c20,stroke:#9aa0a6,color:#9aa0a6,stroke-dasharray: 4 2;
  class GW,DB ours;
  class LOC,proxy ext;
```

The compose stack is just `db` + `gateway` — no daemon sidecars, no
unix-socket volumes. In the localhost pilot, `make pilot` runs foreground
Compose with host networking for the gateway so LOC-returned loopback broker
URLs work. Each SPA runs via its own `dev-server.js`, serving its
checked-in files locally and proxying API traffic back to the gateway.

---

## 10. Out of scope here

- The Livepeer wire spec itself — owned by `livepeer-network-protocol`
  in the source monorepo.
- The on-chain service registry contracts — operated separately.
- Production deployment infra (Grafana, Prometheus, Traefik configs)
  — deferred; will land under `infra/` later (tracked in
  `docs/exec-plans/tech-debt-tracker.md` when prioritized).
- The LOC clearinghouse itself — route selection, the pooled
  PM-ticket wallet, and chain access are owned by the LOC, not this
  repo. `make loc-smoke` exercises a real job open + settle against it.
- Real upstream proxying validation — needs a real `capability-broker`.
  Everything up to and including the broker call is unit-tested via the
  smoke flow.
