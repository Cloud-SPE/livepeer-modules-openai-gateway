import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import fixture from './fixtures/shared-wallet.json' with { type: 'json' };
import { prepareInvocation } from '../src/loc/authorization.js';
import { createLocClient } from '../src/loc/client.js';
import { dispatchReqresp } from '../src/loc/dispatch.js';
import { decodeSignedSettlement, lookupBrokerSettlement } from '../src/loc/brokerSettlement.js';
import { runSettleOnce } from '../src/loc/settler.js';
import { routeSnapshot } from './wholesale-fixtures.js';

function recoverProof(authorization: string, proof: string): string {
  const digest = keccak_256(concatBytes(utf8ToBytes('livepeer-invocation-proof/v1\0'), Buffer.from(authorization, 'base64')));
  const hash = keccak_256(concatBytes(utf8ToBytes('\x19Ethereum Signed Message:\n32'), digest));
  const sig = Buffer.from(proof, 'base64');
  return Buffer.from(secp256k1.recoverPublicKey(concatBytes(Uint8Array.of(sig[64]! - 27), sig.subarray(0, 64)), hash, { prehash: false })).toString('hex');
}

function fixedCaller(t: TestContext) {
  // Noble maps a 48-byte seed to (seed mod (order - 1)) + 1.
  // Override only the test RNG; production caller keys remain random.
  const seed = Buffer.from((BigInt('0x' + fixture.caller_private_key) - 1n).toString(16).padStart(96, '0'), 'hex');
  const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  t.mock.method(globalThis.crypto, 'getRandomValues', (array: Uint8Array<ArrayBuffer>) => {
    if (array.byteLength !== seed.length) return original(array);
    array.set(seed);
    return array;
  });
}

test('v3 caller proof binds the complete account-scoped authorization bytes', async t => {
  fixedCaller(t);
  const prepared = await prepareInvocation(fixture.body, 'application/json');
  assert.equal(prepared.callerPublicKey, fixture.caller_public_key);
  assert.equal(prepared.workloadRequestDigest, fixture.request_digest);
  const proof = prepared.sign(fixture.authorization);
  assert.equal(recoverProof(fixture.authorization, proof), prepared.callerPublicKey);
  assert.notEqual(recoverProof(fixture.other_account_authorization, proof), prepared.callerPublicKey);
  assert.equal(recoverProof(fixture.other_account_authorization, prepared.sign(fixture.other_account_authorization)), prepared.callerPublicKey);
});

test('LOC v3 authority reaches broker intact with exact workload and caller proof', async t => {
  fixedCaller(t);
  const seen: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    const request = new Request(url, init);
    seen.push(request);
    if (request.url === 'https://loc.example/v1/jobs') {
      const body = await request.json() as Record<string, unknown>;
      assert.equal(body['caller_public_key'], fixture.caller_public_key);
      assert.equal(body['workload_request_digest'], fixture.request_digest);
      assert.equal(body['wholesale_account_id'], undefined); // LOC owns account selection.
      return Response.json({
        job_id: 'loc-job-1', request_id: 'request-1', work_id: 'work-1',
        broker_url: 'https://broker.example', protocol: 'paid-job/v1', transport: 'unary',
        work_unit: 'token', accounting_mode: 'wholesale_account',
        route_snapshot: {
          ...routeSnapshot('https://broker.example', 'openai:chat-completions', 'fixture-model'),
          work_unit: 'token', price_per_work_unit_wei: '1', units_per_price: 1, quote_id: 'q-1',
          constraint_fingerprint: '00'.repeat(32), route_fingerprint: '11'.repeat(32),
          settlement_domain_id: fixture.settlement.payload.settlement_domain_id,
        },
        spend_authorization: fixture.authorization, expected_value_wei: '5', funded_value_wei: '100',
        settle_endpoint: '/v1/jobs/loc-job-1/settle', opened_at: '2026-08-20T11:59:00Z',
      }, { status: 201 });
    }
    assert.equal(request.url, 'https://broker.example/v1/job');
    assert.equal(request.headers.get('Livepeer-Authorization'), fixture.authorization);
    assert.equal(recoverProof(fixture.authorization, request.headers.get('Livepeer-Caller-Proof')!), fixture.caller_public_key);
    assert.equal(await request.text(), fixture.body);
    return Response.json({ choices: [] }, { headers: { 'Livepeer-Job-Id': 'broker-job-1', 'Livepeer-Work-Unit': 'token' } });
  });
  const result = await dispatchReqresp({
    loc: createLocClient({ baseUrl: 'https://loc.example', apiKey: 'fixture', timeoutMs: 1000 }),
    capability: 'openai:chat-completions', offering: 'fixture-model', estimatedUnits: 5,
    maxTotalUnits: 100, idempotencyKey: 'fixture-open', body: fixture.body, contentType: 'application/json',
  });
  assert.equal(result.jobRef.spendAuthorization, fixture.authorization);
  assert.equal(seen.length, 2);
});

