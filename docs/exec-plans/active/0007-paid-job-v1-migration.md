# Plan 0007 — paid-job/v1 migration

Migrate the OpenAI gateway from the v0 interaction modes to the breaking
Livepeer Modules 2.0 `paid-job/v1` and matching LOC contracts.

**Beads epic:** `lmoa-3bv`

## Context

Livepeer Modules 2.0 replaces `http-reqresp@v0`, `http-stream@v0`, and
`http-multipart@v0` with one paid-job protocol and a per-request transport.
It makes broker open idempotency and signed usage settlement normative. The
LOC team is simultaneously replacing its handoff and settlement shapes.

The gateway currently contains workarounds for the missing v0 guarantees:
mode inference and mismatch retries, fresh paid jobs after ambiguous opens,
zero-unit compensating settles, stream request mutation, response-body usage
scraping, and a settlement queue that lacks signed evidence. Retrofitting the
broker seam crosses catalog, LOC, proxy, persistence, operations, and UI, so
the work requires an execution plan.

The binding gateway interpretation is
[paid-job-v1.md](../../design-docs/paid-job-v1.md).

## Scope

In scope:

- paid-job protocol and transport catalog metadata;
- v2 LOC reservation and broker clients;
- stable idempotency identities and accounting-only replay;
- durable signed settlement retrieval and LOC settlement;
- non-buffering stream accounting;
- endpoint work units, estimates, and funded ceilings;
- schema, diagnostics, tests, conformance, docs, and breaking cutover;
- deletion of every v0 path and workaround.

Out of scope:

- backward compatibility, dual-stack flags, or fallback to v0;
- capability runner implementations;
- importing or vendoring Modules or LOC source;
- customer billing or price/rate-card behavior;
- paid-session live-media work;
- fixing payer-side `INVALID_RECIPIENT_RAND` rotation.

## Approach

### Phase 1 — lock decisions and external contracts

- [x] Create the migration Beads graph (`lmoa-3bv`).
- [x] Codify the accepted paid-job gateway contract (`lmoa-3bv.1`).
- [x] Define claimed, debited, LOC-settled, and observed usage
  (`lmoa-3bv.5`).
- [x] Resolve durable debit retry and `DEBIT_FAILED` with Modules and LOC
  (`lmoa-3bv.2`).
- [ ] Resolve LOC reservations that never reach broker admission
  (`lmoa-3bv.3`).
- [x] Land transcription duration metering (`lmoa-3bv.4`).
- [ ] Align the effective debit retry schedule with its advertised recovery
  window (`lmoa-3bv.22`).
- [ ] Pin release-ready upstream revisions (`lmoa-3bv.6`).

### Phase 2 — build the independent seam

- [x] Replace catalog interaction modes with protocol and transports
  (`lmoa-3bv.7`).
- [ ] Implement the v2 LOC reservation client (`lmoa-3bv.8`).
- [x] Implement the broker `POST /v1/job` transport client
  (`lmoa-3bv.9`).
- [ ] Migrate durable reservation and settlement evidence storage
  (`lmoa-3bv.10`).

These changes can proceed while the external teams close Phase 1 blockers.
They parse and persist the agreed stable surface without inventing behavior
for the unresolved financial terminal states.

### Phase 3 — accounting and OpenAI endpoints

- [ ] Implement authoritative settlement lookup and durable LOC settlement
  (`lmoa-3bv.11`).
- [ ] Implement accounting-only replay and `upstream_response_lost`
  (`lmoa-3bv.12`).
- [ ] Migrate unary/multipart endpoints (`lmoa-3bv.13`).
- [ ] Migrate streaming chat without buffering (`lmoa-3bv.14`).
- [ ] Configure endpoint units, estimates, and ceilings (`lmoa-3bv.15`).

### Phase 4 — prove and cut over

- [ ] Replace mode-based diagnostics (`lmoa-3bv.16`).
- [ ] Build v2 mock contract regressions (`lmoa-3bv.17`).
- [ ] Run signed registry → broker → gateway → LOC conformance
  (`lmoa-3bv.18`).
- [ ] Delete v0 modes and workarounds (`lmoa-3bv.19`).
- [ ] Update final architecture and operator documentation
  (`lmoa-3bv.20`).
