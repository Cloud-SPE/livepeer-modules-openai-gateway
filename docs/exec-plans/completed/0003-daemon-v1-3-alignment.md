# 0003 — Daemon v1.3.0 alignment

> Historical record. Some compatibility and fallback notes below describe migration-time behavior that was later removed; prefer the current live design docs for present runtime behavior.

**Status**: completed
**Opened**: 2026-05-19
**Driver**: Codex

## One-liner

Align the gateway with the `service-registry-daemon` and
`payment-daemon` `v1.3.0` contracts so `/v1/*` routing and payment
minting remain correct against the current Livepeer network stack.

## Context

`livepeer-network-modules v1.3.0` changed two gateway-facing contracts:

1. **Resolver selection is now first-class.**
   The stable resolver surface includes `Select` / `SelectMany` and
   returns payment-bound quote metadata: `quote_id`, `quote_version`,
   `constraint_fingerprint`, `route_fingerprint`, `units_per_price`.
2. **Payer minting is now quote/funding based.**
   `PayerDaemon.CreatePayment(...)` no longer accepts the old
   `(face_value, recipient, capability, offering, ticket_params_base_url)`
   request. It now requires:
   `recipient + ticket_params_base_url + accepted_price + funding`.

This repo still used the pre-`v1.3.0` shapes:

- vendored proto files under `proto/livepeer/**` were stale
- `routeSelector.select()` rebuilt candidates from `ListKnown` +
  `ResolveByAddress` instead of calling `SelectMany`
- `buildPayment()` minted a fixed 1000-wei face value with no
  accepted quote identity or funding intent

With the new daemon binaries that is not a soft drift; it is a wire
contract mismatch.

## Scope — in

| Area | Change |
|---|---|
| Vendored contracts | Sync resolver + payer proto files from `livepeer-network-modules v1.3.0` |
| Resolver path | Move hot-path selection to `Resolver.SelectMany` |
| Payment path | Build `accepted_price` + `funding` requests for `PayerDaemon.CreatePayment` |
| Request budgeting | Thread conservative estimated-unit inputs from each `/v1/*` route into dispatch |
| Regression coverage | Add tests for exact capability preservation and new payer request shape |

## Scope — out

- Full final-usage settlement / top-up lifecycle for long-lived session
  workloads.
- Any runner-side or broker-side changes; this plan only updates this
  repo as a daemon consumer.
- Replacing the models-cache refresh path with resolver-native catalog
  APIs. `inspect()` may keep its snapshot-building path for now.

## Approach

### Phase 1 — contract sync

- Copy these files from `livepeer-network-modules v1.3.0`:
  - `proto-contracts/livepeer/registry/v1/resolver.proto`
  - `livepeer-network-protocol/proto/livepeer/payments/v1/payer_daemon.proto`
  - `livepeer-network-protocol/proto/livepeer/payments/v1/types.proto`
- Update the gateway TypeScript client types to those wire contracts.

### Phase 2 — resolver hot path

- Keep `inspect()` on the current snapshot path for `/v1/models` and
  admin visibility.
- Change `select()` to call `SelectMany(capability, offering)` and
  convert returned routes into gateway `RouteCandidate`s.
- Preserve resolver capability IDs exactly. Do not normalize
  slash-form and colon-form IDs in the resolver-selected path.

### Phase 3 — payer path

- Extend `RouteCandidate` with:
  `unitsPerPrice`, `quoteId`, `quoteVersion`,
  `constraintFingerprint`, `routeFingerprint`.
- Build `accepted_price` from the selected route:
  `price_per_unit_wei`, `units_per_price`, `work_unit_name`,
  `capability`, `offering`, `quote_ref`.
- Build `funding` from request-estimated units and the accepted quote.
  Initial posture: `top_up_allowed=false`, `max_total_units=estimated_units`.

### Phase 4 — request estimates

Use conservative estimates on the gateway side so the payer can mint a
valid initial payment batch:

- chat: prompt heuristic + completion budget heuristic
- embeddings: text-token heuristic
- images: `n`
- audio speech: input character count
- audio transcription: `1`
- rerank: `1`

These are not billing numbers; they are the gateway’s initial funding
budget inputs.

