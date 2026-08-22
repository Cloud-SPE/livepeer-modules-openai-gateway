import assert from 'node:assert/strict';
import test from 'node:test';

import {
  estimateCeilingSeconds,
  probeDuration,
} from '../src/proxy/service/audioDuration/index.js';

const exactFixtures = [
  { format: 'wav', ceiling: 1, bytes: wavPcm(8_000, 3_200) },
  {
    format: 'flac',
    ceiling: 7,
    bytes: fromBase64('ZkxhQwAAACIAAAAAAAAAAAAACsRA8AAEtdwAAAAAAAAAAAAAAAAAAAAA'),
  },
  {
    format: 'mp4',
    ceiling: 13,
    bytes: fromBase64('AAAAEGZ0eXBNNEEgaXNvbQAAACRtb292AAAAHG12aGQAAAAAAAAAAAAAAAAAAAPoAAAw1A=='),
  },
  {
    format: 'webm',
    ceiling: 10,
    bytes: fromBase64('GkXfo4QAAAAAGFOAZwEAAAAAAAAjFUmpZgEAAAAAAAAXKtexiAAAAAAAD0JARImIQMKOAAAAAAA='),
  },
  {
    format: 'mp3',
    ceiling: 4,
    bytes: fromBase64('//uQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAAEAAACZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='),
  },
  { format: 'ogg', ceiling: 1, bytes: oggOpusOneSecond() },
] as const;

for (const fixture of exactFixtures) {
  test(`locally owned audio estimator measures ${fixture.format}`, () => {
    const result = probeDuration(fixture.bytes);
    assert.equal(result.format, fixture.format);
    assert.equal(result.exact, true);
    assert.equal(estimateCeilingSeconds(fixture.bytes), fixture.ceiling);
  });
}

test('locally owned estimator refuses inexact headerless MP3', () => {
  const bytes = Buffer.alloc(128);
  bytes.set([0xff, 0xfb, 0x90, 0xc0]);
  assert.equal(probeDuration(bytes).exact, false);
  assert.throws(() => estimateCeilingSeconds(bytes), /estimate, not a measurement/);
});

for (const bytes of [
  fromBase64('ZkxhQwAAACIAAAAAAAAAAAAACsRA8AAAAAAAAAAAAAAAAAAAAAAAAAAA'),
  fromBase64('AAAAEGZ0eXBNNEEgaXNvbQAAACRtb292AAAAHG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAA=='),
  fromBase64('dGhpcyBpcyBub3QgYW4gYXVkaW8gY29udGFpbmVyIGF0IGFsbA=='),
  fromBase64('UklGRiR3AQBXQVZFZm10IBAAAAA='),
]) {
  test('locally owned estimator refuses malformed or unsupported media', () => {
    assert.throws(() => estimateCeilingSeconds(bytes));
  });
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

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

function oggOpusOneSecond(): Buffer {
  const out = Buffer.alloc(36);
  out.write('OggS', 0, 'ascii');
  out.writeBigUInt64LE(48_000n, 6);
  out[26] = 1;
  out[27] = 8;
  out.write('OpusHead', 28, 'ascii');
  return out;
}
