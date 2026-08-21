# paid-job/v1 gateway contract

Status: **Drafted** — binding for the migration, not yet exercised end to end.

This document defines how the OpenAI gateway consumes Livepeer Modules 2.0
`paid-job/v1` and the corresponding LOC job API. It supersedes the broker-seam
decisions in [payment-flow.md](./payment-flow.md),
[route-selector.md](./route-selector.md), and
[streaming-usage.md](./streaming-usage.md) when the migration cuts over. Those
documents continue to describe the running v0 code until it is removed.

The migration is intentionally breaking. There is no dual protocol, feature
flag, fallback parser, or backward-compatible broker path.

## Boundary and ownership

The gateway depends on two external HTTP contracts:

1. The LOC catalog and job API select an offering, reserve operator funds, and
   return a broker target, opaque payment envelope, and broker request id.
2. The broker implements `paid-job/v1`, executes the capability, measures the
   seller's usage claim, debits its payment session, and signs the settlement.

Capability runners, broker middleware, settlement verification code, and LOC
accounting remain external. We pin release-ready revisions and run conformance
against them; we do not vendor their source or add build/runtime dependencies
on either repository.

## Binding decisions

### One protocol, transport per request

Catalog offerings must declare `protocol: paid-job/v1` and their supported
`job.transports`. The same offering may serve multiple transports:

| OpenAI exchange | Transport selection |
|---|---|
| Buffered JSON or binary response | `unary` (default HTTP request) |
| Chat SSE response | `stream` via `Accept: text/event-stream` |
| File upload | `multipart` via `Content-Type: multipart/form-data` |

The broker request is `POST /v1/job` with `Livepeer-Protocol:
paid-job/v1`. `Livepeer-Mode`, `Livepeer-Spec-Version`, `/v1/cap`, mode
guessing, mode-specific offerings, and mode-mismatch job replacement do not
exist in the new path. An undeclared transport is a typed
`protocol_transport_unsupported` refusal before broker payment side effects.

### Identity is durable and layered

The gateway persists every identifier instead of treating one as a universal
request id:

| Logical field | Chosen by | Purpose |
|---|---|---|
| `gateway_operation_id` | Gateway | Joins the inbound OpenAI request to its durable reservation row. |
| `loc_idempotency_key` | Gateway | Makes an identical `POST /v1/jobs` retry converge on one LOC reservation. |
| `loc_job_id` | LOC | Identifies the funded reservation and settlement endpoint. |
| `broker_request_id` | LOC | Sent unchanged as `Livepeer-Request-Id`; binds the LOC job to the signed broker settlement. |
| `work_id` | Payment system | Identifies the payment identity; it is not unique to one exchange. |
| `broker_job_id` | Broker | `Livepeer-Job-Id`; gateway lookup key for the authoritative settlement record when the broker response is available. |

An LOC-open retry uses the same idempotency key and byte-equivalent JSON. A
broker retry uses the same broker request id, capability, offering, payment
envelope, transport, and workload bytes. Changed content is a new operation,
not a retry. `request_id_reuse` is terminal for that attempt;
`job_in_flight` is retryable with the same identity.

### Idempotency recovers accounting, not output

A terminal broker replay returns recorded status, claim metadata, and broker
job id without executing the backend or debiting twice. It does not reproduce
the original OpenAI response body.

When the gateway detects this accounting-only replay, it must:

1. retrieve and persist the original signed settlement;
2. complete or durably enqueue LOC accounting for the original reservation;
3. return HTTP 502 with an OpenAI-shaped error whose code is
   `upstream_response_lost`.

It must not silently create a new LOC job, generate a new broker request id,
or resubmit the user's work. A future explicit user request is a new paid
operation. The gateway will not retain all inference responses merely to add
response replay.

### Signed settlement lookup is authoritative

`Livepeer-Work-Units` and `Livepeer-Work-Unit` are observations available in
unary/multipart response headers and, for streams, trailers. They are not
sufficient LOC settlement evidence. Unary headers can be committed before a
later debit fails, and Node Fetch cannot reliably expose stream trailers.

