# Waitlist signup

## Who

A developer who wants to use the OpenAI Service. Not yet an
authenticated user; might be evaluating; might be the operator's
friend they invited.

## What

Land on the marketing site, submit name + email, click the verify
link emailed to them, wait, receive an API key by email once an
admin has approved them.

## Where

- Landing form: `web/site/` (default port 3000)
- Verify result page: `web/site/verify.html`
- Admin's approval surface: `web/admin/` (default port 3002)
- Gateway endpoints: `POST /api/waitlist`, `GET /api/verify`,
  `POST /admin/waitlist/:id/approve`

## Why

Free during beta means we need a gate other than money. The waitlist
+ verify + manual-approve flow gives the operator a chance to keep
abuse out and to throttle growth to the rate at which the
infrastructure can serve it. See
[`../../PRODUCT_SENSE.md`](../../PRODUCT_SENSE.md) §"Free during beta
means truly free."

## User flow

```
1. Visitor lands on the site, fills `name` + `email`, submits.
2. Server creates a waitlist row (status=pending,
   verification_token_hash, email_verified_at=NULL) and sends an
   email with a verify link of the shape
     ${PUBLIC_SITE_URL}/verify.html?token=…
3. Visitor clicks the link; the site's verify page calls the API,
   shows the result, instructs them to wait for admin review.
4. Admin reviews pending rows in /admin/waitlist?status=pending.
   Cannot approve a row whose email_verified_at is null.
5. Admin clicks Approve → server generates an API key, stores the
   hash, emails the plaintext key to the user.
6. User receives the key, copies it into their OpenAI SDK call.
```

## Acceptance criteria

- A new visitor with a fresh email can complete the flow without
  contacting the operator out-of-band.
- The verification link expires after 24 hours; expired links return
  `400 verification link is invalid or expired` from the verify
  page.
- Re-submitting the signup form with an email that's already on the
  list returns `{ok: true}` (no enumeration via response code or
  body shape).
- An admin trying to approve an unverified row gets a `409` with
  `email not verified — cannot approve unverified users` and the
  row stays `pending`.
- The plaintext API key appears exactly once — in the delivery email
  (or, if Resend is disabled, in the gateway log). It is never
  recoverable from the database.
- Re-issuing verification (admin "Resend") rotates the token hash,
  invalidating any prior link.
- The marketing site copy is generic ("OpenAI Service") and can be
  rebranded by editing `web/site/index.html` and `web/site/index.css`
  without touching gateway code.

## Edge cases

| Case | Behavior |
|---|---|
| Email field passes `email` validation but the recipient never gets it (spam folder, bad MX) | Admin can re-send via `POST /admin/waitlist/:id/resend-verification`. |
| User submits with the same email + IP many times | IP-hash rate limit: 5 signups per IP per hour. 6th returns `429 too many signups from this IP recently`. |
| Resend API fails or is unconfigured | Signup still succeeds (the row is created); the verify link is logged to stdout. Operator can dig it out and hand-deliver. |
| User clicks an old link after re-verify | Old token hash is no longer in the DB; `400 invalid or expired`. |
| User clicks the link twice quickly | Second click hits `findVerifiableByToken` after the first set `email_verified_at` — finds no row, returns `400`. The user already saw success once. |

## What this spec does NOT promise (v1)

- **Self-service password / magic-link login.** Lost key → email
  admin. v2.
- **Per-user multi-stage onboarding.** No "your trial expires in X"
  emails. The only emails are: verify, key delivery, re-verify.
- **Spam-protection beyond IP-hash rate limiting.** No CAPTCHA, no
  email-domain blocklist.
- **Internationalization.** Email content is English-only.

## Implementation reference

| Layer | Path |
|---|---|
| Site form component | `web/site/components/cc-signup-form.js` |
| Site verify page | `web/site/verify.html` + `cc-verify-card.js` |
| Public API | `gateway/src/routes/public/{waitlist,verify}.ts` |
| Admin API | `gateway/src/routes/admin/waitlist.ts` |
| Admin UI | `web/admin/components/cc-waitlist-queue.js` |
| Email templates | `gateway/src/email/index.ts` |
| Schema | `gateway/src/schema/waitlist.ts` |
| Crypto | `gateway/src/crypto.ts` |
