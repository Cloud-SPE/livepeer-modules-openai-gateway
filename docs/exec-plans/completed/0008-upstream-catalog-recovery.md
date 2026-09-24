# Upstream catalog and recovery compatibility

Adapt the gateway to the September 24 LOC and network-modules contracts.

## Context and scope

LOC now exposes cached catalog completeness/freshness, allows 45 seconds for
selection, and closes verified rejected admissions with zero billed usage.
Update gateway timeouts, catalog refresh/admin diagnostics, regression tests,
and deployment guidance. No protocol, billing, schema, or frontend changes.

## Approach and decisions (2026-09-24)

- Separate job-open timeout (90 seconds) from ordinary LOC calls (30 seconds).
  Recovery grace must cover the configured foreground open retry budget.
- Carry catalog metadata with candidates. Fresh COMPLETE snapshots replace;
  fresh PARTIAL snapshots upsert without removing absent models. Stale,
  expired, and UNINITIALIZED snapshots do not update the persisted cache.
  Legacy responses without metadata may upsert, but cannot prove absence.
- Keep upstream snapshot timestamps instead of relabeling cached data as new.
- Expose metadata in existing admin diagnostics. LOC remains the authority for
  paid routing; catalog data never authorizes execution or refunds.
- Verify closed zero-unit LOC recovery without synthesizing broker settlement.
- Document coordinated registry/LOC rollout and maximum-debit funding limits.

## Acceptance

TypeScript lint and tests pass, including timeout selection, catalog parsing,
refresh policy, and zero-billed recovery. Document any unavailable integration
checks. Move this plan to completed after validation.

## Outcome (2026-09-24)

Completed as bead `lmoa-3bv.40`. Workspace lint and build pass; all 149 tests
pass with an isolated Postgres 16 database (zero skipped). Fixed the unfinished
persistence tests and included exact foreground retry backoff in recovery grace.
See [the upstream review](../../references/2026-09-24-upstream-compatibility.md)
for reviewed revisions and remaining production gates. No deployment or live
signed conformance is claimed; plan 0007 remains active.
