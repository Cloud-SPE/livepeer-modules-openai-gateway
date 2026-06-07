// LOC-backed dispatch: open a clearinghouse job (route selection +
// payment minting in one call), forward to the returned broker, and
// hand the jobRef back to the route handler so it can enqueue the
// durable settle with actual units (see reservation.ts / settler.ts).
//
// Replaces the daemon-era routeDispatch.ts. The http-* send modules
// are unchanged — they only need brokerUrl + payment blob.

import { LivepeerBrokerError } from '../proxy/livepeer/errors.js';
import * as httpMultipart from '../proxy/livepeer/http-multipart.js';
import * as httpReqresp from '../proxy/livepeer/http-reqresp.js';
import * as httpStream from '../proxy/livepeer/http-stream.js';
import { MODE as MULTIPART_MODE } from '../proxy/livepeer/http-multipart.js';
import { MODE as REQRESP_MODE } from '../proxy/livepeer/http-reqresp.js';
import { MODE as STREAM_MODE } from '../proxy/livepeer/http-stream.js';
import { LocApiError, type LocClient, type OpenJobResponse } from './client.js';

// Kept shape-compatible with the daemon-era RouteCandidate so the
// reservation/audit/admin surfaces compile unchanged. Fields the LOC
// job response does not carry (ethAddress, price, quote identity) are
// empty — the LOC owns quote/price bookkeeping now.
export interface RouteCandidate {
  brokerUrl: string;
  capability: string;
  offering: string;
  model: string | null;
  interactionMode: string | null;
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
  workId: string;
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
  return attemptJobs(opts, REQRESP_MODE, async (job) =>
    httpReqresp.send({
      brokerUrl: job.brokerUrl,
      capability: opts.capability,
      offering: opts.offering,
      paymentBlob: job.paymentEnvelope,
      body: opts.body,
      contentType: opts.contentType,
      requestId: opts.requestId,
    }),
  );
}

export async function dispatchMultipart(opts: MultipartDispatch): Promise<DispatchSuccess<httpMultipart.SendResult>> {
  return attemptJobs(opts, MULTIPART_MODE, async (job) =>
    httpMultipart.send({
      brokerUrl: job.brokerUrl,
      capability: opts.capability,
      offering: opts.offering,
      paymentBlob: job.paymentEnvelope,
      body: opts.body,
      contentType: opts.contentType,
      requestId: opts.requestId,
    }),
  );
}

export async function dispatchStream(opts: StreamDispatch): Promise<DispatchSuccess<httpStream.StreamHandle>> {
  return attemptJobs(opts, STREAM_MODE, async (job) =>
    httpStream.sendStreaming({
      brokerUrl: job.brokerUrl,
      capability: opts.capability,
      offering: opts.offering,
      paymentBlob: job.paymentEnvelope,
      body: opts.body,
      contentType: opts.contentType,
      requestId: opts.requestId,
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

async function attemptJobs<T>(
  opts: DispatchCommon,
  desiredMode: string,
  send: (job: OpenJobResponse) => Promise<T>,
): Promise<DispatchSuccess<T>> {
  const maxAttempts = Math.max(1, opts.maxJobAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS);
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let job: OpenJobResponse;
    try {
      job = await opts.loc.openJob({
        capability: opts.capability,
        offering: opts.offering,
        estimatedUnits: Math.max(1, Math.floor(opts.estimatedUnits)),
      });
    } catch (err) {
      lastError = err;
      if (!shouldRetryJobOpen(err)) break;
      continue;
    }

    if (job.mode !== desiredMode) {
      lastError = new LivepeerBrokerError({
        status: 502,
        code: 'mode_mismatch',
        message: `LOC selected mode ${job.mode}, need ${desiredMode} for ${opts.capability}/${opts.offering}`,
        responseBody: '',
      });
      // Attach the jobRef so the handler also enqueues a durable
      // settle(0) for the final mismatched job — idempotent with the
      // inline settle below (LOC 409s the duplicate).
      attachJobContext(lastError, job, opts.capability, opts.offering, desiredMode);
      await settleBestEffort(opts.loc, job.jobId, 'mode_mismatch');
      continue;
    }

    try {
      const result = await send(job);
      return {
        candidate: candidateFromJob(job, opts.capability, opts.offering, desiredMode),
        result,
        jobRef: { jobId: job.jobId, workId: job.workId },
      };
    } catch (err) {
      lastError = err;
      attachJobContext(err, job, opts.capability, opts.offering, desiredMode);
      if (!shouldRetryBroker(err) || attempt === maxAttempts - 1) {
        // Final job: handler persists the durable settle(0) via jobRef.
        break;
      }
      await settleBestEffort(opts.loc, job.jobId, describeFailure(err));
    }
  }

  throw lastError ?? new Error(`dispatch failed for ${opts.capability}/${opts.offering}`);
}

function candidateFromJob(
  job: OpenJobResponse,
  capability: string,
  offering: string,
  mode: string,
): RouteCandidate {
  return {
    brokerUrl: job.brokerUrl,
    capability,
    offering,
    model: offering,
    interactionMode: mode,
    ethAddress: '',
    pricePerWorkUnitWei: '',
    workUnit: '',
    unitsPerPrice: 1,
    quoteId: '',
    quoteVersion: 0,
    constraintFingerprint: new Uint8Array(),
    routeFingerprint: new Uint8Array(),
    extra: null,
    constraints: null,
  };
}

/** Inline refund for jobs we are about to abandon mid-loop. Best-effort:
 * a miss here is bounded (the durable path only covers the final job)
 * and LOC's job lifecycle is the backstop. */
async function settleBestEffort(loc: LocClient, jobId: string, outcome: string): Promise<void> {
  try {
    await loc.settleJob(jobId, { actualUnits: 0, outcome });
  } catch {
    // Swallow — never let refund bookkeeping mask the original failure.
  }
}

function shouldRetryJobOpen(err: unknown): boolean {
  if (!(err instanceof LocApiError)) return false;
  // 402 insufficient_credit / 404 no_route_available are deterministic;
  // 429 + 5xx + network errors are worth another attempt.
  return err.status === 429 || err.status >= 500 || err.status === 0;
}

function shouldRetryBroker(err: unknown): boolean {
  if (!(err instanceof LivepeerBrokerError)) return true;
  return err.status >= 500;
}

function describeFailure(err: unknown): string {
  if (err instanceof LivepeerBrokerError) return `broker_${err.code}_${err.status}`;
  if (err instanceof Error && err.message) return err.message.slice(0, 80);
  return 'unknown_failure';
}

function attachJobContext(
  err: unknown,
  job: OpenJobResponse,
  capability: string,
  offering: string,
  mode: string,
): void {
  if (err && typeof err === 'object') {
    Object.assign(err, {
      jobRef: { jobId: job.jobId, workId: job.workId } satisfies JobRef,
      routeCandidate: candidateFromJob(job, capability, offering, mode),
    });
  }
}

/** Read the jobRef a failed dispatch attached to its error, if any. */
export function jobRefFromError(err: unknown): JobRef | null {
  const ref = (err as { jobRef?: JobRef })?.jobRef;
  return ref && typeof ref.jobId === 'string' && ref.jobId.length > 0 ? ref : null;
}
