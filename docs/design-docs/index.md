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
| [`payment-flow.md`](./payment-flow.md) | 🟡 | How `Livepeer-Payment` envelopes are minted, gRPC UDS shape, boot/failure semantics. |
| [`route-selector.md`](./route-selector.md) | 🟡 | Candidate selection: `listKnown` → `resolveByAddress`, ranking, health cooldowns, snapshot caching. |
| [`streaming-usage.md`](./streaming-usage.md) | 🟡 | Stream-options injection, transcript accumulation while piping, last-frame-wins parser, settle-vs-refund decision tree. |
| [`boot-sequence.md`](./boot-sequence.md) | 🟡 | Order of operations from `index.ts` entry, failure modes per step, graceful shutdown contract. |

Most of v1 sits at 🟡 — the code is real and matches the docs, but
hasn't been exercised end-to-end against real Livepeer infrastructure
yet. The first real broker validation will promote them to 🟢.
