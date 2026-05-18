// Map proxy errors to OpenAI-shaped responses.

import type { FastifyReply } from 'fastify';

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
