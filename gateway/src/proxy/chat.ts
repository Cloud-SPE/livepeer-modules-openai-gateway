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
import { dispatchReqresp, dispatchStream } from './service/routeDispatch.js';
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
      const interactionMode = isStream ? STREAM_MODE : REQRESP_MODE;
      const capability = Capability.ChatCompletions;
      const requestId = readOrSynthRequestId(req);

      const offering = pickModel(body);
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
        estimatedWorkUnits: estimatedChatWorkUnits(body),
      });

      const dispatchBody = isStream ? withForcedUsageChunk(body) : body;
      const bodyStr = JSON.stringify(dispatchBody);
      const estimatedUnits = estimatedChatWorkUnits(body);

      if (isStream) {
        await runStreaming(deps, req, reply, {
          capability,
          offering,
          estimatedUnits,
          interactionMode,
          bodyStr,
          requestId,
          handle,
        });
        return;
      }

      // ── unary ────────────────────────────────────────────────────
      try {
        const dispatched = await dispatchReqresp({
          routeSelector: deps.routeSelector,
          request: req,
          capability,
          offering,
          estimatedUnits,
          interactionMode,
          body: bodyStr,
          contentType: 'application/json',
          requestId,
        });
        await recordSelectedRoute(deps, handle, dispatched.candidate);
        const usage = parseTotalTokens(dispatched.result.body);
        await commitReservation(deps, handle, { workUnits: usage, statusCode: dispatched.result.status });
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

interface StreamingInput {
  capability: string;
  offering: string;
  estimatedUnits: number;
  interactionMode: string;
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
      routeSelector: deps.routeSelector,
      request: req,
      capability: input.capability,
      offering: input.offering,
      estimatedUnits: input.estimatedUnits,
      interactionMode: input.interactionMode,
      body: input.bodyStr,
      contentType: 'application/json',
      requestId: input.requestId,
    });
  } catch (err) {
    const candidate = (err as { routeCandidate?: import('./service/routeSelector.js').RouteCandidate }).routeCandidate;
    if (candidate) await recordSelectedRoute(deps, input.handle, candidate);
    await refundReservation(deps, input.handle, {
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
    await refundReservation(deps, input.handle, {
      statusCode: dispatched.result.status,
      errorText: (streamErr as Error).message ?? 'stream_error',
    });
    return;
  }

  const usage = parseStreamingUsage(Buffer.concat(transcript).toString('utf8'));
  await commitReservation(deps, input.handle, { workUnits: usage, statusCode: dispatched.result.status });
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
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) return null;
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
