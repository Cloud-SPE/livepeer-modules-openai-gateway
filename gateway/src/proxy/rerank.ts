// POST /v1/rerank — Cohere-style rerank, proxied as unary req/resp.
//
// Ported from an earlier Rust implementation of the same rerank surface.
// Work unit: requests (1 per call). The capability id is plain "rerank"
// (no "openai:" prefix) — rerank isn't an OpenAI-shaped endpoint.

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

interface RerankBody {
  model?: unknown;
  query?: unknown;
  documents?: unknown;
  [k: string]: unknown;
}

export async function registerRerankRoute(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.post(
    '/v1/rerank',
    { preHandler: [bearerAuth(deps), rateLimitV1(deps.rateLimiter)] },
    async (req, reply) => {
      const auth = req.proxyAuth!;
      const body = (req.body ?? {}) as RerankBody;
      const requestId = readOrSynthRequestId(req);

      if (typeof body.model !== 'string' || body.model.length === 0) {
        return reply
          .code(400)
          .header(HEADER.REQUEST_ID, requestId)
          .send({
            error: { message: 'missing `model` field', type: 'invalid_request_error' },
          });
      }
      const capability = Capability.Rerank;
      const offering = body.model;

      const handle = await openReservation(deps, {
        apiKeyId: auth.apiKeyId,
        capability,
        model: offering,
        estimatedWorkUnits: 1,
      });

      try {
        const dispatched = await dispatchReqresp({
          routeSelector: deps.routeSelector,
          request: req,
          capability,
          offering,
          estimatedUnits: 1,
          body: JSON.stringify(body),
          contentType: 'application/json',
          requestId,
        });
        await recordSelectedRoute(deps, handle, dispatched.candidate);
        await commitReservation(deps, handle, {
          workUnits: 1,
          statusCode: dispatched.result.status,
        });
        await reply
          .code(dispatched.result.status)
          .header('Content-Type', dispatched.result.headers.get('Content-Type') ?? 'application/json')
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
