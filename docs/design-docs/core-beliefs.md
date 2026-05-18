# Core beliefs

Invariants any change must uphold. If you're about to violate one of
these, open an exec plan first.

## 1. The repo is the system of record

If a fact isn't checked in (as code, markdown, schema, or executable plan),
it doesn't exist. Slack threads, Google Docs, and chat history are
invisible to agents and invisible to future-you.

## 2. Progressive disclosure beats one big manual

`AGENTS.md` is the table of contents. The encyclopedia lives in `docs/`.
Don't grow `AGENTS.md` past ~100 lines.

## 3. Enforce invariants, not implementations

Constraints belong in lints / CI / structural tests. Implementation
choices belong in code. Don't write "always use X library" — write a
lint that catches the alternative.

## 4. Boundaries — one-way, injection-mediated

The gateway → proxy → wire layers have a one-way dependency: routes
import from proxy, proxy imports from livepeer/service, none of those
import from routes. Cross-cutting concerns (config, db pool, email
client, route selector, rate limiter) flow through `ServerDeps`,
constructed in `index.ts` and threaded via `app.decorate('deps', …)`
in `server.ts`.

Today this is enforced by **reviewer attention + `tsc`**, not by an
import-graph linter. An eslint-boundaries rule is on the tech-debt
tracker. Until that lands: don't introduce upward imports without a
plan.

## 5. Compatibility is the feature

If an OpenAI SDK call works against `api.openai.com` and fails against
us, that's a bug. We don't "improve" the OpenAI API shape.

## 6. The gateway pays the network

Even with no customer billing, every `/v1/*` request mints a
`Livepeer-Payment` envelope via `payment-daemon`. The network charges us;
we don't charge users yet. Removing payment is removing the product.

## 7. Models reflect reality

`/v1/models` is whatever the on-chain registry advertises right now. No
hardcoded list. No curated catalog. If a model disappears from the
registry, it disappears from the API within one refresh cycle.

## 8. Zero-build frontend, light DOM only

`web/` SPAs use Lit + esm.sh importmaps. No bundlers, no shadow DOM, no
inline styles. See [`../../FRONTEND.md`](../../FRONTEND.md).

## 9. Drizzle, one DB, one migration track

The gateway uses Drizzle ORM against a single Postgres. Migrations live
under `gateway/migrations/` and run in order at boot. No multi-tenant
schema split, no per-component migration directories.

## 10. Streaming is non-buffering

`/v1/chat/completions` with `stream: true` pipes SSE chunks to the
client as they arrive from the broker. Don't accumulate-then-flush.

## 11. Plans before non-trivial changes

A 50-line bug fix doesn't need a plan. A new endpoint, a schema change,
or a refactor that crosses two domains does. Plans go under
`docs/exec-plans/active/`.

## 12. Short-lived PRs over blocking review

We fix forward. A test flake doesn't block a merge; a follow-up PR fixes
it. The cost of waiting on agent throughput is higher than the cost of a
quick correction.

## 13. Delete > flag

When a feature doesn't fit v1, remove it cleanly. We don't carry feature
flags or "TODO when we get to it" placeholders. Add it back when we get
to v2.

## 14. Boring technology

Postgres. Fastify. Drizzle. Lit. esm.sh. Standard tools well-represented
in the agent training set. Exotic dependencies are forbidden unless an
exec plan justifies them.

## 15. Capability execution is external

Capability worker implementations live outside this repository. The
gateway should never `import` workload-serving code; the only contract
between the gateway and execution side is the Livepeer capability
surface exposed through brokers and the network daemons.