For every transport, the gateway retrieves
`GET /v1/settlement/{broker_job_id}`. A 202 response is nonterminal and is
retried durably. A terminal response is accepted only after its signed
envelope and bound identifiers are persisted and LOC verifies it against the
route's delegated settlement key. Work unit, request id, job id, work id,
price, quote, and route/constraint identity must not drift. Independently, LOC
must be able to retrieve the same signed record by its stable
`broker_request_id`; otherwise an untrusted caller can hide
`Livepeer-Job-Id` and prevent reconciliation. Modules `3999acc` provides
`GET /v1/exchange/{request_id}` for this purpose. LOC integration and joint
restart conformance remain P0 under `lmoa-3bv.23`; the gateway does not become
the source of truth.

The earlier 24-hour terminal-retention agreement is superseded by
`paid-job` 1.0.12-draft, which requires retention for maximum envelope
spendable life plus a dispute/recovery window. Because governance can revive
an issued ticket, that maximum is not finite under the deployed contract. The
teams must define an enforceable deletion/acknowledgement rule under
`lmoa-3bv.24`. Independently of that decision, the gateway persists a lookup
intent as soon as it knows the broker job id and retries without the bounded
`LOC_SETTLE_MAX_ATTEMPTS` budget. Once the complete signed claim is stored
locally, subsequent LOC retries no longer depend on broker retention.

`DEBIT_FAILED` is an accounting fault, not successful settlement. The gateway
records it, alerts it, and does not represent the LOC reservation as settled.
The broker durably retries the original debit identity while settlement lookup
returns `202 accounting_pending`; only bounded exhaustion produces a signed
`DEBIT_FAILED`. LOC rejects that outcome and keeps the reservation encumbered.
The reviewed broker currently sweeps every 30 seconds and exhausts after
either 10 attempts or 30 minutes. During a continuous outage the attempt bound
wins after roughly five minutes, so the advertised 30-minute reconciliation
window still requires alignment under `lmoa-3bv.22`.

### Streaming remains non-buffering

The gateway forwards SSE bytes as they arrive. It does not inject
`stream_options.include_usage`, accumulate the transcript, or delay output for
accounting. Once response headers yield the broker job id, that identity is
persisted. Normal completion, broker termination at the funded ceiling,
client disconnect, and mid-stream failure all schedule settlement lookup and
LOC accounting independently of the client connection.

### Backend errors and funded ceilings

A non-streaming backend non-2xx response claims zero units regardless of the
configured extractor. Partial streaming output remains claimable as measured.
Every request supplies a bounded LOC `max_total_units`; a stream may terminate
when measured usage reaches the funded ceiling. There is no refill or balance
warning in paid-job work.

## Usage and accounting semantics

The seller's signed claim, money actually moved, and buyer-side observation
are different facts. Durable storage and diagnostics use these meanings:

| Logical field | Authority | Meaning |
|---|---|---|
| `work_unit` | Pinned offering plus signed echo | Unit shared by all numeric fields for the exchange. Drift is an error. |
| `broker_actual_units` | Signed settlement | Units measured by the seller's extractor, including measurable partial stream output. |
| `broker_debited_units` | Signed settlement | Units the broker ledger actually debited. May be lower than actual units on debit failure. |
| `broker_billed_value_wei` | Signed settlement | Value that actually moved; never inferred from a response header. |
| `gateway_observed_units` | Gateway observation | Optional buyer-edge measurement, such as an OpenAI usage object. Absence is unknown, not zero. |
| `gateway_observation_source` | Gateway | Names how the observation was obtained so unlike measurements are not compared silently. |
| `loc_settled_units` and `loc_billed_value_wei` | LOC response | Final clearinghouse accounting after signed evidence is accepted. |

The current product does not bill customers. Portal and admin usage are
operational records, not invoices. They must label seller-claimed, debited,
LOC-settled, and gateway-observed values separately. A broker claim must never
be renamed “customer billed usage.” Divergence is retained for diagnostics;
the gateway does not overwrite one signal with another or invent an estimate
when an observation is absent.

For LOC settlement, the gateway transmits the signed record's values in the
matching LOC fields and lets LOC verify them. It never substitutes
`gateway_observed_units` for the seller claim.

## Durable lifecycle

The implementation may use different internal names, but it must preserve
these distinguishable states:

```text
reservation_open
  -> loc_opened
  -> broker_in_flight
  -> settlement_lookup_pending
  -> settlement_ready
  -> loc_settle_pending
  -> settled
```

Accounting-only replay rejoins at `settlement_lookup_pending` and changes only
the client-visible result. `accounting_pending` remains
in settlement lookup. `DEBIT_FAILED`, invalid signed evidence, and
never-admitted LOC jobs are explicit fault/recovery states; none may be folded
into `settled` or silently converted to zero usage.

