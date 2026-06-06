// POST /v1/chat/completions — streaming + unary.
//
// Streaming: force `stream_options.include_usage = true` so the broker
// emits a trailing usage frame. Pipe SSE chunks straight to the client
// as they arrive; in parallel, accumulate them in-memory to parse the
// final usage chunk for billing settlement.
//
// Adapted from livepeer-network-modules/openai-gateway/src/routes/chat-completions.ts.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ServerDeps } from '../server.js';
import { Capability } from './livepeer/capabilityMap.js';
import { HEADER } from './livepeer/headers.js';
import { MODE as REQRESP_MODE } from './livepeer/http-reqresp.js';
import { MODE as STREAM_MODE } from './livepeer/http-stream.js';
import { readOrSynthRequestId } from './livepeer/requestId.js';
import { dispatchReqresp, dispatchStream, jobRefFromError } from '../loc/dispatch.js';
import { resolveRoute } from '../loc/resolve.js';
import { handleBrokerError } from './errors.js';
import {
  commitReservation,
  openReservation,
  recordSelectedRoute,
  refundReservation,
  type ReservationHandle,
} from './reservation.js';
import { bearerAuth } from './auth.js';
import { rateLimitV1 } from './rateLimit.js';

interface ChatCompletionsBody {
  model?: unknown;
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
    [k: string]: unknown;
  };
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

      // Users request either the friendly model id (extra.openai.model)
      // or a raw offering id. Resolve to the offering for the LOC job
      // and the runner-facing serving name for the upstream body,
      // preferring an offering whose advertised mode matches stream vs
      // unary.
      const { offering, runnerModel } = await resolveRoute({
        catalog: deps.registryCatalog,
        modelMap: deps.config.locModelMap,
        capability,
        requestedModel,
        interactionMode: isStream ? STREAM_MODE : REQRESP_MODE,
      });
      const upstreamBody =
        runnerModel !== requestedModel ? { ...body, model: runnerModel } : body;
      const dispatchBody = isStream ? withForcedUsageChunk(upstreamBody) : upstreamBody;
      const bodyStr = JSON.stringify(dispatchBody);
      const estimatedUnits = estimatedChatWorkUnits(body);

      if (isStream) {
        await runStreaming(deps, req, reply, {
          capability,
          offering,
          estimatedUnits,
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
          estimatedUnits,
          maxJobAttempts: deps.config.locJobRetries + 1,
          body: bodyStr,
          contentType: 'application/json',
          requestId,
        });
        await recordSelectedRoute(deps, handle, dispatched.candidate);
        const usage = parseTotalTokens(dispatched.result.body);
        await commitReservation(deps, handle, {
          workUnits: usage,
          statusCode: dispatched.result.status,
          locJobId: dispatched.jobRef.jobId,
        });
        await reply
          .code(dispatched.result.status)
          .header('Content-Type', dispatched.result.headers.get('Content-Type') ?? 'application/json')
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

interface StreamingInput {
  capability: string;
  offering: string;
  estimatedUnits: number;
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
      maxJobAttempts: deps.config.locJobRetries + 1,
      body: input.bodyStr,
      contentType: 'application/json',
      requestId: input.requestId,
    });
  } catch (err) {
    const candidate = (err as { routeCandidate?: import('../loc/dispatch.js').RouteCandidate }).routeCandidate;
    if (candidate) await recordSelectedRoute(deps, input.handle, candidate);
    await refundReservation(deps, input.handle, {
      statusCode: brokerStatus(err),
      errorText: (err as Error).message ?? 'unknown',
      locJobId: jobRefFromError(err)?.jobId ?? null,
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

  const transcript: Buffer[] = [];
  let streamErr: unknown = null;
  try {
    for await (const chunk of dispatched.result.stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      transcript.push(buf);
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
    // Mid-stream failure: the trailing usage frame never arrived, so
    // actual units are unknowable. Settle the LOC job with 0 (full
    // refund of the estimate); LOC's reconciliation janitor verifies
    // against the daemon ledger out of band.
    await refundReservation(deps, input.handle, {
      statusCode: dispatched.result.status,
      errorText: (streamErr as Error).message ?? 'stream_error',
      locJobId: dispatched.jobRef.jobId,
    });
    return;
  }

  const usage = parseStreamingUsage(Buffer.concat(transcript).toString('utf8'));
  await commitReservation(deps, input.handle, {
    workUnits: usage,
    statusCode: dispatched.result.status,
    locJobId: dispatched.jobRef.jobId,
  });
}

// ── helpers (exported for unit tests) ──────────────────────────────

export function pickModel(body: ChatCompletionsBody): string | null {
  return typeof body.model === 'string' && body.model.length > 0 ? body.model : null;
}

export function withForcedUsageChunk(body: ChatCompletionsBody): ChatCompletionsBody {
  return {
    ...body,
    stream: true,
    stream_options: { ...(body.stream_options ?? {}), include_usage: true },
  };
}

export function parseTotalTokens(body: BodyInit | null): number | null {
  // http-reqresp returns the broker body as an ArrayBuffer.
  if (typeof body !== 'string' && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer)) {
    return null;
  }
  try {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    const parsed = JSON.parse(text) as { usage?: { total_tokens?: number } };
    const total = parsed?.usage?.total_tokens;
    return typeof total === 'number' ? total : null;
  } catch {
    return null;
  }
}

/** Scan SSE transcript for the trailing usage frame. Last wins. */
export function parseStreamingUsage(transcript: string): number | null {
  let total: number | null = null;
  // SSE events are blocks separated by blank lines; "data: " lines carry payloads.
  for (const block of transcript.split(/\n\n+/)) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload) as { usage?: { total_tokens?: number } };
        if (typeof obj?.usage?.total_tokens === 'number') {
          total = obj.usage.total_tokens;
        }
      } catch {
        // ignore malformed line
      }
    }
  }
  return total;
}

function estimatedChatWorkUnits(body: ChatCompletionsBody): number {
  const promptTokens = estimateValueTokens(body.messages) + estimateValueTokens(body.input);
  const completionBudget = readPositiveInt(body.max_completion_tokens)
    ?? readPositiveInt(body.max_tokens)
    ?? 1024;
  return Math.max(1, promptTokens + completionBudget);
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
