# SECURITY

Threat model + auth surface for the gateway. Updated as the surface
evolves.

## Auth surfaces

| Surface | Auth | Notes |
|---|---|---|
| `/v1/*` | `Authorization: Bearer sk-…` | API key only. No cookie session accepted. |
| `/portal/*` | Cookie session | Issued via `/portal/login` (trades an API key for a session). HttpOnly, SameSite=Lax, Secure when `BASE_URL` starts with `https://`. |
| `/admin/*` | `X-Admin-Token` header | Env-var token. **No admin user table** — see ["What `ADMIN_TOKEN` is and is not"](#what-admin_token-is-and-is-not). |
| `/api/waitlist` | None (public) | Validated, rate-limited per IP-hash (5 signups / hour). |
| `/api/verify` | None (public) | Single-use, expiring token in the URL. |
| `/openapi.json`, `/docs` | None (app-layer) | Gate behind reverse-proxy auth in production — the spec maps admin paths. See [`DEPLOYMENT.md`](./DEPLOYMENT.md). |
| `/metrics` | Bearer token (optional) | If `METRICS_TOKEN` env is set, requires `Authorization: Bearer <token>`. Unset → open. Typical production posture: front-edge basic auth via Traefik + optional `METRICS_TOKEN` as defense in depth. |

## API key lifecycle

1. Public signup via `POST /api/waitlist` → row in `waitlist` table,
   `status='pending'`, verification token stored *hashed*.
2. User clicks the verification link → `email_verified_at` set.
3. Admin (with `X-Admin-Token`) approves the waitlist row via
   `POST /admin/waitlist/:id/approve`. The handler **refuses** if
   `email_verified_at IS NULL` (HTTP 409).
4. Approval transactionally inserts the `api_keys` row and sets
   `status='approved'`. Plaintext key sent to the user *once* by
   email (or logged to stdout if Resend is disabled).
5. User uses the key on `/v1/*`. Server-side lookup is by SHA-256
   hash of `key + API_KEY_HASH_PEPPER`.
6. User can list / mint / revoke keys from the portal. Revoking a
   key cascade-revokes every session that uses it.

## Hashing

- **API keys**: SHA-256 with a server-side pepper
  (`API_KEY_HASH_PEPPER`). Rotating the pepper invalidates every
  existing key (no dual-lookup in v1; planned for a future plan).
- **Verification tokens**: hashed before storage with
  `IP_HASH_PEPPER`. A DB leak alone cannot confirm guessed tokens.
  Tokens expire 24h after issue.
- **Session tokens**: opaque 32 random bytes (base64url), hashed at
  rest with `IP_HASH_PEPPER`. The plaintext lives only in the
  client's cookie.
- **Client IPs** (used for waitlist rate-limiting): SHA-256 with
  `IP_HASH_PEPPER`. Without the pepper, IPs are confirmable against
  the full IPv4 space via rainbow table — the gateway logs a warning
  at startup if the pepper is unset.

## What `ADMIN_TOKEN` is and is not

- It **is** the canonical admin credential. Every `/admin/*` request
  carries it as `X-Admin-Token`. The token comparison is
  constant-time (`crypto.timingSafeEqual`).
- It **is not** a "bootstrap" mechanism — there is no separate
  "real admin user" to promote to. v1 has no admin user table by
  design. If/when multi-operator role separation lands, that's a
  schema change documented in a future plan.
- If `ADMIN_TOKEN` is unset on the server, every `/admin/*` request
  returns `503 admin disabled (no ADMIN_TOKEN)`.
- Leaks of `ADMIN_TOKEN` are full admin takeover. Store it like a
  database password. Rotation = update env, restart, sign back in.

## Per-API-key rate limit

`/v1/*` is rate-limited per `api_key_id` via an in-memory token
bucket. Defaults: **60 req/min, burst 30**. Configurable via
`V1_RATE_LIMIT_PER_MINUTE` + `V1_RATE_LIMIT_BURST`. Exhaustion
returns `429 rate_limit_exceeded` with a `Retry-After: <seconds>`
header and OpenAI-shape body. The reservation is NOT opened — 429s
don't pollute `usage_reservations`.

Single-process shape: a multi-replica deploy needs distributed
rate-limiting; that's a separate plan.

## Threats

| Threat | Mitigation |
|---|---|
| API key brute-force | 288 bits of entropy, peppered SHA-256 hash, per-key 429 rate limit on `/v1/*`, constant-time hash compare in DB index lookup. |
| Waitlist email enumeration | `POST /api/waitlist` returns identical `{ok: true}` on conflict vs new. No timing channel intentionally introduced. |
| Verification-token replay | Tokens are hashed at rest and expire (24h). Once consumed (`email_verified_at` set), the hash is cleared from the row. |
| Session fixation | Session cookie issued *only* after successful API-key validation. No anonymous session upgrade. |
| Session theft via XSS | Cookie is `HttpOnly`, `SameSite=Lax`, `Secure` when `BASE_URL` is HTTPS. SPAs have no JS read access. |
| Open redirect on email links | Verify and key-delivery URLs constructed server-side from `PUBLIC_SITE_URL` / `PUBLIC_PORTAL_URL`. Never from request input. |
| CORS abuse | `ALLOWED_ORIGINS` env var; default `*` (dev). Production sets the explicit allowlist. Cookie-bearing requests require explicit origin. |
| Admin-token brute-force | Constant-time compare; rate-limit at the reverse proxy if a public admin endpoint is exposed. |
| Stripe webhook forgery | Not applicable in v1 (no Stripe). |
| Prompt injection via uploaded content | Out of scope at the gateway — upstream capability providers handle their own input validation. |
| OpenAPI spec disclosure mapping the admin surface | Gate `/openapi.json` + `/docs` behind reverse-proxy auth in prod. |

## Secrets and configuration

**Required for production**:

- `DATABASE_URL`
- `BASE_URL`, `PUBLIC_SITE_URL`, `PUBLIC_PORTAL_URL`
- `ADMIN_TOKEN`
- `API_KEY_HASH_PEPPER`
- `IP_HASH_PEPPER`

**Optional but strongly recommended**:

- `METRICS_TOKEN` — Bearer-token gate on `/metrics`
- `RESEND_API_KEY` — email delivery (unset → log instead of send)
- `LIVEPEER_RESOLVER_SOCKET` — registry-driven routing
- `LIVEPEER_PAYER_DAEMON_SOCKET` — required for `/v1/*` to function
  (unset → /v1/* returns 500)
- `ALLOWED_ORIGINS` — comma-separated origin allowlist (default `*`)

All secrets injected via env. No secrets in code, no secrets in
migrations, no secrets in docs.

## Out of scope (v1)

- OAuth, SSO, social login.
- Per-API-key scoping (read-only keys, model-restricted keys).
- Self-service API-key recovery / magic-link login.
- Multi-operator role separation on the admin surface.
- Audit-log retention policy (logs go to stdout; retention is the
  deployer's problem).
- Pepper rotation without invalidating existing keys (dual-lookup).
- Penetration testing. This is beta; security is best-effort.
