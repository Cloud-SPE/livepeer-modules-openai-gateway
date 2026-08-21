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
| `broker_job_id` | Broker | `Livepeer-Job-Id`; lookup key for the authoritative settlement record. |

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
price, quote, and route/constraint identity must not drift.

`DEBIT_FAILED` is an accounting fault, not successful settlement. The gateway
records it, alerts it, and does not represent the LOC reservation as settled.
The durable retry/exhaustion contract and LOC terminal behavior remain a
release blocker; see “Open external contracts.”

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
the client-visible result. `accounting_pending`, if adopted upstream, remains
in settlement lookup. `DEBIT_FAILED`, invalid signed evidence, and
never-admitted LOC jobs are explicit fault/recovery states; none may be folded
into `settled` or silently converted to zero usage.

## Open external contracts

These block release, but not the independent catalog/client/schema retrofit:

1. **Durable debit outcome.** Modules and LOC must define retrying debit,
   nonterminal `accounting_pending`, bounded exhaustion, and LOC treatment of
   signed `DEBIT_FAILED`. Coordination: `lmoa-3bv.2`, Modules `lnm-y08`.
2. **Reservation without broker admission.** LOC must provide idempotent
   abandon, expiry, or equivalent recovery when no signed broker settlement
   can exist. Coordination: `lmoa-3bv.3`.
3. **Transcription duration.** Modules must ship a universal seller-side
   contract. Because runners are external to this gateway, the preferred
   solution is `multipart-audio-duration`; a response header is acceptable
   only if every eligible runner is normatively required to emit it.
   Coordination: `lmoa-3bv.4`, Modules `lnm-4xh`.

The release gate pins immutable upstream revisions only after these contracts
land. Pinning does not introduce a source dependency.

## Reviewed upstream baseline

- Livepeer Modules branch `tasks/lpm-v2`: reviewed head `f34d2d5`, including
  implementation response `dcb8cc8`, `paid-job` 1.0.7-draft, and the reported
  39/39 signed broker conformance run.
- LOC branch `tasks/lpm-v2`: reviewed committed head `0acadd7` plus its active
  v2 working tree. The working contract requires `Idempotency-Key`, returns
  the layered job identities above, and verifies signed broker settlement at
  `POST /v1/jobs/{id}/settle`.

These hashes record what was reviewed; they are not the eventual release pins.
