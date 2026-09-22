# Streaming paid jobs

Streaming chat uses the same `paid-job/v1` lifecycle as unary work, with
`Accept: text/event-stream` selecting the transport.

## Data path

The gateway forwards the caller's JSON without inserting usage options. Once
the broker admits the job, SSE bytes are written to the client immediately.
The gateway does not buffer the transcript and does not parse usage frames.

```text
broker SSE stream -> gateway for-await loop -> client socket
                                      |
                                      +-> no accounting parser
```

The response path and accounting path are deliberately independent. When the
stream terminates, the durable settlement lookup retrieves signed evidence
from `GET /v1/settlement/{jobId}`. If the broker job ID was not observed, it
uses `GET /v1/exchange/{request_id}`.

## Failure semantics

- A pre-admission refusal is returned as a typed OpenAI-shaped error.
- A stream error or client disconnect never triggers a second paid job.
- An idempotent replay can recover accounting but cannot reproduce lost SSE
  bytes; the client receives `upstream_response_lost` where an HTTP response is
  still possible.
- `ACCOUNTING_PENDING` is polled until signed terminal evidence or an explicit
  terminal failure is available.
- Settlement retries are asynchronous and cannot delay already-delivered SSE
  chunks.

## Invariants

- No request-body mutation.
- No transcript accumulation.
- No response-body usage scraping.
- No transport-specific billing authority.
- The broker-signed settlement is authoritative on every transport.

Relevant code: `gateway/src/proxy/chat.ts`,
`gateway/src/proxy/livepeer/http-stream.ts`,
`gateway/src/loc/settlementLookup.ts`, and `gateway/src/loc/settler.ts`.
