import { createHash } from 'node:crypto';
import { routeSnapshot } from './wholesale-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  dispatchMultipart,
  dispatchReqresp,
  isAccountingReplay,
  jobRefFromError,
} from '../src/loc/dispatch.js';
import { LocApiError, type LocClient, type OpenJobRequest, type OpenJobResponse, type SettleJobRequest } from '../src/loc/client.js';
import { LivepeerBrokerError } from '../src/proxy/livepeer/errors.js';

interface BrokerRequest {
  url: string;
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

async function withMockBroker(
  status: number | ((call: number) => number),
  fn: (brokerUrl: string, requests: BrokerRequest[]) => Promise<void>,
  successBody: unknown = { ok: true },
): Promise<void> {
  const requests: BrokerRequest[] = [];
  const server: Server = createServer((req, res) => {
    const recorded = { url: req.url ?? '', headers: req.headers, body: Buffer.alloc(0) };
    requests.push(recorded);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      recorded.body = Buffer.concat(chunks);
      const code = typeof status === 'function' ? status(requests.length) : status;
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Livepeer-Job-Id': `broker-job-${requests.length}`,
        'Livepeer-Work-Unit': 'tokens',
        'Livepeer-Work-Units': code >= 400 ? '0' : '1',
        ...(code === 409 ? { 'Livepeer-Error': 'job_in_flight' } : {}),
      });
      res.end(JSON.stringify(code >= 400 ? { message: 'boom' } : successBody));
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

interface FakeLocCalls {
  opens: number;
  openRequests: OpenJobRequest[];
  settles: Array<{ settleEndpoint: string; jobId: string; req: SettleJobRequest }>;
}

function fakeLoc(
  openImpl: (call: number) => OpenJobResponse | LocApiError,
): { loc: LocClient; calls: FakeLocCalls } {
  const calls: FakeLocCalls = { opens: 0, openRequests: [], settles: [] };
  const loc: LocClient = {
    async getJob() { throw new Error('unused'); },
    async openJob(req) {
      calls.opens += 1;
      calls.openRequests.push(req);
      const out = openImpl(calls.opens);
      if (out instanceof LocApiError) throw out;
      return out;
    },
    async settleJob(settleEndpoint, jobId, req) {
      calls.settles.push({ settleEndpoint, jobId, req });
      return {
        jobId,
        workId: 'w',
        actualUnits: req.actualUnits,
        billedValueWei: '0',
        refundWei: '0',
        outcome: req.outcome ?? '',
        closedAt: '',
        capStatus: {
          sessionPctUsed: 0,
          spendPeriodPctUsed: null,
          userBalancePctUsed: null,
          operatorPoolPctUsed: null,
          willRefuseNextRefill: false,
          winddownReason: null,
        },
      };
    },
    async listCapabilities() {
      return [];
    },
    async listOrchestrators() {
      return [];
    },
    async getBalance() {
      return { amountWei: '0' };
    },
    async health() {
      return { status: 'ok', version: 'test', env: 'test' };
    },
  };
  return { loc, calls };
}

function job(
  brokerUrl: string,
  n: number,
  transport: OpenJobResponse['transport'] = 'unary',
): OpenJobResponse {
  return {
    jobId: `job-${n}`,
    requestId: `broker-request-${n}`,
    workId: `work-${n}`,
    brokerUrl,
    protocol: 'paid-job/v1',
    transport,
    workUnit: 'tokens',
    spendAuthorization: Buffer.from(`authorization-${n}`).toString('base64'),
    accountingMode: 'wholesale_account',
    routeSnapshot: routeSnapshot(brokerUrl),
    expectedValueWei: '100',
    fundedValueWei: '100',
    settleEndpoint: `/v1/jobs/job-${n}/settle`,
    openedAt: '',
  };
}

test('multipart uses the same paid-job endpoint and preserves the upload content type', async () => {
  await withMockBroker(200, async (brokerUrl, brokerRequests) => {
    const { loc, calls } = fakeLoc(() => job(brokerUrl, 1, 'multipart'));
    const out = await dispatchMultipart({
      loc,
      capability: 'openai:audio-transcriptions',
      offering: 'whisper',
      estimatedUnits: 3,
      maxTotalUnits: 4,
      idempotencyKey: 'multipart-operation',
      body: Buffer.from('--boundary--\r\n'),
      contentType: 'multipart/form-data; boundary=boundary',
    });
    assert.deepEqual(calls.openRequests, [{
      idempotencyKey: 'multipart-operation',
      workloadRequestDigest: createHash('sha256').update('--boundary--\r\n').digest('hex'),
      callerPublicKey: calls.openRequests[0]!.callerPublicKey,
      capability: 'openai:audio-transcriptions',
      offering: 'whisper',
      transport: 'multipart',
      estimatedUnits: 3,
      maxTotalUnits: 4,
    }]);
    assert.equal(brokerRequests[0]!.url, '/v1/job');
    assert.equal(
      brokerRequests[0]!.headers['content-type'],
      'multipart/form-data; boundary=boundary',
    );
    assert.equal(brokerRequests[0]!.headers['livepeer-protocol'], 'paid-job/v1');
    assert.equal(createHash('sha256').update(brokerRequests[0]!.body).digest('hex'), calls.openRequests[0]!.workloadRequestDigest);
    assert.equal(out.jobRef.transport, 'multipart');
    assert.equal(out.jobRef.brokerJobId, 'broker-job-1');
  });
});

test('success: opens one job, sends authorization and caller proof to broker, returns jobRef', async () => {
  await withMockBroker(200, async (brokerUrl, brokerRequests) => {
    const { loc, calls } = fakeLoc(() => job(brokerUrl, 1));
    const out = await dispatchReqresp({
      loc,
      capability: 'openai:chat-completions',
      offering: 'llama-3',
      estimatedUnits: 10,
      idempotencyKey: 'req-1',
      body: '{}',
      contentType: 'application/json',
    });
    assert.equal(calls.opens, 1);
    assert.equal(calls.settles.length, 0);
    assert.deepEqual(out.jobRef, {
      idempotencyKey: 'req-1',
      spendAuthorization: Buffer.from('authorization-1').toString('base64'),
      accountingMode: 'wholesale_account',
      routeSnapshot: routeSnapshot(brokerUrl),
      jobId: 'job-1',
      brokerJobId: 'broker-job-1',
      requestId: 'broker-request-1',
      workId: 'work-1',
      protocol: 'paid-job/v1',
      transport: 'unary',
      workUnit: 'tokens',
      settleEndpoint: '/v1/jobs/job-1/settle',
      brokerUrl,
      capability: 'openai:chat-completions',
      offering: 'llama-3',
    });
    assert.equal(out.candidate.brokerUrl, brokerUrl);
    assert.equal(out.candidate.model, 'llama-3');
    assert.equal(brokerRequests.length, 1);
    assert.equal(brokerRequests[0]!.url, '/v1/job');
    assert.equal(brokerRequests[0]!.headers['livepeer-payment'], undefined);
    assert.equal(brokerRequests[0]!.headers['livepeer-authorization'], Buffer.from('authorization-1').toString('base64'));
    assert.ok(brokerRequests[0]!.headers['livepeer-caller-proof']);
    assert.equal(brokerRequests[0]!.headers['livepeer-protocol'], 'paid-job/v1');
    assert.equal(brokerRequests[0]!.headers['livepeer-request-id'], 'broker-request-1');
    assert.equal(brokerRequests[0]!.headers['livepeer-mode'], undefined);
    assert.equal(brokerRequests[0]!.headers['livepeer-spec-version'], undefined);
  });
});

test('persists LOC identity before send and broker identity after admission', async () => {
  await withMockBroker(200, async (brokerUrl) => {
    const { loc } = fakeLoc(() => job(brokerUrl, 1));
    const updates: string[] = [];
    await dispatchReqresp({
      loc,
      capability: 'c',
      offering: 'o',
      estimatedUnits: 1,
      idempotencyKey: 'request-1',
      body: null,
      onJobUpdate: async (ref) => { updates.push(ref.brokerJobId); },
    });
    assert.deepEqual(updates, ['', 'broker-job-1']);
  });
});

test('accounting-only replay marker is not treated as an OpenAI response', () => {
  const body = new TextEncoder().encode('{"replayed":true,"job_id":"broker-job-1"}');
  assert.equal(isAccountingReplay({ body, headers: new Headers() }, 'unary'), true);
  assert.equal(
    isAccountingReplay(
      { headers: { 'content-type': 'application/json' } },
      'stream',
    ),
    true,
  );
  assert.equal(
    isAccountingReplay(
      { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
      'stream',
    ),
    false,
  );
});

test('accounting-only replay schedules the original job and fails without resubmission', async () => {
  await withMockBroker(
    200,
    async (brokerUrl, brokerRequests) => {
      const { loc, calls } = fakeLoc(() => job(brokerUrl, 1));
      const updates: string[] = [];
      await assert.rejects(
        dispatchReqresp({
          loc,
          capability: 'c',
          offering: 'o',
          estimatedUnits: 1,
          idempotencyKey: 'operation-1',
          body: '{}',
          onJobUpdate: async (ref) => { updates.push(ref.brokerJobId); },
        }),
        (error: unknown) => {
          assert.ok(error instanceof LivepeerBrokerError);
          assert.equal(error.code, 'upstream_response_lost');
          assert.equal(jobRefFromError(error)?.brokerJobId, 'broker-job-1');
          return true;
        },
      );
      assert.equal(calls.opens, 1);
      assert.equal(brokerRequests.length, 1);
      assert.deepEqual(updates, ['', 'broker-job-1']);
    },
    { replayed: true, job_id: 'broker-job-1' },
  );
});

test('broker 5xx does not create or compensate a fresh LOC job', async () => {
  await withMockBroker(500, async (brokerUrl) => {
    const { loc, calls } = fakeLoc((n) => job(brokerUrl, n));
    const updates: string[] = [];
    await assert.rejects(
      dispatchReqresp({
        loc,
        capability: 'c',
        offering: 'o',
        estimatedUnits: 1,
        idempotencyKey: 'r',
        maxJobAttempts: 3,
        body: null,
        onJobUpdate: async (ref) => { updates.push(ref.brokerJobId); },
      }),
      (err: unknown) => {
        assert.ok(err instanceof LivepeerBrokerError);
        // Final job's ref is attached for the handler's durable settle.
        assert.equal(jobRefFromError(err)?.jobId, 'job-1');
        assert.equal(jobRefFromError(err)?.brokerJobId, 'broker-job-1');
        return true;
      },
    );
    assert.equal(calls.opens, 1);
    assert.deepEqual(calls.settles, []);
    assert.deepEqual(updates, ['', 'broker-job-1']);
  });
});

test('terminal broker error rejects nonzero work claims', async () => {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Livepeer-Job-Id': 'broker-job-bad',
        'Livepeer-Work-Unit': 'tokens',
        'Livepeer-Work-Units': '9',
      });
      res.end('{"message":"boom"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const brokerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { loc } = fakeLoc(() => job(brokerUrl, 1));
    await assert.rejects(
      dispatchReqresp({
        loc,
        capability: 'c',
        offering: 'o',
        estimatedUnits: 1,
        idempotencyKey: 'r',
        body: null,
      }),
      (err: unknown) => {
        assert.ok(err instanceof LivepeerBrokerError);
        assert.equal(err.code, 'protocol_response_invalid');
        assert.equal(jobRefFromError(err)?.brokerJobId, '');
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('broker 4xx: fails immediately without retry', async () => {
  await withMockBroker(400, async (brokerUrl) => {
    const { loc, calls } = fakeLoc((n) => job(brokerUrl, n));
    await assert.rejects(
      dispatchReqresp({
        loc,
        capability: 'c',
        offering: 'o',
        estimatedUnits: 1,
        idempotencyKey: 'r',
        body: null,
      }),
      (err: unknown) => {
        assert.ok(err instanceof LivepeerBrokerError);
        assert.equal(err.status, 400);
        return true;
      },
    );
    assert.equal(calls.opens, 1);
  });
});

test('broker idempotency refusal is exposed as a typed outcome', async () => {
  await withMockBroker(409, async (brokerUrl) => {
    const { loc, calls } = fakeLoc(() => job(brokerUrl, 1));
    await assert.rejects(
      dispatchReqresp({
        loc,
        capability: 'c',
        offering: 'o',
        estimatedUnits: 1,
        idempotencyKey: 'r',
        body: null,
      }),
      (err: unknown) => {
        assert.ok(err instanceof LivepeerBrokerError);
        assert.equal(err.code, 'job_in_flight');
        return true;
      },
    );
    assert.equal(calls.opens, 1);
  });
});

test('unsupported transport refusal remains pre-admission and never creates accounting evidence', async () => {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'Livepeer-Error': 'protocol_transport_unsupported',
        'Livepeer-Request-Id': 'broker-request-1',
        'Livepeer-Work-Unit': 'tokens',
        'Livepeer-Work-Units': '0',
      });
      res.end('{"message":"stream is not declared"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const brokerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { loc, calls } = fakeLoc(() => job(brokerUrl, 1));
    await assert.rejects(
      dispatchReqresp({
        loc,
        capability: 'c',
        offering: 'o',
        estimatedUnits: 1,
        idempotencyKey: 'r',
        body: null,
      }),
      (err: unknown) => {
        assert.ok(err instanceof LivepeerBrokerError);
        assert.equal(err.code, 'protocol_transport_unsupported');
        assert.equal(err.jobId, undefined);
        assert.equal(jobRefFromError(err)?.brokerJobId, '');
        return true;
      },
    );
    assert.equal(calls.opens, 1);
    assert.deepEqual(calls.settles, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('LOC 402 insufficient_credit: throws immediately, no retry', async () => {
  const { loc, calls } = fakeLoc(
    () => new LocApiError({ status: 402, code: 'insufficient_credit', message: 'broke' }),
  );
  await assert.rejects(
    dispatchReqresp({
      loc,
      capability: 'c',
      offering: 'o',
      estimatedUnits: 1,
      idempotencyKey: 'r',
      body: null,
    }),
    (err: unknown) => {
      assert.ok(err instanceof LocApiError);
      assert.equal(err.code, 'insufficient_credit');
      assert.equal(jobRefFromError(err), null);
      return true;
    },
  );
  assert.equal(calls.opens, 1);
});

test('LOC 5xx: retried up to maxJobAttempts', async () => {
  const { loc, calls } = fakeLoc(
    () => new LocApiError({ status: 503, code: 'daemon_unavailable', message: 'down' }),
  );
  await assert.rejects(
    dispatchReqresp({
      loc,
      capability: 'c',
      offering: 'o',
      estimatedUnits: 1,
      idempotencyKey: 'r',
      maxJobAttempts: 3,
      body: null,
    }),
  );
  assert.equal(calls.opens, 3);
  assert.deepEqual(calls.openRequests, [
    { idempotencyKey: 'r', capability: 'c', offering: 'o', transport: 'unary', estimatedUnits: 1, workloadRequestDigest: createHash('sha256').update('').digest('hex'), callerPublicKey: calls.openRequests[0]!.callerPublicKey },
    { idempotencyKey: 'r', capability: 'c', offering: 'o', transport: 'unary', estimatedUnits: 1, workloadRequestDigest: createHash('sha256').update('').digest('hex'), callerPublicKey: calls.openRequests[0]!.callerPublicKey },
    { idempotencyKey: 'r', capability: 'c', offering: 'o', transport: 'unary', estimatedUnits: 1, workloadRequestDigest: createHash('sha256').update('').digest('hex'), callerPublicKey: calls.openRequests[0]!.callerPublicKey },
  ]);
});

test('LOC timeout retries preserve the identical idempotency key and content', async () => {
  const { loc, calls } = fakeLoc(
    () => new LocApiError({ status: 0, code: 'loc_unreachable', message: 'timed out' }),
  );
  await assert.rejects(
    dispatchReqresp({
      loc,
      capability: 'c',
      offering: 'o',
      estimatedUnits: 9,
      idempotencyKey: 'stable-operation',
      maxJobAttempts: 3,
      body: null,
    }),
  );
  assert.equal(calls.opens, 3);
  assert.equal(new Set(calls.openRequests.map((request) => JSON.stringify(request))).size, 1);
  assert.equal(calls.openRequests[0]!.idempotencyKey, 'stable-operation');
});

test('LOC in-progress replay is retried identically and may converge', async () => {
  const { loc, calls } = fakeLoc((attempt) => {
    if (attempt < 3) {
      return new LocApiError({
        status: 409,
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'mint is still in flight',
      });
    }
    return job('http://127.0.0.1:1', attempt);
  });
  await assert.rejects(
    dispatchReqresp({
      loc,
      capability: 'c',
      offering: 'o',
      estimatedUnits: 9,
      idempotencyKey: 'stable-in-flight-operation',
      maxJobAttempts: 3,
      body: null,
    }),
    /fetch failed|ECONNREFUSED/,
  );
  assert.equal(calls.opens, 3);
  assert.equal(new Set(calls.openRequests.map((request) => JSON.stringify(request))).size, 1);
  assert.equal(calls.openRequests[0]!.idempotencyKey, 'stable-in-flight-operation');
});


test('FormData is serialized once before durable open intent and broker dispatch', async()=>{
  await withMockBroker(200,async(brokerUrl,requests)=>{
    let prepared=false;
    const {loc,calls}=fakeLoc(()=>{assert.ok(prepared);return job(brokerUrl,1,'multipart');});
    const body=new FormData();body.append('model','runner');body.append('file',new Blob(['exact-bytes']),'test.wav');
    await dispatchMultipart({loc,capability:'c',offering:'o',estimatedUnits:1,idempotencyKey:'multipart',body,
      onJobPrepared:async()=>{prepared=true;}});
    assert.equal(calls.openRequests[0]!.workloadRequestDigest,createHash('sha256').update(requests[0]!.body).digest('hex'));
    assert.match(String(requests[0]!.headers['content-type']),/boundary=/);
    assert.equal(requests[0]!.headers['livepeer-payment'],undefined);
    assert.ok(requests[0]!.headers['livepeer-caller-proof']);
  });
});
