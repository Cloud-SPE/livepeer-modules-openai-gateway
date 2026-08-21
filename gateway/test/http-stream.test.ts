import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { sendStreaming } from '../src/proxy/livepeer/http-stream.js';

test('stream handle arrives before completion and needs no terminal trailer', async () => {
  let releaseFinal!: () => void;
  const finalGate = new Promise<void>((resolve) => { releaseFinal = resolve; });
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Livepeer-Job-Id': 'broker-job-1',
      'Livepeer-Work-Unit': 'tokens',
    });
    response.flushHeaders();
    response.write('data: first\n\n');
    void finalGate.then(() => response.end('data: [DONE]\n\n'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const handle = await sendStreaming({
      brokerUrl: `http://127.0.0.1:${port}`,
      capability: 'openai:chat-completions',
      offering: 'model',
      paymentBlob: 'payment',
      body: '{}',
      contentType: 'application/json',
      requestId: 'request-1',
    });
    assert.equal(handle.jobId, 'broker-job-1');
    const iterator = handle.stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(Buffer.from(first.value as Uint8Array).toString(), 'data: first\n\n');

    releaseFinal();
    const second = await iterator.next();
    assert.equal(Buffer.from(second.value as Uint8Array).toString(), 'data: [DONE]\n\n');
    const terminal = await handle.done();
    assert.deepEqual(terminal, { trailers: {}, workUnits: 0 });
  } finally {
    releaseFinal();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
