// Portal: list / create / revoke API keys.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ServerDeps } from '../../server.js';
import { generateApiKey } from '../../crypto.js';
import * as apiKeysRepo from '../../repo/apiKeys.js';
import * as sessionsRepo from '../../repo/sessions.js';
import {
  ApiKeyPublic,
  ApiKeyWithPlaintext,
  ErrorBody,
  OkBody,
  UuidParam,
} from '../../schema/api.js';
import { requirePortalSession } from './auth.js';

const CreateSchema = z
  .object({ label: z.string().trim().max(100).optional() })
  .meta({ id: 'PortalApiKeyCreate' });

const ListResponse = z
  .object({ data: z.array(ApiKeyPublic) })
  .meta({ id: 'PortalApiKeyList' });

export async function registerApiKeyRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.get(
    '/portal/api-keys',
    {
      schema: {
        tags: ['portal'],
        summary: 'List your API keys',
        description: 'Returns key prefixes only — never plaintext.',
        security: [{ cookieAuth: [] }],
        response: { 200: ListResponse, 401: ErrorBody },
      },
      preHandler: requirePortalSession(deps),
    },
    async (req) => {
      const keys = await apiKeysRepo.listByWaitlist(
        deps.db,
        req.portalSession!.waitlistId,
      );
      return {
        data: keys.map((k) => ({
          id: k.id,
          label: k.label,
          keyPrefix: k.keyPrefix,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt,
          revokedAt: k.revokedAt,
        })),
      };
    },
  );

  f.post(
    '/portal/api-keys',
    {
      schema: {
        tags: ['portal'],
        summary: 'Mint a new API key',
        description:
          'Returns the plaintext key exactly once. Save it — it cannot be recovered.',
        security: [{ cookieAuth: [] }],
        body: CreateSchema,
        response: { 200: ApiKeyWithPlaintext, 400: ErrorBody, 401: ErrorBody },
      },
      preHandler: requirePortalSession(deps),
    },
    async (req) => {
      const label = req.body?.label?.trim() ?? null;
      const { plaintext, prefix, hash } = generateApiKey(
        deps.config.apiKeyHashPepper,
      );
      const row = await apiKeysRepo.create(deps.db, {
        waitlistId: req.portalSession!.waitlistId,
        label,
        keyPrefix: prefix,
        keyHash: hash,
      });
      return {
        id: row.id,
        label: row.label,
        keyPrefix: row.keyPrefix,
        plaintextKey: plaintext,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        revokedAt: row.revokedAt,
      };
    },
  );

  f.delete(
    '/portal/api-keys/:id',
    {
      schema: {
        tags: ['portal'],
        summary: 'Revoke an API key',
        description:
          'Revokes the key and cascade-revokes every active session that uses it.',
        security: [{ cookieAuth: [] }],
        params: UuidParam,
        response: { 200: OkBody, 401: ErrorBody, 404: ErrorBody },
      },
      preHandler: requirePortalSession(deps),
    },
    async (req, reply) => {
      const ok = await apiKeysRepo.revoke(
        deps.db,
        req.params.id,
        req.portalSession!.waitlistId,
      );
      if (!ok) {
        return reply.code(404).send({
          error: {
            message: 'not found or already revoked',
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }
      await sessionsRepo.revokeAllForApiKey(deps.db, req.params.id);
      return { ok: true as const };
    },
  );
}
