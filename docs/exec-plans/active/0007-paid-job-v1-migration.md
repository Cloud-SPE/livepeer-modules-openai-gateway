# Plan 0007 — paid-job/v1 migration

Complete the breaking Livepeer Modules 2.0 `paid-job/v1` and matching LOC
contracts with no compatibility path.

**Beads epic:** `lmoa-3bv`

## Context

Livepeer Modules 2.0 defines one paid-job protocol with a per-request transport.
It makes broker open idempotency and signed usage settlement normative. The
LOC team is simultaneously replacing its handoff and settlement shapes.

The retrofit crosses catalog, LOC, proxy, persistence, operations, and UI, so
the work is tracked as one execution plan and Beads epic.

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
- importing or vendoring broker, daemon, worker, or LOC implementations (the
  public client-side audio estimator package is the narrow exception);
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
- [ ] Add independent broker settlement recovery by LOC request id
  (`lmoa-3bv.23`).
- [ ] Resolve broker settlement retention under governance-revivable envelopes
  (`lmoa-3bv.24`).
- [x] Land transcription duration metering (`lmoa-3bv.4`).
- [ ] Align the effective debit retry schedule with its advertised recovery
  window (`lmoa-3bv.22`).
- [ ] Pin release-ready upstream revisions (`lmoa-3bv.6`).

### Phase 2 — build the independent seam

- [x] Consume the catalog's required protocol and transport fields
  (`lmoa-3bv.7`).
- [x] Implement the v2 LOC reservation client (`lmoa-3bv.8`).
- [x] Implement the broker `POST /v1/job` transport client
  (`lmoa-3bv.9`).
- [x] Migrate durable reservation and settlement evidence storage
  (`lmoa-3bv.10`).

These changes can proceed while the external teams close Phase 1 blockers.
They parse and persist the agreed stable surface without inventing behavior
for the unresolved financial terminal states.

### Phase 3 — accounting and OpenAI endpoints

- [x] Implement authoritative settlement lookup and durable LOC settlement
  (`lmoa-3bv.11`).
- [x] Implement accounting-only replay and `upstream_response_lost`
  (`lmoa-3bv.12`).
- [x] Migrate unary/multipart endpoints (`lmoa-3bv.13`).
- [x] Migrate streaming chat without buffering (`lmoa-3bv.14`).
- [ ] Configure endpoint units, estimates, and ceilings (`lmoa-3bv.15`).

### Phase 4 — prove and cut over

- [x] Replace mode-based diagnostics (`lmoa-3bv.16`).
- [ ] Build v2 mock contract regressions (`lmoa-3bv.17`).
- [ ] Run signed registry → broker → gateway → LOC conformance
  (`lmoa-3bv.18`).
- [x] Delete v0 modes and workarounds (`lmoa-3bv.19`).
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
- **2026-08-21 — external implementations remain behind HTTP.** Upstream
  revisions are conformance release gates, not imported broker/daemon/LOC
  implementations. The reproducible transcription ceiling is different: the
  gateway intentionally consumes Modules' public
  `@livepeer-network/audio-duration` client package.
- **2026-08-21 — accounting-only replay.** Finish accounting for the original
  job and return `upstream_response_lost`; never auto-resubmit paid work.
- **2026-08-21 — settlement query on all transports.** Signed lookup is the
  portable authority; response headers/trailers remain observations.
- **2026-08-21 — separate usage signals.** Seller claim, actual debit, LOC
  settlement, and buyer observation remain separately named and stored.
- **2026-08-21 — prefer broker-side transcription parsing.** This gateway owns
  no runners, so a runner header is safe only if it is a universal capability
  contract.
- **2026-08-21 — the 24-hour retention assumption is superseded.** `paid-job`
  1.0.12 defines retention using maximum envelope spendable life, while also
  establishing that governance can revive an issued ticket. A finite deletion
  or LOC-acknowledgement contract is required before the gateway can set a hard
  retrieval deadline. Its durable lookup loop remains independent of the
  bounded LOC-settlement retry count.
- **2026-08-21 — no assertion-only abandon.** A never-admitted LOC reservation
  has no automatic refund path. Governance can retroactively extend or revive
  tickets, so the deployed contract provides no unconditional envelope expiry.
  `NOT_ADMITTED` is attributable audit evidence only. LOC retains unresolved
  jobs and may apply a distinct idempotent `conservative_full_charge` at an
  operational deadline without fabricating usage or network debit.
- **2026-08-21 — settlement 409 preserves evidence.**
  `job_already_settled` is terminal financial success after a lost LOC
  response, but the original signed claim remains stored as the audit record.
- **2026-08-21 — bounded debit retry lifecycle accepted; timing remains open.**
  Modules retains the payee session and retries the original debit sequence
  while lookup returns `accounting_pending`. Signed `DEBIT_FAILED` remains a
  fault, and LOC keeps the reservation encumbered. The current 30-second sweep
  reaches its 10-attempt cap in roughly five minutes, not 30; resolve under
  `lmoa-3bv.22` before pinning.
- **2026-08-21 — LOC must recover settlement without caller cooperation.** A
  caller can withhold `Livepeer-Job-Id`, so job-id-only lookup cannot protect
  reconciliation. Modules `3999acc` exposes the admitted job's durable outcome
  as `GET /v1/exchange/{request_id}`. LOC still must integrate it, verify the
  signed binding, and prove restart retention and all accounting states in
  joint conformance.
- **2026-08-21 — customer-known identity cannot authorize deletion.** Any
  broker record-deletion acknowledgement must authenticate LOC independently
  of `request_id`; otherwise the customer could erase evidence before LOC
  reconciles it.
- **2026-08-21 — transcription duration extractor accepted.** Use Modules'
  `multipart-audio-duration`; keep inexact headerless MP3 estimation disabled
  unless the product deliberately opts into estimated billing.
