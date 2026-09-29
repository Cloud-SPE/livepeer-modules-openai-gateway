# Shared-wallet gateway compatibility

Validate the gateway boundary against shared-wallet authorizations and document
the coordinated upstream cutover, without moving wallet ownership into the gateway.

## Scope and approach

- Record current Modules and LOC revisions and available immutable image identities.
- Add reproducible signed v3 authorization and account-bearing settlement/audit
  fixtures using upstream implementations, with provenance. Gateway tests must
  preserve exact authority bytes, caller proof, and signed account metadata.
- Cover LOC account-mismatch rejection and rejected-admission recovery without
  treating audit evidence as a refund or re-executing customer work.
- Update deployment guidance for LOC account configuration, migration 0029,
  legacy drain, and persistent independent payer streams.
- Retain LOC as the account/signature verifier. Its job response does not expose
  a separate trusted account field; gateway account-column/schema changes are
  outside this compatibility patch.

## Acceptance

Lint/build and gateway tests pass, including Postgres persistence. Record actual
upstream fixture verification and artifact evidence. Distinguish local contract
checks from signed live/pinned-image conformance; leave unexecuted release gates
open in plan 0007 and beads. No production deployment or funding-policy changes.

## Decisions

- 2026-09-26: authorization remains opaque; invocation-proof/v1 signs its exact
  bytes and does not require a gateway authorization-v3 protobuf implementation.
- Fixtures are checked in; ordinary tests require no sibling checkout, chain,
  wallet credentials, or upstream runtime.

## Outcome — 2026-09-26

Completed local compatibility scope as `lmoa-3bv.41`. All 154 gateway tests pass
with isolated Postgres 16 (zero skipped); workspace lint/build pass. LOC's actual
verifier accepted signed account-bearing fixtures and rejected cross-account
settlement/non-admission. The smoke tool can assert the expected account after
settlement. Deployment guidance and inspected immutable image identities are
recorded in the [evidence report](../../references/2026-09-26-shared-wallet-compatibility.md).

No production calls, upstream migrations, or image publication were performed.
Real-process/pinned-image conformance and complete artifact provenance remain
open in plan 0007; concurrent newer upstream changes are not certified by this
patch. No optional gateway account schema change was necessary.