- [ ] Execute the breaking cutover (`lmoa-3bv.21`).

## Expected code surfaces

| Concern | Primary surfaces |
|---|---|
| Catalog | `gateway/src/registry/`, `gateway/src/schema/models.ts` |
| LOC open/settle | `gateway/src/loc/client.ts`, `gateway/src/loc/dispatch.ts` |
| Broker wire | `gateway/src/proxy/livepeer/`, endpoint proxies |
| Durable evidence | `gateway/src/schema/usageReservations.ts`, `gateway/src/repo/usageReservations.ts`, `gateway/migrations/` |
| Settlement recovery | `gateway/src/loc/settler.ts`, boot and health wiring |
| Diagnostics | `gateway/src/routes/{admin,portal}/`, `web/{admin,portal}/` |
| Contract tests | gateway unit/integration tests plus pinned external conformance |

## Acceptance

- Every supported OpenAI endpoint uses `paid-job/v1` and a declared
  `unary`, `stream`, or `multipart` transport.
- Identical retries converge on one LOC reservation, broker execution, debit,
  signed settlement, and LOC settlement.
- Accounting-only replay settles the original job and returns
  `upstream_response_lost` without resubmission.
- All transports retrieve and persist authoritative signed settlement;
  streaming remains non-buffering and accounting survives disconnects.
- Non-streaming non-2xx claims zero, work-unit drift fails locally, and every
  endpoint has a funded ceiling.
- Signed end-to-end conformance covers valid delegation and tampered,
  cross-job, and identity-drift failures.
- Repository search finds no active v0 broker path, mode header/inference,
  fresh-job mismatch retry, compensating settle, or forced usage mutation.
- TypeScript, unit, integration, migration, and smoke checks pass against the
  pinned Modules and LOC revisions.

## Decision log

- **2026-08-21 — breaking cutover.** Carrying v0 would preserve exactly the
  ambiguous-open and usage workarounds the new contract removes.
- **2026-08-21 — no external source dependency.** The gateway consumes HTTP
  contracts and exported conformance behavior. Upstream revisions are release
  gates, not libraries linked into this repository.
- **2026-08-21 — accounting-only replay.** Finish accounting for the original
  job and return `upstream_response_lost`; never auto-resubmit paid work.
- **2026-08-21 — settlement query on all transports.** Signed lookup is the
  portable authority; response headers/trailers remain observations.
- **2026-08-21 — separate usage signals.** Seller claim, actual debit, LOC
  settlement, and buyer observation remain separately named and stored.
- **2026-08-21 — prefer broker-side transcription parsing.** This gateway owns
  no runners, so a runner header is safe only if it is a universal capability
  contract.
- **2026-08-21 — 24-hour broker retention is the minimum retrieval SLA.** The
  gateway uses an independent durable lookup loop and deadline-aware alerts;
  the bounded LOC-settlement retry count does not apply before claim capture.
- **2026-08-21 — no assertion-only abandon.** A never-admitted LOC reservation
  can be released only after joint payer/payee evidence proves the issued
  envelope is no longer spendable.
- **2026-08-21 — settlement 409 preserves evidence.**
  `job_already_settled` is terminal financial success after a lost LOC
  response, but the original signed claim remains stored as the audit record.
- **2026-08-21 — bounded debit retry lifecycle accepted; timing remains open.**
  Modules retains the payee session and retries the original debit sequence
  while lookup returns `accounting_pending`. Signed `DEBIT_FAILED` remains a
  fault, and LOC keeps the reservation encumbered. The current 30-second sweep
  reaches its 10-attempt cap in roughly five minutes, not 30; resolve under
  `lmoa-3bv.22` before pinning.
- **2026-08-21 — chain expiry proves no future spend, not necessarily no prior
  work.** The payment daemon returns `creation_round` and
  `expires_after_round`, and its current working tree exposes
  `current_round`. LOC persists the deadline. Automatic refund remains open
  because an admitted customer could withhold settlement until expiry; the
  teams must choose independently retrievable evidence or a fail-closed
  terminal accounting policy.
- **2026-08-21 — transcription duration extractor accepted.** Use Modules'
  `multipart-audio-duration`; keep inexact headerless MP3 estimation disabled
  unless the product deliberately opts into estimated billing.
