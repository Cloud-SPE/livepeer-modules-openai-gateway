# Route selection

The gateway does not rank brokers. For every OpenAI request it asks LOC to
open one `paid-job/v1` job for the requested capability, offering, and HTTP
transport. LOC selects the route and returns the spend authorization and broker
URL as one idempotent outcome.

## Hot path

```text
gateway -> LOC: POST /v1/jobs
  Idempotency-Key: <gateway operation UUID>
  { capability, offering, transport, estimated_units, max_total_units,
    workload_request_digest, caller_public_key }

LOC -> gateway:
  { job_id, request_id, work_id, broker_url, protocol, transport,
    work_unit, spend_authorization, accounting_mode, route_snapshot, settle_endpoint }

gateway -> broker: POST /v1/job
  Livepeer-Protocol: paid-job/v1
  Livepeer-Request-Id: <LOC request_id>
  Livepeer-Authorization: <spend authorization>
  Livepeer-Caller-Proof: <invocation proof>
```

The gateway verifies that LOC returned `paid-job/v1`, the requested transport,
and the endpoint's expected work unit. A mismatch fails before broker dispatch.

Transient LOC-open failures retry the identical request with the identical
idempotency key, bounded by `LOC_OPEN_MAX_ATTEMPTS`. A broker request is sent
once. The gateway never opens a replacement job after broker dispatch and
never attempts gateway-side candidate failover.

## Catalog path

`GET /v1/models` reads the local `models` table. A background refresh loads
LOC `GET /v1/capabilities`, upserts advertised offerings, and deactivates
offerings that disappear. Model ids are offering ids; workload metadata comes
from the offering's `extra.openai` object.

The catalog is not consulted for broker selection on the request hot path.
It is used to validate offering protocol, transports, work unit, and any
reproducible client estimator contract.

## Ownership

| Concern | Owner |
|---|---|
| Route selection and wholesale funding and authorization | LOC |
| Transport and work-unit requirement | OpenAI endpoint adapter |
| Broker admission and execution | Modules broker |
| Final usage and debit evidence | Broker-signed settlement |
| Customer-facing request history | This gateway |

Relevant code: `gateway/src/loc/dispatch.ts`, `gateway/src/loc/client.ts`,
`gateway/src/registry/catalog.ts`, and `gateway/src/registry/refresh.ts`.
