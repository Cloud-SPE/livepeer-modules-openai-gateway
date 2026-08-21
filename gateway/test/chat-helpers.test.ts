import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  chatFunding,
  parseTotalTokens,
  pickModel,
} from '../src/proxy/chat.js';
import { textCodePoints } from '../src/proxy/audio-speech.js';
import { imageCount } from '../src/proxy/images.js';
import { embeddingFunding } from '../src/proxy/embeddings.js';

describe('pickModel', () => {
  it('returns the model when present and non-empty', () => {
    assert.equal(pickModel({ model: 'qwen3:8b' }), 'qwen3:8b');
  });
  it('returns null when missing', () => {
    assert.equal(pickModel({}), null);
  });
  it('returns null when empty string', () => {
    assert.equal(pickModel({ model: '' }), null);
  });
  it('returns null when non-string', () => {
    assert.equal(pickModel({ model: 42 as unknown }), null);
  });
});

describe('paid-job funding', () => {
  it('bounds chat output separately from its normal estimate', () => {
    const funding = chatFunding({ messages: [{ content: 'hello' }], max_tokens: 1000 });
    assert.ok(funding.maxTotalUnits > funding.estimatedUnits);
    assert.equal(funding.maxTotalUnits - funding.estimatedUnits, 744);
  });

  it('counts TTS Unicode code points rather than UTF-16 units', () => {
    assert.equal(textCodePoints('A😀é'), 3);
  });

  it('accepts only positive integer image counts', () => {
    assert.equal(imageCount(4), 4);
    assert.equal(imageCount(1.5), 1);
    assert.equal(imageCount(-1), 1);
  });

  it('uses UTF-8 bytes as a conservative embedding token ceiling', () => {
    const funding = embeddingFunding('hello 😀');
    assert.ok(funding.maxTotalUnits >= funding.estimatedUnits);
    assert.equal(funding.maxTotalUnits, Buffer.byteLength('hello 😀', 'utf8'));
  });
});

describe('parseTotalTokens', () => {
  it('extracts usage.total_tokens from a string body', () => {
    const body = JSON.stringify({ id: 'x', usage: { total_tokens: 42 } });
    assert.equal(parseTotalTokens(body), 42);
  });
  it('extracts from a Uint8Array body', () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ usage: { total_tokens: 7 } }),
    );
    assert.equal(parseTotalTokens(body), 7);
  });
  it('returns null on malformed JSON', () => {
    assert.equal(parseTotalTokens('not json'), null);
  });
  it('returns null when usage.total_tokens missing', () => {
    assert.equal(parseTotalTokens(JSON.stringify({ id: 'x' })), null);
  });
  it('returns null for non-string non-buffer inputs', () => {
    assert.equal(parseTotalTokens(null), null);
  });
});
