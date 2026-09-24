import test from 'node:test';
import assert from 'node:assert/strict';

import { flattenCapabilities } from '../src/registry/catalog.js';

test('flattenCapabilities maps offerings to RouteCandidates', () => {
  const candidates = flattenCapabilities([
    {
      name: 'openai:chat-completions',
      workUnit: 'tokens',
      offerings: [
        { id: 'llama-3', unitsPerPrice: 1, pricePerWorkUnitWei: '100', workUnit: 'tokens', protocol: 'paid-job/v1', transports: ['unary', 'stream'], extra: {} },
        { id: 'qwen-2', unitsPerPrice: 1, pricePerWorkUnitWei: null, workUnit: null, protocol: 'paid-job/v1', transports: ['unary'], extra: {} },
      ],
    },
    {
      name: 'openai:embeddings',
      workUnit: 'tokens',
      offerings: [{ id: 'bge-m3', unitsPerPrice: 1, pricePerWorkUnitWei: '5', workUnit: 'tokens', protocol: 'paid-job/v1', transports: ['unary'], extra: {} }],
    },
  ]);

  assert.equal(candidates.length, 3);

  const llama = candidates[0]!;
  assert.equal(llama.capability, 'openai:chat-completions');
  assert.equal(llama.offering, 'llama-3');
  // Without extra metadata, model falls back to the offering id.
  assert.equal(llama.model, 'llama-3');
  assert.equal(llama.pricePerWorkUnitWei, '100');
  assert.equal(llama.workUnit, 'tokens');

  // Null offering price defaults to '0'; work unit falls back to the capability's.
  const qwen = candidates[1]!;
  assert.equal(qwen.pricePerWorkUnitWei, '0');
  assert.equal(qwen.workUnit, 'tokens');

  // Daemon-era fields are empty — LOC owns quote identity now.
  assert.equal(llama.ethAddress, '');
  assert.equal(llama.quoteId, '');
  assert.equal(llama.constraintFingerprint.length, 0);
});

test('flattenCapabilities derives runner model and preserves protocol transports', () => {
  const candidates = flattenCapabilities([
    {
      name: 'openai:chat-completions',
      workUnit: 'tokens',
      offerings: [
        {
          id: 'vllm-qwen3.6-27b-default',
          unitsPerPrice: 1, pricePerWorkUnitWei: '100',
          workUnit: 'tokens',
          protocol: 'paid-job/v1',
          transports: ['unary', 'stream'],
          extra: {
            openai: { model: 'Qwen3.6-27B', name: 'Qwen 3.6 27B' },
          },
        },
      ],
    },
  ]);

  assert.equal(candidates[0]!.model, 'Qwen3.6-27B');
  assert.equal(candidates[0]!.protocol, 'paid-job/v1');
  assert.deepEqual(candidates[0]!.transports, ['unary', 'stream']);
  // extra is preserved on the candidate for downstream consumers.
  assert.deepEqual(
    (candidates[0]!.extra as { openai: { name: string } }).openai.name,
    'Qwen 3.6 27B',
  );
});

test('flattenCapabilities drops empty names and offering ids', () => {
  const candidates = flattenCapabilities([
    { name: '', workUnit: null, offerings: [{ id: 'x', unitsPerPrice: 1, pricePerWorkUnitWei: '1', workUnit: null, protocol: 'paid-job/v1', transports: ['unary'], extra: {} }] },
    { name: 'rerank', workUnit: 'requests', offerings: [{ id: '', unitsPerPrice: 1, pricePerWorkUnitWei: '1', workUnit: null, protocol: 'paid-job/v1', transports: ['unary'], extra: {} }] },
  ]);
  assert.equal(candidates.length, 0);
});

test('flattenCapabilities ignores other protocols and rejects malformed paid-job offerings', () => {
  assert.deepEqual(flattenCapabilities([{ name: 'meetings', workUnit: 'seconds', offerings: [
    { id: 'default', unitsPerPrice: 1, pricePerWorkUnitWei: '1', workUnit: 'seconds', protocol: 'paid-session/v1', transports: [], extra: {} },
  ] }]), []);
  assert.throws(() => flattenCapabilities([{ name: 'chat', workUnit: 'tokens', offerings: [
    { id: 'bad', unitsPerPrice: 1, pricePerWorkUnitWei: '1', workUnit: 'tokens', protocol: '', transports: ['unary'], extra: {} },
  ] }]), /missing protocol/);
  assert.throws(() => flattenCapabilities([{ name: 'chat', workUnit: 'tokens', offerings: [
    { id: 'bad', unitsPerPrice: 1, pricePerWorkUnitWei: '1', workUnit: 'tokens', protocol: 'paid-job\/v1', transports: [], extra: {} },
  ] }]), /missing job transports/);
});

test('flattenCapabilities preserves estimator metadata for endpoint funding checks', () => {
  const [candidate] = flattenCapabilities([{
    name: 'openai:audio-transcriptions',
    workUnit: 'seconds',
    offerings: [{
      id: 'default',
      unitsPerPrice: 1, pricePerWorkUnitWei: '100',
      workUnit: 'seconds',
      estimator: {
        id: 'multipart-audio-duration/v1',
        rounding: 'ceil-to-whole-seconds',
        exactness: 'exact-or-reject',
        fixtures: 'livepeer-network-protocol/extractors/fixtures/multipart-audio-duration-v1',
      },
      protocol: 'paid-job/v1',
      transports: ['multipart'],
      extra: {},
    }],
  }]);
  assert.equal(candidate!.estimator?.id, 'multipart-audio-duration/v1');
  assert.equal(candidate!.estimator?.exactness, 'exact-or-reject');
});

test('catalog retains quoted units-per-price instead of assuming one', () => {
  const rows = flattenCapabilities([{name:'openai:chat-completions',workUnit:'tokens',offerings:[{
    id:'model', pricePerWorkUnitWei:'1000',unitsPerPrice:100,workUnit:'tokens',protocol:'paid-job/v1',transports:['unary'],extra:{},
  }]}]);
  assert.equal(rows[0]!.unitsPerPrice,100);
});

test('catalog cache carries metadata and refreshes when coverage expires', async t => {
  const { createRegistryCatalog } = await import('../src/registry/catalog.js');
  const { catalogMetadata } = await import('./catalog-fixtures.js');
  let now = Date.parse('2026-09-24T12:01:00Z');
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const metadata = catalogMetadata({ coverage_valid_until: new Date(now + 1000).toISOString() });
  const catalog = createRegistryCatalog({ listCapabilities: async () => {
    calls++;
    return { items: [], catalog: metadata };
  } } as unknown as import('../src/loc/client.js').LocClient);
  assert.deepEqual((await catalog.inspect()).catalog, metadata);
  await catalog.inspect();
  assert.equal(calls, 1);
  now += 1001;
  await catalog.inspect();
  assert.equal(calls, 2);
});
