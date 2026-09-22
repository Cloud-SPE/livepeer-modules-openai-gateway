# Paid-job payment flow

Every proxied inference request is funded through LOC and executed with
`paid-job/v1`. The gateway holds no chain keys and treats the LOC spend
authorization as opaque.

## Lifecycle

1. The gateway creates its own operation UUID and durably opens a reservation.
2. It asks LOC to open a job with that UUID as `Idempotency-Key`, including the
   capability, offering, transport, estimate, and authorization ceiling, plus exact request digest and caller public key.
3. It persists the gateway operation ID, LOC idempotency key, LOC job ID, LOC
   request ID, and authorization `work_id` before contacting the broker.
4. It sends the original workload to broker `POST /v1/job` with
   `Livepeer-Protocol: paid-job/v1`, the LOC-issued request ID, and the opaque
   spend authorization and caller proof.
5. It persists `Livepeer-Job-Id` when admission is observed and returns or
   streams the broker response without scraping it for accounting.
6. A background lookup retrieves the signed terminal claim by broker job ID,
   falling back to LOC's stable request ID when the response was lost.
7. The complete signed claim is stored before the durable settler submits it
   to LOC. LOC verifies the signature, identities, work unit, and funded
   ceiling, then settles actual usage.

## Authority

The local funding estimate bounds what may be spent. It is not usage evidence.
Immediate broker headers aid correlation but do not override the signed claim.
The signed settlement is authoritative for actual units, debited units,
billed value, and outcome.

The reservation's `open`/`committed`/`failed` state is only the
customer-visible gateway outcome. `failed` never asserts a financial refund;
evidence lookup and LOC reconciliation continue independently for an admitted
job.

For transcription, the gateway runs the canonical
`multipart-audio-duration/v1` exact-or-reject estimator before LOC open. It
rejects an upload that cannot produce an exact positive whole-second ceiling.
It also requires LOC's catalog to advertise that exact estimator contract;
missing or unknown metadata fails before the reservation or paid job is opened.

## Recovery

- LOC-open timeouts retry identically and converge through `Idempotency-Key`.
- Broker requests are not automatically resubmitted.
- An accounting-only replay becomes `upstream_response_lost`; accounting
  recovery continues for the original job.
- `ACCOUNTING_PENDING`, `IN_FLIGHT`, `NO_RECORD` and `ADMISSION_REJECTED` remain retryable lookup states. LOC requests fenced non-admission evidence.
- `NOT_ADMITTED` is retained as audit evidence, never converted to usage.
- `DEBIT_FAILED` is a signed explicit failure, not successful settlement.
- LOC `409 job_already_settled` is terminal financial success after a lost
  response. Other permanent evidence or identity failures stop for review.
- Transient LOC settlement failures retry without an abandonment ceiling;
  `LOC_SETTLE_ALERT_ATTEMPTS` controls alert classification only.

## Operator test

`make loc-smoke` performs a real paid exchange: idempotent LOC open, broker
execution, signed settlement lookup, and signed LOC settlement. It can move
real value and must run against deliberately configured spend limits.

Relevant code: `gateway/src/loc/dispatch.ts`,
`gateway/src/loc/brokerSettlement.ts`, `gateway/src/loc/settlementLookup.ts`,
`gateway/src/loc/settler.ts`, and `gateway/src/repo/usageReservations.ts`.

Stale LOC opens and LOC status are reconciled by `loc/recovery.ts`. See the
[current contract](./paid-job-v1.md) for exact-byte commitments, ephemeral
caller keys, settlement-domain binding and accounting-only restart recovery.
