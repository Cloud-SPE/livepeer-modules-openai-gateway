// Map proxy errors to OpenAI-shaped responses.

import type { FastifyReply } from 'fastify';

import { LocApiError } from '../loc/client.js';
import { LivepeerBrokerError } from './livepeer/errors.js';
import { HEADER } from './livepeer/headers.js';

interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

export function sendOpenAIError(
  reply: FastifyReply,
  status: number,
  type: string,
  message: string,
  requestId: string,
  code?: string,
): void {
  const body: OpenAIErrorBody = { error: { message, type, ...(code ? { code } : {}) } };
  void reply
    .code(status)
    .header('Content-Type', 'application/json')
    .header(HEADER.REQUEST_ID, requestId)
    .send(body);
}

export function handleBrokerError(
  reply: FastifyReply,
  err: unknown,
  requestId: string,
): void {
  if (err instanceof LocApiError) {
    handleLocError(reply, err, requestId);
    return;
  }
  if (err instanceof LivepeerBrokerError) {
    // 5xx from upstream is *our* 502; everything else passes through.
    const status = err.status >= 500 ? 502 : err.status;
    sendOpenAIError(reply, status, 'api_error', err.message, requestId, err.code);
    return;
  }
  sendOpenAIError(
    reply,
    500,
    'api_error',
    (err as Error).message ?? 'internal error',
    requestId,
    'internal_error',
  );
}

/** Clearinghouse failures are operator problems, never end-user billing:
 * an exhausted LOC credit balance reads as capacity (503), not 402. */
function handleLocError(reply: FastifyReply, err: LocApiError, requestId: string): void {
  if (err.code === 'no_route_available' || err.status === 404) {
    sendOpenAIError(
      reply,
      404,
      'invalid_request_error',
      'The model does not exist or is not currently served.',
      requestId,
      'model_not_found',
    );
    return;
  }
  if (err.status === 429) {
    sendOpenAIError(
      reply,
      429,
      'rate_limit_exceeded',
      'Upstream capacity is rate limited, please retry.',
      requestId,
      'rate_limit_exceeded',
    );
    return;
  }
  // insufficient_credit / spend_cap_exceeded / daemon_unavailable /
  // loc_unreachable / 5xx — all "service can't take this right now".
  sendOpenAIError(
    reply,
    503,
    'api_error',
    'Service temporarily unable to process requests.',
    requestId,
    'service_unavailable',
  );
}
