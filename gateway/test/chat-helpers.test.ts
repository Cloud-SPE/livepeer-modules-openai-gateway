import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTotalTokens,
  pickModel,
} from '../src/proxy/chat.js';

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
