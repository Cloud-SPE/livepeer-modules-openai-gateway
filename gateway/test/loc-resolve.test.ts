import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRoute } from '../src/loc/resolve.js';
import type { RegistryCatalog, RouteCandidate } from '../src/registry/catalog.js';

function candidate(overrides: Partial<RouteCandidate>): RouteCandidate {
  return {
    brokerUrl: '',
    capability: 'openai:chat-completions',
    offering: 'offering-id',
    model: null,
    protocol: 'paid-job/v1',
    transports: ['unary'],
    ethAddress: '',
    pricePerWorkUnitWei: '0',
    workUnit: 'tokens',
    unitsPerPrice: 1,
    quoteId: '',
    quoteVersion: 0,
    constraintFingerprint: new Uint8Array(),
    routeFingerprint: new Uint8Array(),
    extra: null,
    constraints: null,
    ...overrides,
  };
}

function catalogOf(candidates: RouteCandidate[]): RegistryCatalog {
  return { inspect: async () => candidates };
}

const QWEN = candidate({
  offering: 'vllm-qwen3.6-27b',
  model: 'Qwen3.6-27B',
  transports: ['unary', 'stream'],
  extra: { openai: { model: 'Qwen3.6-27B' } },
});

test('offering id resolves for a declared transport and runner name', async () => {
  const resolved = await resolveRoute({
    catalog: catalogOf([QWEN]),
    modelMap: {},
    capability: 'openai:chat-completions',
    requestedModel: 'vllm-qwen3.6-27b',
    transport: 'stream',
  });
  assert.equal(resolved.offering, 'vllm-qwen3.6-27b');
  assert.equal(resolved.runnerModel, 'Qwen3.6-27B');
});

test('offering id resolves to runner name from extra', async () => {
  const resolved = await resolveRoute({
    catalog: catalogOf([QWEN]),
    modelMap: {},
    capability: 'openai:chat-completions',
    requestedModel: 'vllm-qwen3.6-27b',
    transport: 'unary',
  });
  assert.equal(resolved.offering, 'vllm-qwen3.6-27b');
  assert.equal(resolved.runnerModel, 'Qwen3.6-27B');
});

test('no extra metadata: falls back to operator model map', async () => {
  const bare = candidate({ offering: 'legacy-offering', model: 'legacy-offering' });
  const resolved = await resolveRoute({
    catalog: catalogOf([bare]),
    modelMap: { 'legacy-offering': 'Mapped/Name' },
    capability: 'openai:chat-completions',
    requestedModel: 'legacy-offering',
    transport: 'unary',
  });
  assert.equal(resolved.offering, 'legacy-offering');
  assert.equal(resolved.runnerModel, 'Mapped/Name');
});

test('unknown model passes through unchanged (LOC will 404 the job)', async () => {
  const resolved = await resolveRoute({
    catalog: catalogOf([QWEN]),
    modelMap: {},
    capability: 'openai:chat-completions',
    requestedModel: 'no-such-model',
    transport: 'unary',
  });
  assert.equal(resolved.offering, 'no-such-model');
  assert.equal(resolved.runnerModel, 'no-such-model');
});

test('catalog failure degrades to map/identity', async () => {
  const broken: RegistryCatalog = {
    inspect: async () => {
      throw new Error('LOC down');
    },
  };
  const resolved = await resolveRoute({
    catalog: broken,
    modelMap: { 'an-offering': 'Runner/Name' },
    capability: 'openai:chat-completions',
    requestedModel: 'an-offering',
    transport: 'unary',
  });
  assert.equal(resolved.offering, 'an-offering');
  assert.equal(resolved.runnerModel, 'Runner/Name');
});

test('capability mismatch is not resolved across capabilities', async () => {
  const resolved = await resolveRoute({
    catalog: catalogOf([QWEN]),
    modelMap: {},
    capability: 'openai:embeddings',
    requestedModel: 'Qwen3.6-27B',
    transport: 'unary',
  });
  assert.equal(resolved.offering, 'Qwen3.6-27B');
  assert.equal(resolved.runnerModel, 'Qwen3.6-27B');
});

test('declared endpoint work-unit drift is rejected before LOC open', async () => {
  await assert.rejects(
    resolveRoute({
      catalog: catalogOf([candidate({ workUnit: 'characters' })]),
      modelMap: {},
      capability: 'openai:chat-completions',
      requestedModel: 'offering-id',
      transport: 'unary',
      expectedWorkUnit: 'tokens',
    }),
    /uses work unit characters; expected tokens/,
  );
});
