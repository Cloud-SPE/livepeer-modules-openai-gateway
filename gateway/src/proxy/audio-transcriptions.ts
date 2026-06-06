// POST /v1/audio/transcriptions — multipart/form-data input, Whisper STT.
// Work unit: requests (1 per call). Audio duration would be more accurate
// but isn't recoverable without decoding; the registry can advertise
// `work_unit=requests` and we record 1.

import type { FastifyInstance } from 'fastify';

import type { ServerDeps } from '../server.js';
import { Capability } from './livepeer/capabilityMap.js';
import { HEADER } from './livepeer/headers.js';
import { readOrSynthRequestId } from './livepeer/requestId.js';
import { dispatchMultipart, jobRefFromError } from '../loc/dispatch.js';
import { resolveRoute } from '../loc/resolve.js';
import { extractMultipartField } from './service/multipart.js';
import { handleBrokerError } from './errors.js';
import {
  commitReservation,
  openReservation,
  recordSelectedRoute,
  refundReservation,
} from './reservation.js';
import { bearerAuth } from './auth.js';
import { rateLimitV1 } from './rateLimit.js';

const BODY_LIMIT = 100 * 1024 * 1024; // 100 MB

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

      const handle = await openReservation(deps, {
        apiKeyId: auth.apiKeyId,
        capability,
        model: requestedModel,
        estimatedWorkUnits: 1,
      });

      // Resolve a friendly model id to its offering for the LOC job.
      // The multipart body is forwarded verbatim (no model rewrite) —
      // transcription runners are addressed by offering id today.
      const { offering } = await resolveRoute({
        catalog: deps.registryCatalog,
        modelMap: deps.config.locModelMap,
        capability,
        requestedModel,
      });

      try {
        const dispatched = await dispatchMultipart({
          loc: deps.loc,
          capability,
          offering,
          estimatedUnits: 1,
          maxJobAttempts: deps.config.locJobRetries + 1,
          body,
          contentType,
          requestId,
        });
        await recordSelectedRoute(deps, handle, dispatched.candidate);
        await commitReservation(deps, handle, {
          workUnits: 1,
          statusCode: dispatched.result.status,
          locJobId: dispatched.jobRef.jobId,
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
        await refundReservation(deps, handle, {
          statusCode: brokerStatus(err),
          errorText: (err as Error).message ?? 'unknown',
          locJobId: jobRefFromError(err)?.jobId ?? null,
        });
        handleBrokerError(reply, err, requestId);
      }
    },
  );
}

function brokerStatus(err: unknown): number {
  const anyErr = err as { status?: number };
  return typeof anyErr?.status === 'number' ? anyErr.status : 502;
}
