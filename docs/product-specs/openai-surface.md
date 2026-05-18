# OpenAI API surface

## Who

A developer with an existing OpenAI SDK integration. Wants to switch
to this service by changing `base_url` and `api_key`, keeping
everything else.

## What

A drop-in subset of the OpenAI v1 HTTP API:

| Endpoint | Streaming | Auth | Status |
|---|---|---|---|
| `POST /v1/chat/completions` | yes (`stream: true`) | Bearer | v1 |
| `POST /v1/embeddings` | no | Bearer | v1 |
| `POST /v1/images/generations` | no | Bearer | v1 |
| `POST /v1/audio/speech` | no | Bearer | v1 |
| `POST /v1/audio/transcriptions` | no | Bearer | v1 |
| `POST /v1/rerank` | no | Bearer | v1 (Cohere-shape, not OpenAI) |
| `GET /v1/models` | no | none | v1 |
| `GET /v1/realtime` (WebSocket) | n/a | n/a | **v2** |

## Where

- Base URL: whatever the gateway is deployed at, plus `/v1`. Example:
  ```python
  client = OpenAI(api_key="sk-…", base_url="https://api.example.com/v1")
  ```
- Auth header: `Authorization: Bearer sk-…`
- All responses are OpenAI-shape JSON unless the spec endpoint says
  otherwise (e.g. `/v1/audio/speech` returns binary audio).

## Why

Compatibility is the feature (see
[`../../PRODUCT_SENSE.md`](../../PRODUCT_SENSE.md) §"Principle 1").
If an SDK call works against `api.openai.com` and fails here, that's
a bug, not a deliberate gap.

## Acceptance criteria

### Per-endpoint shape

- Request body schemas are accepted verbatim; extra fields are
  forwarded to the upstream broker without validation.
- Response body shapes match the upstream's output verbatim — the
  gateway re-encodes nothing for chat / embeddings / images / audio
  speech / audio transcriptions.
- `/v1/chat/completions` with `stream: true` returns
  `text/event-stream` with `data: …` frames terminated by
  `data: [DONE]`. See [`../design-docs/streaming-usage.md`](../design-docs/streaming-usage.md).
- `/v1/audio/transcriptions` accepts `multipart/form-data` up to
  100MB; the `model` field is read from the multipart form (or from
  the `Livepeer-Model` header as a fallback).

### Auth

- Missing / malformed / unknown Bearer token → `401` in OpenAI shape:
  ```json
  { "error": { "message": "...", "type": "invalid_request_error", "code": "invalid_api_key" } }
  ```
- Revoked key → same `401`.
- Approved-but-disabled account → `403 account_disabled`.

### Rate limit

- Per-API-key token bucket: default 60 req/min, burst 30. Configurable
  via `V1_RATE_LIMIT_PER_MINUTE` + `V1_RATE_LIMIT_BURST`.
- Exhaustion → `429 rate_limit_exceeded` with a `Retry-After` header
  (seconds). The reservation is not opened — 429s don't pollute
  `usage_reservations`.

### Errors from upstream

- `LivepeerBrokerError` with status ≥ 500 → returned as our `502
  api_error`.
- Broker 4xx (including 429) → passed through verbatim, OpenAI-shape.
- Network / payment / unknown error → `500 api_error: internal_error`.

### Models

- `GET /v1/models` is unauthenticated; returns the OpenAI catalog
  shape:
  ```json
  { "object": "list",
    "data": [{ "id": "qwen3:8b", "object": "model",
               "created": 1700000000, "owned_by": "livepeer" }, …] }
  ```
- Catalog is whatever the on-chain service registry advertises right
  now (refreshed every `REGISTRY_REFRESH_INTERVAL_MS`, default 60s).
- A model that disappears from the registry disappears from the API
  within one refresh cycle (`active=false` in the cache; filtered out
  of the list response).
- If the models cache is empty, `/v1/models` returns `503
  models_cache_unavailable` rather than pretending the catalog is
  healthy.
- If the latest cached snapshot is older than
  `max(REGISTRY_REFRESH_INTERVAL_MS * 2, 120s)`, `/v1/models` returns
  `503 models_cache_stale`.
- Internally the cache also preserves route/quote metadata
  (`units_per_price`, `quote_id`, `quote_version`, route/constraint
  fingerprints) for admin debugging, but the public `/v1/models`
  response stays OpenAI-shaped and does not expose those fields.

### Headers

- Every response carries `Livepeer-Request-Id`. Pass it in if you
  want correlation across upstreams (we honor inbound
  `Livepeer-Request-Id` and synthesize one otherwise).

## What this surface does NOT promise (v1)

- **`/v1/files`, `/v1/threads`, `/v1/assistants`, fine-tuning,
  batch.** Not in v1.
- **Stripe metadata in errors** (`error.code: rate_limit_exceeded`
  matches, but we don't carry headers like
  `X-RateLimit-Remaining`).
- **`stream_options` other than `include_usage`.** We accept and
  forward whatever the client sends, but only `include_usage`
  affects our settlement.
- **Idempotency-Key header.** Duplicate POSTs create duplicate
  upstream work.
- **Per-model latency / token-rate guarantees.** Performance reflects
  upstream brokers.
- **`tool_choice` / `response_format` JSON-mode guarantees.** Whatever
  the upstream supports is what works — we don't validate or
  transform.

## Edge cases

| Case | Behavior |
|---|---|
| Client requests a model that no registry candidate advertises | Route selection fails before broker dispatch and returns an API error for no route candidates. |
| Client requests `model: ""` or no model field | `400 invalid_request_error` for missing `model`. |
| Streaming mid-flight broker failure | SSE stream terminates from the client's perspective; reservation is `refunded`. No retry, by design (see streaming-usage.md). |
| Client cancels mid-stream | `reply.raw.end()` from the loop; reservation is `committed` if usage parsed, else `committed` with null work units. |

## Implementation reference

| Layer | Path |
|---|---|
| Per-endpoint handlers | `gateway/src/proxy/{chat,embeddings,images,audio-speech,audio-transcriptions,rerank}.ts` |
| Capability mapping | `gateway/src/proxy/livepeer/capabilityMap.ts` |
| Wire drivers (req/resp, stream, multipart) | `gateway/src/proxy/livepeer/http-*.ts` |
| Bearer auth | `gateway/src/proxy/auth.ts` |
| Rate limit | `gateway/src/proxy/rateLimit.ts` |
| Reservation lifecycle | `gateway/src/proxy/reservation.ts` |
| Models catalog | `gateway/src/routes/models.ts` |
| Error shapes | `gateway/src/proxy/errors.ts` |
