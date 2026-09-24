# paid-job/v1 gateway contract

The current contract is Modules network protocol major 4 and LOC wholesale
accounts. The interaction identifier remains `paid-job/v1`. Old ticket-only
admission is unsupported. Reviewed sources: Modules `08f5985`, LOC `6a6392a`.
These source revisions are not a claim that production runs those exact images.

## Ownership

LOC selects the route, funds aggregate wholesale accounts, and issues a
single-purpose spend authorization. The gateway holds no chain keys or
payment wallet. It creates a short-lived invocation proof key; that key
proves possession of one authorization and cannot fund a network account.
Broker/runner implementations remain external. LOC verifies delegated
settlement signatures and performs authoritative accounting.

## Preparation and dispatch

1. Create a durable gateway operation UUID.
2. Resolve offering/model metadata and prepare the final broker request.
   Serialize JSON or multipart once, including its boundary and any model
   rewrite; compute SHA-256 over exactly the bytes to be sent.
3. Generate an ephemeral compressed secp256k1 caller key. Persist the public
   LOC open intent: idempotency key, digest, public key, transport and ceiling.
   Do not persist prompts, uploads or the private key.
4. Open LOC with `workload_request_digest`, `caller_public_key`, capability,
   offering, transport, estimated units and maximum total units. Retries
   reuse the same intent and key. `503 WHOLESALE_FUNDING_UNVERIFIED` and
   `409 IDEMPOTENCY_IN_PROGRESS` are retryable; definitive 422 refusal is not.
5. Require `accounting_mode: wholesale_account`. Validate and persist the
   returned job/request/work identities, spend authorization, route snapshot
   and same-origin settlement endpoint before dispatch.
6. Send `POST /v1/job` with `Livepeer-Protocol: paid-job/v1`, capability,
   offering, LOC request ID, `Livepeer-Authorization`, and
   `Livepeer-Caller-Proof`. Redirects do not transfer invocation authority.
7. Return the response, keeping SSE incremental. Broker job identity is
   persisted as soon as available. Response bodies are not billing evidence.

Caller proof is base64(R || S || V), V=27/28, of EIP-191 personal-sign over
`keccak256("livepeer-invocation-proof/v1\0" || authorization_bytes)`. The
implementation uses pinned noble primitives, matching the LOC reference
example. The private key lives only for the active invocation.

## Identity and persistence

Gateway `work_id` is the local operation UUID. LOC job ID identifies the
clearinghouse engagement; LOC request ID identifies the broker exchange.
The historical `payment_work_id` column now carries the authorization ID.
Broker job ID is a lookup handle, not a replacement for those identities.

Migration 0010 adds nullable open intent, authorization, route snapshot,
settlement-domain and LOC-status columns. Historical rows are retained.
The snapshot pins the broker, capability, offering, quote/version, price
numerator/denominator, fingerprints, delegated settlement keys and domain.
A wholesale account is scoped by chain, payer, payee, settlement domain and
denomination; a URL or payee address alone is insufficient.

Authorization bytes remain private database recovery material. Admin and
portal projections expose the domain and accounting observations, not the
spend authorization, caller proof, or signed evidence. Errors do not enumerate
the attached recovery authority when serialized into logs.

## Accounting recovery

The broker lookup worker requests settlement by broker job ID, or exchange
by LOC request ID when the response was lost. The exact signed envelope is
persisted before submitting it to LOC. It validates request/job/work/unit
bindings and, for new rows, authorization and settlement domain. LOC verifies
the delegated signature, quote, financial scope and amount.

ProtoJSON omits zero scalar fields and empty BigUInt bytes. These are read as
zero without inserting fields into the signed payload. Never repair or
normalize a signed payload before forwarding it to LOC.

`ACCOUNTING_PENDING`, `IN_FLIGHT`, `NO_RECORD` and `ADMISSION_REJECTED`
remain retryable. The broker's current contract retries uncertain authorization
settlement indefinitely; the historical ten-attempt DEBIT_FAILED timeout is
obsolete. An unexpected historical DEBIT_FAILED remains an explicit fault.

The LOC recovery worker repeats stale open intents after a grace period longer
than the foreground retry budget, solely to discover the original job. It
never dispatches inference after restart. No private caller key or prompt is
needed: LOC reconciles the unused grant. Definitive refused opens terminate;
uncertain funding keeps the identical intent eligible for recovery.

A separate status poll reads `GET /v1/jobs/{id}` and checks request/work
identity. LOC state and accounting outcome stay separate from signed evidence:
`unresolved`, `non_admission_audit`, `broker_settled`, and
`conservative_full_charge` must not be conflated. Only a closed LOC state is
recorded as terminal LOC accounting. Signed NOT_ADMITTED is audit evidence;
it is not a gateway-generated refund or synthetic zero-unit settlement.
After expiry, LOC may verify fenced non-admission, release the hold, and report
closed/broker_settled with zero units and zero billed value. Status recovery
records that terminal LOC decision without creating broker settlement evidence.

Broker replay is accounting-only. The gateway reports
`upstream_response_lost` and recovers the original exchange without executing
new work. Customer-visible `open/committed/failed` is independent of accounting.

## Units and catalog

| Endpoint | Accepted unit | Ceiling |
|---|---|---|
| Chat | tokens | Prompt estimate plus caller output bound |
| Embeddings | tokens | Conservative UTF-8 input size |
| Images | images | Requested positive count |
| Speech | characters or input_chars | Unicode code points |
| Rerank | requests | One |
| Transcription | seconds or audio_seconds | Exact rounded-up duration under advertised multipart-audio-duration/v1 |

The gateway validates the offering's work unit before opening LOC. Catalog
`units_per_price` is required and must be a positive safe integer; the actual
denominator is retained in the cache and diagnostics. There are no rate cards
or customer billing. Session offerings remain outside this product.

Transcription still requires the explicit exact estimator contract. Missing
metadata returns `transcription_estimator_unavailable` before payment. A
production offering's presence in the catalog alone does not prove that it
can be selected or that its estimator meets gateway requirements.

## Validation and release

The unit suite covers proof recovery, exact multipart bytes, LOC validation,
refusal recovery, status identities, price denominators and signed zero values.
`make loc-smoke` tests direct paid dispatch. `make live-conformance` exercises
the public gateway and durable settlement; its default requires unary, stream
and multipart. `LIVE_CONFORMANCE_TRANSPORTS=unary,stream` runs an explicitly
partial check and does not certify omitted transports.

Beads epic `lmoa-3bv` owns implementation and remaining release gates. A local
image build, production interoperability, and immutable multi-service release
certification are distinct evidence. Drain old work, back up all affected
ledgers and follow upstream settlement-domain migration guidance before a
coordinated production upgrade. The gateway does not upgrade upstream ledgers.
