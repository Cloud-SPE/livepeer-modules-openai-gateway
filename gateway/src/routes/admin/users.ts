// Admin: list approved users + their api-keys + per-user usage summary.

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ServerDeps } from '../../server.js';
import * as apiKeysRepo from '../../repo/apiKeys.js';
import * as usageRepo from '../../repo/usageReservations.js';
import * as waitlistRepo from '../../repo/waitlist.js';
import {
  ApiKeyPublic,
  ErrorBody,
  PaginationQuery,
  Timestamp,
  UuidParam,
} from '../../schema/api.js';

const ADMIN_SECURITY = [{ adminToken: [] as string[] }];

const UserSummary = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    name: z.string(),
    approvedAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: 'AdminUserSummary' });

const UsersListResponse = z
  .object({ data: z.array(UserSummary) })
  .meta({ id: 'AdminUsersList' });

const UserDetail = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    name: z.string(),
    status: z.enum(['pending', 'approved', 'rejected']),
    emailVerifiedAt: Timestamp.nullable(),
    approvedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    apiKeys: z.array(ApiKeyPublic),
    usage: z.object({
      totalRequests: z.number(),
      committedTotal: z.number(),
      refundedTotal: z.number(),
      lastUsedAt: Timestamp.nullable(),
    }),
  })
  .meta({ id: 'AdminUserDetail' });

export async function registerAdminUserRoutes(
  app: FastifyInstance,
  deps: ServerDeps,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.get(
    '/admin/users',
    {
      schema: {
        tags: ['admin'],
        summary: 'List approved users',
        security: ADMIN_SECURITY,
        querystring: PaginationQuery,
        response: { 200: UsersListResponse, 401: ErrorBody, 503: ErrorBody },
      },
    },
    async (req) => {
      const rows = await waitlistRepo.list(deps.db, {
        status: 'approved',
        limit: req.query.limit,
        offset: req.query.offset,
      });
      return {
        data: rows.map((r) => ({
          id: r.id,
          email: r.email,
          name: r.name,
          approvedAt: r.approvedAt,
          createdAt: r.createdAt,
        })),
      };
    },
  );

  f.get(
    '/admin/users/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'User detail with keys + usage summary',
        security: ADMIN_SECURITY,
        params: UuidParam,
        response: { 200: UserDetail, 401: ErrorBody, 404: ErrorBody, 503: ErrorBody },
      },
    },
    async (req, reply) => {
      const user = await waitlistRepo.findById(deps.db, req.params.id);
      if (!user) {
        return reply.code(404).send({
          error: { message: 'not found', type: 'invalid_request_error', code: 'not_found' },
        });
      }
      const keys = await apiKeysRepo.listByWaitlist(deps.db, user.id);
      const usage = await usageRepo.summaryByWaitlist(deps.db, user.id);
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        status: user.status as 'pending' | 'approved' | 'rejected',
        emailVerifiedAt: user.emailVerifiedAt,
        approvedAt: user.approvedAt,
        createdAt: user.createdAt,
        apiKeys: keys.map((k) => ({
          id: k.id,
          label: k.label,
          keyPrefix: k.keyPrefix,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt,
          revokedAt: k.revokedAt,
        })),
        usage,
      };
    },
  );
}
