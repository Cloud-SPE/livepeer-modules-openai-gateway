import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import { dispatchReqresp } from '../src/proxy/service/routeDispatch.js';
import type { RouteCandidate, RouteSelector } from '../src/proxy/service/routeSelector.js';
import * as payment from '../src/proxy/livepeer/payment.js';

test('dispatchReqresp reports INVALID_RECIPIENT_RAND and retries once with a fresh payment', async (t) => {
  const calls: Array<{ method: string; workId?: string; payment?: string }> = [];
  const sock = `/tmp/livepeer-openai-payment-retry-${process.pid}-${Date.now()}.sock`;
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
    livepeer: {
      payments: {
        v1: {
          PayerDaemon: { service: grpc.ServiceDefinition };
          Payment: { serialize: (value: unknown) => Buffer };
        };
      };
    };
  };

  let createCount = 0;
  const server = new grpc.Server();
  server.addService(proto.livepeer.payments.v1.PayerDaemon.service, {
    createPayment: (_call: unknown, cb: grpc.sendUnaryData<unknown>) => {
      createCount += 1;
      const randHash = createCount === 1 ? Buffer.from('aa'.repeat(32), 'hex') : Buffer.from('bb'.repeat(32), 'hex');
      const workId = randHash.toString('hex');
      calls.push({ method: 'createPayment', workId });
      cb(null, {
        paymentBytes: proto.livepeer.payments.v1.Payment.serialize({
          ticketParams: {
            recipientRandHash: randHash,
          },
        }),
        ticketsCreated: 1,
        expectedValue: { value: Buffer.from([0x01]) },
        fundedValueWei: { value: Buffer.from([0x01]) },
        acceptedQuoteRef: {
          quoteId: 'quote-123',
          quoteVersion: 7,
          constraintFingerprint: Buffer.from([0xaa]),
          routeFingerprint: Buffer.from([0xbb]),
        },
        work_id: workId,
      });
    },
    reportPaymentResult: (
      call: { request: { workId: string; rejectionReason: string } },
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      calls.push({ method: 'reportPaymentResult', workId: call.request.workId });
      cb(
        {
          name: 'Error',
          message: 'payment session rotated; retry exactly once',
          code: grpc.status.ABORTED,
          details: 'payment session rotated; retry exactly once',
        } as grpc.ServiceError,
        null,
      );
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

  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    fetchCount += 1;
    calls.push({ method: 'fetch', payment: new Headers(init?.headers).get('Livepeer-Payment') ?? undefined });
    if (fetchCount === 1) {
      return new Response(
        JSON.stringify({
          error: 'payment_invalid',
          message: 'process payment: INVALID_RECIPIENT_RAND',
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'Livepeer-Error': 'payment_invalid',
          },
        },
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }) as typeof fetch;

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((res) => server.tryShutdown(() => res()));
    payment.shutdown();
  });

  await payment.init({ socketPath: sock, protoRoot });

  const outcomes: Array<{ ok: boolean; retryable: boolean; reason?: string }> = [];
  const candidate: RouteCandidate = {
    brokerUrl: 'https://broker-a.example.com',
    capability: 'openai:chat-completions',
    offering: 'qwen3.6-27b',
    model: 'qwen3.6-27b',
    interactionMode: null,
    ethAddress: '0x1111111111111111111111111111111111111111',
    pricePerWorkUnitWei: '1000',
    workUnit: 'tokens',
    unitsPerPrice: 10,
    quoteId: 'quote-123',
    quoteVersion: 7,
    constraintFingerprint: new Uint8Array([0xaa]),
    routeFingerprint: new Uint8Array([0xbb]),
    extra: null,
    constraints: null,
  };
  const routeSelector: RouteSelector = {
    async select(): Promise<RouteCandidate[]> {
      return [candidate];
    },
    recordOutcome(_candidate, outcome, reason): void {
      outcomes.push({ ...outcome, reason });
    },
    inspectHealth() {
      return [];
    },
    inspectMetrics() {
      return {
        attemptsTotal: 0,
        successesTotal: 0,
        retryableFailuresTotal: 0,
        nonRetryableFailuresTotal: 0,
        cooldownsOpenedTotal: 0,
        totalCandidates: 0,
        healthyCandidates: 0,
        coolingCandidates: 0,
      };
    },
  };

  const result = await dispatchReqresp({
    routeSelector,
    request: {} as never,
    capability: candidate.capability,
    offering: candidate.offering,
    estimatedUnits: 25,
    body: JSON.stringify({ model: candidate.offering }),
    contentType: 'application/json',
    requestId: 'req-123',
  });

  assert.equal(result.result.status, 200);
  assert.equal(fetchCount, 2);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['createPayment', 'fetch', 'reportPaymentResult', 'createPayment', 'fetch'],
  );
  assert.deepEqual(
    calls.filter((call) => call.method === 'reportPaymentResult').map((call) => call.workId),
    [Buffer.from('aa'.repeat(32), 'hex').toString('hex')],
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.ok, true);
});

function locateProtoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'proto');
}
