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
import { LivepeerBrokerError } from '../proxy/livepeer/errors.js';
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
  idempotencyKey: string;
  jobId: string;
  brokerJobId: string;
  requestId: string;
  workId: string;
  protocol: 'paid-job/v1';
  transport: JobTransport;
  workUnit: string;
  settleEndpoint: string;
  brokerUrl: string;
  capability: string;
  offering: string;
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
  maxTotalUnits?: number;
  idempotencyKey: string;
  /** Total job-open attempts (default 3 = 1 + 2 retries). */
  maxJobAttempts?: number;
  /** Called durably after LOC open and again after broker admission. */
  onJobUpdate?: (job: JobRef, candidate: RouteCandidate) => Promise<void>;
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
// Retry the same idempotent LOC open until it converges, persist the
// returned identities, then send exactly once to the selected broker.
// Broker failures never manufacture a zero-unit settlement; the
// durable lookup worker retrieves the signed terminal outcome.

async function attemptJob<T extends {
  jobId?: string;
  workUnit?: string;
  body?: unknown;
  headers?: Headers | Record<string, string | string[] | undefined>;
}>(
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
        idempotencyKey: opts.idempotencyKey,
        capability: opts.capability,
        offering: opts.offering,
        transport,
        estimatedUnits: Math.max(1, Math.floor(opts.estimatedUnits)),
        ...(opts.maxTotalUnits !== undefined
          ? { maxTotalUnits: Math.max(1, Math.floor(opts.maxTotalUnits)) }
          : {}),
      });
    } catch (err) {
      lastError = err;
      if (!shouldRetryJobOpen(err)) throw err;
    }
  }
  if (!job) throw lastError ?? new Error(`LOC open failed for ${opts.capability}/${opts.offering}`);

  const candidate = candidateFromJob(job, opts.capability, opts.offering);
  await opts.onJobUpdate?.(jobRef(job, opts, ''), candidate);

  let admittedJobId = '';
  try {
    const result = await send(job);
    validateBrokerMetadata(result, job);
    admittedJobId = result.jobId!;
    const ref = jobRef(job, opts, admittedJobId);
    await opts.onJobUpdate?.(ref, candidate);
    if (isAccountingReplay(result, transport)) {
      throw new LivepeerBrokerError({
        status: 502,
        code: 'upstream_response_lost',
        message: 'The original upstream response was lost; accounting recovered without re-execution.',
      });
    }
    return {
      candidate,
      result,
      jobRef: ref,
    };
  } catch (err) {
    let dispatchError = err;
    if (err instanceof LivepeerBrokerError && err.jobId) {
      try {
        validateBrokerErrorMetadata(err, job);
        admittedJobId = err.jobId;
        await opts.onJobUpdate?.(jobRef(job, opts, admittedJobId), candidate);
      } catch (metadataError) {
        dispatchError = metadataError;
      }
    }
    attachJobContext(dispatchError, job, opts, admittedJobId);
    throw dispatchError;
  }
}

export function isAccountingReplay(
  result: { body?: unknown; headers?: Headers | Record<string, string | string[] | undefined> },
  transport: JobTransport,
): boolean {
  if (transport === 'stream') {
    const headers = result.headers;
    const contentType =
      headers instanceof Headers
        ? headers.get('content-type')
        : headers
          ? firstHeader(headers, 'content-type')
          : undefined;
    return !contentType?.toLowerCase().startsWith('text/event-stream');
  }
  const body = result.body;
  if (typeof body !== 'string' && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
    return false;
  }
  try {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body as ArrayBufferView);
    const parsed = JSON.parse(text) as { replayed?: unknown };
    return parsed.replayed === true;
  } catch {
    return false;
  }
}

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
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
  opts: DispatchCommon,
  brokerJobId: string,
): void {
  if (err && typeof err === 'object') {
    Object.assign(err, {
      jobRef: jobRef(job, opts, brokerJobId),
      routeCandidate: candidateFromJob(job, opts.capability, opts.offering),
    });
  }
}

function jobRef(job: OpenJobResponse, opts: DispatchCommon, brokerJobId: string): JobRef {
  return {
    idempotencyKey: opts.idempotencyKey,
    jobId: job.jobId,
    brokerJobId,
    requestId: job.requestId,
    workId: job.workId,
    protocol: job.protocol,
    transport: job.transport,
    workUnit: job.workUnit,
    settleEndpoint: job.settleEndpoint,
    brokerUrl: job.brokerUrl,
    capability: opts.capability,
    offering: opts.offering,
  };
}

function validateBrokerMetadata(
  result: { jobId?: string; workUnit?: string },
  job: OpenJobResponse,
): void {
  if (!result.jobId) {
    throw new LivepeerBrokerError({
      status: 502,
      code: 'protocol_response_invalid',
      message: 'broker response missing Livepeer-Job-Id',
    });
  }
  if (!result.workUnit || result.workUnit !== job.workUnit) {
    throw new LivepeerBrokerError({
      status: 502,
      code: 'work_unit_mismatch',
      message: `broker work unit ${result.workUnit ?? '<missing>'} does not match LOC ${job.workUnit}`,
    });
  }
}

/** paid-job/v1 terminal errors carry the same audit identity as successes and
 * always claim zero delivered units. A pre-admission refusal has no job id and
 * is recovered (if recorded) by the stable request-id lookup instead. */
function validateBrokerErrorMetadata(
  error: LivepeerBrokerError,
  job: OpenJobResponse,
): void {
  if (!error.workUnit || error.workUnit !== job.workUnit) {
    throw new LivepeerBrokerError({
      status: 502,
      code: 'work_unit_mismatch',
      message: `broker error work unit ${error.workUnit ?? '<missing>'} does not match LOC ${job.workUnit}`,
    });
  }
  if (error.workUnits !== '0') {
    throw new LivepeerBrokerError({
      status: 502,
      code: 'protocol_response_invalid',
      message: `broker terminal error must report zero work units, received ${error.workUnits ?? '<missing>'}`,
    });
  }
}

/** Read the jobRef a failed dispatch attached to its error, if any. */
export function jobRefFromError(err: unknown): JobRef | null {
  const ref = (err as { jobRef?: JobRef })?.jobRef;
  return ref && typeof ref.jobId === 'string' && ref.jobId.length > 0 ? ref : null;
}
