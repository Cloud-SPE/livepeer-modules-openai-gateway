import type { RouteCandidate, RouteSelector } from "./routeSelector.js";
import { LivepeerBrokerError } from "../livepeer/errors.js";
import * as httpMultipart from "../livepeer/http-multipart.js";
import * as httpReqresp from "../livepeer/http-reqresp.js";
import * as httpStream from "../livepeer/http-stream.js";
import { buildPayment } from "../livepeer/payment.js";

interface DispatchCommon {
  routeSelector: RouteSelector;
  capability: string;
  offering: string;
  estimatedUnits: number;
  interactionMode?: string;
  requestId: string;
  request: import("fastify").FastifyRequest;
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

export interface DispatchSuccess<T> {
  candidate: RouteCandidate;
  result: T;
}

export async function dispatchReqresp(opts: ReqRespDispatch): Promise<DispatchSuccess<httpReqresp.SendResult>> {
  return attemptCandidates(
    opts.routeSelector,
    { capability: opts.capability, offering: opts.offering, interactionMode: opts.interactionMode, request: opts.request },
    async (candidate) =>
      httpReqresp.send({
        brokerUrl: candidate.brokerUrl,
        capability: candidate.capability,
        offering: candidate.offering,
        paymentBlob: await buildPayment({
          route: {
            capability: candidate.capability,
            offering: candidate.offering,
            recipientHex: candidate.ethAddress,
            brokerUrl: candidate.brokerUrl,
            pricePerWorkUnitWei: candidate.pricePerWorkUnitWei,
            workUnit: candidate.workUnit,
            unitsPerPrice: candidate.unitsPerPrice,
            quoteId: candidate.quoteId,
            quoteVersion: candidate.quoteVersion,
            constraintFingerprint: candidate.constraintFingerprint,
            routeFingerprint: candidate.routeFingerprint,
          },
          estimatedUnits: opts.estimatedUnits,
        }),
        body: opts.body,
        contentType: opts.contentType,
        requestId: opts.requestId,
      }),
  );
}

export async function dispatchMultipart(opts: MultipartDispatch): Promise<DispatchSuccess<httpMultipart.SendResult>> {
  return attemptCandidates(
    opts.routeSelector,
    { capability: opts.capability, offering: opts.offering, interactionMode: opts.interactionMode, request: opts.request },
    async (candidate) =>
      httpMultipart.send({
        brokerUrl: candidate.brokerUrl,
        capability: candidate.capability,
        offering: candidate.offering,
        paymentBlob: await buildPayment({
          route: {
            capability: candidate.capability,
            offering: candidate.offering,
            recipientHex: candidate.ethAddress,
            brokerUrl: candidate.brokerUrl,
            pricePerWorkUnitWei: candidate.pricePerWorkUnitWei,
            workUnit: candidate.workUnit,
            unitsPerPrice: candidate.unitsPerPrice,
            quoteId: candidate.quoteId,
            quoteVersion: candidate.quoteVersion,
            constraintFingerprint: candidate.constraintFingerprint,
            routeFingerprint: candidate.routeFingerprint,
          },
          estimatedUnits: opts.estimatedUnits,
        }),
        body: opts.body,
        contentType: opts.contentType,
        requestId: opts.requestId,
      }),
  );
}

export async function dispatchStream(opts: StreamDispatch): Promise<DispatchSuccess<httpStream.StreamHandle>> {
  return attemptCandidates(
    opts.routeSelector,
    { capability: opts.capability, offering: opts.offering, interactionMode: opts.interactionMode, request: opts.request },
    async (candidate) =>
      httpStream.sendStreaming({
        brokerUrl: candidate.brokerUrl,
        capability: candidate.capability,
        offering: candidate.offering,
        paymentBlob: await buildPayment({
          route: {
            capability: candidate.capability,
            offering: candidate.offering,
            recipientHex: candidate.ethAddress,
            brokerUrl: candidate.brokerUrl,
            pricePerWorkUnitWei: candidate.pricePerWorkUnitWei,
            workUnit: candidate.workUnit,
            unitsPerPrice: candidate.unitsPerPrice,
            quoteId: candidate.quoteId,
            quoteVersion: candidate.quoteVersion,
            constraintFingerprint: candidate.constraintFingerprint,
            routeFingerprint: candidate.routeFingerprint,
          },
          estimatedUnits: opts.estimatedUnits,
        }),
        body: opts.body,
        contentType: opts.contentType,
        requestId: opts.requestId,
      }),
  );
}

export async function selectRealtimeCandidate(
  routeSelector: RouteSelector,
  request: import("fastify").FastifyRequest,
  capability: string,
  offering: string,
  interactionMode?: string,
): Promise<RouteCandidate> {
  const candidates = await routeSelector.select({ capability, offering, interactionMode, request });
  if (candidates.length === 0) {
    throw new Error(`no route candidates for capability=${capability} offering=${offering}`);
  }
  return candidates[0]!;
}

async function attemptCandidates<T>(
  routeSelector: RouteSelector,
  input: { capability: string; offering: string; interactionMode?: string; request: import("fastify").FastifyRequest },
  fn: (candidate: RouteCandidate) => Promise<T>,
): Promise<DispatchSuccess<T>> {
  const candidates = await routeSelector.select(input);
  if (candidates.length === 0) {
    throw new Error(`no route candidates for capability=${input.capability} offering=${input.offering}`);
  }

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const result = await fn(candidate);
      routeSelector.recordOutcome(candidate, { ok: true, retryable: false });
      return { candidate, result };
    } catch (err) {
      lastError = err;
      attachCandidate(err, candidate);
      routeSelector.recordOutcome(candidate, { ok: false, retryable: shouldPenalize(err) }, describeFailure(err));
      if (!shouldRetry(err)) break;
    }
  }

  throw lastError;
}

function shouldRetry(err: unknown): boolean {
  if (!(err instanceof LivepeerBrokerError)) return true;
  return err.status >= 500;
}

function shouldPenalize(err: unknown): boolean {
  if (!(err instanceof LivepeerBrokerError)) return true;
  return err.status >= 500 || err.status === 429;
}

function describeFailure(err: unknown): string {
  if (err instanceof LivepeerBrokerError) {
    return `${err.code}:${err.status}`;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return "unknown_failure";
}

function attachCandidate(err: unknown, candidate: RouteCandidate): void {
  if (err && typeof err === 'object') {
    Object.assign(err, { routeCandidate: candidate });
  }
}
