import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** Serialize once: the body hashed for LOC is the body delivered to the broker. */
export async function prepareInvocation(body: BodyInit | null, contentType?: string) {
  const request = new Request('http://serialization.invalid', {
    method: 'POST', body,
    headers: contentType && !(body instanceof FormData) ? { 'Content-Type': contentType } : {},
  });
  const bytes = Buffer.from(await request.arrayBuffer());
  const privateKey = secp256k1.utils.randomSecretKey();
  return {
    body: bytes,
    contentType: request.headers.get('content-type') ?? contentType,
    workloadRequestDigest: createHash('sha256').update(bytes).digest('hex'),
    callerPublicKey: Buffer.from(secp256k1.getPublicKey(privateKey, true)).toString('hex'),
    sign(authorization: string): string {
      const decoded = Buffer.from(authorization, 'base64');
      if (!decoded.length || decoded.toString('base64') !== authorization) {
        throw new Error('LOC returned invalid base64 spend authorization');
      }
      const digest = keccak_256(concatBytes(utf8ToBytes('livepeer-invocation-proof/v1\0'), decoded));
      const hash = keccak_256(concatBytes(utf8ToBytes('\x19Ethereum Signed Message:\n32'), digest));
      const sig = secp256k1.sign(hash, privateKey, { prehash: false, format: 'recovered' });
      return Buffer.from(concatBytes(sig.subarray(1), Uint8Array.of(27 + sig[0]!))).toString('base64');
    },
  };
}
