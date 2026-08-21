// LOC-backed dispatch: open a clearinghouse job (route selection +
// payment minting in one call), forward to the returned broker, and
// hand the jobRef back to the route handler so it can enqueue the
// durable settle with actual units (see reservation.ts / settler.ts).
//
// Replaces the daemon-era routeDispatch.ts. The http-* send modules
// are unchanged — they only need brokerUrl + payment blob.

import * as httpMultipart from '../proxy/livepeer/http-multipart.js';
import * as httpReqresp from '../proxy/livepeer/http-reqresp.js';
import * as httpStream from '../proxy/livepeer/http-stream.js';
import { LocApiError, type JobTransport, type LocClient, type OpenJobResponse } from './client.js';

// Kept shape-compatible with the daemon-era RouteCandidate so the
// reservation/audit/admin surfaces compile unchanged. Fields the LOC
// job response does not carry (ethAddress, price, quote identity) are
// empty — the LOC owns quote/price bookkeeping now.
export interface RouteCandidate {
  brokerUrl: string;
  capability: string;
  offering: string;
  model: string | null;
  protocol: string;
  transports: Array<'unary' | 'stream' | 'multipart'>;
  ethAddress: string;
  pricePerWorkUnitWei: string;
  workUnit: string;
  unitsPerPrice: number;
  quoteId: string;
  quoteVersion: number;
  constraintFingerprint: Uint8Array;
  routeFingerprint: Uint8Array;
  extra: unknown;
  constraints: unknown;
}

/** Handle for settling the LOC job once actual units are known. */
export interface JobRef {
  jobId: string;
  requestId: string;
  workId: string;
  protocol: 'paid-job/v1';
  transport: JobTransport;
  workUnit: string;
  settleEndpoint: string;
}

export interface DispatchSuccess<T> {
  candidate: RouteCandidate;
  result: T;
  jobRef: JobRef;
}

interface DispatchCommon {
  loc: LocClient;
  capability: string;
  offering: string;
  estimatedUnits: number;
  requestId: string;
  /** Total job-open attempts (default 3 = 1 + 2 retries). */
  maxJobAttempts?: number;
}

interface ReqRespDispatch extends DispatchCommon {
  body: BodyInit | null;
  contentType?: string;
}

interface MultipartDispatch extends DispatchCommon {
  body: FormData | Buffer | string;
  contentType?: string;
}

interface StreamDispatch extends DispatchCommon {
  body: string | Buffer | null;
  contentType?: string;
}

const DEFAULT_MAX_JOB_ATTEMPTS = 3;

export async function dispatchReqresp(opts: ReqRespDispatch): Promise<DispatchSuccess<httpReqresp.SendResult>> {
  return attemptJob(opts, 'unary', async (job) =>
    httpReqresp.send({
      brokerUrl: job.brokerUrl,
      capability: opts.capability,
      offering: opts.offering,
      paymentBlob: job.paymentEnvelope,
      body: opts.body,
      contentType: opts.contentType,
      requestId: job.requestId,
    }),
  );
}

export async function dispatchMultipart(opts: MultipartDispatch): Promise<DispatchSuccess<httpMultipart.SendResult>> {
  return attemptJob(opts, 'multipart', async (job) =>
    httpMultipart.send({
      brokerUrl: job.brokerUrl,
      capability: opts.capability,
      offering: opts.offering,
      paymentBlob: job.paymentEnvelope,
      body: opts.body,
      contentType: opts.contentType,
      requestId: job.requestId,
    }),
  );
}

export async function dispatchStream(opts: StreamDispatch): Promise<DispatchSuccess<httpStream.StreamHandle>> {
  return attemptJob(opts, 'stream', async (job) =>
    httpStream.sendStreaming({
      brokerUrl: job.brokerUrl,
      capability: opts.capability,
      offering: opts.offering,
      paymentBlob: job.paymentEnvelope,
      body: opts.body,
      contentType: opts.contentType,
      requestId: job.requestId,
    }),
  );
}

// ── core loop ───────────────────────────────────────────────────────
// Per attempt: open a fresh job → verify the LOC granted the desired
// interaction mode → send to the returned broker. Failed attempts get
// a best-effort inline settle(0) so the estimate's charge is refunded;
// the FINAL failed job's ref is attached to the thrown error so the
// handler can persist a durable settle(0) (at-least-once; LOC's 409
// job_already_settled makes the overlap idempotent-safe).

async function attemptJob<T>(
  opts: DispatchCommon,
  transport: JobTransport,
  send: (job: OpenJobResponse) => Promise<T>,
): Promise<DispatchSuccess<T>> {
  const maxAttempts = Math.max(1, opts.maxJobAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS);
  let job: OpenJobResponse | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts && !job; attempt++) {
    try {
      job = await opts.loc.openJob({
        idempotencyKey: opts.requestId,
        capability: opts.capability,
        offering: opts.offering,
        transport,
        estimatedUnits: Math.max(1, Math.floor(opts.estimatedUnits)),
      });
    } catch (err) {
      lastError = err;
      if (!shouldRetryJobOpen(err)) throw err;
    }
  }
  if (!job) throw lastError ?? new Error(`LOC open failed for ${opts.capability}/${opts.offering}`);

  try {
    const result = await send(job);
    return {
      candidate: candidateFromJob(job, opts.capability, opts.offering),
      result,
      jobRef: jobRef(job),
    };
  } catch (err) {
    attachJobContext(err, job, opts.capability, opts.offering);
    throw err;
  }
}

function candidateFromJob(
  job: OpenJobResponse,
  capability: string,
  offering: string,
): RouteCandidate {
  return {
    brokerUrl: job.brokerUrl,
    capability,
    offering,
    model: offering,
    protocol: job.protocol,
    transports: [job.transport],
    ethAddress: '',
    pricePerWorkUnitWei: '',
    workUnit: job.workUnit,
    unitsPerPrice: 1,
    quoteId: '',
    quoteVersion: 0,
    constraintFingerprint: new Uint8Array(),
    routeFingerprint: new Uint8Array(),
    extra: null,
    constraints: null,
  };
}

function shouldRetryJobOpen(err: unknown): boolean {
  if (!(err instanceof LocApiError)) return false;
  // 402 insufficient_credit / 404 no_route_available are deterministic;
  // 429 + 5xx + network errors are worth another attempt.
  return err.status === 429 || err.status >= 500 || err.status === 0;
}

function attachJobContext(
  err: unknown,
  job: OpenJobResponse,
  capability: string,
  offering: string,
): void {
  if (err && typeof err === 'object') {
    Object.assign(err, {
      jobRef: jobRef(job),
      routeCandidate: candidateFromJob(job, capability, offering),
    });
  }
}

function jobRef(job: OpenJobResponse): JobRef {
  return {
    jobId: job.jobId,
    requestId: job.requestId,
    workId: job.workId,
    protocol: job.protocol,
    transport: job.transport,
    workUnit: job.workUnit,
    settleEndpoint: job.settleEndpoint,
  };
}

/** Read the jobRef a failed dispatch attached to its error, if any. */
export function jobRefFromError(err: unknown): JobRef | null {
  const ref = (err as { jobRef?: JobRef })?.jobRef;
  return ref && typeof ref.jobId === 'string' && ref.jobId.length > 0 ? ref : null;
}
