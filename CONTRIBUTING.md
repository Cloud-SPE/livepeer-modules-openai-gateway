# Contributing

Thanks for thinking about contributing. This repo follows an
**agent-first harness pattern** ([reference](./docs/references/openai-harness-engineer.md)) —
the conventions matter more than the code style.

If you have not yet, read these three files first:

1. [`AGENTS.md`](./AGENTS.md) — the map.
2. [`docs/design-docs/core-beliefs.md`](./docs/design-docs/core-beliefs.md) — invariants.
3. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the system shape + data flows.

Together they're under 600 lines. Read them.

---

## Dev environment

```bash
# Workspace deps
pnpm install

# Bring up gateway + postgres
make dev

# Run the three SPAs (each in its own terminal)
( cd web/site   && node dev-server.js )   # :3000
( cd web/portal && node dev-server.js )   # :3001
( cd web/admin  && node dev-server.js )   # :3002

# Verify end-to-end
make smoke
```

You don't need a Resend account for local dev. When `RESEND_API_KEY` is
unset, verification + API-key emails are logged to stdout instead of
sent.

For a fully working `/v1/*` stack, you do need valid Livepeer daemon
configuration: chain RPC, registry address, and a keystore. This repo is
on-chain only; there is no local fallback broker mode.

---

## How work lands

Two paths, depending on size:

### Small changes — go straight to a PR

Bug fixes, doc tweaks, single-file refactors, anything <50 lines.
Open a PR, link the issue (if any), get it reviewed (agent or human),
merge.

### Non-trivial changes — write an exec plan first

Open the plan as a markdown file at `docs/exec-plans/active/NNNN-slug.md`,
following the template in [`PLANS.md`](./PLANS.md):

1. **One-liner.** One sentence: what does this plan accomplish?
2. **Context.** Why now? What's the trigger?
3. **Scope.** In + out, explicitly.
4. **Approach.** Phases, files touched, decisions to lock.
5. **Acceptance.** How do we know it's done?
6. **Decision log.** Each non-obvious choice + why, dated.

Land the plan first (small PR, mostly markdown), then implement
against it. When done, append a `## Outcome` section and
`git mv` it to `docs/exec-plans/completed/`.

"Non-trivial" includes: new HTTP endpoints, schema changes, cross-
component refactors, anything that introduces a new dependency,
anything you're not sure how to scope. When in doubt, write the
plan — it's cheap.

---

## What good code looks like here

- **Boring technology.** Postgres. Fastify. Drizzle. Lit. esm.sh. If
  you're reaching for an exotic dependency, write a plan and justify
  the choice.
- **Strict TypeScript.** `tsc --noEmit` is the lint gate. No `any`
  outside narrow, justified boundaries.
- **Light DOM.** See [`FRONTEND.md`](./FRONTEND.md): no shadow DOM,
  no inline styles, no bundler. CSS lives in checked-in `.css` files.
- **Validate at the boundary.** zod schemas at every HTTP entry
  point + every env-var read.
- **Tests at the load-bearing seams.** `gateway/test/` covers pure
  helpers (`crypto.ts`, the chat streaming-usage parser, the registry
  refresh row-mapping). Adding code in those areas? Extend the tests.
- **No comments that just restate the code.** Comments earn their
  keep by explaining *why* something is non-obvious — a constraint,
  a workaround, a future-bite.

---

## Things to leave alone

- **`gateway/src/proxy/livepeer/`** and **`gateway/src/proxy/service/`**.
  These are verbatim copies of load-bearing wire mechanics from the
  upstream `livepeer-network-modules/openai-gateway` repo. They're
  copied not because they're frozen, but because divergence is
  expensive — every change makes future syncs harder. If you need to
  change them, write an exec plan first and explain why.
- **The Livepeer wire spec.** Owned by `livepeer-network-protocol`
  upstream, not here.

---

## Commit style

- Subject line: imperative, ≤72 chars. Examples:
  - `fix: refund usage_reservation on streaming-mid-flight error`
  - `gateway: add /admin/users CSV export`
  - `docs: tighten core-beliefs §3 wording`
- Body wraps at ~72 chars, focuses on *why* not *what*. The diff
  shows what.
- Link issues / plan files as relative paths from repo root.
- We do **not** use Co-Authored-By trailers in this repo.

---

## Reporting bugs

Open an issue with:

1. What you expected
2. What happened
3. How to reproduce (curl commands or repro repo welcome)
4. Gateway version (`git rev-parse --short HEAD`) + relevant env
   (Node version, Docker version, OS)

If it's a security issue, please don't file a public issue — email
the maintainer directly. See [`SECURITY.md`](./SECURITY.md) for the
threat model.

---

## Code of conduct

Be kind. Disagreements about technical direction are welcome.
Personal attacks aren't. If something feels off, raise it — privately
to a maintainer if that's easier.
