import test from 'node:test';
import assert from 'node:assert/strict';

import { flattenCapabilities } from '../src/registry/catalog.js';

test('flattenCapabilities maps offerings to RouteCandidates', () => {
  const candidates = flattenCapabilities([
    {
      name: 'openai:chat-completions',
      workUnit: 'tokens',
      offerings: [
        { id: 'llama-3', pricePerWorkUnitWei: '100', workUnit: 'tokens', extra: {} },
        { id: 'qwen-2', pricePerWorkUnitWei: null, workUnit: null, extra: {} },
      ],
    },
    {
      name: 'openai:embeddings',
      workUnit: 'tokens',
      offerings: [{ id: 'bge-m3', pricePerWorkUnitWei: '5', workUnit: 'tokens', extra: {} }],
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

test('flattenCapabilities derives model and mode from extra metadata', () => {
  const candidates = flattenCapabilities([
    {
      name: 'openai:chat-completions',
      workUnit: 'tokens',
      offerings: [
        {
          id: 'vllm-qwen3.6-27b-default',
          pricePerWorkUnitWei: '100',
          workUnit: 'tokens',
          extra: {
            interaction_mode: 'http-reqresp@v0',
            openai: { model: 'Qwen3.6-27B', name: 'Qwen 3.6 27B' },
          },
        },
        {
          id: 'vllm-qwen3.6-27b-stream',
          pricePerWorkUnitWei: '100',
          workUnit: 'tokens',
          extra: {
            interaction_mode: 'http-stream@v0',
            openai: { model: 'Qwen3.6-27B' },
          },
        },
      ],
    },
  ]);

  assert.equal(candidates[0]!.model, 'Qwen3.6-27B');
  assert.equal(candidates[0]!.interactionMode, 'http-reqresp@v0');
  assert.equal(candidates[1]!.model, 'Qwen3.6-27B');
  assert.equal(candidates[1]!.interactionMode, 'http-stream@v0');
  // extra is preserved on the candidate for downstream consumers.
  assert.deepEqual(
    (candidates[0]!.extra as { openai: { name: string } }).openai.name,
    'Qwen 3.6 27B',
  );
});

test('flattenCapabilities drops empty names and offering ids', () => {
  const candidates = flattenCapabilities([
    { name: '', workUnit: null, offerings: [{ id: 'x', pricePerWorkUnitWei: '1', workUnit: null, extra: {} }] },
    { name: 'rerank', workUnit: 'requests', offerings: [{ id: '', pricePerWorkUnitWei: '1', workUnit: null, extra: {} }] },
  ]);
  assert.equal(candidates.length, 0);
});