## Open external contracts

These block release, but not the independent catalog/client/schema retrofit:

1. **Never-admitted outcome implementation.** The policy is final: the
   deployed chain contract has no unconditional envelope expiry because
   governance can retroactively extend or revive tickets. LOC implements no
   abandon, automatic refund, or re-encumbrance. Valid signed settlement is
   settled accurately; absence of terminal evidence remains unresolved; an
   operational deadline may produce a distinct idempotent
   `conservative_full_charge`; signed `NOT_ADMITTED` is attributable audit
   evidence only. The conservative outcome retains issuance/deadline fields,
   observed chain telemetry, reason, and evidence without inventing usage or a
   network debit. No gateway implementation change is requested. LOC must land
   and test these states before release. Coordination: `lmoa-3bv.3`.
2. **Settlement recovery by request id.** Modules `3999acc` now exposes
   `GET /v1/exchange/{request_id}` with `SETTLED`, `ACCOUNTING_PENDING`,
   `IN_FLIGHT`, `NOT_ADMITTED`, and `NO_RECORD` outcomes. LOC must consume it
   idempotently and joint conformance must prove restart recovery and
   cross-request isolation when the caller withholds `Livepeer-Job-Id`.
   Coordination: `lmoa-3bv.23`.
3. **Settlement retention.** The prior 24-hour rule no longer matches
   `paid-job` 1.0.12. Its replacement depends on maximum envelope spendable
   life, but governance can make that unbounded. Define when restart-persistent
   records may be deleted, preferably with an authenticated LOC
   acknowledgement or another finite rule. Any acknowledgement must
   authenticate LOC independently of the customer-known request id, which
   cannot authorize evidence deletion. The same spec revision must remove
   stale §5.3.1 language that still describes `NOT_ADMITTED` as refund evidence.
   Coordination: `lmoa-3bv.24`.
4. **Debit retry window.** The retry lifecycle is resolved, but its implemented
   timing is not the advertised “10 attempts over 30 minutes.” A 30-second
   sweep with a 10-attempt cap reaches terminal failure in roughly five
   minutes. Coordination: `lmoa-3bv.22`.

The release gate pins immutable upstream revisions only after these contracts
land. Pinning does not introduce a source dependency.

## Resolved upstream contracts

- **Durable debit outcome.** Modules `818430c` retains delivered-but-unsettled
  jobs, reports `202 accounting_pending`, retries the same debit sequence, and
  signs either the successful terminal result or `DEBIT_FAILED` after bounded
  exhaustion. LOC `258b36e` rejects `DEBIT_FAILED` without settling or
  releasing the reservation. The lifecycle decision is closed under
  `lmoa-3bv.2`; retry timing remains open under `lmoa-3bv.22`.
- **Transcription duration.** Modules `12fa0db` ships the
  `multipart-audio-duration` extractor for WAV, FLAC, MP4/M4A, Ogg, WebM, and
  MP3. Exact duration rounds up to seconds. MP3 without Xing/Info or VBRI
  metadata is an inexact CBR estimate and is refused by default unless the
  offering explicitly enables `allow_inexact`. Coordination bead
  `lmoa-3bv.4` is closed.

## Reviewed upstream baseline

- Livepeer Modules branch `tasks/lpm-v2`: reviewed committed head `3999acc`, including
  durable debit retry `818430c`, transcription extractor `12fa0db`, and payment
  conditional expiry corrections, signed `NOT_ADMITTED`, and the final
  four-outcome policy and request-id exchange lookup in `paid-job`
  1.0.13-draft. Local verification
  passed 39/39 protocol conformance tests, 19/19 capability-broker smoke
  assertions, the payment daemon Go test suite, and the current sender tests.
- LOC branch `tasks/lpm-v2`: reviewed committed head `73e523d`. Expiry telemetry
  persistence landed at `d7ae387`; signed `DEBIT_FAILED` rejection landed at
  `258b36e`; the four-outcome recovery decision is recorded without adding an
  unsafe automatic refund path.

These hashes record what was reviewed; they are not the eventual release pins.

The LOC team's confirmation and open release blockers are preserved in
[the 2026-08-21 LOC reply](../references/2026-08-21-loc-paid-job-reply.md).
