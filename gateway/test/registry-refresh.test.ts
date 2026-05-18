import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RouteCandidate } from '../src/registry/catalog.js';
import { candidatesToModelRows } from '../src/registry/refresh.js';

function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    brokerUrl: 'http://broker.local',
    capability: 'openai:chat-completions',
    offering: 'fallback-offering',
    model: 'qwen3:8b',
    interactionMode: 'http-reqresp@v0',
    ethAddress: '0xabc',
    pricePerWorkUnitWei: '0',
    workUnit: 'total_tokens',
    unitsPerPrice: 1,
    quoteId: 'quote-a',
    quoteVersion: 1,
    constraintFingerprint: new Uint8Array([1]),
    routeFingerprint: new Uint8Array([2]),
    extra: null,
    constraints: null,
    ...overrides,
  };
}

describe('candidatesToModelRows', () => {
  it('produces one row per unique modelId', () => {
    const rows = candidatesToModelRows([
      candidate({ model: 'a' }),
      candidate({ model: 'b' }),
      candidate({ model: 'c' }),
    ]);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.modelId).sort(),
      ['a', 'b', 'c'],
    );
  });

  it('de-dupes by modelId (last candidate wins)', () => {
    const rows = candidatesToModelRows([
      candidate({ model: 'a', brokerUrl: 'http://broker1' }),
      candidate({ model: 'a', brokerUrl: 'http://broker2' }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.brokerUrl, 'http://broker2');
  });

  it('falls back to offering when model is null', () => {
    const rows = candidatesToModelRows([
      candidate({ model: null, offering: 'offering-id' }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.modelId, 'offering-id');
  });

  it('skips candidates with no derivable modelId', () => {
    const rows = candidatesToModelRows([
      candidate({ model: null, offering: '' }),
      candidate({ model: '   ', offering: '' }),
      candidate({ model: 'real' }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.modelId, 'real');
  });

  it('pulls display fields from extra.openai (preferred)', () => {
    const rows = candidatesToModelRows([
      candidate({
        model: 'm',
        extra: {
          openai: { name: 'Qwen 3 8B', description: 'fast chat model' },
        },
      }),
    ]);
    assert.equal(rows[0]!.name, 'Qwen 3 8B');
    assert.equal(rows[0]!.description, 'fast chat model');
  });

  it('falls back to top-level extra fields when openai key is absent', () => {
    const rows = candidatesToModelRows([
      candidate({
        model: 'm',
        extra: {
          name: 'Fallback Name',
          provider: 'livepeer',
          category: 'chat',
        },
      }),
    ]);
    assert.equal(rows[0]!.name, 'Fallback Name');
    assert.equal(rows[0]!.provider, 'livepeer');
    assert.equal(rows[0]!.category, 'chat');
  });

  it('handles arrays / non-object extras as missing display fields', () => {
    const rows = candidatesToModelRows([
      candidate({ model: 'm', extra: ['unexpected', 'array'] }),
    ]);
    assert.equal(rows[0]!.name, null);
    assert.equal(rows[0]!.description, null);
    assert.equal(rows[0]!.provider, null);
    assert.equal(rows[0]!.category, null);
  });

  it('preserves capability / interactionMode / ethAddress / price / brokerUrl', () => {
    const rows = candidatesToModelRows([
      candidate({
        model: 'm',
        capability: 'openai:embeddings',
        interactionMode: 'http-reqresp@v0',
        ethAddress: '0xface',
        pricePerWorkUnitWei: '1000',
        brokerUrl: 'http://b',
      }),
    ]);
    assert.equal(rows[0]!.capability, 'openai:embeddings');
    assert.equal(rows[0]!.interactionMode, 'http-reqresp@v0');
    assert.equal(rows[0]!.ethAddress, '0xface');
    assert.equal(rows[0]!.pricePerWorkUnitWei, '1000');
    assert.equal(rows[0]!.brokerUrl, 'http://b');
  });

  it('preserves quote-aware route metadata', () => {
    const rows = candidatesToModelRows([
      candidate({
        model: 'm',
        unitsPerPrice: 25,
        quoteId: 'quote-xyz',
        quoteVersion: 9,
        constraintFingerprint: new Uint8Array([0xaa, 0xbb]),
        routeFingerprint: new Uint8Array([0xcc, 0xdd]),
      }),
    ]);
    assert.equal(rows[0]!.unitsPerPrice, 25);
    assert.equal(rows[0]!.quoteId, 'quote-xyz');
    assert.equal(rows[0]!.quoteVersion, '9');
    assert.equal(rows[0]!.constraintFingerprintHex, 'aabb');
    assert.equal(rows[0]!.routeFingerprintHex, 'ccdd');
  });

  it('all rows ship active=true with a snapshotAt timestamp', () => {
    const rows = candidatesToModelRows([candidate({ model: 'm' })]);
    assert.equal(rows[0]!.active, true);
    assert.ok(rows[0]!.snapshotAt instanceof Date);
  });

  it('ethAddress / brokerUrl null when empty string from registry', () => {
    const rows = candidatesToModelRows([
      candidate({ model: 'm', ethAddress: '', brokerUrl: '' }),
    ]);
    assert.equal(rows[0]!.ethAddress, null);
    assert.equal(rows[0]!.brokerUrl, null);
  });
});
