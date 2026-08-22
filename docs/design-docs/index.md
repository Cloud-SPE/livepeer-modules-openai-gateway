# Design docs

Cross-cutting design that binds more than one component lives here.
Component-local design lives under each component's own directory
(none yet).

## Status

- 🟢 **Adopted** — implemented and load-bearing.
- 🟡 **Drafted** — written down; not yet exercised against production.
- 🔴 **Proposed** — under discussion; do not build against.

## Index

| Doc | Status | Summary |
|---|---|---|
| [`core-beliefs.md`](./core-beliefs.md) | 🟢 | Invariants any change must uphold. Read before making load-bearing decisions. |
| [`payment-flow.md`](./payment-flow.md) | 🟡 | Signed paid-job lifecycle: idempotent open → dispatch → evidence lookup → durable LOC settlement. |
| [`route-selector.md`](./route-selector.md) | 🟡 | LOC-owned selection, transport/work-unit validation, and identical open retries. |
| [`streaming-usage.md`](./streaming-usage.md) | 🟡 | Non-buffering SSE delivery with transport-independent signed accounting. |
| [`paid-job-v1.md`](./paid-job-v1.md) | 🟡 | Binding Modules 2.0 migration contract: transport negotiation, layered idempotency, signed settlement authority, replay, and distinct usage signals. |
| [`boot-sequence.md`](./boot-sequence.md) | 🟡 | Order of operations from `index.ts` entry (config → migrations → LOC probe → catalog → server → refresh + settler), failure modes, shutdown. |

Most of v1 sits at 🟡 — the code is real and matches the docs, but
hasn't been exercised end-to-end against real Livepeer infrastructure
yet. The first real broker validation will promote them to 🟢.
