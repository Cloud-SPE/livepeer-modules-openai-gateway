# Admin — waitlist + users + registry debug

## Who

The operator. Has the `ADMIN_TOKEN` from the gateway's environment.
Reviews pending signups, approves or rejects, watches usage, debugs
routing.

## What

- See pending waitlist rows (and verified-vs-unverified status)
- Approve any pending row (mints + emails an API key)
- Reject rows
- Resend a verification email
- See approved users, their keys, their usage summary
- See aggregate usage across all keys
- See the live registry snapshot + route health for debugging

## Where

- SPA: `web/admin/` (default port 3002)
- Hash routes: `#/waitlist`, `#/users`, `#/usage`, `#/health`,
  `#/registry`
- Gateway endpoints (all gated by `X-Admin-Token`):
  - `GET /admin/waitlist?status=…`
  - `POST /admin/waitlist/:id/approve`
  - `POST /admin/waitlist/:id/reject`
  - `POST /admin/waitlist/:id/resend-verification`
  - `GET /admin/users`, `GET /admin/users/:id`
  - `GET /admin/usage`
  - `GET /admin/registry/{model-health,summary,candidates,health,models}`

## Why

The admin is a tool, not a product (see
[`../../PRODUCT_SENSE.md`](../../PRODUCT_SENSE.md) §"Admin is a tool,
not a product"). It exists so the operator can keep the beta
running. Polish optional; correctness mandatory.

## User flow — approval

```
1. Operator signs in: paste ADMIN_TOKEN, stored in localStorage.
2. Land on #/waitlist with the pending filter active.
3. Review the row: name, email, verified pill.
4. If unverified, the operator may resend verification or approve
   directly.
5. Click "Approve" → server mints an API key in a transaction with
   the status change, then emails the plaintext key to the user.
6. The admin UI also shows the one-time plaintext key immediately so
   the operator can hand-deliver it if email is disabled or fails.
7. Row moves to status=approved; appears in #/users.
```

## User flow — debugging routing

```
1. Operator navigates to `#/health` or `#/registry`.
2. `#/health` shows the concise operator-facing view:
   capability availability, selectable-vs-unavailable model counts,
   plus per-model interaction modes and offerings.
3. `#/registry` is the deeper diagnostic view.
4. Live candidate table shows what `registryCatalog.inspect()` sees
   right now from the resolver.
   Each row includes quote-aware route identity:
   `units_per_price`, `quote_id`, `quote_version`,
   `constraint_fingerprint`, `route_fingerprint`.
5. Route health panel shows attempts / successes / failures /
   cooldowns plus per-route snapshots.
6. Cached models table shows what `/v1/models` will return next, plus
   the stored quote-aware metadata carried over from the inspection
   snapshot.
7. Registry summary shows live-vs-cache model drift and whether the
   `/v1/models` cache is fresh or stale.
```

## Acceptance criteria

- Without `X-Admin-Token` header, every `/admin/*` returns `401`.
- With the wrong token, every `/admin/*` returns `401` via
  constant-time comparison.
- With `ADMIN_TOKEN` unset on the server, every `/admin/*` returns
  `503 admin disabled (no ADMIN_TOKEN)`.
- Approve stays clickable for unverified rows and succeeds
  server-side.
- Approve is atomic: api_keys row + waitlist status change happen in
  one transaction.
- Approve returns the plaintext key exactly once in the immediate
  response; later admin surfaces show only the safe prefix.
- Reject is reversible by editing the row in the DB; v1 doesn't ship
  an unreject button.
- Registry candidate endpoint reflects the resolver's current live
  snapshot at request time.
- Registry summary reports whether the cached `/v1/models` table is
  fresh enough to serve publicly, using the same snapshot-age rule as
  the public catalog endpoint.
- Admin health and registry screens include inline help affordances for
  ambiguous terms such as `live only`, `cached only`, `offerings`,
  interaction modes, and route-health state.

## Edge cases

| Case | Behavior |
|---|---|
| Approve fails because email send fails | API-key row + status change are NOT rolled back. Admin must hand-deliver the key from the approval response. We log loudly. |
| Operator rejects a row that's already approved | `409 already approved`. (Currently we don't have this check on reject — TODO for the approve path; reject simply runs the UPDATE.) |
| Operator resends to an already-verified user | `409 already verified`. |
| Two operators approve the same row concurrently | Second loses with `409 already approved`. |
| Token leaks | Operator rotates `ADMIN_TOKEN` env var, restarts the gateway, signs back in. v1 has no token revocation list. |

## What this spec does NOT promise (v1)

- **Audit log.** `usage_reservations` is the request log; there's no
  separate admin-action log. Approvals are visible via
  `approved_at` + `approved_by` columns; rejections too. Resends are
  not durably logged.
- **Multi-operator role separation.** Anyone with the token is
  fully privileged.
- **Soft-delete / undo for rejections.** Edit the DB row.
- **Bulk operations.** No bulk approve / bulk export.
- **CSV / JSON export of users.** Use psql.

## Implementation reference

| Layer | Path |
|---|---|
| SPA shell + routing | `web/admin/components/cc-app.js` |
| Token prompt | `web/admin/components/cc-token-prompt.js` |
| Waitlist queue UI | `web/admin/components/cc-waitlist-queue.js` |
| Users UI | `web/admin/components/cc-users.js` |
| Usage UI | `web/admin/components/cc-usage.js` |
| Health UI | `web/admin/components/cc-network-health.js` |
| Registry debug UI | `web/admin/components/cc-registry.js` |
| Token middleware | `gateway/src/routes/admin/auth.ts` |
| Routes | `gateway/src/routes/admin/{waitlist,users,usage,registry}.ts` |
| Bootstrap rationale | [`../../SECURITY.md`](../../SECURITY.md) §"What `ADMIN_TOKEN` is and is not" |
