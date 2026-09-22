// POST /v1/embeddings — unary req/resp.

import type { FastifyInstance } from 'fastify';

import type { ServerDeps } from '../server.js';
import { Capability } from './livepeer/capabilityMap.js';
import { HEADER } from './livepeer/headers.js';
import { readOrSynthRequestId } from './livepeer/requestId.js';
import { dispatchReqresp } from '../loc/dispatch.js';
import { resolveRoute } from '../loc/resolve.js';
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

interface EmbeddingsBody {
  model?: unknown;
  input?: unknown;
  [k: string]: unknown;
}

export async function registerEmbeddingsRoute(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.post(
    '/v1/embeddings',
    { preHandler: [bearerAuth(deps), rateLimitV1(deps.rateLimiter)] },
    async (req, reply) => {
      const auth = req.proxyAuth!;
      const body = (req.body ?? {}) as EmbeddingsBody;
      const capability = Capability.Embeddings;
      const requestId = readOrSynthRequestId(req);

      const requestedModel = typeof body.model === 'string' && body.model.length > 0 ? body.model : null;
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
        estimatedWorkUnits: estimateEmbeddingUnits(body.input),
      });

      const { offering, runnerModel } = await resolveRoute({
        catalog: deps.registryCatalog,
        modelMap: deps.config.locModelMap,
        capability,
        requestedModel,
        transport: 'unary',
        expectedWorkUnit: 'tokens',
      });
      const upstreamBody =
        runnerModel !== requestedModel ? { ...body, model: runnerModel } : body;

      try {
        const funding = embeddingFunding(body.input);
        const dispatched = await dispatchReqresp({
          loc: deps.loc,
          capability,
          offering,
          estimatedUnits: funding.estimatedUnits,
          maxTotalUnits: funding.maxTotalUnits,
          maxJobAttempts: deps.config.locOpenMaxAttempts,
          body: JSON.stringify(upstreamBody),
          contentType: 'application/json',
          idempotencyKey: handle.workId,
          onJobUpdate: (job, candidate) => recordPaidJob(deps, handle, job, candidate),
        });
        await recordSelectedRoute(deps, handle, dispatched.candidate);
        await commitReservation(deps, handle, {
          workUnits: null,
          statusCode: dispatched.result.status,
        });
        await reply
          .code(dispatched.result.status)
          .header('Content-Type', dispatched.result.headers.get('Content-Type') ?? 'application/json')
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

function estimateEmbeddingUnits(input: unknown): number {
  if (typeof input === 'string') return estimateTextTokens(input);
  if (Array.isArray(input)) {
    return Math.max(
      1,
      input.reduce((sum, item) => sum + estimateEmbeddingUnits(item), 0),
    );
  }
  return 1;
}

export function embeddingFunding(input: unknown): {
  estimatedUnits: number;
  maxTotalUnits: number;
} {
  const estimatedUnits = estimateEmbeddingUnits(input);
  return {
    estimatedUnits,
    maxTotalUnits: Math.max(estimatedUnits, embeddingByteCeiling(input)),
  };
}

function embeddingByteCeiling(input: unknown): number {
  if (typeof input === 'string') return Math.max(1, Buffer.byteLength(input, 'utf8'));
  if (Array.isArray(input)) {
    return Math.max(1, input.reduce((sum, item) => sum + embeddingByteCeiling(item), 0));
  }
  // Numeric token ids are already tokenized and count one-for-one.
  return 1;
}

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function brokerStatus(err: unknown): number {
  const anyErr = err as { status?: number };
  return typeof anyErr?.status === 'number' ? anyErr.status : 502;
}
