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
- importing or vendoring broker, daemon, worker, LOC, or Modules package
  implementations;
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
- [x] Resolve LOC reservations that never reach broker admission
  (`lmoa-3bv.3`).
- [x] Add independent broker settlement recovery by LOC request id
  (`lmoa-3bv.23`).
- [x] Resolve broker settlement retention under governance-revivable envelopes
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
- [x] Configure endpoint units, estimates, and ceilings (`lmoa-3bv.15`).

### Phase 4 — prove and cut over

- [x] Replace mode-based diagnostics (`lmoa-3bv.16`).
- [x] Build v2 mock contract regressions (`lmoa-3bv.17`).
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
  implementations. The reproducible transcription ceiling is implemented by
  the gateway-owned `multipart-audio-duration/v1` parser, with no sibling
  repository or package dependency.
- **2026-08-21 — accounting-only replay.** Finish accounting for the original
  job and return `upstream_response_lost`; never auto-resubmit paid work.
- **2026-08-21 — settlement query on all transports.** Signed lookup is the
  portable authority; response headers/trailers remain observations.
- **2026-08-21 — separate usage signals.** Seller claim, actual debit, LOC
  settlement, and buyer observation remain separately named and stored.
- **2026-08-21 — reproduce only the advertised transcription ceiling.** The
  broker owns seller-side measurement. The gateway owns a small local
  `multipart-audio-duration/v1` implementation solely to bound LOC funding,
  and verifies it against the protocol fixture vectors. LOC passes estimator
  metadata through but parses no media; no Modules package is a dependency.
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
- **2026-08-21 — transcription duration contract accepted.** Implement the
  advertised `multipart-audio-duration/v1`, `ceil-to-whole-seconds`,
  `exact-or-reject` ceiling locally; refuse headerless MP3 and unknown
  estimator IDs. The signed broker settlement remains usage authority.
- **2026-08-23 — live stream path proven.** A localhost stream returned HTTP
  200 SSE and `[DONE]`; request-ID recovery persisted a signed claim for 36
  actual/debited tokens and 4 wei, and LOC reached terminal settlement. LOC
  recovered and closed the job before the gateway's retry, so the gateway
  correctly treated `job_already_settled` as success while retaining evidence.
- **2026-08-23 — multipart remains externally blocked.** A fresh exact 3-second
  WAV open again funded 3000 wei but credited only 2 wei of payee expected
  value. The broker refused `insufficient_balance` without the mandatory
  zero-unit HTTP claim and request-ID lookup ended as
  `ADMITTED_OUTCOME_UNKNOWN`. Track under `lmoa-3bv.27` and `.28`.
- **2026-08-23 — worker output limits are part of conformance.** The Modules
  fixture emitted 36 total tokens for a request whose prompt plus
  `max_tokens: 8` ceiling was 17. LOC correctly rejected the signed claim as
  `usage_ceiling_exceeded`; `lmoa-3bv.29` tracks fixture compliance.
- **2026-08-24 — upstream release recheck remains blocked.** Modules release
  head `ac94ba7` (implementation `e9445e8`) guarantees nonzero credit at its
  advertised minimum but does not credit the requested funded ceiling. A
  3-second transcription funded at 3000 wei credited 2 wei, and the resulting
  broker `insufficient_balance` response again omitted the required zero-unit
  claim and signed terminal evidence. The gateway must not inflate usage
  ceilings to compensate; `lmoa-3bv.27` and `.28` remain upstream release
  gates.
- **2026-08-24 — current LOC boundary proven.** LOC `3b3eb83` successfully
  opened and settled a fresh unary chat exchange selected through its catalog.
  Gateway reservation `893451cb-0b1a-4a83-8b40-44724333260e` retained the LOC
  job, stable request id, broker job, signed evidence, 33 actual/debited
  tokens, and 3 wei billed before reaching `settled`. This proves the LOC job
  interface used by the gateway; it does not waive the separate broker defects
  affecting multipart work.
- **2026-08-24 — LOC rejects underfunded envelopes.** LOC `d1ab76d`
  (`76d42ef`) validates that the payer echoes the requested funded value and
  returns expected value greater than or equal to it before persisting payment
  or accounting state. Job-open, session-open, and refill guards are covered;
  the targeted 13-test verification passes. Current Modules therefore fails
  closed at LOC open rather than handing the gateway an unusable envelope.
- **2026-08-24 — Modules source fixes verified.** Candidate `0e89b3d` contains
  funded-EV sizing, signed/replayable post-admission refusal evidence, and a
  single authoritative terminal outcome after pending debit. Focused payment
  and broker suites pass, as do all 41 protocol conformance cases. LOC's
  complete real-process matrix remains the behavioral gate. The published
  Modules `v2.0.0` image record still references `e9445e8`; deployment must
  wait for new immutable digests built from the verified candidate.
- **2026-08-24 — LOC integration complete.** LOC `a171f9b` passes check,
  layering, typecheck, and 410/410 tests. Its committed audit records a 14/14
  hermetic real-process matrix against clean Modules `215e8a4`, covering
  funded EV, job idempotency, request-id settlement recovery, cross-request
  and tamper rejection, signed close, broker restart, pending-debit recovery,
  reactive rotation, and proactive rollover at the real 600-ticket boundary.
  Only new immutable Modules digests and the image-based deployment check
  remain before final pin/cutover.
- **2026-08-24 — release harness complete.** `make live-conformance` now
  exercises unary chat, non-buffered SSE through `[DONE]`, and an exact
  generated three-second WAV through the public gateway. It authenticates via
  the portal and polls the durable usage surface until all four identities,
  signed broker usage, and terminal LOC settlement are persisted. Release
  scripts are part of strict TypeScript lint. `make release-check` validates
  OCI version/revision, non-root execution, healthcheck, migration 0009, and
  the absence of a Modules audio package; the release Compose override refuses
  mutable image tags and removes the source build.
- **2026-08-24 — immutable Modules artifacts published.** Release record
  `1241d76` points to matrix-tested source `215e8a4` and records immutable
  digests. LOC is tagged `v2.0.0` at `f739a28`. Final live image conformance is
  currently blocked because the running LOC rejects the private pilot API key
  with HTTP 401; the gateway credential still matches the private credential
  file. Do not alter LOC account state from this repository.
- **2026-09-05 — image build entrypoint consolidated.**
  `infra/scripts/build-images.sh` is now the shared local, Make, and tagged-CI
  build path. It derives auditable git build metadata, pins the Node and pnpm
  build inputs, rejects mismatched tags and dirty publishes, preserves the
  `linux/amd64,linux/arm64` release contract, prints the immutable manifest
  digest, and does not implicitly move `latest`.
