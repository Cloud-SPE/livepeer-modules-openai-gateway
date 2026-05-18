import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateApiKey,
  generateSessionToken,
  generateVerificationToken,
  hashApiKey,
  hashIp,
  hashSessionToken,
  hashVerificationToken,
} from '../src/crypto.js';

describe('generateApiKey', () => {
  it('produces sk- prefix and 11-char public prefix', () => {
    const k = generateApiKey('pepper');
    assert.ok(k.plaintext.startsWith('sk-'));
    assert.equal(k.prefix.length, 11);
    assert.equal(k.prefix.slice(0, 3), 'sk-');
    assert.equal(k.plaintext.slice(0, 11), k.prefix);
  });

  it('produces a 64-char hex hash (SHA-256)', () => {
    const k = generateApiKey('pepper');
    assert.equal(k.hash.length, 64);
    assert.match(k.hash, /^[0-9a-f]{64}$/);
  });

  it('round-trips: hashApiKey(plaintext, pepper) === generated hash', () => {
    const k = generateApiKey('pepper');
    assert.equal(hashApiKey(k.plaintext, 'pepper'), k.hash);
  });

  it('different peppers produce different hashes for the same plaintext', () => {
    const plain = 'sk-fixedforthistest';
    assert.notEqual(hashApiKey(plain, 'pepperA'), hashApiKey(plain, 'pepperB'));
  });

  it('omitted pepper still produces a stable hash (but warns at boot)', () => {
    const plain = 'sk-fixed';
    assert.equal(hashApiKey(plain, undefined), hashApiKey(plain, undefined));
    assert.notEqual(hashApiKey(plain, undefined), hashApiKey(plain, 'p'));
  });

  it('keys collide with vanishing probability', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateApiKey('p').plaintext);
    assert.equal(seen.size, 1000);
  });
});

describe('verification + session tokens', () => {
  it('verification token is base64url-shaped and round-trips through its hash', () => {
    const t = generateVerificationToken('pepper');
    assert.match(t.plaintext, /^[A-Za-z0-9_-]+$/);
    assert.equal(hashVerificationToken(t.plaintext, 'pepper'), t.hash);
  });

  it('session token round-trips', () => {
    const t = generateSessionToken('pepper');
    assert.equal(hashSessionToken(t.plaintext, 'pepper'), t.hash);
  });

  it('different pepper → different hash for same plaintext', () => {
    const t = generateVerificationToken('A');
    assert.notEqual(
      hashVerificationToken(t.plaintext, 'A'),
      hashVerificationToken(t.plaintext, 'B'),
    );
  });
});

describe('hashIp', () => {
  it('is deterministic with a pepper', () => {
    assert.equal(hashIp('1.2.3.4', 'p'), hashIp('1.2.3.4', 'p'));
  });
  it('different IPs hash differently', () => {
    assert.notEqual(hashIp('1.2.3.4', 'p'), hashIp('1.2.3.5', 'p'));
  });
  it('trims whitespace', () => {
    assert.equal(hashIp('1.2.3.4', 'p'), hashIp('  1.2.3.4 ', 'p'));
  });
});