## Acceptance

1. `pnpm -F @livepeer-modules-openai/gateway lint` clean.
2. `pnpm -F @livepeer-modules-openai/gateway test` passes.
3. Vendored resolver proto exposes `SelectMany` and quote metadata.
4. Gateway `select()` uses `SelectMany` rather than rebuilding hot-path
   candidates from `ListKnown` + `ResolveByAddress`.
5. Gateway `buildPayment()` sends `accepted_price` and `funding`, not
   the old fixed-face-value request.
6. Route-level dispatch supplies estimated units for every current
   `/v1/*` proxy route.
7. This file moves to `docs/exec-plans/completed/`.

## Decision log

- **2026-05-19 — Keep `inspect()` on the old snapshot path for now.**
  The outage risk is in live request dispatch and payment minting, not
  in admin/model inspection. Decoupling those lets us land the
  compatibility fix without bundling a larger catalog refactor.
- **2026-05-19 — Conservative estimates first.**
  The payer now needs a funding budget before dispatch. Exact budgeting
  is a separate concern from wire compatibility; heuristics are enough
  to restore functional correctness.
- **2026-05-19 — Exact capability IDs win over alias normalization.**
  Resolver discovery metadata is now an opaque contract. The gateway may
  still choose its own endpoint-family constants, but once a capability
  comes from resolver discovery/selection we treat it as exact.

## Outcome — 2026-05-19

All 7 acceptance criteria met:

1. ✅ `pnpm -F @livepeer-modules-openai/gateway lint` clean.
2. ✅ `pnpm -F @livepeer-modules-openai/gateway test` passes.
3. ✅ Vendored resolver proto now exposes `SelectMany` plus quote
   metadata, and vendored payer proto now expects
   `accepted_price + funding`.
4. ✅ Gateway `select()` uses `SelectMany` on the hot path, with a
   compatibility fallback across canonical and legacy capability keys.
5. ✅ Gateway `buildPayment()` sends `accepted_price` and `funding`
   rather than the old fixed-face-value request.
6. ✅ Every current `/v1/*` proxy route supplies estimated units into
   dispatch and payment minting.
7. ✅ This file moves to `docs/exec-plans/completed/`.

Additional work landed during implementation because it was directly
coupled to the daemon-alignment correctness boundary:

- `usage_reservations` now captures selected route + quote metadata
  (`selected_capability`, `selected_offering`, `selected_work_unit`,
  `units_per_price`, `quote_id`, `quote_version`,
  `constraint_fingerprint_hex`, `route_fingerprint_hex`) so committed
  and refunded requests retain the exact route context the gateway
  accepted.
- The `models` cache now stores quote-aware inspection metadata
  (`units_per_price`, `quote_id`, `quote_version`,
  `constraint_fingerprint_hex`, `route_fingerprint_hex`) so admin
  registry views and `/v1/models` diagnostics reflect the richer
  resolver-selected route shape.

Files touched (high-signal set):

- **Vendored contracts**:
  `proto/livepeer/registry/v1/resolver.proto`,
  `proto/livepeer/payments/v1/{payer_daemon,types}.proto`
- **Gateway hot path**:
  `gateway/src/proxy/service/{routeSelector,routeDispatch}.ts`,
  `gateway/src/proxy/livepeer/payment.ts`,
  `gateway/src/proxy/{chat,embeddings,images,audio-speech,audio-transcriptions,rerank}.ts`
- **Persistence / inspection**:
  `gateway/src/proxy/reservation.ts`,
  `gateway/src/{schema,repo}/usageReservations.ts`,
  `gateway/src/{schema,repo}/models.ts`,
  `gateway/src/registry/refresh.ts`,
  `gateway/src/routes/{portal/usage,admin/registry}.ts`
- **Migrations**:
  `gateway/migrations/0002_usage_reservation_route_metadata.sql`,
  `gateway/migrations/0003_models_quote_metadata.sql`
- **Tests**:
  `gateway/test/{payment,route-selector,capability-map,registry-refresh}.test.ts`
- **Docs**:
  `docs/design-docs/{payment-flow,route-selector}.md`,
  `docs/product-specs/{openai-surface,portal-account,admin-waitlist}.md`
