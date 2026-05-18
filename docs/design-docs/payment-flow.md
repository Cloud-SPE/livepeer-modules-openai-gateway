# Payment flow

How the gateway mints `Livepeer-Payment` envelopes for every `/v1/*`
request, where the keys live, and what the failure modes look like.

## Why payment exists in v1

Even though v1 has **no customer billing**, the gateway still has to
pay the Livepeer network on behalf of each request. Network
orchestrators won't serve traffic without a valid payment envelope;
removing payment removes the product. See
[core-beliefs §6](./core-beliefs.md).

## Wire shape

Every outbound request from gateway → broker carries:

```
Livepeer-Capability: openai:chat-completions
Livepeer-Offering:   qwen3:8b
Livepeer-Mode:       http-reqresp@v0  (or http-stream / http-multipart)
Livepeer-Payment:    <base64-encoded payment bytes>
Livepeer-Request-Id: <uuid>
```

The `Livepeer-Payment` value is opaque to the gateway. It's bytes
minted by `payment-daemon` over a unix-socket gRPC call using the
selected route's accepted price basis plus a gateway-side funding
intent.

## gRPC surface

The payer-daemon exposes (from `proto/livepeer/payments/v1/payer_daemon.proto`):

```protobuf
service PayerDaemon {
  rpc CreatePayment(CreatePaymentRequest) returns (CreatePaymentResponse);
  rpc Health(google.protobuf.Empty) returns (HealthResponse);
}

message CreatePaymentRequest {
  bytes         recipient              = 1;  // 20-byte eth address
  string        ticket_params_base_url = 2;  // selected broker URL
  AcceptedPrice accepted_price         = 3;
  FundingIntent funding                = 4;
}
```

`gateway/src/proxy/livepeer/payment.ts` is the only call site. It:

1. Loads the proto files at boot (`init()`) from
   `config.paymentProtoRoot` (default `/app/proto` in container,
   `<repo>/proto` in dev).
2. Opens a single long-lived gRPC client to
   `unix:${config.payerDaemonSocket}` (default
   `/var/run/livepeer/payer-daemon.sock`).
3. Sends a Health probe; init throws if it fails. The boot sequence
   logs a warning and continues — `/v1/*` will 503 at request time
   instead of crashing the process.
4. `buildPayment()` does a one-shot `CreatePayment` RPC per outbound
   broker attempt, returns the base64-encoded `paymentBytes` for the
   header.

`accepted_price` carries the exact selected route tuple:
- `price_per_unit_wei`
- `units_per_price`
- `work_unit_name`
- `capability`
- `offering`
- `quote_ref { quote_id, quote_version, constraint_fingerprint, route_fingerprint }`

`funding` is the gateway's initial budget authorization for the
attempt. In the current implementation it is conservative and
single-shot:
- `estimated_units` comes from the request handler's heuristic
- `funded_value_wei` is derived from `estimated_units × accepted price`
- `max_total_units = estimated_units`
- `top_up_allowed = false`

## Per-attempt, not per-request

`routeDispatch.attemptCandidates()` may retry against a fresh broker
candidate on upstream failure. Each retry mints a **new** payment
envelope — the contract is "one payment per attempted upstream call,"
not "one payment per inbound `/v1/*` request." This is
intentional: a different broker serving the retry needs its own
ticket scoped to it. The reservation row is updated with the actual
selected route metadata for the last attempted candidate, so commit and
refund records still retain route/quote context.

## What we DO NOT do

- **No ticket-signing in the gateway.** The daemon owns the
  keystore + nonce state. v0.2 of the wire spec explicitly hoists
  signing out of the gateway so warm-key handling stays one surface.
- **No payment caching.** Tickets are nonce-bound; reuse breaks
  receivers.
- **No payment validation.** The orchestrator-side
  `capability-broker` validates envelopes; the gateway treats them
  as opaque.

## Failure modes

| What fails | What the gateway does | Visible to user as |
|---|---|---|
| Payer daemon socket not present at boot | Warn, continue. Cache stays `null`. | First `/v1/*` call → `500 internal_error: "payer-daemon client not initialized"`. |
| Payer daemon socket present but Health RPC fails | Warn, continue. | Same as above. |
| `CreatePayment` RPC fails mid-request | Throws — caught by route handler. Reservation `refund`. Failover loop tries the next candidate (a new payment is minted for it). | `502 api_error` if every candidate's `CreatePayment` fails. |
| Broker rejects the envelope as invalid | Route-health tracker marks the candidate unhealthy; retry next. | If all candidates reject: passthrough of the last broker's error. |

## Operator setup

See [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md) §"Livepeer plumbing"
for the keystore + chain-RPC setup. Short version: payer-daemon needs
a funded eth keystore (`keystore.json` + `keystore-password` file
mounted at `/etc/livepeer/`) and an EVM JSON-RPC endpoint.

## Where it lives

| Concern | File |
|---|---|
| gRPC client + RPC call | `gateway/src/proxy/livepeer/payment.ts` |
| Proto files | `proto/livepeer/payments/v1/*.proto` |
| Boot wiring | `gateway/src/index.ts` (the `payer-daemon` block) |
| Config | `gateway/src/config.ts` — `payerDaemonSocket`, `paymentProtoRoot` |
| Health probe | `gateway/src/routes/health.ts` (socket presence only — we don't reissue the gRPC Health probe per request) |
