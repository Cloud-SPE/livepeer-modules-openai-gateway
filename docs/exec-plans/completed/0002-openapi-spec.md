# 0002 — OpenAPI spec for `/api/*`, `/portal/*`, `/admin/*`

**Status**: active
**Opened**: 2026-05-18
**Driver**: Mike Zupper

## One-liner

Ship a machine-readable OpenAPI 3.1 document for every non-`/v1/*`
endpoint the gateway hosts, served at `GET /openapi.json` with an
interactive Swagger UI at `GET /docs`.

## Context

`/portal/*` and `/admin/*` have no machine-readable contract today.
The SPAs hand-roll their HTTP via `web/{portal,admin}/lib/api.js`;
endpoint shape drift breaks SPAs silently at runtime. Anyone writing
tooling against the admin API has to read prose and curl-poke.
See the `## OpenAPI spec` discussion in conversation `[2026-05-18]`.

## Scope — in

| Surface | Route count | Notes |
|---|---|---|
| `/api/*` (public) | 2 | `/api/waitlist` (POST), `/api/verify` (GET) |
| `/portal/*` (cookie session) | 7 | login/logout, account, api-keys × 3, usage |
| `/admin/*` (X-Admin-Token) | 10 | waitlist × 4, users × 2, usage, registry × 3 |
| **Total** | **19** | |

Each route lands with: `tags`, `summary`, request schemas (`body`,
`params`, `querystring`, `headers` where applicable), success
response schema, error response references.

## Scope — out

