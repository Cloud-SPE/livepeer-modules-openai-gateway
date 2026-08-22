import assert from 'node:assert/strict';
import test from 'node:test';

import type { RouteCandidate } from '../src/registry/catalog.js';
import { candidatesForModel } from '../src/registry/modelHealth.js';

function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    brokerUrl: '',
    capability: 'openai:chat-completions',
    offering: 'default',
    model: 'gpt-oss-20b',
    protocol: 'paid-job/v1',
    transports: ['unary', 'stream'],
    ethAddress: '',
    pricePerWorkUnitWei: '100',
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

test('model health matches public offering identity, not runner model name', () => {
  const matches = candidatesForModel(
    [candidate()],
    'openai:chat-completions',
    'default',
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.model, 'gpt-oss-20b');
});

test('model health scopes equal offering ids by capability', () => {
  const candidates = [
    candidate(),
    candidate({ capability: 'openai:audio-transcriptions', model: 'whisper-1' }),
  ];
  const chat = candidatesForModel(candidates, 'openai:chat-completions', 'default');
  const transcription = candidatesForModel(
    candidates,
    'openai:audio-transcriptions',
    'default',
  );
  assert.equal(chat.length, 1);
  assert.equal(chat[0]!.model, 'gpt-oss-20b');
  assert.equal(transcription.length, 1);
  assert.equal(transcription[0]!.model, 'whisper-1');
});
