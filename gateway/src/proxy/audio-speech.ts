// POST /v1/audio/speech — TTS, returns binary audio.
// Work unit: input character count.

import type { FastifyInstance } from 'fastify';

import type { ServerDeps } from '../server.js';
import { Capability } from './livepeer/capabilityMap.js';
import { HEADER } from './livepeer/headers.js';
import { readOrSynthRequestId } from './livepeer/requestId.js';
import { dispatchReqresp } from './service/routeDispatch.js';
import { handleBrokerError } from './errors.js';
import {
  commitReservation,
  openReservation,
  recordSelectedRoute,
  refundReservation,
} from './reservation.js';
import { bearerAuth } from './auth.js';
import { rateLimitV1 } from './rateLimit.js';

interface AudioSpeechBody {
  model?: unknown;
  input?: unknown;
  [k: string]: unknown;
}

export async function registerAudioSpeechRoute(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.post(
    '/v1/audio/speech',
    { preHandler: [bearerAuth(deps), rateLimitV1(deps.rateLimiter)] },
    async (req, reply) => {
      const auth = req.proxyAuth!;
      const body = (req.body ?? {}) as AudioSpeechBody;
      const capability = Capability.AudioSpeech;
      const requestId = readOrSynthRequestId(req);

      const offering = typeof body.model === 'string' && body.model.length > 0 ? body.model : null;
      if (!offering) {
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
        model: offering,
        estimatedWorkUnits: typeof body.input === 'string' ? Math.max(1, body.input.length) : 1,
      });

      try {
        const estimatedUnits =
          typeof body.input === 'string' ? Math.max(1, body.input.length) : 1;
        const dispatched = await dispatchReqresp({
          routeSelector: deps.routeSelector,
          request: req,
          capability,
          offering,
          estimatedUnits,
          body: JSON.stringify(body),
          contentType: 'application/json',
          requestId,
        });
        await recordSelectedRoute(deps, handle, dispatched.candidate);
        await commitReservation(deps, handle, {
          workUnits: typeof body.input === 'string' ? body.input.length : null,
          statusCode: dispatched.result.status,
        });
        await reply
          .code(dispatched.result.status)
          .header(
            'Content-Type',
            dispatched.result.headers.get('Content-Type') ?? 'application/octet-stream',
          )
          .header(HEADER.REQUEST_ID, requestId)
          .send(Buffer.from(dispatched.result.body));
      } catch (err) {
        const candidate = (err as { routeCandidate?: import('./service/routeSelector.js').RouteCandidate }).routeCandidate;
        if (candidate) await recordSelectedRoute(deps, handle, candidate);
        await refundReservation(deps, handle, {
          statusCode: brokerStatus(err),
          errorText: (err as Error).message ?? 'unknown',
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
