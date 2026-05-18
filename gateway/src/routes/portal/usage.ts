// GET /portal/usage — recent requests by the calling user.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ServerDeps } from '../../server.js';
import * as apiKeysRepo from '../../repo/apiKeys.js';
import * as usageRepo from '../../repo/usageReservations.js';
import {
  ErrorBody,
  PaginationQuery,
  UsageReservationRow,
} from '../../schema/api.js';
import { requirePortalSession } from './auth.js';

const QuerySchema = PaginationQuery.extend({
  apiKeyId: z.string().uuid().optional(),
});

const UsageResponse = z
  .object({ data: z.array(UsageReservationRow) })
  .meta({ id: 'PortalUsageResponse' });

export async function registerUsageRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/portal/usage',
    {
      schema: {
        tags: ['portal'],
        summary: 'Your recent /v1/* requests',
        description:
          'Reservation log scoped to the calling user. ' +
          'Optional `apiKeyId` filter (403 if the key is not yours).',
        security: [{ cookieAuth: [] }],
        querystring: QuerySchema,
        response: { 200: UsageResponse, 401: ErrorBody, 403: ErrorBody },
      },
      preHandler: requirePortalSession(deps),
    },
    async (req, reply) => {
      const { waitlistId } = req.portalSession!;
      const userKeys = await apiKeysRepo.listByWaitlist(deps.db, waitlistId);
      const ownedKeyIds = new Set(userKeys.map((k) => k.id));

      const targetKeyId = req.query.apiKeyId;
      if (targetKeyId && !ownedKeyIds.has(targetKeyId)) {
        return reply.code(403).send({
          error: {
            message: 'not your API key',
            type: 'invalid_request_error',
            code: 'forbidden',
          },
        });
      }

      const rows = targetKeyId
        ? await usageRepo.listByApiKey(
            deps.db,
            targetKeyId,
            req.query.limit,
            req.query.offset,
          )
        : (
            await Promise.all(
              userKeys.map((k) =>
                usageRepo.listByApiKey(deps.db, k.id, req.query.limit, 0),
              ),
            )
          )
            .flat()
            .sort((a, b) => +b.createdAt - +a.createdAt)
            .slice(req.query.offset, req.query.offset + req.query.limit);

      return {
        data: rows.map((r) => ({
          id: r.id,
          workId: r.workId,
          apiKeyId: r.apiKeyId,
          capability: r.capability,
          model: r.model,
          brokerUrl: r.brokerUrl,
          ethAddress: r.ethAddress,
          selectedCapability: r.selectedCapability,
          selectedOffering: r.selectedOffering,
          selectedWorkUnit: r.selectedWorkUnit,
          unitsPerPrice: r.unitsPerPrice,
          pricePerWorkUnitWei: r.pricePerWorkUnitWei,
          quoteId: r.quoteId,
          quoteVersion: r.quoteVersion,
          constraintFingerprintHex: r.constraintFingerprintHex,
          routeFingerprintHex: r.routeFingerprintHex,
          estimatedWorkUnits: r.estimatedWorkUnits,
          state: r.state as 'open' | 'committed' | 'refunded',
          committedWorkUnits: r.committedWorkUnits,
          latencyMs: r.latencyMs,
          statusCode: r.statusCode,
          createdAt: r.createdAt,
          resolvedAt: r.resolvedAt,
        })),
      };
    },
  );
}
