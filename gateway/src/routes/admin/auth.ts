// Admin auth: `X-Admin-Token` header must match `ADMIN_TOKEN` env.
//
// Per SECURITY.md: this is a bootstrap mechanism. No "admin user" rows
// in the DB. Once we have a real admin SPA in place, the token is the
// only credential admin endpoints check.
//
// Constant-time comparison to avoid timing-oracle leaks.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ServerDeps } from '../../server.js';

export const ADMIN_TOKEN_HEADER = 'x-admin-token';

export function requireAdminToken(deps: ServerDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const expected = deps.config.adminToken;
    if (!expected) {
      void reply.code(503).send({ error: 'admin disabled (no ADMIN_TOKEN)' });
      return;
    }
    const header = req.headers[ADMIN_TOKEN_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided) {
      void reply.code(401).send({ error: 'missing X-Admin-Token' });
      return;
    }
    if (!constantTimeEqual(provided, expected)) {
      void reply.code(401).send({ error: 'invalid admin token' });
      return;
    }
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  // Equal-length precondition before timingSafeEqual; pad to dodge a
  // length-revealing early return.
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Still do a compare to keep timing flat, then return false.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
