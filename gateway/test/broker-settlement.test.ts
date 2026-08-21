import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  BrokerSettlementContractError,
  decodeSignedSettlement,
  lookupBrokerSettlement,
} from '../src/loc/brokerSettlement.js';
import type { PendingSettlementLookup } from '../src/repo/usageReservations.js';

function encodeEnvelope(overrides: Record<string, unknown> = {}): string {
  const payload = {
    actual_units: '42',
    debited_units: '40',
    billed_value_wei: { value: Buffer.from([0x01, 0x00]).toString('base64') },
    outcome: 'EXACT',
    request_id: 'request-1',
    job_id: 'broker-job-1',
    work_id: 'payment-work-1',
    work_unit_name: 'tokens',
    ...overrides,
  };
  return Buffer.from(JSON.stringify({
    payload,
    signature: {
      algorithm: 'secp256k1',
      canonicalization: 'jcs',
      value: `0x${'ab'.repeat(65)}`,
    },
  })).toString('base64');
}

function row(overrides: Partial<PendingSettlementLookup> = {}): PendingSettlementLookup {
  return {
    id: 'reservation-1',
    brokerUrl: 'http://unused.invalid',
    brokerJobId: 'broker-job-1',
    locRequestId: 'request-1',
    paymentWorkId: 'payment-work-1',
    workUnit: 'tokens',
    attempts: 0,
    ...overrides,
  };
}

async function withBroker(
  responder: (url: string) => { status: number; body: unknown },
  fn: (url: string, paths: string[]) => Promise<void>,
): Promise<void> {
  const paths: string[] = [];
  const server: Server = createServer((req, response) => {
    paths.push(req.url ?? '');
    const result = responder(req.url ?? '');
    response.writeHead(result.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`, paths);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('decodes exact signed job identity, usage, and BigUInt value', () => {
  const settlement = decodeSignedSettlement(encodeEnvelope());
  assert.equal(settlement.requestId, 'request-1');
  assert.equal(settlement.brokerJobId, 'broker-job-1');
  assert.equal(settlement.paymentWorkId, 'payment-work-1');
  assert.equal(settlement.actualUnits, '42');
  assert.equal(settlement.debitedUnits, '40');
  assert.equal(settlement.billedValueWei, '256');
});

test('queries a known job and returns its signed terminal evidence', async () => {
  const encoded = encodeEnvelope();
  await withBroker(
    () => ({
      status: 200,
      body: {
        job_id: 'broker-job-1',
        state: 'terminal',
        work_units: 42,
        unit: 'tokens',
        settlement: encoded,
      },
    }),
    async (brokerUrl, paths) => {
      const result = await lookupBrokerSettlement(row({ brokerUrl }), 5000);
      assert.equal(result.kind, 'evidence');
      assert.deepEqual(paths, ['/v1/settlement/broker-job-1']);
    },
  );
});

test('falls back to request-id exchange recovery before broker job id is known', async () => {
  const encoded = encodeEnvelope();
  await withBroker(
    () => ({
      status: 200,
      body: {
        outcome: 'SETTLED',
        job_id: 'broker-job-1',
        state: 'terminal',
        unit: 'tokens',
        settlement: encoded,
      },
    }),
    async (brokerUrl, paths) => {
      const result = await lookupBrokerSettlement(row({ brokerUrl, brokerJobId: null }), 5000);
      assert.equal(result.kind, 'evidence');
      assert.deepEqual(paths, ['/v1/exchange/request-1']);
    },
  );
});

test('accounting_pending remains a deferred lookup state', async () => {
  await withBroker(
    () => ({
      status: 202,
      body: { job_id: 'broker-job-1', state: 'accounting_pending', debit_attempts: 3 },
    }),
    async (brokerUrl) => {
      const result = await lookupBrokerSettlement(row({ brokerUrl }), 5000);
      assert.deepEqual(result, {
        kind: 'deferred',
        state: 'accounting_pending',
        detail: 'broker debit pending after 3 attempts',
      });
    },
  );
});

test('response metadata cannot disagree with signed evidence', async () => {
  await withBroker(
    () => ({
      status: 200,
      body: {
        job_id: 'different-job',
        state: 'terminal',
        unit: 'tokens',
        settlement: encodeEnvelope(),
      },
    }),
    async (brokerUrl) => {
      await assert.rejects(
        lookupBrokerSettlement(row({ brokerUrl }), 5000),
        BrokerSettlementContractError,
      );
    },
  );
});

test('unsigned settlement envelopes are rejected', () => {
  const encoded = Buffer.from(JSON.stringify({ payload: { job_id: 'x' } })).toString('base64');
  assert.throws(() => decodeSignedSettlement(encoded), BrokerSettlementContractError);
});