- **`/v1/*` proxy endpoints.** OpenAI publishes
  [`openai-openapi`](https://github.com/openai/openai-openapi) for
  this surface; we deliberately conform. Adding our own conflicting
  spec would invite drift between our YAML and OpenAI's canonical
  one.
- **`/health`, `/healthz`, `/metrics`, `/v1/models`.** Infra
  endpoints; clients don't generate SDKs against them.
- **Response runtime validation.** Schemas document responses but
  don't *enforce* them (no `responseValidation: true`). v1 tradeoff:
  documentation wins over runtime cost; tighten later if drift
  appears.
- **SPA client generation.** A natural follow-up — once the spec
  exists, run `openapi-typescript` to emit
  `web/{portal,admin}/lib/api.gen.ts` and replace the hand-rolled
  `api.js`. Separate plan.
- **CI spec-diff job.** Same — once spec exists, CI can fail when
  the emitted JSON diverges from a committed snapshot. Separate
  plan.

## Approach

### Dependencies

```
+ @fastify/swagger@^9
+ @fastify/swagger-ui@^5
+ fastify-type-provider-zod@^4
```

`fastify-type-provider-zod` is the bridge: it registers
`validatorCompiler` + `serializerCompiler` once, then `schema: {
body: <zodSchema>, … }` flows through Fastify's native validation
*and* feeds `@fastify/swagger` for spec generation. Single source of
truth = the zod schema; the spec is derived.

### Shared schema module

New `gateway/src/schema/api.ts` (companion to `gateway/src/schema/`
which holds Drizzle table schemas). Holds:

- `ErrorBody` — `{ error: { message, type, code? } }`
- `OkBody` — `{ ok: true }`
- `PaginationQuery` — `limit`/`offset` with defaults + caps
- `IdParam` — `{ id: uuid }`
- Common response references for 401 / 403 / 429 / 503

Route-specific schemas stay co-located with the route file. Request
schemas like `SignupSchema`, `LoginSchema`, etc., already exist
inline today — they get extracted to module-level consts where
needed.

### Per-route migration pattern

```ts
// Before
app.post('/api/waitlist', async (req, reply) => {
  const parsed = SignupSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: '...' });
  // use parsed.data
});

// After
app.post('/api/waitlist', {
  schema: {
    tags: ['public'],
    summary: 'Join the waitlist',
    description: 'Public signup. Idempotent on existing email.',
    body: SignupSchema,
    response: {
      200: OkBody,
      400: ErrorBody,
      429: ErrorBody,
    },
  },
}, async (req, reply) => {
  // req.body is typed by zod-type-provider AND validated by Fastify
});
```

Fastify validates `body` automatically; if it fails, the route
handler isn't called. Our manual `safeParse` blocks get removed.

### Boot wiring

In `server.ts`:

1. `setValidatorCompiler` + `setSerializerCompiler` from
   `fastify-type-provider-zod`.
2. Register `@fastify/swagger` with OpenAPI 3.1 metadata + security
   schemes (`cookieAuth`, `adminToken`).
3. Register `@fastify/swagger-ui` at `/docs` (route prefix).
4. `app.withTypeProvider<ZodTypeProvider>()` applied at app level
   for type inference.
5. `/openapi.json` served by the swagger plugin's default route.

### Documentation

- `README.md` gains a "Browsing the API" subsection in the
  Configuration section.
- `DEPLOYMENT.md` mentions `/docs` for production deploys
  (gate behind admin auth in prod via reverse proxy).
- `AGENTS.md` updates the "Where to look" table with the new
  surface.

## Acceptance

1. `pnpm -F …/gateway lint` clean.
2. `pnpm -F …/gateway test` — 45+ pass (existing + any new tests
   for the schema module).
3. `GET /openapi.json` returns a valid OpenAPI 3.1 document with
   19 paths.
4. `GET /docs` renders Swagger UI; every route's "Try it out" works
   against a running gateway (subject to auth — admin routes need
   the operator's token).
5. Every `/v1/*` route is **absent** from the spec.
6. `make smoke` still passes.
7. The plan moves to `docs/exec-plans/completed/`.

## Decision log

- **2026-05-18 — Single OpenAPI doc, not per-surface.** Could split
  into `/openapi/public.json` / `portal.json` / `admin.json`. One
  doc with `tags: [public|portal|admin]` is cheaper and renders
  fine in Swagger UI's tag-grouped layout.
- **2026-05-18 — OpenAPI 3.1 over 3.0.** Native JSON Schema
  alignment; matches what zod emits without lossy translation.
  Most tooling supports 3.1 by now.
- **2026-05-18 — No response runtime validation.** Schemas document
  shapes; enforcing them adds CPU on every response and turns
  schema drift into 500s instead of (eventually) caught drift. We
  can flip `responseValidation: true` per-route later if the
  contract for that route becomes load-bearing.
- **2026-05-18 — Skip `/v1/models` from the spec** despite it being
  in scope as "our" endpoint. Reason: it's the catalog endpoint of
  the OpenAI surface; documenting it twice (here + via OpenAI's
  spec) invites diff. The README's Configuration section can point
  at OpenAI's spec for `/v1/*` reference.
- **2026-05-18 (revised during impl) — fastify-type-provider-zod v6.**
  Plan named v4; that one peer-deps zod v3 and we're on zod v4. v6
  is the current line with zod v4 support.
- **2026-05-18 (revised during impl) — explicit /openapi.json route.**
  @fastify/swagger v9 doesn't auto-expose a canonical path; the
  swagger-ui plugin's `/docs/json` works but is non-obvious. Added a
  tiny passthrough handler at `/openapi.json` so external tooling
  finds the spec where it expects.

## Outcome — 2026-05-18

All 7 acceptance criteria met:

1. ✅ `pnpm -F …/gateway lint` clean.
2. ✅ `pnpm -F …/gateway test` — 45/45 pass (no new tests; existing
   coverage holds since the schema migration didn't change behavior).
3. ✅ `GET /openapi.json` returns OpenAPI 3.1 with **18 paths / 19
   operations** across `public` (2), `portal` (7), and `admin`
   (10) tags. Reusable components (e.g. `WaitlistSignupInput`,
   `ApiKeyPublic`, `WaitlistRow`, `ErrorBody`) emitted via
   `$ref: '#/components/schemas/…'`.
4. ✅ `GET /docs` renders Swagger UI (HTTP 200).
5. ✅ No `/v1/*` paths in the spec (`v1 paths: (empty - correct)`).
6. ✅ `make smoke` passes — all 14 checks ✓.
7. ✅ This file moves to `docs/exec-plans/completed/`.

Files touched:

- **Plugins**: added `@fastify/swagger@^9.4.2`,
  `@fastify/swagger-ui@^5.2.1`, `fastify-type-provider-zod@^6.0.0`
  to `gateway/package.json`.
- **New**: `gateway/src/schema/api.ts` (shared zod components),
  `docs/exec-plans/completed/0002-openapi-spec.md` (this file).
- **Migrated** (19 routes across 9 files): all of
  `gateway/src/routes/{public,portal,admin}/**/*.ts`. Each route
  registration now uses `.withTypeProvider<ZodTypeProvider>()` and
  declares `schema: { tags, summary, description, params,
  querystring, body, response, security }`. Inline `safeParse`
  blocks removed — Fastify validates from the schema field
  automatically; bad requests get OpenAPI-shape 400s from
  fastify-type-provider-zod's error formatter.
- **`server.ts`**: registers swagger + swagger-ui + the zod
  validator/serializer compilers, adds `GET /openapi.json` route.
- **Docs**: README + AGENTS + DEPLOYMENT cross-link the new
  `/openapi.json` + `/docs` endpoints and document the production
  posture (gate behind reverse-proxy auth).

Follow-ups still on the tech-debt tracker:

- Generate `web/{portal,admin}/lib/api.gen.ts` from the spec and
  replace hand-rolled `api.js` calls.
- CI job to fail when a committed `openapi.snapshot.json` diverges
  from the freshly-generated one.
- Per-route response runtime validation (flip
  `responseValidation: true` on the high-traffic admin routes
  first; observe; expand).
