# AGENTS.md

This is `livepeer-modules-openai` — an **OpenAI Service**: a drop-in
OpenAI-compatible inference gateway backed by the Livepeer network.

## Operating principles

This repo follows the agent-first harness pattern in
[`docs/references/openai-harness-engineer.md`](./docs/references/openai-harness-engineer.md).
Short version:

- **You steer; the agent executes.** Humans set intent; tools and feedback
  loops do the rest.
- **The repo is the system of record.** If it isn't checked in, it doesn't
  exist.
- **Progressive disclosure.** This file is a *map*, not a manual.
- **Enforce invariants, not implementations.** Constraints in lints/CI;
  choices in code.
- **Throughput over ceremony.** Short-lived PRs; fix-forward over block.

Read [`docs/design-docs/core-beliefs.md`](./docs/design-docs/core-beliefs.md)
before making load-bearing decisions.

## Where to look

| Question | File |
|---|---|
| What is this repo? | [`README.md`](./README.md) |
| Architectural overview at a glance | [`DESIGN.md`](./DESIGN.md) |
| Top-level architecture map | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| What invariants must any change uphold? | [`docs/design-docs/core-beliefs.md`](./docs/design-docs/core-beliefs.md) |
| What design docs exist? | [`docs/design-docs/index.md`](./docs/design-docs/index.md) |
| What product surface ships? | [`docs/product-specs/index.md`](./docs/product-specs/index.md) |
| What plans are active / done? | [`PLANS.md`](./PLANS.md) |
| What tech debt are we tracking? | [`docs/exec-plans/tech-debt-tracker.md`](./docs/exec-plans/tech-debt-tracker.md) |
| What product principles guide tradeoffs? | [`PRODUCT_SENSE.md`](./PRODUCT_SENSE.md) |
| What's the quality bar per layer? | [`QUALITY_SCORE.md`](./QUALITY_SCORE.md) |
| What reliability properties hold? | [`RELIABILITY.md`](./RELIABILITY.md) |
| What's the threat model + auth surface? | [`SECURITY.md`](./SECURITY.md) |
| What frontend DOM/CSS rules apply? | [`FRONTEND.md`](./FRONTEND.md) |
| How do I deploy this to production? | [`DEPLOYMENT.md`](./DEPLOYMENT.md) |
| Where is the API spec? | `GET /openapi.json` (live) or [`docs/product-specs/openai-surface.md`](./docs/product-specs/openai-surface.md) (prose). |
| Reference material (papers, transcripts) | [`docs/references/`](./docs/references/) |

## Repo shape

Top-level components — each has its own surface but no per-component
`AGENTS.md`; navigation flows from this map.

| Path | What it is |
|---|---|
| [`gateway/`](./gateway/) | TypeScript backend — single Fastify service: OpenAI `/v1/*` proxy, waitlist + auth + admin SaaS shell, gRPC clients to `service-registry-daemon` + `payment-daemon`. |
| [`web/site/`](./web/site/) | Zero-build Lit marketing site + waitlist signup. |
| [`web/portal/`](./web/portal/) | Zero-build Lit user dashboard (account, API keys, playground). |
| [`web/admin/`](./web/admin/) | Zero-build Lit admin (waitlist queue, users, usage, registry candidates). |
| [`proto/`](./proto/) | gRPC protos shared between the gateway and the registry / payer daemons. |

## Doing work in this repo

- **TypeScript strict.** `tsc --noEmit` is the lint gate for `gateway/`.
- **Drizzle ORM** for the gateway's Postgres schema. Single migration track
  under `gateway/migrations/`.
- **Zero-build SPAs.** `web/` apps use Lit + `esm.sh` importmaps + a per-app
  `dev-server.js`. No Vite, no bundler. See [`FRONTEND.md`](./FRONTEND.md)
  for the DOM/CSS invariants.
- **Gateway pays the network.** Even though customers pay nothing during
  beta, the gateway mints `Livepeer-Payment` envelopes via the
  `payment-daemon` for every `/v1/*` request. This is not optional.
- **Models come from the service registry.** No hardcoded model list, no
  rate cards. `/v1/models` reflects what the on-chain registry advertises.
- **No Stripe, no billing, no rate cards in v1.** Auth shape is
  waitlist → email verify → admin approval → API key by email.
- **Capability workers are external.** This repo talks to the Livepeer
  network's capability brokers and daemons; it does not carry local worker
  implementations.
- **Single root `Makefile`.** Local dev entrypoints live at the repo root.

## Plan-as-code

Non-trivial work lands as an exec plan under
[`docs/exec-plans/active/`](./docs/exec-plans/active/). Completed plans
move to [`docs/exec-plans/completed/`](./docs/exec-plans/completed/).
Lightweight changes go straight to PR.
