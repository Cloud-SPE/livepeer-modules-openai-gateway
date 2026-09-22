// POST /v1/audio/transcriptions — multipart/form-data input, Whisper STT.
// Work unit: whole seconds of uploaded audio. The gateway-owned implementation
// of the advertised estimator sizes the LOC funding ceiling before dispatch;
// it is never settlement evidence. The broker's signed terminal claim remains
// authoritative.

import {
  ESTIMATOR,
  estimateCeilingSecondsFromMultipart,
} from './service/audioDuration/index.js';

import type { FastifyInstance } from 'fastify';

import type { ServerDeps } from '../server.js';
import { Capability } from './livepeer/capabilityMap.js';
import { HEADER } from './livepeer/headers.js';
import { readOrSynthRequestId } from './livepeer/requestId.js';
import { dispatchMultipart } from '../loc/dispatch.js';
import { resolveRoute } from '../loc/resolve.js';
import { extractMultipartField } from './service/multipart.js';
import { handleBrokerError } from './errors.js';
import {
  commitReservation,
  openReservation,
  recordPaidJob,
  recordSelectedRoute,
  failReservation,
} from './reservation.js';
import { bearerAuth } from './auth.js';
import { rateLimitV1 } from './rateLimit.js';

const BODY_LIMIT = 100 * 1024 * 1024; // 100 MB
const REQUIRED_ESTIMATOR = {
  id: ESTIMATOR,
  rounding: 'ceil-to-whole-seconds',
  exactness: 'exact-or-reject',
} as const;

export async function registerAudioTranscriptionsRoute(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.post(
    '/v1/audio/transcriptions',
    {
      bodyLimit: BODY_LIMIT,
      preHandler: [bearerAuth(deps), rateLimitV1(deps.rateLimiter)],
    },
    async (req, reply) => {
      const auth = req.proxyAuth!;
      const requestId = readOrSynthRequestId(req);
      const contentType = req.headers['content-type'];
      if (!contentType || !contentType.startsWith('multipart/form-data')) {
        return reply
          .code(400)
          .header(HEADER.REQUEST_ID, requestId)
          .send({
            error: {
              message: 'Content-Type must be multipart/form-data',
              type: 'invalid_request_error',
            },
          });
      }
      const body = req.body as Buffer | undefined;
      if (!body || !Buffer.isBuffer(body)) {
        return reply
          .code(400)
          .header(HEADER.REQUEST_ID, requestId)
          .send({
            error: { message: 'empty multipart body', type: 'invalid_request_error' },
          });
      }

      const capability = Capability.AudioTranscriptions;
      const modelField = extractMultipartField(body, contentType, 'model');
      const modelHeader = req.headers['livepeer-model'] as string | undefined;
      const requestedModel =
        modelField ??
        (modelHeader && modelHeader.length > 0 ? modelHeader : null);
      if (!requestedModel) {
        return reply
          .code(400)
          .header(HEADER.REQUEST_ID, requestId)
          .send({
            error: { message: 'missing `model` field', type: 'invalid_request_error' },
          });
      }

      let ceilingSeconds: number;
      try {
        ceilingSeconds = transcriptionCeilingSeconds(body, contentType);
      } catch {
        return reply
          .code(400)
          .header(HEADER.REQUEST_ID, requestId)
          .send({
            error: {
              message:
                'Audio duration cannot be measured exactly for funding; use a supported container with exact duration metadata.',
              type: 'invalid_request_error',
              code: 'audio_duration_inexact_or_unsupported',
            },
          });
      }

      // Resolve a friendly model id to its offering for the LOC job.
      // The multipart body is forwarded verbatim (no model rewrite) —
      // transcription runners are addressed by offering id today.
      let offering: string;
      try {
        ({ offering } = await resolveRoute({
          catalog: deps.registryCatalog,
          modelMap: deps.config.locModelMap,
          capability,
          requestedModel,
          transport: 'multipart',
          expectedWorkUnit: 'seconds',
          expectedEstimator: REQUIRED_ESTIMATOR,
        }));
      } catch {
        return reply
          .code(503)
          .header(HEADER.REQUEST_ID, requestId)
          .send({
            error: {
              message: 'The selected transcription offering does not advertise a supported exact funding estimator.',
              type: 'service_unavailable_error',
              code: 'transcription_estimator_unavailable',
            },
          });
      }

      const handle = await openReservation(deps, {
        apiKeyId: auth.apiKeyId,
        capability,
        model: requestedModel,
        estimatedWorkUnits: ceilingSeconds,
      });

      try {
        const dispatched = await dispatchMultipart({
          loc: deps.loc,
          capability,
          offering,
          estimatedUnits: ceilingSeconds,
          maxTotalUnits: ceilingSeconds,
          maxJobAttempts: deps.config.locOpenMaxAttempts,
          body,
          contentType,
          idempotencyKey: handle.workId,
          onJobUpdate: (job, candidate) => recordPaidJob(deps, handle, job, candidate),
        });
        await recordSelectedRoute(deps, handle, dispatched.candidate);
        await commitReservation(deps, handle, {
          // The estimator only bounds spend; it is not an observation of
          // the broker's authoritative terminal usage.
          workUnits: null,
          statusCode: dispatched.result.status,
        });
        await reply
          .code(dispatched.result.status)
          .header(
            'Content-Type',
            dispatched.result.headers.get('Content-Type') ?? 'application/json',
          )
          .header(HEADER.REQUEST_ID, requestId)
          .send(Buffer.from(dispatched.result.body));
      } catch (err) {
        const candidate = (err as { routeCandidate?: import('../loc/dispatch.js').RouteCandidate }).routeCandidate;
        if (candidate) await recordSelectedRoute(deps, handle, candidate);
        await failReservation(deps, handle, {
          statusCode: brokerStatus(err),
          errorText: (err as Error).message ?? 'unknown',
        });
        handleBrokerError(reply, err, requestId);
      }
    },
  );
}

export const TRANSCRIPTION_ESTIMATOR_ID = ESTIMATOR;

export function transcriptionCeilingSeconds(body: Uint8Array, contentType: string): number {
  const seconds = estimateCeilingSecondsFromMultipart(body, contentType);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`${ESTIMATOR} returned a non-positive or unsafe ceiling`);
  }
  return seconds;
}

function brokerStatus(err: unknown): number {
  const anyErr = err as { status?: number };
  return typeof anyErr?.status === 'number' ? anyErr.status : 502;
}
