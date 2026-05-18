// Admin: aggregate usage across all API keys.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ServerDeps } from '../../server.js';
import * as usageRepo from '../../repo/usageReservations.js';
import { ErrorBody, Timestamp } from '../../schema/api.js';

const ADMIN_SECURITY = [{ adminToken: [] as string[] }];

const UsageSummaryRow = z
  .object({
    apiKeyId: z.string().uuid(),
    email: z.string(),
    totalRequests: z.number(),
    committedTotal: z.number(),
    refundedTotal: z.number(),
    lastUsedAt: Timestamp.nullable(),
  })
  .meta({ id: 'AdminUsageRow' });

const UsageResponse = z
  .object({ data: z.array(UsageSummaryRow) })
  .meta({ id: 'AdminUsageResponse' });

export async function registerAdminUsageRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/admin/usage',
    {
      schema: {
        tags: ['admin'],
        summary: 'Aggregate usage by API key',
        description: 'Joined to the owning user email. Top 200 keys by recency.',
        security: ADMIN_SECURITY,
        response: { 200: UsageResponse, 401: ErrorBody, 503: ErrorBody },
      },
    },
    async () => {
      const summary = await usageRepo.summaryByApiKey(deps.db, 200);
      return {
        data: summary.map((s) => ({
          apiKeyId: s.apiKeyId,
          email: s.email,
          totalRequests: s.totalRequests,
          committedTotal: s.committedTotal,
          refundedTotal: s.refundedTotal,
          lastUsedAt: s.lastUsedAt,
        })),
      };
    },
  );
}
