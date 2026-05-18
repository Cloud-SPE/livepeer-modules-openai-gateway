// Crypto helpers: generate + hash API keys, verification tokens, session
// tokens, IP fingerprints. All hashing is peppered with server-side
// secrets so a DB leak alone isn't sufficient to confirm a guessed
// secret.

import { createHash, randomBytes } from 'node:crypto';

// ── API keys ──────────────────────────────────────────────────────────
//
// Format: "sk-<48 random base64url chars>".
// Prefix: "sk-" + first 8 chars of the random tail — shown to the user
// in the portal to identify a key without revealing the secret.
//
// Total entropy: 48 chars × 6 bits/char = 288 bits. Way over the
// brute-force horizon.

const API_KEY_RANDOM_BYTES = 36; // 36 bytes → 48 base64url chars

export interface GeneratedApiKey {
  /** Plaintext key, shown to the user once. */
  plaintext: string;
  /** First 11 chars (sk- + 8 chars), safe to log / display. */
  prefix: string;
  /** SHA-256(plaintext + pepper) for storage. */
  hash: string;
}

export function generateApiKey(pepper: string | undefined): GeneratedApiKey {
  const tail = base64urlBytes(API_KEY_RANDOM_BYTES);
  const plaintext = `sk-${tail}`;
  const prefix = plaintext.slice(0, 11);
  const hash = hashWithPepper(plaintext, pepper);
  return { plaintext, prefix, hash };
}

export function hashApiKey(
  plaintext: string,
  pepper: string | undefined,
): string {
  return hashWithPepper(plaintext, pepper);
}

// ── Verification tokens ──────────────────────────────────────────────
//
// Single-use, time-limited links delivered by email. We never store the
// plaintext; the link contains the plaintext, the DB stores its hash.

const VERIFICATION_TOKEN_RANDOM_BYTES = 24;

export function generateVerificationToken(pepper: string | undefined): {
  plaintext: string;
  hash: string;
} {
  const plaintext = base64urlBytes(VERIFICATION_TOKEN_RANDOM_BYTES);
  const hash = hashWithPepper(plaintext, pepper);
  return { plaintext, hash };
}

export function hashVerificationToken(
  plaintext: string,
  pepper: string | undefined,
): string {
  return hashWithPepper(plaintext, pepper);
}

// ── Session tokens (portal cookie) ───────────────────────────────────

const SESSION_TOKEN_RANDOM_BYTES = 32;

export function generateSessionToken(pepper: string | undefined): {
  plaintext: string;
  hash: string;
} {
  const plaintext = base64urlBytes(SESSION_TOKEN_RANDOM_BYTES);
  const hash = hashWithPepper(plaintext, pepper);
  return { plaintext, hash };
}

export function hashSessionToken(
  plaintext: string,
  pepper: string | undefined,
): string {
  return hashWithPepper(plaintext, pepper);
}

// ── Client IP fingerprint ────────────────────────────────────────────
//
// Used to rate-limit waitlist signups. Without a pepper, a leaked
// hashed IP is confirmable against the full IPv4 space via rainbow
// table. Log a warning at startup if the pepper is unset.

export function hashIp(
  ip: string,
  pepper: string | undefined,
): string {
  return hashWithPepper(ip.trim(), pepper);
}

// ── Internals ────────────────────────────────────────────────────────

function hashWithPepper(value: string, pepper: string | undefined): string {
  const h = createHash('sha256');
  h.update(value);
  if (pepper !== undefined && pepper.length > 0) {
    h.update(pepper);
  }
  return h.digest('hex');
}

function base64urlBytes(n: number): string {
  return randomBytes(n)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
