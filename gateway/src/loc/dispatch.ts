// Prepare one exact workload commitment, open LOC idempotently, persist its
// authorization/route identity, and dispatch once with caller proof.
// Restart recovery discovers accounting state without replaying workload bytes.

import { prepareInvocation } from './authorization.js';
import type { OpenJobRequest, RouteSnapshot } from './client.js';
import * as httpMultipart from '../proxy/livepeer/http-multipart.js';
import * as httpReqresp from '../proxy/livepeer/http-reqresp.js';
import * as httpStream from '../proxy/livepeer/http-stream.js';
import { LivepeerBrokerError } from '../proxy/livepeer/errors.js';
import { LocApiError, type JobTransport, type LocClient, type OpenJobResponse } from './client.js';

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
  spendAuthorization: string;
  routeSnapshot: RouteSnapshot;
  accountingMode: 'wholesale_account';
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
  onJobPrepared?: (request: OpenJobRequest) => Promise<void>;
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
const JOB_OPEN_RETRY_BASE_MS = 250;

/** Keep recovery behind every foreground open and its exponential backoff. */
export function jobOpenRecoveryGraceMs(timeoutMs: number, maxAttempts: number): number {
  const backoffMs = JOB_OPEN_RETRY_BASE_MS * (2 ** (maxAttempts - 1) - 1);
  return Math.max(300_000, timeoutMs * maxAttempts + backoffMs + 60_000);
}


export async function dispatchReqresp(opts: ReqRespDispatch): Promise<DispatchSuccess<httpReqresp.SendResult>> {
  const prepared = await prepareInvocation(opts.body as BodyInit | null, opts.contentType);
  return attemptJob(opts, 'unary', prepared, async (job) =>
    httpReqresp.send({
      brokerUrl: job.brokerUrl,
      capability: opts.capability,
      offering: opts.offering,
      authorization: job.spendAuthorization,
      callerProof: prepared.sign(job.spendAuthorization),
      body: prepared.body,
      contentType: prepared.contentType,
      requestId: job.requestId,
    }),
  );
}

export async function dispatchMultipart(opts: MultipartDispatch): Promise<DispatchSuccess<httpMultipart.SendResult>> {
  const prepared = await prepareInvocation(opts.body as BodyInit | null, opts.contentType);
  return attemptJob(opts, 'multipart', prepared, async (job) =>
    httpMultipart.send({
      brokerUrl: job.brokerUrl,
      capability: opts.capability,
      offering: opts.offering,
      authorization: job.spendAuthorization,
      callerProof: prepared.sign(job.spendAuthorization),
      body: prepared.body,
      contentType: prepared.contentType,
      requestId: job.requestId,
    }),
  );
}

export async function dispatchStream(opts: StreamDispatch): Promise<DispatchSuccess<httpStream.StreamHandle>> {
  const prepared = await prepareInvocation(opts.body as BodyInit | null, opts.contentType);
  return attemptJob(opts, 'stream', prepared, async (job) =>
    httpStream.sendStreaming({
      brokerUrl: job.brokerUrl,
      capability: opts.capability,
      offering: opts.offering,
      authorization: job.spendAuthorization,
      callerProof: prepared.sign(job.spendAuthorization),
      body: prepared.body,
      contentType: prepared.contentType,
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
  prepared: Awaited<ReturnType<typeof prepareInvocation>>,
  send: (job: OpenJobResponse) => Promise<T>,
): Promise<DispatchSuccess<T>> {
  const maxAttempts = Math.max(1, opts.maxJobAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS);
  let job: OpenJobResponse | null = null;
  let lastError: unknown;
  const request: OpenJobRequest = {
    idempotencyKey: opts.idempotencyKey,
    capability: opts.capability,
    offering: opts.offering,
    transport,
    estimatedUnits: Math.max(1, Math.floor(opts.estimatedUnits)),
    ...(opts.maxTotalUnits !== undefined ? { maxTotalUnits: Math.max(1, Math.floor(opts.maxTotalUnits)) } : {}),
    workloadRequestDigest: prepared.workloadRequestDigest,
    callerPublicKey: prepared.callerPublicKey,
  };
  await opts.onJobPrepared?.(request);
  for (let attempt = 0; attempt < maxAttempts && !job; attempt++) {
    try {
      job = await opts.loc.openJob(request);
    } catch (err) {
      lastError = err;
      if (!shouldRetryJobOpen(err)) throw err;
      if (attempt + 1 < maxAttempts) {
        await delay(JOB_OPEN_RETRY_BASE_MS * 2 ** attempt);
      }
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
    ethAddress: job.routeSnapshot.eth_address,
    pricePerWorkUnitWei: job.routeSnapshot.price_per_work_unit_wei,
    workUnit: job.workUnit,
    unitsPerPrice: job.routeSnapshot.units_per_price,
    quoteId: job.routeSnapshot.quote_id,
    quoteVersion: job.routeSnapshot.quote_version,
    constraintFingerprint: Buffer.from(job.routeSnapshot.constraint_fingerprint, 'hex'),
    routeFingerprint: Buffer.from(job.routeSnapshot.route_fingerprint, 'hex'),
    extra: job.routeSnapshot.extra ?? null,
    constraints: null,
  };
}

function shouldRetryJobOpen(err: unknown): boolean {
  if (!(err instanceof LocApiError)) return false;
  if (err.status === 409 && err.code === 'IDEMPOTENCY_IN_PROGRESS') return true;
  // 402 insufficient_credit / 404 no_route_available are deterministic;
  // 429 + 5xx + network errors are worth another identical attempt.
  return err.status === 429 || err.status >= 500 || err.status === 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attachJobContext(
  err: unknown,
  job: OpenJobResponse,
  opts: DispatchCommon,
  brokerJobId: string,
): void {
  if (err && typeof err === 'object') {
    Object.defineProperty(err, 'jobRef', { value: jobRef(job, opts, brokerJobId), configurable: true, enumerable: false });
    Object.assign(err, { routeCandidate: candidateFromJob(job, opts.capability, opts.offering) });
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
    spendAuthorization: job.spendAuthorization,
    routeSnapshot: job.routeSnapshot,
    accountingMode: job.accountingMode,
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
