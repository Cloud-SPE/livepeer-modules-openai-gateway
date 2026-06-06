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
    interactionMode: null,
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

const QWEN_DEFAULT = candidate({
  offering: 'vllm-qwen3.6-27b-default',
  model: 'Qwen3.6-27B',
  interactionMode: 'http-reqresp@v0',
  extra: { interaction_mode: 'http-reqresp@v0', openai: { model: 'Qwen3.6-27B' } },
});

const QWEN_STREAM = candidate({
  offering: 'vllm-qwen3.6-27b-stream',
  model: 'Qwen3.6-27B',
  interactionMode: 'http-stream@v0',
  extra: { interaction_mode: 'http-stream@v0', openai: { model: 'Qwen3.6-27B' } },
});

test('friendly model id resolves to mode-matching offering + runner name', async () => {
  const resolved = await resolveRoute({
    catalog: catalogOf([QWEN_DEFAULT, QWEN_STREAM]),
    modelMap: {},
    capability: 'openai:chat-completions',
    requestedModel: 'Qwen3.6-27B',
    interactionMode: 'http-stream@v0',
  });
  assert.equal(resolved.offering, 'vllm-qwen3.6-27b-stream');
  assert.equal(resolved.runnerModel, 'Qwen3.6-27B');
});

test('offering id resolves to runner name from extra', async () => {
  const resolved = await resolveRoute({
    catalog: catalogOf([QWEN_DEFAULT, QWEN_STREAM]),
    modelMap: {},
    capability: 'openai:chat-completions',
    requestedModel: 'vllm-qwen3.6-27b-default',
  });
  assert.equal(resolved.offering, 'vllm-qwen3.6-27b-default');
  assert.equal(resolved.runnerModel, 'Qwen3.6-27B');
});

test('no extra metadata: falls back to operator model map', async () => {
  const bare = candidate({ offering: 'legacy-offering', model: 'legacy-offering' });
  const resolved = await resolveRoute({
    catalog: catalogOf([bare]),
    modelMap: { 'legacy-offering': 'Mapped/Name' },
    capability: 'openai:chat-completions',
    requestedModel: 'legacy-offering',
  });
  assert.equal(resolved.offering, 'legacy-offering');
  assert.equal(resolved.runnerModel, 'Mapped/Name');
});

test('unknown model passes through unchanged (LOC will 404 the job)', async () => {
  const resolved = await resolveRoute({
    catalog: catalogOf([QWEN_DEFAULT]),
    modelMap: {},
    capability: 'openai:chat-completions',
    requestedModel: 'no-such-model',
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
  });
  assert.equal(resolved.offering, 'an-offering');
  assert.equal(resolved.runnerModel, 'Runner/Name');
});

test('capability mismatch is not resolved across capabilities', async () => {
  const resolved = await resolveRoute({
    catalog: catalogOf([QWEN_DEFAULT]),
    modelMap: {},
    capability: 'openai:embeddings',
    requestedModel: 'Qwen3.6-27B',
  });
  assert.equal(resolved.offering, 'Qwen3.6-27B');
  assert.equal(resolved.runnerModel, 'Qwen3.6-27B');
});
