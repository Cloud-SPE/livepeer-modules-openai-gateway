# Streaming usage settlement

How `POST /v1/chat/completions` with `stream: true` settles its
usage record without buffering the response.

## The constraint

Two requirements compete:

1. **Non-buffering.** SSE chunks must reach the client as they arrive
   from the broker. Time-to-first-byte is the user-visible latency
   metric.
2. **Settle usage.** The reservation row in `usage_reservations`
   needs `committed_work_units` set on success. The total token
   count comes from the streaming response itself — only the broker
   knows it.

The fix is **pipe + accumulate**: write each chunk to the client
*and* push a copy into an in-memory buffer. After the stream
terminates, parse the buffer for the trailing usage frame and update
the reservation.

## Forcing the usage frame

OpenAI-compatible upstreams only emit the trailing
`data: {…"usage":{…}}` frame when the caller requested it via
`stream_options.include_usage = true`. Many real clients don't pass
it. The gateway forces it on:

```ts
function withForcedUsageChunk(body: ChatCompletionsBody): ChatCompletionsBody {
  return {
    ...body,
    stream: true,
    stream_options: { ...(body.stream_options ?? {}), include_usage: true },
  };
}
```

This mutation happens **before** serialization to the broker. The
client never sees it — the request they sent and the body the
gateway sent are different by exactly this one field.

## The pipe

`proxy/chat.ts → runStreaming()`:

```text
broker stream → for-await loop:
  ┌──> reply.raw.write(chunk)   ◄── client sees bytes immediately
  └──> transcript.push(chunk)   ◄── kept for parsing
```

`reply.hijack()` is called once before the loop — this tells Fastify
to step out of the response lifecycle so we write directly to the
underlying Node `ServerResponse`. Without hijack, Fastify would try
to serialize / chunk-encode our writes a second time.

## Parsing the trailing frame

`parseStreamingUsage(transcript)`:

```ts
for (const block of transcript.split(/\n\n+/)) {
  for (const line of block.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      if (typeof obj?.usage?.total_tokens === 'number') {
        total = obj.usage.total_tokens;  // last wins
      }
    } catch { /* malformed, ignore */ }
  }
}
return total;  // null if no usage frame
```

The parser is robust to:

- `[DONE]` sentinels
- Malformed `data: …` lines (ignored)
- Multiple usage frames (last wins — OpenAI sometimes emits
  per-chunk + final aggregate)
- CRLF and double-blank-line separators

## Three settlement outcomes

After the loop terminates and `handle.done()` resolves:

| Outcome | Trigger | Reservation state |
|---|---|---|
| **Clean usage** | Stream completed, parser returned a number | `committed`, `committed_work_units = total` |
| **Stream completed, no usage frame** | Either client disconnected early, or broker malformed the stream, or upstream forgot `include_usage` despite our injection | `committed`, `committed_work_units = null` (best-effort: we know the stream ran but not the cost) |
| **Stream errored mid-flight** | Network failure, broker timeout, parse exception in the loop | `refunded` |

The distinction between "completed but no usage" and "errored" is
load-bearing: a partial response that the client successfully
received was a successful upstream call — it just lacked
self-reported usage.

## What we DO NOT do

- **No retry on mid-stream failure.** Once the first byte is in flight,
  switching brokers would corrupt the client's transcript.
- **No buffering the full response before sending.** Latency is the
  reason this matters.
- **No per-chunk usage extraction.** We accumulate and parse once at
  the end. Per-chunk parsing would burn CPU on every event for a
  value only the last frame carries.
- **No fallback estimation** of work units when usage is missing.
  Pre-billing v1 doesn't need a number, and inventing one would
  pollute the reservation log with synthetic data.

## Where it lives

| Concern | File |
|---|---|
| Route + stream handling | `gateway/src/proxy/chat.ts` |
| HTTP streaming wire driver | `gateway/src/proxy/livepeer/http-stream.ts` |
| Reservation lifecycle | `gateway/src/proxy/reservation.ts` |
| Unit tests | `gateway/test/chat-helpers.test.ts` |
