// POST /v1/chat/completions — streaming + unary.
//
// Streaming bytes pass through without body mutation or transcript
// buffering. Accounting is recovered independently from the broker's
// signed terminal settlement after the stream ends.
//
// Adapted from livepeer-network-modules/openai-gateway/src/routes/chat-completions.ts.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ServerDeps } from '../server.js';
import { Capability } from './livepeer/capabilityMap.js';
import { HEADER } from './livepeer/headers.js';
import { readOrSynthRequestId } from './livepeer/requestId.js';
import { dispatchReqresp, dispatchStream } from '../loc/dispatch.js';
import { resolveRoute } from '../loc/resolve.js';
import { handleBrokerError } from './errors.js';
import {
  commitReservation,
  openReservation,
  recordPaidJob,
  recordSelectedRoute,
  failReservation,
  type ReservationHandle,
} from './reservation.js';
import { bearerAuth } from './auth.js';
import { rateLimitV1 } from './rateLimit.js';

interface ChatCompletionsBody {
  model?: unknown;
  stream?: boolean;
  [k: string]: unknown;
}

export async function registerChatRoute(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.post(
    '/v1/chat/completions',
    { preHandler: [bearerAuth(deps), rateLimitV1(deps.rateLimiter)] },
    async (req, reply) => {
      const auth = req.proxyAuth!;
      const body = (req.body ?? {}) as ChatCompletionsBody;
      const isStream = body.stream === true;
      const capability = Capability.ChatCompletions;
      const requestId = readOrSynthRequestId(req);

      const requestedModel = pickModel(body);
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
        estimatedWorkUnits: estimatedChatWorkUnits(body),
      });

      // The OpenAI model id is the LOC offering id. Resolve only the
      // runner-facing serving name and verify the declared transport.
      const { offering, runnerModel } = await resolveRoute({
        catalog: deps.registryCatalog,
        modelMap: deps.config.locModelMap,
        capability,
        requestedModel,
        transport: isStream ? 'stream' : 'unary',
        expectedWorkUnit: 'tokens',
      });
      const upstreamBody =
        runnerModel !== requestedModel ? { ...body, model: runnerModel } : body;
      const bodyStr = JSON.stringify(upstreamBody);
      const funding = chatFunding(body);

      if (isStream) {
        await runStreaming(deps, req, reply, {
          capability,
          offering,
          estimatedUnits: funding.estimatedUnits,
          maxTotalUnits: funding.maxTotalUnits,
          bodyStr,
          requestId,
          handle,
        });
        return;
      }

      // ── unary ────────────────────────────────────────────────────
      try {
        const dispatched = await dispatchReqresp({
          loc: deps.loc,
          capability,
          offering,
          estimatedUnits: funding.estimatedUnits,
          maxTotalUnits: funding.maxTotalUnits,
          maxJobAttempts: deps.config.locOpenMaxAttempts,
          body: bodyStr,
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

interface StreamingInput {
  capability: string;
  offering: string;
  estimatedUnits: number;
  maxTotalUnits: number;
  bodyStr: string;
  requestId: string;
  handle: ReservationHandle;
}

async function runStreaming(
  deps: ServerDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  input: StreamingInput,
): Promise<void> {
  let dispatched;
  try {
    dispatched = await dispatchStream({
      loc: deps.loc,
      capability: input.capability,
      offering: input.offering,
      estimatedUnits: input.estimatedUnits,
      maxTotalUnits: input.maxTotalUnits,
      maxJobAttempts: deps.config.locOpenMaxAttempts,
      body: input.bodyStr,
      contentType: 'application/json',
      idempotencyKey: input.handle.workId,
      onJobUpdate: (job, candidate) => recordPaidJob(deps, input.handle, job, candidate),
    });
  } catch (err) {
    const candidate = (err as { routeCandidate?: import('../loc/dispatch.js').RouteCandidate }).routeCandidate;
    if (candidate) await recordSelectedRoute(deps, input.handle, candidate);
    await failReservation(deps, input.handle, {
      statusCode: brokerStatus(err),
      errorText: (err as Error).message ?? 'unknown',
    });
    handleBrokerError(reply, err, input.requestId);
    return;
  }

  await recordSelectedRoute(deps, input.handle, dispatched.candidate);

  reply.raw.statusCode = dispatched.result.status;
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader(HEADER.REQUEST_ID, input.requestId);
  reply.hijack();

  let streamErr: unknown = null;
  try {
    for await (const chunk of dispatched.result.stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      reply.raw.write(buf);
    }
  } catch (err) {
    streamErr = err;
  } finally {
    reply.raw.end();
  }
  try {
    await dispatched.result.done();
  } catch (err) {
    streamErr ??= err;
  }

  if (streamErr) {
    req.log.warn({ err: streamErr, requestId: input.requestId }, 'chat stream ended with error');
    await failReservation(deps, input.handle, {
      statusCode: dispatched.result.status,
      errorText: (streamErr as Error).message ?? 'stream_error',
    });
    return;
  }

  await commitReservation(deps, input.handle, {
    workUnits: null,
    statusCode: dispatched.result.status,
  });
}

// ── helpers (exported for unit tests) ──────────────────────────────

export function pickModel(body: ChatCompletionsBody): string | null {
  return typeof body.model === 'string' && body.model.length > 0 ? body.model : null;
}

function estimatedChatWorkUnits(body: ChatCompletionsBody): number {
  return chatFunding(body).estimatedUnits;
}

export function chatFunding(body: ChatCompletionsBody): {
  estimatedUnits: number;
  maxTotalUnits: number;
} {
  const promptTokens = estimateValueTokens(body.messages) + estimateValueTokens(body.input);
  const completionBudget = readPositiveInt(body.max_completion_tokens)
    ?? readPositiveInt(body.max_tokens)
    ?? 1024;
  return {
    estimatedUnits: Math.max(1, promptTokens + Math.min(completionBudget, 256)),
    maxTotalUnits: Math.max(1, promptTokens + completionBudget),
  };
}

function estimateValueTokens(value: unknown): number {
  if (typeof value === 'string') return estimateTextTokens(value);
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + estimateValueTokens(item), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .reduce<number>((sum, item) => sum + estimateValueTokens(item), 0);
  }
  return 0;
}

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function readPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function brokerStatus(err: unknown): number {
  const anyErr = err as { status?: number };
  return typeof anyErr?.status === 'number' ? anyErr.status : 502;
}
