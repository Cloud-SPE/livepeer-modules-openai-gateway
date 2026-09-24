# September 24 upstream compatibility review

Reviewed local source checkouts: network-modules
`747a085d816479aa1f3e3491aced86dfd422e542` and open-clearinghouse
`fade802f988872cb8803666ead10c2b197d2fff0`. These are source review inputs,
not deployed image identities or production certification.

## Changes affecting this gateway

| Upstream change | Gateway impact and disposition |
|---|---|
| Modules `9ab3a00`, `e9f08e4`, `684b1a4`; LOC `eaf40cd`, `9150afc` | Selection uses verified cached state, honors failure cooldowns, and defaults to a 45-second deadline. LOC discovery consumes the new ListOfferings RPC, with completeness and freshness metadata. Job opens now have a separate 90-second timeout; ordinary calls retain 30 seconds. Only fresh COMPLETE catalogs remove absent models; PARTIAL/legacy catalogs upsert, and stale/expired/UNINITIALIZED catalogs leave persistence untouched. Admin responses expose metadata. |
| LOC `8bd3b81`, `81535e2`; Modules `08f5985` | LOC recognizes rejected admission and can release a hold after scoped, verified non-admission evidence. Existing gateway accounting recovery already accepts terminal zero-billed LOC status. New regressions prove that signed audit evidence remains separate from broker settlement and no workload retry or synthetic refund occurs. Live-session preparation recovery does not add a gateway endpoint. |
| LOC `fade802` | Readiness now checks receiver credit against maximum authorized debit. Existing retry handling preserves the same open idempotency key for retryable funding errors. Operators must size funding limits for maximum units. |
| Modules `747a085` | Session revision runway and winddown changes concern paid-session/v1, which this gateway does not expose. Shared broker/payment deployments must follow receiver-first rollout; no new gateway session or payment RPC implementation is required. |

Finishing the existing patch exposed two Postgres test errors: raw timestamp
handling and a nonexistent settlement column. Tests now compare timestamp
instants and inspect the actual settlement envelope plus retained non-admission
evidence. Recovery grace also now includes the exact exponential retry schedule;
the previous per-attempt approximation could let recovery overlap foreground
opens when operators configured many attempts.

## Validation

Workspace lint, build, and tests were run locally. The full suite ran against a
new isolated Postgres 16 database, including migrations and all persistence tests.
Results: **149 passed, 0 failed, 0 skipped**. Test database containers are disposable;
no production database or service was changed. No signed live inference,
production deployment, image publishing, or pinned-image conformance was run.

## Beads and remaining work

- `lmoa-3bv.40`: this gateway compatibility patch and validation (plan 0008).
- Modules `lnm-j950`, `lnm-9tw9`, and `lnm-ir9z` are closed upstream;
  LOC `loc-dqw` and `loc-a4t` are also closed.
- LOC `loc-8v4` remains open: receiver credit observations are not atomic
  reservations across competing authorizations. Preserve non-admission recovery;
  do not treat the readiness check as guaranteed admission.
- `lmoa-3bv.38`: production transcription still needs truthful estimator
  advertisement and signed multipart validation; this source review cannot close it.
- `lmoa-3bv.39`: discovery/admission fixes are relevant to embeddings, but a fresh
  production embedding with signed settlement is still needed to establish recovery.
- `lmoa-3bv.6`, `.29`, `.18`, `.20`, and `.21` remain open for immutable release
  artifacts, endpoint coverage, signed conformance, final release documentation,
  and coordinated cutover. Historical September 22 success is not validation of
  these newer upstream revisions. Plan 0007 remains active.
