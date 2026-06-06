# Portal — account, API keys, health, playground, usage

## Who

An approved user with at least one active API key. Wants to manage
their keys, see what they've used, and test what the current network
can actually serve.

## What

Sign in with an API key, see account info, list / create / revoke API
keys, inspect user-facing network health, test live `/v1/*` routes,
and see recent request history.

## Where

- SPA: `web/portal/` (default port 3001)
- Hash routes inside the SPA: `#/account`, `#/api-keys`, `#/health`,
  `#/playground`, `#/usage`
- Gateway endpoints:
  - `POST /portal/login`, `POST /portal/logout`
  - `GET /portal/account`
  - `GET /portal/api-keys`, `POST /portal/api-keys`,
    `DELETE /portal/api-keys/:id`
  - `GET /portal/playground/catalog`
  - `GET /portal/usage`

## Why

A user with a key needs to (a) know who they are in the system,
(b) rotate the key if they leak it, (c) see whether their requests
are actually working. The portal is a courtesy, not a product — see
[`../../PRODUCT_SENSE.md`](../../PRODUCT_SENSE.md) §"The portal is a
courtesy, not a product."

## User flow

```
1. User visits the portal. They are not signed in → <cc-login>
   renders with a single password-typed input for the API key.

2. User pastes the key, submits. Server validates the key, mints a
   session token, sets a cookie. <cc-app> re-checks the session and
   renders the shell.

3. User navigates:
   - #/account     → email + name + waitlist id
   - #/api-keys    → list, create, revoke
   - #/health      → user-facing capability + model availability
   - #/playground  → live chat / embeddings / rerank / images /
                     speech / transcription testing
   - #/usage       → recent usage_reservations rows

4. User signs out → cookie cleared, session revoked.
```

## Acceptance criteria

- A user with an `active` API key whose `waitlist.status='approved'`
  can sign in.
- A user with a revoked key, or whose waitlist row is not approved,
  gets `401` from `/portal/login` ("invalid API key" or "account not
  approved").
- Sessions live for `SESSION_TTL_HOURS` (default 24). After expiry,
  `/portal/account` returns 401, `<cc-app>` shows `<cc-login>` again.
- Revoking a key in `#/api-keys` cascade-revokes every session tied
  to that key — including the calling user's own session if they
  revoked the key they signed in with.
- Creating a key shows the plaintext exactly once, in a
  `user-select: all` block; refreshing the page hides it forever.
- The health view stays user-friendly: it shows capability/model
  availability, route counts, and interaction modes without exposing
  full admin debug detail.
- Ambiguous portal diagnostics include inline help affordances so a
  user can understand terms like `selectable`, `cached`, interaction
  modes, and route details without leaving the page.
- The playground only enables tabs when there is at least one live
  selectable model for that capability in the current LOC-backed
  catalog.
- The speech playground uses the selected model's published `voices`
  metadata when available and falls back to free-text input when a
  model does not advertise a voice list.
- The usage view shows at least: timestamp, capability, model,
  state pill (committed/refunded/open), work units, status, latency.
- Route/quote details in usage are readable without distorting the
  table layout: they open in a dismissible modal rather than inline.
- The usage API also carries the selected route/quote metadata for each
  request (`brokerUrl`, `ethAddress`, selected capability/offering/work
  unit, `unitsPerPrice`, `quoteId`, `quoteVersion`, route/constraint
  fingerprint hex, estimated units). The current UI may choose not to
  render every field, but the portal contract exposes them.
- `/v1/*` API keys do NOT accept the session cookie, and `/portal/*`
  does NOT accept Bearer auth. The two surfaces never cross.

## Edge cases

| Case | Behavior |
|---|---|
| User pastes their key with surrounding whitespace | Server's hashApiKey hashes the trimmed value? Actually no — current behavior hashes verbatim. (Tracked as polish: hashApiKey should trim.) |
| User has multiple browser tabs open | All tabs share the cookie. Sign-out in one ends sessions in all. |
| User revokes their last key | They're locked out. They have to email the admin to issue a new one. v1 has no self-serve recovery. |
| Network drops during key creation | Server transaction is atomic; either the row + email succeeded or neither did. UI shows the error from `api()`. |

## What this spec does NOT promise (v1)

- **Profile editing.** Email and name are immutable in v1; admin
  changes only.
- **Email change with re-verification.** v2.
- **2FA / per-session device fingerprinting.** v2.
- **Per-key scoping or model restrictions.** v2.
- **Per-tab notification of session expiry.** Tab refresh shows
  login, that's the recovery.

## Implementation reference

| Layer | Path |
|---|---|
| SPA shell + routing | `web/portal/components/cc-app.js` |
| Login | `web/portal/components/cc-login.js` |
| Account view | `web/portal/components/cc-account.js` |
| API-key management | `web/portal/components/cc-api-keys.js` |
| Health view | `web/portal/components/cc-network-health.js` |
| Playground | `web/portal/components/cc-playground.js` |
| Usage view | `web/portal/components/cc-usage.js` |
| Session auth middleware | `gateway/src/routes/portal/auth.ts` |
| Routes | `gateway/src/routes/portal/{auth,account,apiKeys,playground,usage}.ts` |
| Schema | `gateway/src/schema/{apiKeys,sessions,usageReservations}.ts` |
