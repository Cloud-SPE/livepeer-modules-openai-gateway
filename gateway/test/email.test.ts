import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { createEmailClient } from '../src/email/index.js';

test('email client uses the Resend SDK against a compatible API origin', async () => {
  const requests: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        authorization: String(req.headers.authorization ?? ''),
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"id":"email-1"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const client = createEmailClient({
      apiKey: 'frs_test',
      baseUrl: `http://127.0.0.1:${address.port}/`,
      fromEmail: 'info@loc.cloudspe.com',
      log: console,
    });
    await client.sendVerification({
      email: 'recipient@example.com',
      name: 'Recipient',
      token: 'verify-token',
      baseUrl: 'http://127.0.0.1:4001',
    });

    const request = requests[0];
    assert.ok(request);
    assert.equal(request.url, '/emails');
    assert.equal(request.authorization, 'Bearer frs_test');
    assert.equal(request.body['from'], 'info@loc.cloudspe.com');
    assert.equal(request.body['to'], 'recipient@example.com');
    assert.match(String(request.body['text']), /verify-token/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('email client surfaces Resend-compatible API errors', async () => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end('{"name":"validation_error","message":"sender is not allowed","statusCode":403}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const client = createEmailClient({
      apiKey: 'frs_test',
      baseUrl: `http://127.0.0.1:${address.port}`,
      fromEmail: 'info@loc.cloudspe.com',
      log: console,
    });
    await assert.rejects(
      client.sendApiKey({
        email: 'recipient@example.com',
        name: 'Recipient',
        plaintextKey: 'sk-test',
        portalUrl: 'http://127.0.0.1:4001/portal/',
      }),
      /sender is not allowed/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
