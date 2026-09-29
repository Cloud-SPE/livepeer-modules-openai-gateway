# Shared-wallet gateway compatibility — 2026-09-26

## Scope

Gateway compatibility follow-up to Modules shared-wallet merge `09e68c9` and LOC
merge `7c93bc6`. Inspected source HEADs were Modules
`f39740c6d3a06accad55d0915c3e09b26aa81dc3` and LOC
`fe55795add9505ecd74082026d019890f182b95b`. Both upstream working trees acquired
concurrent changes during this work. They were not edited by this task, and their
uncommitted state is not represented as a released artifact. Fixture provenance
includes hashes of the exact contract source files used.

## Gateway behavior and verification

- LOC job requests/responses retain their existing gateway-facing shape. The
  gateway forwards the opaque v3 authorization unchanged and signs its exact
  bytes with invocation-proof/v1. A proof for account A fails recovery against
  the independently signed authorization for account B.
- Account-bearing signed envelopes survive decoding, Postgres storage, and LOC
  submission without dropping or rewriting account metadata.
- LOC's HTTP 409 `settlement_verification_failed` response for an account mismatch
  is a permanent settlement failure retained for review, not a successful replay,
  refund, or trigger for another paid invocation.
- Rejected admission remains deferred until evidence arrives. Signed
  non-admission stays audit evidence; zero-billed closure requires LOC's status.
- LOC remains the signature/account authority. Local account-column validation
  was not added: its job response exposes no independent trusted account field.
  No gateway schema, wallet configuration, or public endpoint changes were needed.

The checked-in generator ran LOC's real verifier: it accepted signed settlement
and non-admission fixtures and rejected each against the other account with
`wholesale_account_mismatch`. Gateway HTTP tests use mocks and offline historical
vectors. They do not run actual payer minting, broker admission, or network work.

Gateway validation: **154 tests passed, 0 failed, 0 skipped**, including all four
Postgres tests against a new disposable Postgres 16 database. Workspace lint and
build pass. The smoke script now accepts
`LOC_SMOKE_EXPECTED_WHOLESALE_ACCOUNT_ID`; its assertion runs after settling the
paid job. The live smoke itself was not run during this task.

## Artifact evidence

[Machine-readable local image inventory](2026-09-26-shared-wallet-images.json)
records image IDs, repository digests, architecture, and available revision data.
These are inspected local artifacts, not a certified compatible deployment set.

| Component | Repository digest | Source evidence |
|---|---|---|
| Payer / receiver | `tztcloud/livepeer-payment-daemon@sha256:c1d88fdbbb8e3123c7e68a8128a2af2b4742a98ec3e7d34d29b5bb842a77129f` | Binary `--version`: `v2.1.0-b15ff35c2fae` |
| Broker | `tztcloud/livepeer-capability-broker@sha256:6f4b7753e157be21038ba316eab37f8c72df6ff387bb5f6b3b4deb68d917b0da` | Binary `--version`: `v2.1.0-b15ff35c2fae` |
| Registry | `tztcloud/livepeer-service-registry-daemon@sha256:961cac159884b1c8100125ba51a8eb5b4c77bd6cf150733a68c8c19d32af3443` | No revision label; `--version` unsupported; revision unverified |
| LOC | `tztcloud/livepeer-open-clearinghouse-gateway@sha256:e50023169b5e6408bae00afa3995e262d7c168078b64ebd832d4ace7052c4692` | OCI revision `fe55795add9505ecd74082026d019890f182b95b` |
| Conformance | `tztcloud/livepeer-conformance@sha256:7147029220987414b16dfdaf17906d3d9665f24122671ee13fd14bed271ec44d` | No revision label; no OpenAI endpoint coverage claim |

Modules `f39740c` adds sender-database binding for uncertain mint recovery beyond
these payer/broker images. LOC working-tree changes consume that contract and add
migration `0030`; those uncommitted changes are not in the inspected LOC image.
Select and reverify matching released artifacts before deploying that additional
recovery behavior. No new gateway image was built or published in this task.

## Remaining release gates

Bead `lmoa-3bv.41` covers this local compatibility patch. Plan 0007 and beads
`.6`, `.18`, `.29`, `.20`, and `.21` remain open: complete immutable provenance
(including the gateway and endpoint runner), signed real-process/pinned-image
unary/SSE/multipart conformance, final release-set documentation, and coordinated
cutover. `.38` transcription and `.39` embeddings still need production evidence.
No LOC/broker containers were running in the inspected local Docker inventory.
No production traffic, migration, deployment, or funding-policy change was performed.

Run the paid smoke with the expected LOC account and selected real offering, then
the endpoint conformance matrix with immutable artifacts. Exercise cross-account
rejection and recovery on an isolated upstream test stack; do not inject altered
financial evidence into production. Follow the
[deployment cutover procedure](../../DEPLOYMENT.md#shared-wallet-cutover-september-26-2026).
