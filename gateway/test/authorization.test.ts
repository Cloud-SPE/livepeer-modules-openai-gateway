import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { prepareInvocation } from '../src/loc/authorization.js';

test('caller proof recovers the LOC-bound key and changes with authorization bytes', async () => {
  const invocation = await prepareInvocation('{"model":"runner-name"}', 'application/json');
  const authorization = Buffer.from('authorization-protobuf-bytes');
  const proof = Buffer.from(invocation.sign(authorization.toString('base64')), 'base64');
  assert.equal(proof.length, 65);
  assert.ok(proof[64] === 27 || proof[64] === 28);
  const digest = keccak_256(concatBytes(utf8ToBytes('livepeer-invocation-proof/v1\0'), authorization));
  const hash = keccak_256(concatBytes(utf8ToBytes('\x19Ethereum Signed Message:\n32'), digest));
  const recovered = secp256k1.recoverPublicKey(concatBytes(Uint8Array.of(proof[64]! - 27), proof.subarray(0,64)), hash, { prehash: false });
  assert.equal(Buffer.from(recovered).toString('hex'), invocation.callerPublicKey);
  assert.notEqual(invocation.sign(Buffer.from('other').toString('base64')), proof.toString('base64'));
  assert.throws(() => invocation.sign('!invalid'), /invalid base64/);
});

test('multipart commitment covers the final boundary, file bytes and rewritten model', async () => {
  const form = new FormData();
  form.append('model', 'runner-name');
  form.append('file', new Blob([Uint8Array.from([0,1,255,13,10])]), 'audio.wav');
  const prepared = await prepareInvocation(form, 'multipart/form-data');
  assert.match(prepared.contentType!, /multipart\/form-data; boundary=/);
  assert.equal(prepared.workloadRequestDigest, createHash('sha256').update(prepared.body).digest('hex'));
  const decoded = await new Response(prepared.body, {headers:{'content-type':prepared.contentType!}}).formData();
  assert.equal(decoded.get('model'), 'runner-name');
  assert.deepEqual(new Uint8Array(await (decoded.get('file') as File).arrayBuffer()), Uint8Array.from([0,1,255,13,10]));
});
