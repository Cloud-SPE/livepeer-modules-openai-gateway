import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  chatFunding,
  parseTotalTokens,
  pickModel,
} from '../src/proxy/chat.js';
import { textCodePoints } from '../src/proxy/audio-speech.js';
import {
  TRANSCRIPTION_ESTIMATOR_ID,
  transcriptionCeilingSeconds,
} from '../src/proxy/audio-transcriptions.js';
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

  it('uses the canonical exact multipart audio ceiling for transcription', () => {
    const wav = wavPcm(8_000, 4_000);
    const prefix = Buffer.from(
      '--b\r\nContent-Disposition: form-data; name="file"; filename="sample.wav"\r\n' +
        'Content-Type: audio/wav\r\n\r\n',
    );
    const body = Buffer.concat([prefix, wav, Buffer.from('\r\n--b--\r\n')]);
    assert.equal(TRANSCRIPTION_ESTIMATOR_ID, 'multipart-audio-duration/v1');
    assert.equal(
      transcriptionCeilingSeconds(body, 'multipart/form-data; boundary=b'),
      1,
    );
    assert.throws(() =>
      transcriptionCeilingSeconds(Buffer.from('not audio'), 'application/octet-stream'),
    );
  });
});

function wavPcm(sampleRate: number, samples: number): Buffer {
  const dataSize = samples * 2;
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataSize, 40);
  return out;
}

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
