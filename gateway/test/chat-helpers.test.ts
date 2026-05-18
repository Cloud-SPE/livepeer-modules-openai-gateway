import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseStreamingUsage,
  parseTotalTokens,
  pickModel,
  withForcedUsageChunk,
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

describe('withForcedUsageChunk', () => {
  it('forces stream:true and include_usage:true', () => {
    const out = withForcedUsageChunk({ model: 'x', stream: false });
    assert.equal(out.stream, true);
    assert.equal(out.stream_options?.include_usage, true);
  });
  it('preserves caller-provided stream_options', () => {
    const out = withForcedUsageChunk({
      model: 'x',
      stream_options: { /* invented field caller might pass */ foo: 'bar' as unknown },
    });
    assert.equal(out.stream_options?.include_usage, true);
    assert.equal((out.stream_options as { foo: unknown }).foo, 'bar');
  });
  it('preserves all other body fields', () => {
    const out = withForcedUsageChunk({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }] as unknown,
      temperature: 0.7,
    });
    assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }]);
    assert.equal(out.temperature, 0.7);
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

describe('parseStreamingUsage', () => {
  it('extracts the last usage frame from an SSE transcript', () => {
    const transcript = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
      '',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: ' there' } }] }),
      '',
      'data: ' + JSON.stringify({ usage: { total_tokens: 99 } }),
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    assert.equal(parseStreamingUsage(transcript), 99);
  });

  it('returns null when no usage frame appears', () => {
    const transcript = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    assert.equal(parseStreamingUsage(transcript), null);
  });

  it('ignores malformed data lines', () => {
    const transcript = [
      'data: not json at all',
      '',
      'data: ' + JSON.stringify({ usage: { total_tokens: 5 } }),
      '',
    ].join('\n');
    assert.equal(parseStreamingUsage(transcript), 5);
  });

  it('last usage wins when multiple appear', () => {
    const transcript = [
      'data: ' + JSON.stringify({ usage: { total_tokens: 10 } }),
      '',
      'data: ' + JSON.stringify({ usage: { total_tokens: 20 } }),
      '',
    ].join('\n');
    assert.equal(parseStreamingUsage(transcript), 20);
  });

  it('handles CRLF / extra blank lines between events', () => {
    const transcript = [
      'data: ' + JSON.stringify({ usage: { total_tokens: 42 } }),
      '',
      '',
      '',
    ].join('\n');
    assert.equal(parseStreamingUsage(transcript), 42);
  });
});
