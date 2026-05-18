import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import * as payment from '../src/proxy/livepeer/payment.js';

interface CapturedCreatePayment {
  recipient: Buffer;
  ticketParamsBaseUrl?: string;
  acceptedPrice: {
    pricePerUnitWei: { value: Buffer };
    unitsPerPrice: number;
    workUnitName: string;
    capability: string;
    offering: string;
    quoteRef: {
      quoteId: string;
      quoteVersion: number;
      constraintFingerprint: Buffer;
      routeFingerprint: Buffer;
    };
  };
  funding: {
    estimatedUnits: number;
    fundedValueWei: { value: Buffer };
    maxTotalUnits: number;
    topUpAllowed: boolean;
  };
}

test('payment.buildPayment sends accepted_price and funding intent to payer-daemon', async (t) => {
  const captured: CapturedCreatePayment[] = [];
  const sock = `/tmp/livepeer-openai-payment-${process.pid}-${Date.now()}.sock`;
  const protoRoot = locateProtoRoot();
  const def = await protoLoader.load(
    [
      'livepeer/payments/v1/types.proto',
      'livepeer/payments/v1/payer_daemon.proto',
    ],
    {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [protoRoot],
    },
  );
  const proto = grpc.loadPackageDefinition(def) as unknown as {
    livepeer: { payments: { v1: { PayerDaemon: { service: grpc.ServiceDefinition } } } };
  };

  const server = new grpc.Server();
  server.addService(proto.livepeer.payments.v1.PayerDaemon.service, {
    createPayment: (call: { request: CapturedCreatePayment }, cb: grpc.sendUnaryData<unknown>) => {
      captured.push(call.request);
      cb(null, {
        paymentBytes: Buffer.from('test-payment-bytes'),
        ticketsCreated: 1,
        expectedValue: { value: Buffer.from([0x13, 0x88]) },
        fundedValueWei: { value: Buffer.from([0x13, 0x88]) },
        acceptedQuoteRef: {
          quoteId: 'quote-123',
          quoteVersion: 7,
          constraintFingerprint: Buffer.from([0xaa]),
          routeFingerprint: Buffer.from([0xbb]),
        },
      });
    },
    getDepositInfo: (_call: unknown, cb: grpc.sendUnaryData<unknown>) => cb(null, {}),
    getSessionDebits: (_call: unknown, cb: grpc.sendUnaryData<unknown>) =>
      cb(null, { totalWorkUnits: 0, debitCount: 0, closed: false }),
    health: (_call: unknown, cb: grpc.sendUnaryData<unknown>) => cb(null, { status: 'ok' }),
  });

  await new Promise<void>((res, rej) => {
    server.bindAsync(`unix:${sock}`, grpc.ServerCredentials.createInsecure(), (err) =>
      err ? rej(err) : res(),
    );
  });

  t.after(async () => {
    await new Promise<void>((res) => server.tryShutdown(() => res()));
    payment.shutdown();
  });

  await payment.init({ socketPath: sock, protoRoot });
  const blob = await payment.buildPayment({
    route: {
      capability: 'openai:chat-completions',
      offering: 'qwen3.6-27b',
      recipientHex: '0x1111111111111111111111111111111111111111',
      brokerUrl: 'https://broker-a.example.com',
      pricePerWorkUnitWei: '1000',
      workUnit: 'tokens',
      unitsPerPrice: 10,
      quoteId: 'quote-123',
      quoteVersion: 7,
      constraintFingerprint: new Uint8Array([0xaa]),
      routeFingerprint: new Uint8Array([0xbb]),
    },
    estimatedUnits: 25,
  });

  assert.equal(blob, Buffer.from('test-payment-bytes').toString('base64'));
  assert.equal(captured.length, 1);
  const req = captured[0]!;
  assert.equal(req.recipient.toString('hex'), '1111111111111111111111111111111111111111');
  assert.equal(req.ticketParamsBaseUrl, 'https://broker-a.example.com');
  assert.equal(req.acceptedPrice.capability, 'openai:chat-completions');
  assert.equal(req.acceptedPrice.offering, 'qwen3.6-27b');
  assert.equal(req.acceptedPrice.workUnitName, 'tokens');
  assert.equal(Number(req.acceptedPrice.unitsPerPrice), 10);
  assert.equal(req.acceptedPrice.quoteRef.quoteId, 'quote-123');
  assert.equal(Number(req.acceptedPrice.quoteRef.quoteVersion), 7);
  assert.equal(Number(req.funding.estimatedUnits), 25);
  assert.equal(Number(req.funding.maxTotalUnits), 25);
  assert.equal(req.funding.topUpAllowed, false);
  assert.equal(bufferToBigInt(req.acceptedPrice.pricePerUnitWei.value), 1000n);
  assert.equal(bufferToBigInt(req.funding.fundedValueWei.value), 3000n);
});

function locateProtoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'proto');
}

function bufferToBigInt(raw: Buffer): bigint {
  return raw.length === 0 ? 0n : BigInt(`0x${raw.toString('hex')}`);
}
