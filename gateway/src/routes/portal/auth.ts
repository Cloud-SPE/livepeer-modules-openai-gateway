// Portal session auth: cookie-based.
//
// Login flow: user pastes API key → server validates the key →
// generates session token → sets cookie. Subsequent portal calls send
// the cookie back.
//
// The session FKs to api_keys.id. If the API key is revoked, all
// sessions for it are revoked too (see repo/sessions.revokeAllForApiKey).

import { z } from 'zod';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ServerDeps } from '../../server.js';
import { generateSessionToken, hashApiKey, hashSessionToken } from '../../crypto.js';
import * as apiKeysRepo from '../../repo/apiKeys.js';
import * as sessionsRepo from '../../repo/sessions.js';
import * as waitlistRepo from '../../repo/waitlist.js';
import { ErrorBody, OkBody } from '../../schema/api.js';

export const SESSION_COOKIE = 'openai_service_session';

const LoginSchema = z
  .object({
    apiKey: z.string().min(8).max(128),
  })
  .meta({ id: 'PortalLogin' });

const LoginResponse = z
  .object({
    ok: z.literal(true),
    account: z.object({ email: z.string(), name: z.string() }),
  })
  .meta({ id: 'PortalLoginResponse' });

export interface PortalSession {
  sessionId: string;
  apiKeyId: string;
  waitlistId: string;
  email: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    portalSession?: PortalSession;
  }
}

/** Reads the cookie, validates the session, populates req.portalSession or 401. */
export function requirePortalSession(deps: ServerDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) {
      void reply.code(401).send({
        error: {
          message: 'not authenticated',
          type: 'invalid_request_error',
          code: 'no_session',
        },
      });
      return;
    }
    const session = await loadSession(deps, token);
    if (!session) {
      void reply.code(401).send({
        error: {
          message: 'session invalid or expired',
          type: 'invalid_request_error',
          code: 'session_invalid',
        },
      });
      return;
    }
    req.portalSession = session;
  };
}

async function loadSession(
  deps: ServerDeps,
  plaintextToken: string,
): Promise<PortalSession | null> {
  const { db, config } = deps;
  const hash = hashSessionToken(plaintextToken, config.ipHashPepper);
  const row = await sessionsRepo.findActive(db, hash);
  if (!row) return null;

  const apiKey = await apiKeysRepo.findById(db, row.apiKeyId);
  if (!apiKey || apiKey.revokedAt !== null) return null;

  const waitlistRow = await waitlistRepo.findById(db, apiKey.waitlistId);
  if (!waitlistRow || waitlistRow.status !== 'approved') return null;

  return {
    sessionId: row.id,
    apiKeyId: apiKey.id,
    waitlistId: waitlistRow.id,
    email: waitlistRow.email,
    name: waitlistRow.name,
  };
}

export async function registerPortalAuthRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/portal/login',
    {
      schema: {
        tags: ['portal'],
        summary: 'Sign in to the portal',
        description: 'Trade an API key for a session cookie.',
        body: LoginSchema,
        response: {
          200: LoginResponse,
          400: ErrorBody,
          401: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const { apiKey } = req.body;
      const keyHash = hashApiKey(apiKey, deps.config.apiKeyHashPepper);
      const keyRow = await apiKeysRepo.findByHash(deps.db, keyHash);
      if (!keyRow) {
        return reply.code(401).send({
          error: {
            message: 'invalid API key',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        });
      }
      const waitlistRow = await waitlistRepo.findById(deps.db, keyRow.waitlistId);
      if (!waitlistRow || waitlistRow.status !== 'approved') {
        return reply.code(401).send({
          error: {
            message: 'account not approved',
            type: 'invalid_request_error',
            code: 'account_disabled',
          },
        });
      }

      const { plaintext, hash } = generateSessionToken(deps.config.ipHashPepper);
      const expiresAt = new Date(
        Date.now() + deps.config.sessionTtlHours * 3600 * 1000,
      );
      await sessionsRepo.create(deps.db, {
        apiKeyId: keyRow.id,
        sessionHash: hash,
        expiresAt,
      });

      return reply
        .setCookie(SESSION_COOKIE, plaintext, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: deps.config.baseUrl.startsWith('https://'),
          maxAge: deps.config.sessionTtlHours * 3600,
        })
        .send({
          ok: true as const,
          account: { email: waitlistRow.email, name: waitlistRow.name },
        });
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    '/portal/logout',
    {
      schema: {
        tags: ['portal'],
        summary: 'Sign out',
        description: 'Revoke the current session and clear the cookie.',
        response: { 200: OkBody },
      },
    },
    async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) {
        const hash = hashSessionToken(token, deps.config.ipHashPepper);
        const session = await sessionsRepo.findActive(deps.db, hash);
        if (session) await sessionsRepo.revoke(deps.db, session.id);
      }
      return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true as const });
    },
  );
}
