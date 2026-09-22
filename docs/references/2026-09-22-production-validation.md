# Protocol-4 production interoperability — 2026-09-22

This is local gateway validation against `https://loc.cloudspe.com`, not an
immutable multi-service release certificate. Reviewed source: gateway baseline
`bc231d2` plus this working tree, Modules `08f5985`, LOC `6a6392a`.
Production health reports `2.0.0`; the operator supplied the production Compose
service definitions. Their image references use unresolved tag variables.
Running upstream image digests and broker deployment provenance remain unknown.

## Implemented and checked

Migration 0010, exact workload commitments, ephemeral caller proofs, wholesale
authorization transport, route/domain persistence, idempotent accounting-only
open recovery, broker evidence recovery, independent LOC accounting polling,
and catalog denominators are implemented. No caller private key or workload
body is persisted. Portal/admin expose accounting observations without grants.

Strict TypeScript lint and build pass. The default suite reports 140 passes,
zero failures and one optional Postgres test skipped. That Postgres integration
test separately passed against a disposable database: migrations, historical
rows, durable intent recovery, identity/domain drift and NO_RECORD recovery.

## Observed production results

| Surface | Result |
| --- | --- |
| Chat unary | HTTP 200; signed usage and closed LOC accounting persisted |
| Chat SSE | Incremental chunks and `[DONE]`; signed usage and closed accounting |
| Tight chat ceiling | `max_completion_tokens: 8`: HTTP 200, 2 completion tokens |
| Speech | HTTP 200, valid 67,244-byte WAV; signed 6 input_chars settled |
| Transcription | Fails closed: catalog has `audio_seconds` but no estimator contract |
| Embeddings | Two offerings return no_route; another fails broker admission |
| Images/rerank | No production catalog offerings available for validation |

The public conformance harness passed with `LIVE_CONFORMANCE_TRANSPORTS=unary,stream`:
51 tokens / 680000000 wei and 233 tokens / 3106666667 wei, with zero pending
settlements for those cases. The harness explicitly labels this partial coverage;
its default full unary/stream/multipart release gate has not passed.

Useful upstream correlation identities (no credentials):

- Unary: LOC `074920f0-e144-46b9-8aea-55dcb44f1a44`, broker
  `job_d75e86e8-b911-48ab-9ce2-f7b8cb943369`.
- SSE: LOC `65594b68-cb81-43b1-b98e-caa6ee29a2ce`, broker
  `job_f81c8c02-08c9-4c99-a104-b0649b8f3fd9`.
- Speech: LOC `28886591-beba-410b-ab8c-92b8de8fdaab`, broker
  `job_8674d1d3-0988-4d52-99b0-1fe4b39c9f07`.
- Embeddings failure: LOC `31f2c507-0138-458c-8b0f-eb4db967c4bd`, request
  `83ec11bc-7df7-4967-8f2d-86f908152ddf`. Broker reported
  `sessionstore: a non-admission record was already issued for this request`.
  Subsequent lookup was NOT_ADMITTED; LOC reported open/non_admission_audit.
  The root cause requires upstream investigation; it is not proven by this run.

Some initial chat/speech attempts returned transient no_route. Successful later
manual validation does not establish continuous production availability.

## Remaining release gates

Beads .38 and .39 track upstream estimator/admission blockers. Beads .6, .29,
.18 and .21 retain artifact pins, full endpoint coverage, full conformance and
coordinated release cutover. A version string alone does not prove which source
or container content served a request. No upstream service, funding policy or
account setting was changed, and no release image was published.

The development gateway runs at `http://127.0.0.1:4001` in Docker with local
Postgres and the existing production LOC credential. Its local validation API
key is in ignored `.dev/prod-loc/credentials.json` (mode 0600). Do not commit
that file. These are development credentials and a development image.

Final local development image: `sha256:49dd719fa2afd872150c95cac4423edc8e84f192f33215b8dfbcc623aa36243a`.
The image metadata/content check passed (version 2.0.0, baseline revision
bc231d2, Linux amd64, non-root, healthcheck and migration 0010). This image
includes uncommitted working-tree changes; its revision label is the baseline,
not a claim of a clean release commit. After recreation, `/health` reported DB
and production LOC healthy, zero pending settlements, and `/v1/models` returned
10 catalog models.

A final chat check after recreation returned HTTP 404 `model_not_found` after
waiting for LOC route selection, despite the offering remaining in the catalog.
The gateway stayed healthy and retained the public open intent for accounting
recovery. Earlier successful inference/settlement remains valid evidence, but
production routing availability is intermittent and this final request did not
succeed. This also prevents an unconditional readiness claim.

## Read-only production diagnosis and recovery

SSH inspection of `infra1.cloudspe.com` identified the registry's sole configured
RPC host as `arb1.xode.app`. Read-only chain-ID and block-number probes returned
HTTP 403. Registry logs showed `rpc.all_circuits_open` and explicitly skipped
Speedybird (`0xdef1c70578b2b5e8589a42e26980687fc5153079`), previously advertising
Qwen3.8 and embeddings at `https://broker-us-east.speedybird.xyz`. Successful
route discovery continued through 22:27 UTC; skipped-address failures were
observed from 22:32 UTC. No production changes were performed by this agent.

After the operator's subsequent intervention (containers show starts at
22:57 UTC), read-only probes recovered: capabilities lists both Qwen chat models
and all three embeddings models; Qwen3.8 and Nomic v2 embeddings route lookup
returns HTTP 200 to Speedybird. The local model cache also refreshed successfully.
This supersedes the last observed routing outage, but does not establish that
the earlier embeddings admission failure is fixed: no new inference was submitted.

Observed production artifact identities before that intervention:

| Service | Repository digest | Source/version evidence |
| --- | --- | --- |
| LOC gateway | `tztcloud/livepeer-open-clearinghouse-gateway@sha256:53f5733c639a48beba3a4248b3ae4b29d65ce3e5d1fe30409dc9729c4a46be32` | OCI revision `51578061ac0f6ac567ecf70f31e8c57b6c6470a3` |
| Registry daemon | `tztcloud/livepeer-service-registry-daemon@sha256:f4a4f6da185dd854fc8b96962e14edd39f42479353790575009f6034f24deb1d` | Log version `v2.0.0-d8d369de4aba` |
| Payment daemon | `tztcloud/livepeer-payment-daemon@sha256:ccc6faa87c5c3e386609db884e326b71ce4dfc0550d80aaa856ee8e9a734cd8a` | No OCI revision label observed |

These observations supersede the initial unknown-LOC-digests note. Broker/runner
artifact provenance and full conformance remain outstanding; this is not a
certification of the whole release set.
