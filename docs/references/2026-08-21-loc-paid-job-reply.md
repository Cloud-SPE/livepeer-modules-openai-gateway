# LOC reply on paid-job/v1 gateway migration

Date: 2026-08-21

> Thanks—your reading matches the intended breaking v2 contract.
>
> ## 1. Never-admitted jobs
>
> You identified a real gap. LOC currently cannot safely settle or release a
> job without broker-signed terminal evidence.
>
> We will not implement an assertion-based abandon endpoint or LOC-only
> timeout: once LOC returns the signed payment envelope, the caller may still
> submit it after LOC releases the encumbrance.
>
> The recovery mechanism must establish that the issued payment is no longer
> spendable—for example through payer/payee revocation, authoritative no-debit
> plus envelope expiry, or another daemon-supported proof. We have made this a
> P0 v2 release blocker and are taking it to the Modules team for a joint
> payer/payee design.
>
> ## 2. Identifier mapping
>
> Your mapping is correct:
>
> - `Idempotency-Key`: gateway-to-LOC job-open idempotency key
> - LOC `job_id`: LOC payment-session UUID
> - LOC `request_id`: stable broker-facing request identity; send it as
>   `Livepeer-Request-Id`
> - `work_id`: payer-daemon payment identity/recipient rand hash
> - `Livepeer-Job-Id`: broker audit and settlement identifier
>
> These remain distinct. Persist all five, plus the complete signed settlement
> claim. Persisting the selected capability/offering, transport, and work unit
> is also recommended for support and reconciliation.
>
> ## 3. Streaming settlement
>
> Your proposed TypeScript path is the expected one: capture
> `Livepeer-Job-Id`, stream immediately, retrieve
> `GET /v1/settlement/{jobId}` after termination, durably store the signed
> claim, and settle LOC asynchronously.
>
> The current paid-job contract retains terminal job records for at least the
> idempotency window; the reference implementation currently uses 24 hours.
> The gateway must retrieve and persist the claim within that period. Once
> persisted, LOC settlement retries are independent of broker retention.
> Please confirm whether 24 hours covers your outage/recovery target.
>
> ## 4. Catalog contract
>
> Confirmed. The intended breaking `GET /v1/capabilities` contract uses:
>
> - `offering.protocol`
> - `offering.job.transports`
> - `offering.work_unit`
> - `offering.units_per_price`
> - workload-specific metadata under `offering.extra.openai`
>
> There is no mode-based compatibility contract.
>
> ## 5. Settlement retries
>
> Current behavior is:
>
> - A retry after successful settlement returns `409 job_already_settled`
> - The gateway may treat that as terminal financial success, including after
>   a lost LOC response
> - It is not currently an exact replay of the original settlement response
> - Invalid signatures, quote/request mismatches, cross-job claims, and
>   work-unit mismatches are permanent failures
> - Transient LOC/database failures are safe to retry with the identical
>   payload
>
> Keep the original signed claim for audit even when a retry terminates with
> `job_already_settled`.
>
> ## 6. Revision and integration test
>
> We are not issuing a final SHA yet. The signed settlement implementation is
> landed locally, but the never-admitted recovery mechanism remains a P0
> blocker, and the live registry-seed integration path still depends on an
> upstream fix.
>
> Your proposed signed end-to-end matrix matches our release gate. We will add
> an explicit never-admitted recovery case and provide a pushed pin once the
> blocker and live conformance run are complete.

## Gateway response

The 24-hour retention minimum covers the gateway's routine outage/recovery
target provided retention starts at terminalization and survives broker
restart. The gateway will retrieve durably and alert well before expiry; it
will not use the bounded LOC-settlement retry budget for broker lookup. Longer
retention should remain operator-configurable, but is not a gateway v2 release
requirement.
