// Bearer-token middleware for /v1/* routes.
//
// `Authorization: Bearer sk-<...>` → look up api_keys by SHA-256 hash.
// 401 if missing / unknown / revoked. 403 if the owning waitlist row
// isn't approved (shouldn't happen — admin approval is what mints the
// key — but defense in depth).

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ServerDeps } from '../server.js';
import { hashApiKey } from '../crypto.js';
import * as apiKeysRepo from '../repo/apiKeys.js';
import * as waitlistRepo from '../repo/waitlist.js';

export interface ProxyAuthContext {
  apiKeyId: string;
  waitlistId: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    proxyAuth?: ProxyAuthContext;
  }
}

export function bearerAuth(deps: ServerDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers['authorization'];
    if (!header || Array.isArray(header)) {
      void reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer realm="openai-service"')
        .send(openaiError(401, 'invalid_api_key', 'missing API key'));
      return;
    }
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      void reply
        .code(401)
        .send(openaiError(401, 'invalid_api_key', 'malformed Authorization header'));
      return;
    }
    const plaintext = match[1]!;
    const keyHash = hashApiKey(plaintext, deps.config.apiKeyHashPepper);
    const keyRow = await apiKeysRepo.findByHash(deps.db, keyHash);
    if (!keyRow) {
      void reply.code(401).send(openaiError(401, 'invalid_api_key', 'invalid API key'));
      return;
    }
    const waitlistRow = await waitlistRepo.findById(deps.db, keyRow.waitlistId);
    if (!waitlistRow || waitlistRow.status !== 'approved') {
      void reply.code(403).send(openaiError(403, 'account_disabled', 'account not approved'));
      return;
    }
    req.proxyAuth = {
      apiKeyId: keyRow.id,
      waitlistId: waitlistRow.id,
      email: waitlistRow.email,
    };
    // Fire-and-forget last-used touch — don't await.
    void apiKeysRepo.markUsed(deps.db, keyRow.id).catch((err) => {
      req.log.warn({ err, apiKeyId: keyRow.id }, 'apiKey markUsed failed');
    });
  };
}

function openaiError(
  _status: number,
  code: string,
  message: string,
): { error: { message: string; type: string; code: string } } {
  return { error: { message, type: 'invalid_request_error', code } };
}
