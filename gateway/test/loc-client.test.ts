import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createLocClient, LocApiError } from '../src/loc/client.js';

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function withMockLoc(
  respond: (req: RecordedRequest) => { status: number; body?: unknown; rawBody?: string },
  fn: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const { status, body, rawBody } = respond(recorded);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(rawBody ?? JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('openJob sends X-API-Key and snake_case body, maps camelCase response', async () => {
  await withMockLoc(
    () => ({
      status: 201,
      body: {
        job_id: 'job-1',
        request_id: 'broker-request-1',
        work_id: 'work-1',
        broker_url: 'https://broker.example',
        protocol: 'paid-job/v1',
        transport: 'unary',
        work_unit: 'tokens',
        payment_envelope: 'cGF5bWVudA==',
        expected_value_wei: 1000,
        funded_value_wei: 2000,
        settle_endpoint: '/v1/jobs/job-1/settle',
        opened_at: '2026-06-06T00:00:00Z',
      },
    }),
    async (baseUrl, requests) => {
      const client = createLocClient({ baseUrl, apiKey: 'test-key', timeoutMs: 5000 });
      const job = await client.openJob({
        idempotencyKey: 'gateway-operation-1',
        capability: 'openai:chat-completions',
        offering: 'llama-3',
        transport: 'unary',
        estimatedUnits: 42,
      });
      assert.equal(job.jobId, 'job-1');
      assert.equal(job.brokerUrl, 'https://broker.example');
      assert.equal(job.requestId, 'broker-request-1');
      assert.equal(job.protocol, 'paid-job/v1');
      assert.equal(job.transport, 'unary');
      assert.equal(job.workUnit, 'tokens');
      assert.equal(job.paymentEnvelope, 'cGF5bWVudA==');
      assert.equal(job.expectedValueWei, '1000');

      assert.equal(requests.length, 1);
      const req = requests[0]!;
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/jobs');
      assert.equal(req.headers['x-api-key'], 'test-key');
      assert.equal(req.headers['idempotency-key'], 'gateway-operation-1');
      assert.deepEqual(JSON.parse(req.body), {
        capability: 'openai:chat-completions',
        offering: 'llama-3',
        transport: 'unary',
        estimated_units: 42,
      });
    },
  );
});

test('error envelope {error:{code,message}} maps to LocApiError', async () => {
  await withMockLoc(
    () => ({
      status: 402,
      body: { error: { code: 'insufficient_credit', message: 'top up required' } },
    }),
    async (baseUrl) => {
      const client = createLocClient({ baseUrl, apiKey: 'k', timeoutMs: 5000 });
      await assert.rejects(
        client.openJob({ idempotencyKey: 'key', capability: 'c', offering: 'o', transport: 'unary', estimatedUnits: 1 }),
        (err: unknown) => {
          assert.ok(err instanceof LocApiError);
          assert.equal(err.status, 402);
          assert.equal(err.code, 'insufficient_credit');
          assert.equal(err.message, 'top up required');
          return true;
        },
      );
    },
  );
});

test('request_id_reuse remains a typed LOC refusal', async () => {
  await withMockLoc(
    () => ({
      status: 409,
      body: {
        error: {
          code: 'request_id_reuse',
          message: 'idempotency key was already used with different content',
        },
      },
    }),
    async (baseUrl) => {
      const client = createLocClient({ baseUrl, apiKey: 'k', timeoutMs: 5000 });
      await assert.rejects(
        client.openJob({
          idempotencyKey: 'same-key',
          capability: 'different-capability',
          offering: 'o',
          transport: 'unary',
          estimatedUnits: 1,
        }),
        (err: unknown) => {
          assert.ok(err instanceof LocApiError);
          assert.equal(err.status, 409);
          assert.equal(err.code, 'request_id_reuse');
          return true;
        },
      );
    },
  );
});

test('openJob rejects drift or missing identity in a successful LOC response', async () => {
  await withMockLoc(
    () => ({
      status: 201,
      body: {
        job_id: 'job-1',
        request_id: '',
        work_id: 'work-1',
        broker_url: 'https://broker.example',
        protocol: 'paid-job/v1',
        transport: 'stream',
        work_unit: 'tokens',
        payment_envelope: 'payment',
        expected_value_wei: '1',
        funded_value_wei: '1',
        settle_endpoint: '/v1/jobs/job-1/settle',
        opened_at: '2026-08-21T00:00:00Z',
      },
    }),
    async (baseUrl) => {
      const client = createLocClient({ baseUrl, apiKey: 'k', timeoutMs: 5000 });
      await assert.rejects(
        client.openJob({ idempotencyKey: 'key', capability: 'c', offering: 'o', transport: 'unary', estimatedUnits: 1 }),
        (err: unknown) => {
          assert.ok(err instanceof LocApiError);
          assert.equal(err.code, 'loc_contract_invalid');
          assert.match(err.message, /transport drift/);
          return true;
        },
      );
    },
  );
});

test('legacy {detail} envelope maps to LocApiError with http_NNN code', async () => {
  await withMockLoc(
    () => ({ status: 401, body: { detail: 'missing credentials' } }),
    async (baseUrl) => {
      const client = createLocClient({ baseUrl, apiKey: 'k', timeoutMs: 5000 });
      await assert.rejects(client.listCapabilities(), (err: unknown) => {
        assert.ok(err instanceof LocApiError);
        assert.equal(err.status, 401);
        assert.equal(err.code, 'http_401');
        assert.equal(err.message, 'missing credentials');
        return true;
      });
    },
  );
});

test('unreachable LOC surfaces LocApiError with status 0', async () => {
  // Port 1 is essentially guaranteed closed.
  const client = createLocClient({
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'k',
    timeoutMs: 2000,
  });
  await assert.rejects(client.health(), (err: unknown) => {
    assert.ok(err instanceof LocApiError);
    assert.equal(err.status, 0);
    assert.equal(err.code, 'loc_unreachable');
    return true;
  });
});

test('settleJob hits the per-job settle path', async () => {
  await withMockLoc(
    () => ({
      status: 200,
      body: {
        job_id: 'job-9',
        work_id: 'work-9',
        actual_units: 7,
        billed_value_wei: 70,
        refund_wei: 30,
        outcome: 'committed',
        closed_at: '2026-06-06T00:00:01Z',
        cap_status: {
          session_pct_used: 1,
          spend_period_pct_used: 0.25,
          user_balance_pct_used: null,
          operator_pool_pct_used: null,
          will_refuse_next_refill: false,
          winddown_reason: null,
        },
      },
    }),
    async (baseUrl, requests) => {
      const client = createLocClient({ baseUrl, apiKey: 'k', timeoutMs: 5000 });
      const settlement = {
        payload: {
          actual_units: '7',
          job_id: 'broker-job-9',
          work_id: 'work-9',
          work_unit_name: 'tokens',
          outcome: 'committed',
        },
        signature: {
          algorithm: 'secp256k1' as const,
          canonicalization: 'jcs' as const,
          value: `0x${'ab'.repeat(65)}`,
        },
      };
      const settled = await client.settleJob('job-9', {
        actualUnits: 7,
        brokerJobId: 'broker-job-9',
        workUnit: 'tokens',
        outcome: 'committed',
        settlement,
      });
      assert.equal(settled.refundWei, '30');
      assert.equal(requests[0]!.url, '/v1/jobs/job-9/settle');
      assert.deepEqual(JSON.parse(requests[0]!.body), {
        actual_units: 7,
        broker_job_id: 'broker-job-9',
        work_unit: 'tokens',
        outcome: 'committed',
        settlement,
      });
    },
  );
});

test('settleJob rejects unsigned or cross-job evidence before making a request', async () => {
  await withMockLoc(
    () => ({ status: 500, body: {} }),
    async (baseUrl, requests) => {
      const client = createLocClient({ baseUrl, apiKey: 'k', timeoutMs: 5000 });
      await assert.rejects(
        client.settleJob('job-9', {
          actualUnits: 7,
          brokerJobId: 'broker-job-9',
          workUnit: 'tokens',
          settlement: {
            payload: {
              actual_units: '7',
              job_id: 'different-job',
              work_id: 'work-9',
              work_unit_name: 'tokens',
            },
            signature: {
              algorithm: 'secp256k1',
              canonicalization: 'jcs',
              value: `0x${'ab'.repeat(65)}`,
            },
          },
        }),
        (err: unknown) => {
          assert.ok(err instanceof LocApiError);
          assert.equal(err.code, 'loc_contract_invalid');
          assert.match(err.message, /broker job identity drift/);
          return true;
        },
      );
      assert.equal(requests.length, 0);
    },
  );
});

test('large LOC wei integers are preserved without IEEE-754 rounding', async () => {
  await withMockLoc(
    () => ({
      status: 201,
      rawBody: '{"job_id":"job-large","request_id":"request-large",' +
        '"work_id":"work-large","broker_url":"https://broker.example",' +
        '"protocol":"paid-job/v1","transport":"unary","work_unit":"tokens",' +
        '"payment_envelope":"payment",' +
        '"expected_value_wei":123456789012345678901234567890,' +
        '"funded_value_wei":123456789012345678901234567891,' +
        '"settle_endpoint":"/v1/jobs/job-large/settle",' +
        '"opened_at":"2026-08-21T00:00:00Z"}',
    }),
    async (baseUrl) => {
      const client = createLocClient({ baseUrl, apiKey: 'k', timeoutMs: 5000 });
      const response = await client.openJob({
        idempotencyKey: 'key-large',
        capability: 'c',
        offering: 'o',
        transport: 'unary',
        estimatedUnits: 1,
      });
      assert.equal(response.expectedValueWei, '123456789012345678901234567890');
      assert.equal(response.fundedValueWei, '123456789012345678901234567891');
    },
  );
});

test('listCapabilities flattens snake_case payload', async () => {
  await withMockLoc(
    () => ({
      status: 200,
      body: {
        items: [
          {
            name: 'openai:chat-completions',
            work_unit: 'tokens',
            offerings: [
              {
                id: 'llama-3',
                price_per_work_unit_wei: '100',
                work_unit: 'tokens',
                protocol: 'paid-job/v1',
                job: { transports: ['unary', 'stream'] },
              },
            ],
          },
        ],
      },
    }),
    async (baseUrl) => {
      const client = createLocClient({ baseUrl, apiKey: 'k', timeoutMs: 5000 });
      const caps = await client.listCapabilities();
      assert.equal(caps.length, 1);
      assert.equal(caps[0]!.name, 'openai:chat-completions');
      assert.equal(caps[0]!.offerings[0]!.id, 'llama-3');
      assert.equal(caps[0]!.offerings[0]!.pricePerWorkUnitWei, '100');
      assert.equal(caps[0]!.offerings[0]!.protocol, 'paid-job/v1');
      assert.deepEqual(caps[0]!.offerings[0]!.transports, ['unary', 'stream']);
    },
  );
});
