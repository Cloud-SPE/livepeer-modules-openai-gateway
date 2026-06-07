import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { dispatchReqresp, jobRefFromError } from '../src/loc/dispatch.js';
import { LocApiError, type LocClient, type OpenJobResponse, type SettleJobRequest } from '../src/loc/client.js';
import { LivepeerBrokerError } from '../src/proxy/livepeer/errors.js';

interface BrokerRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

async function withMockBroker(
  status: number | ((call: number) => number),
  fn: (brokerUrl: string, requests: BrokerRequest[]) => Promise<void>,
): Promise<void> {
  const requests: BrokerRequest[] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    req.resume();
    req.on('end', () => {
      const code = typeof status === 'function' ? status(requests.length) : status;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(code >= 400 ? { message: 'boom' } : { ok: true }));
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
  settles: Array<{ jobId: string; req: SettleJobRequest }>;
}

function fakeLoc(
  openImpl: (call: number) => OpenJobResponse | LocApiError,
): { loc: LocClient; calls: FakeLocCalls } {
  const calls: FakeLocCalls = { opens: 0, settles: [] };
  const loc: LocClient = {
    async openJob() {
      calls.opens += 1;
      const out = openImpl(calls.opens);
      if (out instanceof LocApiError) throw out;
      return out;
    },
    async settleJob(jobId, req) {
      calls.settles.push({ jobId, req });
      return {
        jobId,
        workId: 'w',
        actualUnits: req.actualUnits,
        billedValueWei: '0',
        refundWei: '0',
        outcome: req.outcome ?? '',
        closedAt: '',
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

function job(brokerUrl: string, n: number, mode = 'http-reqresp@v0'): OpenJobResponse {
  return {
    jobId: `job-${n}`,
    workId: `work-${n}`,
    brokerUrl,
    mode,
    paymentEnvelope: `envelope-${n}`,
    expectedValueWei: '100',
    fundedValueWei: '100',
    settleEndpoint: `/v1/jobs/job-${n}/settle`,
    openedAt: '',
  };
}

test('success: opens one job, sends payment envelope to broker, returns jobRef', async () => {
  await withMockBroker(200, async (brokerUrl, brokerRequests) => {
    const { loc, calls } = fakeLoc(() => job(brokerUrl, 1));
    const out = await dispatchReqresp({
      loc,
      capability: 'openai:chat-completions',
      offering: 'llama-3',
      estimatedUnits: 10,
      requestId: 'req-1',
      body: '{}',
      contentType: 'application/json',
    });
    assert.equal(calls.opens, 1);
    assert.equal(calls.settles.length, 0);
    assert.deepEqual(out.jobRef, { jobId: 'job-1', workId: 'work-1' });
    assert.equal(out.candidate.brokerUrl, brokerUrl);
    assert.equal(out.candidate.model, 'llama-3');
    assert.equal(brokerRequests.length, 1);
    assert.equal(brokerRequests[0]!.headers['livepeer-payment'], 'envelope-1');
  });
});

test('mode mismatch: settles 0 and retries with a fresh job', async () => {
  await withMockBroker(200, async (brokerUrl) => {
    const { loc, calls } = fakeLoc((n) =>
      n === 1 ? job(brokerUrl, 1, 'http-stream@v0') : job(brokerUrl, 2),
    );
    const out = await dispatchReqresp({
      loc,
      capability: 'c',
      offering: 'o',
      estimatedUnits: 1,
      requestId: 'r',
      body: null,
    });
    assert.equal(calls.opens, 2);
    assert.equal(calls.settles.length, 1);
    assert.equal(calls.settles[0]!.jobId, 'job-1');
    assert.equal(calls.settles[0]!.req.actualUnits, 0);
    assert.equal(calls.settles[0]!.req.outcome, 'mode_mismatch');
    assert.equal(out.jobRef.jobId, 'job-2');
  });
});

test('broker 5xx: retries with fresh jobs, settles intermediates, final error carries jobRef', async () => {
  await withMockBroker(500, async (brokerUrl) => {
    const { loc, calls } = fakeLoc((n) => job(brokerUrl, n));
    await assert.rejects(
      dispatchReqresp({
        loc,
        capability: 'c',
        offering: 'o',
        estimatedUnits: 1,
        requestId: 'r',
        maxJobAttempts: 3,
        body: null,
      }),
      (err: unknown) => {
        assert.ok(err instanceof LivepeerBrokerError);
        // Final job's ref is attached for the handler's durable settle.
        assert.deepEqual(jobRefFromError(err), { jobId: 'job-3', workId: 'work-3' });
        return true;
      },
    );
    assert.equal(calls.opens, 3);
    // Intermediate jobs (1, 2) settled inline; final job left to the handler.
    assert.deepEqual(
      calls.settles.map((s) => s.jobId),
      ['job-1', 'job-2'],
    );
  });
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
        requestId: 'r',
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
      requestId: 'r',
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
      requestId: 'r',
      maxJobAttempts: 3,
      body: null,
    }),
  );
  assert.equal(calls.opens, 3);
});