test('account-bearing signed settlement survives decoding and LOC rejection without rewriting evidence', async t => {
  const evidence = decodeSignedSettlement(Buffer.from(JSON.stringify(fixture.settlement)).toString('base64'));
  assert.deepEqual(evidence.envelope, fixture.settlement);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    requests++;
    const request = new Request(url, init);
    assert.equal(request.url, 'https://loc.example/v1/jobs/loc-job-1/settle');
    const body = await request.json() as { settlement: unknown };
    assert.deepEqual(body.settlement, fixture.settlement);
    // Actual LOC reason verified by the checked-in fixture generator, not a gateway verifier.
    return Response.json({ error: { code: 'settlement_verification_failed', message: 'broker settlement verification failed', details: { reason: 'wholesale_account_mismatch' } } }, { status: 409 });
  });
  const failures: unknown[] = [];
  const stats = await runSettleOnce({
    claimPendingSettlements: async () => [{ id: 'r', locJobId: 'loc-job-1', settleEndpoint: '/v1/jobs/loc-job-1/settle', brokerJobId: evidence.brokerJobId, workUnit: evidence.workUnit, actualUnits: 5, outcome: evidence.outcome, settlement: evidence.envelope, settleAttempts: 0 }],
    markSettled: async () => { assert.fail('cross-account rejection must not settle'); },
    recordSettleFailure: async (...args) => { failures.push(args); },
  }, createLocClient({ baseUrl: 'https://loc.example', apiKey: 'fixture', timeoutMs: 1000 }), 20, 50);
  assert.deepEqual(stats, { settled: 0, failed: 1, retried: 0 });
  assert.deepEqual(failures, [['r', 'broker settlement verification failed', true]]);
  assert.equal(requests, 1);
  assert.equal((evidence.envelope['payload'] as Record<string, unknown>)['wholesale_account_id'], fixture.account_id);
});

test('account-scoped non-admission remains exact audit evidence rather than a settlement', async t => {
  const encoded = Buffer.from(JSON.stringify(fixture.non_admission)).toString('base64');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? Response.json({ outcome: 'ADMISSION_REJECTED' })
    : Response.json({ outcome: 'NOT_ADMITTED', non_admission: encoded }));
  const row = { id: 'r', brokerUrl: 'https://broker.example', brokerJobId: null, locRequestId: 'request-1', paymentWorkId: 'work-1', workUnit: 'token', attempts: 0 };
  assert.equal((await lookupBrokerSettlement(row, 1000)).kind, 'deferred');
  const result = await lookupBrokerSettlement(row, 1000);
  assert.equal(result.kind, 'terminal_evidence');
  if (result.kind !== 'terminal_evidence') assert.fail('expected audit evidence');
  assert.equal(result.state, 'not_admitted');
  assert.equal(result.encoded, encoded);
});
