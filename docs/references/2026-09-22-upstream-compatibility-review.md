# Upstream compatibility review — 2026-09-22

This gateway is not compatible with the current upstream checkouts. Updating
images or configuration alone will not restore inference. This is a source
review, not a live deployment certification or an implementation plan.

## Scope

Compared this repository at `bc231d2` with Modules at `08f5985` and LOC at
`6a6392a`, including changes since the August 24 integration baseline.
Both upstream worktrees have an unrelated modified `.beads/interactions.jsonl`;
those files were not used as contract evidence or modified.

The major changes are authorization-only wholesale accounts (Modules
`c453d14`, LOC `f66cff0` / `b3fe6af`), settlement domains (Modules `80800f8`,
LOC `f7d9fe0`), signed published discovery (`a542fe9` / `4d26d1b`), independent
regional pools (`1dcf739`), and refusal recovery (Modules `08f5985`, LOC
`d8724d8`). Network protocol major 4 still uses the interaction identifier
`paid-job/v1`; checking that string alone does not establish compatibility.

## Findings

### P1 — Job creation fails before any broker dispatch

`gateway/src/loc/client.ts:197` sends neither `workload_request_digest` nor
`caller_public_key`. Both are required by LOC's
`src/livepeer_open_clearinghouse/domains/jobs/types.py:16`, so current job
requests fail request validation with HTTP 422. The same client requires
`payment_envelope` at line 227, but LOC now returns `spend_authorization`,
`accounting_mode`, and `route_snapshot` instead.

Update the request and response contracts together. Hash the exact final
broker body after model rewriting. Preserve that byte sequence across LOC
open retries and broker dispatch; serialize multipart once, including its
boundary, rather than hashing one serialization and sending another.

### P1 — Every broker transport uses obsolete admission credentials

The unary, stream, and multipart adapters in `gateway/src/proxy/livepeer/`
send `Livepeer-Payment` and have no authorization or caller-proof fields.
Modules' `capability-broker/internal/server/middleware/payment.go:160`
requires `Livepeer-Authorization` and returns 401 when it is absent.
Payment tickets now fund wholesale accounts; they do not authorize work.

LOC requires a compressed secp256k1 caller public key. Its authorization
therefore also requires `Livepeer-Caller-Proof`: a base64 recoverable EIP-191
signature over the domain-separated authorization digest. Use the current
LOC TypeScript one-shot example and Modules `ValidateCallerProof` as the
contract references. A caller proof key is not a chain payment key; LOC must
continue owning chain access and wholesale funding. Clarify that distinction
in the gateway's key-custody documentation.

### P1 — Definitive admission refusals permanently stop local recovery

Modules `exchange_lookup.go` now returns HTTP 200 with
`outcome: ADMISSION_REJECTED` for a persisted payment admission refusal,
before fenced non-admission evidence is issued. The gateway's
`gateway/src/loc/brokerSettlement.ts:94` instead requires `settlement`, throws
`BrokerSettlementContractError`, and `settlementLookup.ts:75` permanently
marks the lookup failed. It will miss subsequent signed non-admission evidence.

Treat that response as a recoverable state. LOC already reconciles jobs and
requests `POST /v1/non-admission/{request_id}` when appropriate. Decide how
the gateway observes LOC's authoritative terminal state through
`GET /v1/jobs/{id}`; the current client has no status method. Preserve the
distinction between signed settlement, non-admission audit, and LOC accounting
outcome. A refusal, missing record, or expired authorization alone must never
be converted into a synthetic zero-unit settlement or assumed refund.

### P2 — Catalog price denominators are discarded

LOC `domains/discovery/types.py` now exposes `units_per_price`. The gateway
ignores it and `gateway/src/registry/catalog.ts:100` hardcodes 1. Any offering
quoted per multiple units is consequently misrepresented in the model cache
and admin price diagnostics. Carry the denominator using an exact integer
representation or explicit safe-range validation. LOC still calculates the
charge, so this finding concerns gateway diagnostics, not proven misbilling.

## Other migration requirements

- Retain the returned route snapshot, including settlement domain, quote,
  fingerprints, and delegated settlement keys, for durable audit/recovery.
  Current `OpenJobResponse` discards it and `candidateFromJob` supplies blank
  route metadata. LOC verifies these bindings already; this is not evidence
  that the gateway currently bypasses LOC signature verification.
- Keep exact signed payloads intact. Authorization-only `work_id` identifies
  the authorization, not a shared funding session. Wholesale account identity
  includes `(chain, payer, payee, settlement_domain_id, denomination)`; a broker
  URL or payee address alone does not identify a ledger.
- LOC `d8724d8` distinguishes terminal `422 AUTHORIZATION_REFUSED` from
  retryable `503 WHOLESALE_FUNDING_UNVERIFIED`. The gateway already retries
  503 opens using the same idempotency key and does not retry 422; preserve
  this behavior and add fixtures for the named errors and closed engagements.
- Signed discovery, regional pools, receiver initialization, and aggregate
  float remain upstream responsibilities. Do not add registry discovery,
  pool management, chain keys, or account-funding policy to this gateway.
  Session and WebSocket improvements do not require expanding the OpenAI
  product surface; shared catalog session offerings are already filtered out.
- Supersede the August v2 deployment evidence and payment-envelope runbook.
  Drain old authorizations/accounting before a coordinated upgrade; follow
  Modules' settlement-domain migration instructions for upstream ledgers.
  Update the existing smoke/conformance tools and certify immutable images
  from the same compatible release set.

## Verification

- `pnpm --dir gateway lint`: passed.
- `pnpm --dir gateway test`: 128 passed, zero failed.
- In-memory HTTP probes against the current gateway client confirmed both
  commitment fields are missing and a new-style LOC response fails with
  `missing payment_envelope`.
- A probe using the current broker's `ADMISSION_REJECTED` response shape
  fails with `BrokerSettlementContractError: missing settlement`.

The passing suite reflects the old fixtures, not current upstream compatibility.
No live paid requests, deployments, or upstream modifications were performed.

Before implementation, create an exec plan covering exact request bytes and
caller proof, LOC contracts and persistence, refusal/status reconciliation,
catalog denominators, then updated real-process unary/SSE/multipart and
restart/recovery conformance. No runtime code was changed by this review.
